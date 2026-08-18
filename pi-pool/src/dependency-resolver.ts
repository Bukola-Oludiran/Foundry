import type {
  DependencyResolutionEvidenceV1,
  ResolveDependenciesRequestV2,
  ResolveDependenciesResultV2,
  VulnerabilityFindingV1,
} from "./contract.ts";
import { RequestError } from "./validation.ts";
import { BoundedProcessRunner, type ProcessRunner } from "./process-runner.ts";
import { isAbsolute } from "node:path";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";

/**
 * Execution boundary for a pinned, policy-enforcing dependency resolver.
 *
 * The HTTP worker deliberately has no host-package-manager fallback. Production
 * wiring must provide an OCI implementation whose only network path is the
 * operator-controlled registry proxy.
 */
export interface DependencyResolver {
  readiness?(): Promise<{ ready: boolean; reason: string | null }>;
  resolve(
    request: ResolveDependenciesRequestV2,
    signal: AbortSignal,
  ): Promise<ResolveDependenciesResultV2>;
}

export interface OciDependencyResolverOptions {
  network: string;
  proxyUrl: string;
  runner?: ProcessRunner;
  dockerCommand?: string;
  resolverCommand?: string;
  artifactDirectory: string;
  catalogDirectory?: string;
}

function safeDockerName(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`${label} is not a safe Docker identifier`);
  }
  return value;
}

function credentialFreeProxy(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    throw new Error(
      "registry proxy must be a credential-free HTTP(S) URL on the internal resolver network",
    );
  }
  return url.toString();
}

/**
 * Concrete resolver adapter for a purpose-built resolver image.
 *
 * The selected Docker network must be internal. An operator-managed proxy may
 * bridge that network to the allowlisted registries; the resolver has no other
 * egress path. The image reads one request from stdin and emits one bounded
 * ResolveDependenciesResultV2 JSON object on stdout.
 */
export class OciDependencyResolver implements DependencyResolver {
  private readonly network: string;
  private readonly proxyUrl: string;
  private readonly runner: ProcessRunner;
  private readonly docker: string;
  private readonly resolverCommand: string;
  private readonly artifactDirectory: string;
  private readonly catalogDirectory?: string;

  constructor(options: OciDependencyResolverOptions) {
    this.network = safeDockerName(options.network, "resolver network");
    this.proxyUrl = credentialFreeProxy(options.proxyUrl);
    this.runner = options.runner ?? new BoundedProcessRunner();
    this.docker = options.dockerCommand ?? "docker";
    this.resolverCommand =
      options.resolverCommand ?? "/usr/local/bin/foundry-resolver";
    if (!this.resolverCommand.startsWith("/")) {
      throw new Error("resolver command must be an absolute container path");
    }
    if (
      !isAbsolute(options.artifactDirectory) ||
      /[\r\n,]/.test(options.artifactDirectory)
    ) {
      throw new Error(
        "resolver artifact directory must be a safe absolute path",
      );
    }
    mkdirSync(options.artifactDirectory, { recursive: true, mode: 0o700 });
    const artifactMetadata = lstatSync(options.artifactDirectory);
    if (!artifactMetadata.isDirectory() || artifactMetadata.isSymbolicLink()) {
      throw new Error(
        "resolver artifact directory must be a regular directory",
      );
    }
    this.artifactDirectory = realpathSync(options.artifactDirectory);
    if (options.catalogDirectory) {
      if (
        !isAbsolute(options.catalogDirectory) ||
        /[\r\n,]/.test(options.catalogDirectory)
      ) {
        throw new Error(
          "resolver catalog directory must be a safe absolute path",
        );
      }
      const catalog = realpathSync(options.catalogDirectory);
      const metadata = lstatSync(catalog);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(
          "resolver catalog directory must be a regular directory",
        );
      }
      this.catalogDirectory = catalog;
    }
  }

  async readiness(): Promise<{ ready: boolean; reason: string | null }> {
    try {
      const inspection = await this.inspectNetwork();
      return inspection
        ? { ready: true, reason: null }
        : {
            ready: false,
            reason: "resolver Docker network is not marked internal",
          };
    } catch {
      return {
        ready: false,
        reason: "resolver Docker network is unavailable",
      };
    }
  }

  private async inspectNetwork(signal?: AbortSignal): Promise<boolean> {
    const inspection = await this.runner.run(
      this.docker,
      ["network", "inspect", "--format", "{{json .Internal}}", this.network],
      { timeoutMs: 10_000, maxOutputBytes: 4096, signal },
    );
    return inspection.code === 0 && inspection.stdout.trim() === "true";
  }

  async resolve(
    request: ResolveDependenciesRequestV2,
    signal: AbortSignal,
  ): Promise<ResolveDependenciesResultV2> {
    if (request.workspace.includes(",") || /[\r\n]/.test(request.workspace)) {
      throw new RequestError(
        400,
        "PATH_ESCAPE",
        "workspace cannot be represented safely as an OCI bind mount",
      );
    }
    if (!(await this.inspectNetwork(signal))) {
      throw new RequestError(
        503,
        "RESOLVER_NETWORK_UNSAFE",
        "resolver network is unavailable or is not an internal Docker network",
        true,
      );
    }
    const uid = process.getuid?.() ?? 65532;
    const gid = process.getgid?.() ?? 65532;
    const args = [
      "run",
      "--rm",
      "--interactive",
      "--read-only",
      "--network",
      this.network,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(request.resource_policy.pids),
      "--memory",
      `${request.resource_policy.memory_mb}m`,
      "--cpus",
      String(request.resource_policy.cpu_count),
      "--user",
      `${uid}:${gid}`,
      "--platform",
      request.platform,
      "--label",
      `foundry.run_id=${request.run_id}`,
      "--label",
      `foundry.plan_digest=${request.plan.plan_digest}`,
      "--env",
      `HTTP_PROXY=${this.proxyUrl}`,
      "--env",
      `HTTPS_PROXY=${this.proxyUrl}`,
      "--env",
      "NO_PROXY=",
      "--mount",
      `type=bind,src=${request.workspace},dst=/workspace,readonly`,
      "--mount",
      `type=bind,src=${this.artifactDirectory},dst=/artifacts`,
      "--env",
      "FOUNDRY_ARTIFACT_DIR=/artifacts",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=128m",
    ];
    if (this.catalogDirectory) {
      args.push(
        "--mount",
        `type=bind,src=${this.catalogDirectory},dst=/catalog,readonly`,
        "--env",
        "FOUNDRY_RESOLUTION_CATALOG=/catalog/index.json",
        "--env",
        "FOUNDRY_RESOLUTION_CATALOG_ARTIFACTS=/catalog/artifacts",
      );
    }
    args.push(request.resolver_image, this.resolverCommand);
    const execution = await this.runner.run(this.docker, args, {
      input: JSON.stringify(request),
      timeoutMs: request.resource_policy.timeout_ms,
      maxOutputBytes: 4 * 1024 * 1024,
      signal,
    });
    if (signal.aborted) {
      throw new RequestError(
        409,
        "JOB_CANCELLED",
        "dependency resolution was cancelled",
      );
    }
    if (execution.timedOut) {
      throw new RequestError(
        504,
        "RESOLVER_TIMEOUT",
        "dependency resolver timed out",
        true,
      );
    }
    if (execution.code !== 0) {
      throw new RequestError(
        502,
        "RESOLVER_FAILED",
        "dependency resolver exited unsuccessfully; inspect sanitized worker diagnostics",
        true,
      );
    }
    try {
      return JSON.parse(execution.stdout) as ResolveDependenciesResultV2;
    } catch {
      throw new RequestError(
        502,
        "RESOLVER_OUTPUT_INVALID",
        "dependency resolver did not return one valid JSON result",
      );
    }
  }
}

const DIGEST = /^[a-f0-9]{64}$/;
const SEVERITY: Record<VulnerabilityFindingV1["severity"], number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const SAFE_FAILURE_CODES = new Set([
  "VERSION_UNAVAILABLE",
  "INTEGRITY_MISMATCH",
  "LOCKFILE_DRIFT",
  "REGISTRY_DENIED",
  "LICENSE_POLICY_REJECTED",
  "VULNERABILITY_POLICY_REJECTED",
  "UNSUPPORTED_SOURCE",
]);

function safeText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      `${label} is not a bounded string`,
    );
  }
  if (
    /(?:bearer\s+|authorization|cookie|password|private[_ -]?key|nsec1|ghp_|github_pat_|sk-)/i.test(
      value,
    )
  ) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      `${label} contains forbidden secret-shaped material`,
    );
  }
  return value;
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      `${label} is not a lowercase SHA-256 digest`,
    );
  }
}

/** Fail closed when an adapter returns evidence outside the accepted plan. */
export function verifyDependencyResolutionResult(
  request: ResolveDependenciesRequestV2,
  result: ResolveDependenciesResultV2,
): ResolveDependenciesResultV2 {
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new RequestError(
      502,
      "RESOLVER_OUTPUT_INVALID",
      "dependency resolver returned an invalid result object",
    );
  }
  if (!result.ok) {
    if (
      result.evidence !== null ||
      result.failure_code === null ||
      !SAFE_FAILURE_CODES.has(result.failure_code)
    ) {
      throw new RequestError(
        502,
        "RESOLVER_OUTPUT_INVALID",
        "failed resolution returned an invalid failure category",
      );
    }
    return {
      ok: false,
      evidence: null,
      manifest: null,
      lockfile: null,
      dependency_layer: null,
      sbom: null,
      license_report: null,
      vulnerability_report: null,
      error:
        "dependency resolution failed under the configured supply-chain policy",
      failure_code: result.failure_code,
    };
  }
  if (
    !result.evidence ||
    result.error !== null ||
    result.failure_code !== null
  ) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      "green resolution must include evidence and no failure",
    );
  }
  const evidence: DependencyResolutionEvidenceV1 = result.evidence;
  if (
    evidence.resolution_version !== 1 ||
    evidence.plan_digest !== request.plan.plan_digest ||
    evidence.resolver_image !== request.resolver_image ||
    evidence.platform !== request.platform
  ) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      "resolver evidence is not bound to the submitted plan, image, and platform",
    );
  }
  for (const [label, value] of [
    ["manifest_sha256", evidence.manifest_sha256],
    ["lockfile_sha256", evidence.lockfile_sha256],
    ["dependency_layer_sha256", evidence.dependency_layer_sha256],
    ["sbom_sha256", evidence.sbom_sha256],
  ] as const) {
    assertDigest(value, label);
  }
  const declared = new Map(
    request.plan.roots.flatMap((root) =>
      root.packages.map((pkg) => [pkg.id, pkg] as const),
    ),
  );
  const resolved = new Map(
    evidence.packages.map((pkg) => [pkg.package_id, pkg] as const),
  );
  if (
    evidence.packages.length > 4096 ||
    evidence.vulnerabilities.length > 4096
  ) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      "resolver evidence exceeds its item bound",
    );
  }
  if (resolved.size !== evidence.packages.length) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      "resolver returned duplicate package identities",
    );
  }
  for (const [id, expected] of declared) {
    const actual = resolved.get(id);
    if (
      !actual ||
      actual.name !== expected.name ||
      actual.version !== expected.version ||
      actual.integrity !== expected.integrity
    ) {
      throw new RequestError(
        422,
        "DEPENDENCY_DRIFT",
        `resolved package ${id} does not match the accepted architecture`,
      );
    }
    for (const license of actual.licenses) {
      safeText(license, `package ${id} license`, 128);
      if (!request.policy.allowed_licenses.includes(license)) {
        throw new RequestError(
          422,
          "LICENSE_POLICY_REJECTED",
          `package ${id} uses disallowed license ${license}`,
        );
      }
    }
  }
  for (const id of resolved.keys()) {
    if (!declared.has(id)) {
      throw new RequestError(
        422,
        "UNDECLARED_DEPENDENCY",
        `resolver returned undeclared package ${id}`,
      );
    }
  }
  const threshold = SEVERITY[request.policy.deny_at_or_above];
  const blocked = evidence.vulnerabilities.find(
    (finding) => SEVERITY[finding.severity] >= threshold,
  );
  if (blocked) {
    throw new RequestError(
      422,
      "VULNERABILITY_POLICY_REJECTED",
      `${blocked.package_id} is affected by ${blocked.advisory_id} (${blocked.severity})`,
    );
  }
  for (const finding of evidence.vulnerabilities) {
    if (!declared.has(finding.package_id)) {
      throw new RequestError(
        502,
        "RESOLUTION_EVIDENCE_INVALID",
        `vulnerability references undeclared package ${finding.package_id}`,
      );
    }
    safeText(finding.advisory_id, "vulnerability advisory_id", 200);
    safeText(finding.summary, "vulnerability summary", 512);
  }
  const normalizedArtifacts = [];
  for (const artifact of [
    result.manifest,
    result.lockfile,
    result.dependency_layer,
    result.sbom,
    result.license_report,
    result.vulnerability_report,
  ]) {
    if (!artifact) {
      throw new RequestError(
        502,
        "RESOLUTION_EVIDENCE_INVALID",
        "green resolution omitted a required supply-chain artifact",
      );
    }
    assertDigest(artifact.sha256, "artifact.sha256");
    if (
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      artifact.size > 1024 * 1024 * 1024
    ) {
      throw new RequestError(
        502,
        "RESOLUTION_EVIDENCE_INVALID",
        "supply-chain artifact has an invalid size",
      );
    }
    normalizedArtifacts.push({
      sha256: artifact.sha256,
      size: artifact.size,
      media_type: safeText(artifact.media_type, "artifact.media_type", 200),
    });
  }
  const [
    manifest,
    lockfile,
    dependencyLayer,
    sbom,
    licenseReport,
    vulnerabilityReport,
  ] = normalizedArtifacts;
  if (
    manifest!.media_type !==
      "application/vnd.foundry.package-manifests.v1+json" ||
    lockfile!.media_type !==
      "application/vnd.foundry.package-lockfiles.v1+json" ||
    manifest!.size > 16 * 1024 * 1024 ||
    lockfile!.size > 16 * 1024 * 1024
  ) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      "dependency file bundles use an unsupported media type or size",
    );
  }
  if (
    manifest!.sha256 !== evidence.manifest_sha256 ||
    lockfile!.sha256 !== evidence.lockfile_sha256 ||
    dependencyLayer!.sha256 !== evidence.dependency_layer_sha256 ||
    sbom!.sha256 !== evidence.sbom_sha256
  ) {
    throw new RequestError(
      502,
      "RESOLUTION_EVIDENCE_INVALID",
      "supply-chain artifact identities do not match resolver evidence",
    );
  }
  return {
    ok: true,
    evidence: {
      resolution_version: 1,
      plan_digest: evidence.plan_digest,
      resolver_image: evidence.resolver_image,
      platform: safeText(evidence.platform, "evidence.platform", 100),
      manifest_sha256: evidence.manifest_sha256,
      lockfile_sha256: evidence.lockfile_sha256,
      dependency_layer_sha256: evidence.dependency_layer_sha256,
      sbom_sha256: evidence.sbom_sha256,
      packages: evidence.packages.map((pkg) => ({
        package_id: safeText(pkg.package_id, "package_id", 200),
        name: safeText(pkg.name, "package name", 512),
        version: safeText(pkg.version, "package version", 200),
        integrity: safeText(pkg.integrity, "package integrity", 512),
        licenses: pkg.licenses.map((license) =>
          safeText(license, "package license", 128),
        ),
      })),
      vulnerabilities: evidence.vulnerabilities.map((finding) => ({
        package_id: finding.package_id,
        advisory_id: finding.advisory_id,
        severity: finding.severity,
        summary: finding.summary,
      })),
    },
    manifest: manifest!,
    lockfile: lockfile!,
    dependency_layer: dependencyLayer!,
    sbom: sbom!,
    license_report: licenseReport!,
    vulnerability_report: vulnerabilityReport!,
    error: null,
    failure_code: null,
  };
}

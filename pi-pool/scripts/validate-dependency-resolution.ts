import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ResolveDependenciesRequestV2,
  ResolveDependenciesResultV2,
} from "../src/contract.ts";
import {
  OciDependencyResolver,
  verifyDependencyResolutionResult,
} from "../src/dependency-resolver.ts";
import type { ProcessRunner } from "../src/process-runner.ts";
import { FilesystemDependencyArtifactStore } from "../src/dependency-artifacts.ts";
import {
  RequestError,
  validateResolveDependenciesRequest,
} from "../src/validation.ts";

const digest = (character: string): string => character.repeat(64);
const workspace = mkdtempSync(join(tmpdir(), "foundry-resolver-contract-"));

const request: ResolveDependenciesRequestV2 = {
  protocol_version: 2,
  job_id: "run-1:deps",
  run_id: "run-1",
  ir_digest: digest("a"),
  base_commit: digest("b"),
  workspace,
  resolver_image: `registry.example/foundry-resolver@sha256:${digest("c")}`,
  platform: "linux/amd64",
  existing_repository: false,
  resource_policy: {
    timeout_ms: 120_000,
    memory_mb: 1024,
    cpu_count: 2,
    pids: 256,
    network: "registry-egress",
  },
  plan: {
    resolution_version: 1,
    ir_digest: digest("a"),
    plan_digest: digest("d"),
    roots: [
      {
        package_root: "web",
        ecosystem: "npm",
        language: "typescript",
        manifest_path: "package.json",
        lockfile_path: "package-lock.json",
        resolver: { mode: "locked", allow_prereleases: false },
        registry_allowlist: ["https://registry.npmjs.org"],
        packages: [
          {
            id: "zod",
            name: "zod",
            version: "4.1.0",
            integrity: "sha512-example",
            features: [],
            scope: "runtime",
            owner_node: "web",
            package_root: "web",
          },
        ],
      },
    ],
  },
  policy: {
    allowed_licenses: ["MIT"],
    deny_at_or_above: "high",
  },
};

const artifact = (
  character: string,
  media_type = "application/octet-stream",
) => ({
  sha256: digest(character),
  size: 1,
  media_type,
});
const result: ResolveDependenciesResultV2 = {
  ok: true,
  evidence: {
    resolution_version: 1,
    plan_digest: digest("d"),
    resolver_image: request.resolver_image,
    platform: request.platform,
    manifest_sha256: digest("1"),
    lockfile_sha256: digest("2"),
    dependency_layer_sha256: digest("3"),
    sbom_sha256: digest("4"),
    packages: [
      {
        package_id: "zod",
        name: "zod",
        version: "4.1.0",
        integrity: "sha512-example",
        licenses: ["MIT"],
      },
    ],
    vulnerabilities: [],
  },
  manifest: artifact("1", "application/vnd.foundry.package-manifests.v1+json"),
  lockfile: artifact("2", "application/vnd.foundry.package-lockfiles.v1+json"),
  dependency_layer: artifact("3"),
  sbom: artifact("4"),
  license_report: artifact("5"),
  vulnerability_report: artifact("6"),
  error: null,
  failure_code: null,
};

let failures = 0;
function accept(label: string, action: () => unknown): void {
  try {
    action();
    console.log(`OK  ${label}`);
  } catch (error) {
    failures++;
    console.error(`BAD ${label}: ${String(error)}`);
  }
}
function reject(label: string, code: string, action: () => unknown): void {
  try {
    action();
    failures++;
    console.error(`BAD ${label}: accepted`);
  } catch (error) {
    const ok = error instanceof RequestError && error.code === code;
    if (!ok) failures++;
    console.log(`${ok ? "OK " : "BAD"} ${label}`);
  }
}

async function acceptAsync(
  label: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
    console.log(`OK  ${label}`);
  } catch (error) {
    failures++;
    console.error(`BAD ${label}: ${String(error)}`);
  }
}

try {
  accept("accepts strict pinned resolution request", () =>
    validateResolveDependenciesRequest(request, workspace),
  );
  accept("accepts plan-bound green evidence", () =>
    verifyDependencyResolutionResult(request, result),
  );
  reject("rejects unpinned resolver image", "INVALID_REQUEST", () =>
    validateResolveDependenciesRequest(
      { ...request, resolver_image: "foundry-resolver:latest" },
      workspace,
    ),
  );
  reject("rejects credential-bearing registry URL", "INVALID_REQUEST", () =>
    validateResolveDependenciesRequest(
      {
        ...request,
        plan: {
          ...request.plan,
          roots: [
            {
              ...request.plan.roots[0]!,
              registry_allowlist: ["https://token@example.invalid"],
            },
          ],
        },
      },
      workspace,
    ),
  );
  reject("rejects lock drift", "DEPENDENCY_DRIFT", () =>
    verifyDependencyResolutionResult(request, {
      ...result,
      evidence: {
        ...result.evidence!,
        packages: [{ ...result.evidence!.packages[0]!, version: "4.2.0" }],
      },
    }),
  );
  reject("rejects high vulnerabilities", "VULNERABILITY_POLICY_REJECTED", () =>
    verifyDependencyResolutionResult(request, {
      ...result,
      evidence: {
        ...result.evidence!,
        vulnerabilities: [
          {
            package_id: "zod",
            advisory_id: "CVE-TEST",
            severity: "high",
            summary: "fixture",
          },
        ],
      },
    }),
  );
  reject(
    "rejects secret-shaped resolver evidence",
    "RESOLUTION_EVIDENCE_INVALID",
    () =>
      verifyDependencyResolutionResult(request, {
        ...result,
        evidence: {
          ...result.evidence!,
          vulnerabilities: [
            {
              package_id: "zod",
              advisory_id: "ADVISORY-1",
              severity: "low",
              summary: "Authorization: Bearer should-never-persist",
            },
          ],
        },
      }),
  );
  await acceptAsync(
    "artifact store verifies content-addressed bytes",
    async () => {
      const directory = join(workspace, "artifacts");
      mkdirSync(directory);
      const bytes = Buffer.from("manifest bundle");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(join(directory, sha256), bytes);
      const store = new FilesystemDependencyArtifactStore(directory);
      const loaded = await store.read(sha256, new AbortController().signal);
      if (!loaded.equals(bytes)) throw new Error("artifact bytes changed");
      writeFileSync(join(directory, sha256), "corrupt");
      try {
        await store.read(sha256, new AbortController().signal);
        throw new Error("corrupt artifact was accepted");
      } catch (error) {
        if (
          !(error instanceof RequestError) ||
          error.code !== "ARTIFACT_CHECKSUM_MISMATCH"
        ) {
          throw error;
        }
      }
    },
  );
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const runner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ command, args, input: options.input });
      return calls.length === 1
        ? {
            code: 0,
            signal: null,
            stdout: "true\n",
            stderr: "",
            timedOut: false,
          }
        : {
            code: 0,
            signal: null,
            stdout: JSON.stringify(result),
            stderr: "",
            timedOut: false,
          };
    },
  };
  await acceptAsync(
    "runs resolver in a bounded internal OCI network",
    async () => {
      const resolver = new OciDependencyResolver({
        network: "foundry-registry-internal",
        proxyUrl: "http://registry-proxy:8080",
        artifactDirectory: join(workspace, "artifacts"),
        runner,
      });
      await resolver.resolve(request, new AbortController().signal);
      const invocation = calls[1]!;
      if (
        invocation.command !== "docker" ||
        !invocation.args.includes("--read-only") ||
        !invocation.args.includes("no-new-privileges") ||
        !invocation.args.includes("foundry-registry-internal") ||
        !invocation.args.includes(request.resolver_image) ||
        !invocation.args.some((value) => value.endsWith(",readonly")) ||
        !invocation.args.some((value) => value.endsWith(",dst=/artifacts")) ||
        !invocation.args.includes("FOUNDRY_ARTIFACT_DIR=/artifacts") ||
        invocation.input !== JSON.stringify(request)
      ) {
        throw new Error("OCI resolver invocation omitted a required boundary");
      }
    },
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.exitCode = failures === 0 ? 0 : 1;

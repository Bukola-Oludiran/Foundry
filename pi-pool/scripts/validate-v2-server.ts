import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { DependencyResolver } from "../src/dependency-resolver.ts";
import type { DependencyArtifactStore } from "../src/dependency-artifacts.ts";
import type { EnvironmentManager } from "../src/environment-manager.ts";
import type { ProjectRunner } from "../src/project-runner.ts";
import type { TestRequestV2 } from "../src/contract.ts";
import { StubLlm } from "../src/llm.ts";
import { createFoundryServer } from "../src/server.ts";

const digest = (character: string): string => character.repeat(64);
const workspace = mkdtempSync(join(tmpdir(), "foundry-v2-server-"));
mkdirSync(join(workspace, "src"));
writeFileSync(
  join(workspace, "src/api.py"),
  "def health():\n    return True\n",
);
const artifact = (
  character: string,
  media_type = "application/octet-stream",
) => ({
  sha256: digest(character),
  size: 1,
  media_type,
});
const artifactBytes = Buffer.from("verified dependency artifact");
const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex");
const artifactStore: DependencyArtifactStore = {
  async read(sha256) {
    if (sha256 !== artifactDigest)
      throw new Error("unexpected artifact digest");
    return artifactBytes;
  },
};
let resolverCalls = 0;
const resolver: DependencyResolver = {
  async resolve(request) {
    resolverCalls++;
    return {
      ok: true,
      evidence: {
        resolution_version: 1,
        plan_digest: request.plan.plan_digest,
        resolver_image: request.resolver_image,
        platform: request.platform,
        manifest_sha256: digest("1"),
        lockfile_sha256: digest("2"),
        dependency_layer_sha256: digest("3"),
        sbom_sha256: digest("4"),
        packages: [],
        vulnerabilities: [],
      },
      manifest: artifact(
        "1",
        "application/vnd.foundry.package-manifests.v1+json",
      ),
      lockfile: artifact(
        "2",
        "application/vnd.foundry.package-lockfiles.v1+json",
      ),
      dependency_layer: artifact("3"),
      sbom: artifact("4"),
      license_report: artifact("5"),
      vulnerability_report: artifact("6"),
      error: null,
      failure_code: null,
    };
  },
};
const environment: EnvironmentManager = {
  async start(request) {
    return {
      environment_id: "environment-v2",
      run_id: request.run_id,
      plan_digest: request.plan.plan_digest,
      network_id: "network-v2",
      state: "ready",
      aliases: {},
      secret_handles: [],
    };
  },
  async health(request) {
    return {
      environment_id: request.environment_id,
      plan_digest: request.plan_digest,
      healthy: true,
      services: [],
    };
  },
  async migrate(request) {
    return {
      environment_id: request.environment_id,
      plan_digest: request.plan_digest,
      green: true,
      outcomes: [],
      artifact: artifact("e"),
    };
  },
  async snapshot(request) {
    return {
      environment_id: request.environment_id,
      plan_digest: request.plan_digest,
      snapshot_digest: digest("5"),
      artifact: artifact("e"),
    };
  },
  async evidence(request) {
    return {
      environment_id: request.environment_id,
      run_id: request.run_id,
      plan_digest: request.plan_digest,
      green: true,
      contracts: [],
      unexpected_requests: 0,
      resource_usage: [],
      artifact: artifact("d"),
    };
  },
  async teardown(request) {
    return {
      environment_id: request.environment_id,
      plan_digest: request.plan_digest,
      stopped: true,
      cleanup_complete: true,
      diagnostic_artifact: null,
    };
  },
};
let projectRunnerCalls = 0;
const projectRunner: ProjectRunner = {
  async test(request) {
    projectRunnerCalls++;
    const caseResults = request.acceptance.cases.map((testCase) => ({
      name: testCase.name,
      status: "passed" as const,
      failure: null,
    }));
    return {
      protocol_version: 2,
      job_id: request.job_id,
      run_id: request.run_id,
      dependency_layer_sha256: request.dependency_layer?.sha256 ?? null,
      environment_snapshot_digest:
        request.test_environment?.snapshot_digest ?? null,
      node_id: request.node_id,
      verdict: "green",
      passed: caseResults.length,
      failed: 0,
      failures: [],
      case_results: caseResults,
      failure_code: null,
      implementation_evidence: {
        evidence_version: 1,
        node_id: request.node_id,
        build_run_id: request.run_id,
        proposal_id: request.proposal_id ?? null,
        revision_id: request.revision_id ?? null,
        semantic_digest: request.semantic_digest ?? request.ir_digest,
        base_commit: request.base_commit,
        attempt: request.attempt ?? 1,
        language: request.language,
        source_snapshot_digest: digest("8"),
        source_files: [{ path: request.write_target, sha256: digest("8") }],
        symbols: [],
        contract_mappings: [],
        case_results: caseResults,
        measurements: { duration_ms: 2, memory_mb: 16 },
        completeness: "complete",
        diagnostics: [],
        created_at_ms: 1,
      },
      measurements: { duration_ms: 2, memory_mb: 16 },
      artifact: artifact("e"),
      piston: { code: 0, signal: null, stdout: "", stderr: "" },
    };
  },
};

const server = createFoundryServer({
  llm: new StubLlm(() => ""),
  authToken: "v2-test-token",
  workspaceRoot: workspace,
  dependencyResolver: resolver,
  dependencyArtifactStore: artifactStore,
  environmentManager: environment,
  projectRunner,
  requireProtocolV2: true,
});
const listening = await new Promise<boolean>((resolve, reject) => {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPERM") resolve(false);
    else reject(error);
  });
  server.listen(0, "127.0.0.1", () => resolve(true));
});
if (!listening) {
  console.log("SKIP — this host forbids loopback listeners");
  rmSync(workspace, { recursive: true, force: true });
  process.exit(0);
}
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer v2-test-token",
    },
    body: JSON.stringify(body),
  });
const resolution = {
  protocol_version: 2,
  job_id: "v2:resolve",
  run_id: "v2",
  ir_digest: digest("a"),
  base_commit: digest("b"),
  workspace,
  resolver_image: `registry.example/resolver@sha256:${digest("c")}`,
  platform: "linux/amd64",
  existing_repository: false,
  resource_policy: {
    timeout_ms: 10_000,
    memory_mb: 512,
    cpu_count: 1,
    pids: 64,
    network: "registry-egress",
  },
  plan: {
    resolution_version: 1,
    ir_digest: digest("a"),
    plan_digest: digest("d"),
    roots: [],
  },
  policy: { allowed_licenses: ["MIT"], deny_at_or_above: "high" },
};
const environmentStart = {
  protocol_version: 2,
  job_id: "v2:environment:start",
  run_id: "v2",
  ir_digest: digest("a"),
  base_commit: digest("b"),
  plan: {
    environment_plan_version: 1,
    ir_digest: digest("a"),
    plan_digest: digest("f"),
    network_egress: "none",
    resources: [],
    integrations: [],
    migrations: [],
    integration_expectations: [],
  },
  resource_images: {},
  emulator_image: `registry.example/emulator@sha256:${digest("7")}`,
  resource_policy: {
    timeout_ms: 10_000,
    memory_mb: 512,
    cpu_count: 1,
    pids: 64,
    network: "private-integration",
  },
};
const projectTest: TestRequestV2 = {
  protocol_version: 2,
  job_id: "v2:api:test",
  run_id: "v2",
  ir_digest: digest("a"),
  base_commit: digest("b"),
  resource_policy: {
    timeout_ms: 10_000,
    memory_mb: 512,
    cpu_count: 1,
    pids: 64,
    network: "none",
  },
  node_id: "api",
  language: "python",
  workspace,
  write_target: "src/api.py",
  provides: {
    name: "Api",
    operations: [{ name: "health", signature: "health() -> bool" }],
  },
  acceptance: {
    mandate_owner: "spec",
    language: "python",
    cases: [{ name: "healthy", call: "health()", expect: true }],
  },
  deps: [],
  dependency_layer: null,
  test_environment: null,
  migration_phase: "not_required",
};

let failed = false;
try {
  const readiness = await fetch(`${base}/ready`);
  const readinessBody = (await readiness.json()) as {
    protocol_v2?: {
      dependency_resolver?: { ready?: boolean };
      dependency_artifacts?: { ready?: boolean };
      environment_manager?: { ready?: boolean };
      project_runner?: { ready?: boolean };
    };
  };
  if (
    readiness.status !== 200 ||
    readinessBody.protocol_v2?.dependency_resolver?.ready !== true ||
    readinessBody.protocol_v2.dependency_artifacts?.ready !== true ||
    readinessBody.protocol_v2.environment_manager?.ready !== true ||
    readinessBody.protocol_v2.project_runner?.ready !== true
  ) {
    failed = true;
  }
  for (let index = 0; index < 2; index++) {
    const response = await post("/v2/dependencies/resolve", resolution);
    if (response.status !== 200) failed = true;
    await response.text();
  }
  const unauthorizedArtifact = await fetch(
    `${base}/v2/dependencies/artifacts/${artifactDigest}`,
  );
  if (unauthorizedArtifact.status !== 401) failed = true;
  const downloadedArtifact = await fetch(
    `${base}/v2/dependencies/artifacts/${artifactDigest}`,
    { headers: { authorization: "Bearer v2-test-token" } },
  );
  if (
    downloadedArtifact.status !== 200 ||
    !Buffer.from(await downloadedArtifact.arrayBuffer()).equals(artifactBytes)
  ) {
    failed = true;
  }
  const started = await post("/v2/environments/start", environmentStart);
  if (started.status !== 200) failed = true;
  await started.text();
  const environmentEvidence = await post("/v2/environments/evidence", {
    protocol_version: 2,
    job_id: "v2:environment:evidence",
    run_id: "v2",
    environment_id: "environment-v2",
    plan_digest: digest("f"),
    expectations: [],
    resources: [],
  });
  if (environmentEvidence.status !== 200) failed = true;
  await environmentEvidence.text();
  for (let index = 0; index < 2; index++) {
    const tested = await post("/test", projectTest);
    if (tested.status !== 200) failed = true;
    await tested.text();
  }
  if (resolverCalls !== 1) failed = true;
  if (projectRunnerCalls !== 1) failed = true;
  console.log(
    `${failed ? "BAD" : "OK "} authenticated v2 routes and durable job replay`,
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

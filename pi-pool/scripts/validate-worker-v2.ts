import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildRequestV2, TestRequestV2 } from "../src/contract.ts";
import {
  RequestError,
  validateBuildRequest,
  validateTestRequest,
} from "../src/validation.ts";

const digest = (character: string): string => character.repeat(64);
const workspace = mkdtempSync(join(tmpdir(), "foundry-worker-v2-"));
mkdirSync(join(workspace, "src"));
writeFileSync(
  join(workspace, "src/service.py"),
  "def health():\n    return True\n",
);

const context = {
  protocol_version: 2 as const,
  job_id: "run-v2:service:1",
  run_id: "run-v2",
  ir_digest: digest("a"),
  base_commit: digest("b"),
  resource_policy: {
    timeout_ms: 30_000,
    memory_mb: 512,
    cpu_count: 1,
    pids: 64,
    network: "model-egress" as const,
  },
};
const dependencyLayer = {
  artifact_id: "artifact-dependency-layer",
  sha256: digest("c"),
  package_root: "python-service",
  manifest_path: "requirements.txt",
  lockfile_path: "requirements.lock",
  resolver_image: `registry.example/resolver@sha256:${digest("d")}`,
  platform: "linux/amd64",
};
const build: BuildRequestV2 = {
  ...context,
  node_id: "service",
  kind: "leaf",
  language: "python",
  workspace,
  write_target: "src/service.py",
  provides: {
    name: "Service",
    operations: [{ name: "health", signature: "health() -> bool" }],
  },
  requires: [],
  composition: null,
  children: [],
  attempt: 1,
  feedback: null,
  dependency_layer: dependencyLayer,
  resource_bindings: [
    {
      resource_id: "primary-db",
      kind: "postgresql",
      alias: "primary-db",
      permissions: ["read", "write"],
      environment: { DATABASE_HANDLE: "secret-handle-database" },
      secret_handles: ["secret-handle-database"],
    },
  ],
  integration_bindings: [],
  secret_handles: ["secret-handle-database"],
};
const test: TestRequestV2 = {
  ...context,
  job_id: "run-v2:service:test:1",
  resource_policy: { ...context.resource_policy, network: "none" },
  node_id: "service",
  language: "python",
  workspace,
  write_target: "src/service.py",
  provides: build.provides,
  acceptance: {
    mandate_owner: "spec",
    language: "python",
    cases: [{ name: "healthy", call: "health()", expect: true }],
  },
  deps: [],
  dependency_layer: dependencyLayer,
  test_environment: null,
  migration_phase: "not_required",
};

let failures = 0;
function accept(label: string, operation: () => unknown): void {
  try {
    operation();
    console.log(`OK  ${label}`);
  } catch (error) {
    failures++;
    console.error(`BAD ${label}: ${String(error)}`);
  }
}
function reject(label: string, operation: () => unknown): void {
  try {
    operation();
    failures++;
    console.error(`BAD ${label}: accepted`);
  } catch (error) {
    const passed = error instanceof RequestError;
    if (!passed) failures++;
    console.log(`${passed ? "OK " : "BAD"} ${label}`);
  }
}

accept("accepts a dependency-bound v2 build", () =>
  validateBuildRequest(build, workspace),
);
accept("accepts a network-free v2 unit test", () =>
  validateTestRequest(test, workspace),
);
accept("accepts a private integration test environment", () =>
  validateTestRequest(
    {
      ...test,
      resource_policy: {
        ...test.resource_policy,
        network: "private-integration",
      },
      migration_phase: "verified",
      test_environment: {
        environment_id: "environment-run-v2",
        network_id: "network-run-v2",
        snapshot_digest: digest("e"),
        resources: build.resource_bindings,
        integrations: [],
      },
    },
    workspace,
  ),
);
reject("rejects an unverified dependency-layer digest", () =>
  validateBuildRequest(
    { ...build, dependency_layer: { ...dependencyLayer, sha256: "latest" } },
    workspace,
  ),
);
reject("rejects a secret value in a resource environment map", () =>
  validateBuildRequest(
    {
      ...build,
      resource_bindings: [
        {
          ...build.resource_bindings[0],
          environment: { DATABASE_URL: "postgres://owner:password@example/db" },
        },
      ],
    },
    workspace,
  ),
);
reject("rejects private networking without an environment", () =>
  validateTestRequest(
    {
      ...test,
      resource_policy: {
        ...test.resource_policy,
        network: "private-integration",
      },
    },
    workspace,
  ),
);
reject("keeps protocol v1 strict against v2 fields", () =>
  validateBuildRequest({ ...build, protocol_version: 1 }, workspace),
);

rmSync(workspace, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;

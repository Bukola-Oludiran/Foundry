import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRequestV2, TestResultV2 } from "../src/contract.ts";
import {
  HttpProjectRunner,
  verifyProjectTestResult,
} from "../src/project-runner.ts";
import { RequestError } from "../src/validation.ts";

const digest = (character: string): string => character.repeat(64);
const workspace = mkdtempSync(join(tmpdir(), "foundry-project-runner-"));
mkdirSync(join(workspace, "src"));
writeFileSync(
  join(workspace, "src/api.py"),
  "def health():\n    return True\n",
);
const request: TestRequestV2 = {
  protocol_version: 2,
  job_id: "run-1:api:test:1",
  run_id: "run-1",
  ir_digest: digest("a"),
  semantic_digest: digest("b"),
  base_commit: digest("c"),
  resource_policy: {
    timeout_ms: 30_000,
    memory_mb: 512,
    cpu_count: 1,
    pids: 64,
    network: "private-integration",
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
  dependency_layer: {
    artifact_id: "dependency-layer",
    sha256: digest("d"),
    package_root: "api-root",
    manifest_path: "requirements.txt",
    lockfile_path: "requirements.lock",
    resolver_image: `resolver@sha256:${digest("e")}`,
    platform: "linux/amd64",
  },
  test_environment: {
    environment_id: "environment-1",
    network_id: "network-1",
    snapshot_digest: digest("f"),
    resources: [],
    integrations: [],
  },
  migration_phase: "verified",
};
const result: TestResultV2 = {
  protocol_version: 2,
  job_id: request.job_id,
  run_id: request.run_id,
  dependency_layer_sha256: request.dependency_layer!.sha256,
  environment_snapshot_digest: request.test_environment!.snapshot_digest,
  node_id: request.node_id,
  verdict: "green",
  passed: 1,
  failed: 0,
  failures: [],
  case_results: [{ name: "healthy", status: "passed", failure: null }],
  failure_code: null,
  implementation_evidence: {
    evidence_version: 1,
    node_id: request.node_id,
    build_run_id: request.run_id,
    proposal_id: null,
    revision_id: null,
    semantic_digest: request.semantic_digest!,
    base_commit: request.base_commit,
    attempt: 1,
    language: request.language,
    source_snapshot_digest: digest("1"),
    source_files: [{ path: "src/api.py", sha256: digest("1") }],
    symbols: [],
    contract_mappings: [],
    case_results: [{ name: "healthy", status: "passed", failure: null }],
    measurements: { duration_ms: 10, memory_mb: 24 },
    completeness: "complete",
    diagnostics: [],
    created_at_ms: 1,
  },
  measurements: { duration_ms: 10, memory_mb: 24 },
  artifact: {
    sha256: digest("2"),
    size: 100,
    media_type: "application/vnd.foundry.test-result+json",
  },
  piston: { code: 0, signal: null, stdout: "", stderr: "" },
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
async function acceptAsync(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
    console.log(`OK  ${label}`);
  } catch (error) {
    failures++;
    console.error(`BAD ${label}: ${String(error)}`);
  }
}

accept("accepts exact project evidence", () =>
  verifyProjectTestResult(request, result),
);
reject("rejects a mismatched dependency layer", () =>
  verifyProjectTestResult(request, {
    ...result,
    dependency_layer_sha256: digest("9"),
  }),
);
reject("rejects sensitive raw runner output", () =>
  verifyProjectTestResult(request, {
    ...result,
    piston: {
      ...result.piston,
      stderr: "Authorization: Bearer exposed-secret",
    },
  }),
);
reject("rejects an absolute source evidence path", () =>
  verifyProjectTestResult(request, {
    ...result,
    implementation_evidence: {
      ...result.implementation_evidence,
      source_files: [{ path: "/private/worker/api.py", sha256: digest("1") }],
    },
  }),
);
reject("rejects incomplete named-case evidence", () =>
  verifyProjectTestResult(request, { ...result, case_results: [] }),
);

const calls: Array<{ authorization: string | null; url: string }> = [];
const fetcher = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = String(input);
  calls.push({
    authorization: new Headers(init?.headers).get("authorization"),
    url,
  });
  return new Response(
    JSON.stringify(url.endsWith("/ready") ? { ready: true } : result),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;
const runner = new HttpProjectRunner({
  baseUrl: "http://127.0.0.1:9091/",
  token: "project-runner-token-at-least-32-characters",
  fetcher,
});
await acceptAsync("checks authenticated OCI runner readiness", async () => {
  if (!(await runner.readiness()).ready) throw new Error("runner not ready");
});
await acceptAsync("dispatches an authenticated project test", async () => {
  verifyProjectTestResult(
    request,
    await runner.test(request, new AbortController().signal),
  );
  if (
    calls.length !== 2 ||
    calls.some(
      (call) =>
        call.authorization !==
        "Bearer project-runner-token-at-least-32-characters",
    )
  ) {
    throw new Error("runner authentication was not preserved");
  }
});

rmSync(workspace, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRequestV2 } from "../src/contract.ts";
import type { ProcessResult, ProcessRunner } from "../src/process-runner.ts";
import { OciProjectRunnerService } from "../src/runtime/project-runner-service.ts";

const root = mkdtempSync(join(tmpdir(), "foundry-project-runner-service-"));
const workspace = join(root, "workspace");
const jobs = join(root, "jobs");
const dependencies = join(root, "dependencies");
const artifacts = join(root, "artifacts");
mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(jobs);
mkdirSync(dependencies);
mkdirSync(artifacts);
writeFileSync(
  join(workspace, "src", "api.py"),
  "def health():\n    return True\n",
);
const calls: string[][] = [];
class FakeDocker implements ProcessRunner {
  async run(command: string, args: string[]): Promise<ProcessResult> {
    if (command !== "docker") throw new Error("unexpected command");
    calls.push(args);
    return {
      code: 0,
      signal: null,
      stdout:
        args[0] === "version"
          ? "27.5.1\n"
          : '__FOUNDRY_VERDICT__{"passed":1,"failed":0,"failures":[]}\n',
      stderr: "",
      timedOut: false,
    };
  }
}
const digest = (value: string) => value.repeat(64);
const request: TestRequestV2 = {
  protocol_version: 2,
  job_id: "run:api:test:1",
  run_id: "run-one",
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
  dependency_layer: null,
  test_environment: {
    environment_id: "environment-one",
    network_id: "foundry-network-one",
    snapshot_digest: digest("d"),
    resources: [],
    integrations: [],
  },
  migration_phase: "not_required",
};
let failures = 0;
const check = (condition: unknown, label: string) => {
  console.log(`${condition ? "OK " : "BAD"} ${label}`);
  if (!condition) failures++;
};
try {
  const service = new OciProjectRunnerService({
    jobDirectory: jobs,
    hostJobDirectory: jobs,
    dependencyArtifactDirectory: dependencies,
    resultArtifactDirectory: artifacts,
    runner: new FakeDocker(),
  });
  check((await service.readiness()).ready, "checks Docker runner readiness");
  const result = await service.test(request);
  check(
    result.verdict === "green" && result.passed === 1,
    "returns bound named-case evidence",
  );
  const invocation = calls.find((args) => args[0] === "run") ?? [];
  check(
    invocation.includes("--read-only") &&
      invocation.includes("--cap-drop") &&
      invocation.includes("no-new-privileges") &&
      !invocation.includes("--privileged"),
    "runs each test in a hardened fresh container",
  );
  const networkIndex = invocation.indexOf("--network");
  check(
    invocation[networkIndex + 1] === request.test_environment!.network_id,
    "joins only the declared private environment network",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failures) process.exit(1);

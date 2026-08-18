import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult, ProcessRunner } from "../src/process-runner.ts";
import type { StartEnvironmentRequestV2 } from "../src/contract.ts";
import { DockerEnvironmentController } from "../src/runtime/environment-controller.ts";

const root = mkdtempSync(join(tmpdir(), "foundry-environment-controller-"));
const state = join(root, "state");
const artifacts = join(root, "artifacts");
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "migrations"), { recursive: true });
writeFileSync(
  join(workspace, "migrations", "001.sql"),
  "CREATE TABLE IF NOT EXISTS health (id integer primary key);\n",
);
const calls: Array<{ command: string; args: string[]; input?: string }> = [];

class FakeDocker implements ProcessRunner {
  async run(
    command: string,
    args: string[],
    options: { input?: string },
  ): Promise<ProcessResult> {
    calls.push({ command, args, input: options.input });
    if (args[0] === "version") return result(0, "27.5.1\n");
    if (args[0] === "inspect" && args.includes("--format"))
      return result(0, "true\n");
    if (
      args[0] === "inspect" ||
      (args[0] === "network" && args[1] === "inspect")
    ) {
      return result(1);
    }
    if (args[0] === "ps") return result(0, "");
    return result(0, "ok\n");
  }
}

const result = (code: number, stdout = ""): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
});
const digest = (value: string) => value.repeat(64);
const request: StartEnvironmentRequestV2 = {
  protocol_version: 2,
  job_id: "run:environment:start",
  run_id: "run-one",
  ir_digest: digest("a"),
  base_commit: digest("b"),
  resource_policy: {
    timeout_ms: 120_000,
    memory_mb: 1024,
    cpu_count: 1,
    pids: 128,
    network: "private-integration",
  },
  plan: {
    environment_plan_version: 1,
    ir_digest: digest("a"),
    plan_digest: digest("c"),
    network_egress: "none",
    resources: [
      {
        resource_id: "primary-db",
        kind: "postgresql",
        version: "17.2",
        private_alias: "primary-db",
        image_key: "postgresql",
        consumers: { api: ["read", "write", "admin"] },
      },
    ],
    integrations: [
      {
        integration_id: "payments",
        kind: "stripe",
        private_alias: "payments",
        operations: ["create-payment"],
        consumers: ["api"],
      },
    ],
    migrations: [
      {
        resource_id: "primary-db",
        owner_node: "api",
        migration_path: "migrations",
        require_repeatable: true,
      },
    ],
  },
  resource_images: {
    postgresql: `docker.io/library/postgres@sha256:${digest("d")}`,
  },
  emulator_image: `example.invalid/foundry-emulator@sha256:${digest("e")}`,
};

let failures = 0;
const check = (condition: unknown, message: string) => {
  if (!condition) {
    failures++;
    console.error(`BAD ${message}`);
  } else {
    console.log(`OK  ${message}`);
  }
};

try {
  const runner = new FakeDocker();
  const controller = new DockerEnvironmentController({
    stateDirectory: state,
    artifactDirectory: artifacts,
    workspaceRoot: workspace,
    runner,
  });
  const handle = await controller.start(request);
  check(handle.state === "ready", "starts a plan-bound environment");
  const networkCreate = calls.find(
    (call) => call.args[0] === "network" && call.args[1] === "create",
  );
  check(
    networkCreate?.args.includes("--internal"),
    "creates an internal-only Docker network",
  );
  const runs = calls.filter((call) => call.args[0] === "run");
  check(
    runs.length === 2 &&
      runs.every(
        (call) =>
          call.args.includes("--read-only") &&
          call.args.includes("--cap-drop") &&
          !call.args.includes("--publish") &&
          !call.args.includes("--privileged"),
      ),
    "starts only hardened unprivileged containers without published ports",
  );
  const persisted = readFileSync(
    join(state, `${handle.environment_id}.json`),
    "utf8",
  );
  const generatedPassword = runs
    .flatMap((call) => call.args)
    .find((argument) => argument.startsWith("POSTGRES_PASSWORD="))
    ?.slice("POSTGRES_PASSWORD=".length);
  check(
    Boolean(generatedPassword) && !persisted.includes(generatedPassword!),
    "persists no generated credential values",
  );
  const beforeRestart = calls.length;
  const restarted = new DockerEnvironmentController({
    stateDirectory: state,
    artifactDirectory: artifacts,
    workspaceRoot: workspace,
    runner,
  });
  const adopted = await restarted.start(request);
  check(
    adopted.environment_id === handle.environment_id &&
      calls.length === beforeRestart,
    "adopts an existing matching environment after restart",
  );
  const health = await restarted.health({
    protocol_version: 2,
    job_id: "run:environment:health",
    run_id: request.run_id,
    environment_id: handle.environment_id,
    plan_digest: request.plan.plan_digest,
  });
  check(health.healthy, "checks every declared container");
  const migration = await restarted.migrate({
    protocol_version: 2,
    job_id: "run:environment:migrations",
    run_id: request.run_id,
    environment_id: handle.environment_id,
    plan_digest: request.plan.plan_digest,
    workspace,
    migrations: request.plan.migrations,
  });
  check(
    migration.green &&
      calls.filter((call) => call.args[0] === "exec").length === 2,
    "applies and repeat-verifies PostgreSQL migrations",
  );
  const snapshot = restarted.snapshot({
    protocol_version: 2,
    job_id: "run:environment:snapshot",
    run_id: request.run_id,
    environment_id: handle.environment_id,
    plan_digest: request.plan.plan_digest,
  });
  check(
    /^[a-f0-9]{64}$/.test(snapshot.snapshot_digest),
    "creates content-addressed snapshot evidence",
  );
  const teardown = await restarted.teardown({
    protocol_version: 2,
    job_id: "run:environment:teardown",
    run_id: request.run_id,
    environment_id: handle.environment_id,
    plan_digest: request.plan.plan_digest,
  });
  check(
    teardown.cleanup_complete,
    "removes containers and the private network idempotently",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) process.exit(1);

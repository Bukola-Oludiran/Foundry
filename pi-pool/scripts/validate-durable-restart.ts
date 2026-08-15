import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sandboxAvailability } from "../src/sandbox.ts";

const available = sandboxAvailability();
if (!available.available) {
  console.log(`SKIP — sandbox unavailable (${available.reason})`);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "foundry-crash-matrix-"));
const host = resolve("../gr-host/target/debug/foundry-host");
const token = "durable-restart-token-0123456789abcdef";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady) =>
    server.listen(0, "127.0.0.1", resolveReady),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitReady(base: string, worker: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null)
      throw new Error(`worker exited ${worker.exitCode}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await delay(50);
  }
  throw new Error("worker did not become healthy");
}

mkdirSync(join(root, "src"), { recursive: true });
const irPath = join(root, "single.ir.json");
writeFileSync(
  irPath,
  JSON.stringify({
    ir_version: 1,
    spec: { name: "durable-restart", language: "python" },
    root: "value",
    nodes: [
      {
        id: "value",
        kind: "leaf",
        owner: null,
        provides: {
          name: "Value",
          operations: [{ name: "value", signature: "value() -> number" }],
        },
        requires: [],
        implementation: { language: "python", write_target: "src/value.py" },
        acceptance: {
          mandate_owner: "spec",
          language: "python",
          cases: [{ name: "returns value", call: "value()", expect: 42 }],
        },
      },
    ],
  }),
);
const fixture = join(root, "impl.json");
writeFileSync(
  fixture,
  JSON.stringify({ value: "```python\ndef value():\n    return 42\n```" }),
);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const worker = spawn(process.execPath, [resolve("src/server.ts")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PORT: String(port),
    FOUNDRY_STUB_IMPLS: fixture,
    FOUNDRY_WORKER_TOKEN: token,
    FOUNDRY_WORKSPACE_ROOT: root,
    FOUNDRY_WORKER_STATE_DIR: join(root, "worker-state"),
    FOUNDRY_ALLOW_LOCAL_TESTER: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitReady(base, worker);
  for (const point of [
    "after_activation",
    "before_effect_dispatch",
    "after_effect_dispatch",
    "after_effect_result_application",
    "before_terminal_snapshot",
  ]) {
    const persistence = join(root, `persistence-${point}`);
    const marker = join(root, `marker-${point}`);
    const args = [
      "build",
      "--ir",
      irPath,
      "--pi-pool",
      base,
      "--workspace",
      root,
      "--base",
      `fixture-${point}`,
      "--durability",
      "local",
      "--durability-dir",
      persistence,
    ];
    const env = {
      ...process.env,
      FOUNDRY_WORKER_TOKEN: token,
      FOUNDRY_CRASH_AT: point,
      FOUNDRY_CRASH_MARKER: marker,
    };
    const crashed = spawnSync(host, args, { env, encoding: "utf8" });
    if (crashed.status !== 86) {
      throw new Error(
        `${point}: expected crash 86, got ${crashed.status}\n${crashed.stderr}`,
      );
    }
    const recovered = spawnSync(host, args, { env, encoding: "utf8" });
    if (recovered.status !== 0) {
      throw new Error(
        `${point}: recovery failed\n${recovered.stdout}\n${recovered.stderr}`,
      );
    }
    console.log(`GREEN crash/restart at ${point}`);
  }
} finally {
  worker.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

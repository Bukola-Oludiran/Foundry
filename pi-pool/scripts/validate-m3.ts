import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "../..");
const POOL = join(ROOT, "pi-pool");
const HOST = join(ROOT, "gr-host/target/debug/foundry-host");
const IR = join(ROOT, "ir/examples/string-utils.ir.json");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate port");
  await new Promise<void>((ok) => server.close(() => ok()));
  return address.port;
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Worker is still starting.
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`worker on port ${port} did not become healthy`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((ok) => child.once("exit", () => ok()));
}

async function scenario(fixture: string, expectGreen: boolean): Promise<string> {
  const port = await freePort();
  const workspace = mkdtempSync(join(tmpdir(), "foundry-m3-validation-"));
  const worker = spawn("node", ["src/server.ts"], {
    cwd: POOL,
    env: {
      ...process.env,
      PORT: String(port),
      FOUNDRY_STUB_IMPLS: `./fixtures/${fixture}`,
      FOUNDRY_LLM_PROVIDER: "",
      FOUNDRY_LLM_MODEL: "",
      FOUNDRY_TESTER: "piston",
      PISTON_URL: process.env.PISTON_URL ?? "http://127.0.0.1:2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHealth(port);
    const host = spawnSync(
      HOST,
      [
        "--ir",
        IR,
        "--pi-pool",
        `http://127.0.0.1:${port}`,
        "--workspace",
        workspace,
      ],
      { cwd: ROOT, encoding: "utf-8" },
    );
    const output = `${host.stdout ?? ""}${host.stderr ?? ""}`;
    const expectedStatus = expectGreen ? 0 : 1;
    if (host.status !== expectedStatus) {
      throw new Error(`host exited ${host.status}, expected ${expectedStatus}\n${output}`);
    }
    return output;
  } finally {
    await stop(worker);
    rmSync(workspace, { recursive: true, force: true });
  }
}

const build = spawnSync("cargo", ["build", "--manifest-path", "gr-host/Cargo.toml", "-p", "foundry-host"], {
  cwd: ROOT,
  encoding: "utf-8",
});
if (build.status !== 0) throw new Error(`${build.stdout}\n${build.stderr}`);

const runtimes = await fetch(`${process.env.PISTON_URL ?? "http://127.0.0.1:2000"}/api/v2/runtimes`);
if (!runtimes.ok) throw new Error("Piston is not reachable");

const green = await scenario("string-utils-impls-flaky.mjs", true);
for (const expected of [
  "supervision: 2 managers govern 4 dyads",
  "observed completion order: lowercase → trim → hyphenate → string-utils",
  "tester feedback supplied to doer",
  "Foundry M3: supervised dyads + message-gated bottom-up build",
]) {
  if (!green.includes(expected)) throw new Error(`green scenario missing: ${expected}\n${green}`);
}

const red = await scenario("string-utils-impls-buggy.mjs", false);
for (const expected of [
  "BLOCKED string-utils",
  "manager string-utils owns failure hyphenate",
  "supervisor Deferred: hyphenate",
]) {
  if (!red.includes(expected)) throw new Error(`red scenario missing: ${expected}\n${red}`);
}

console.log("✅ M3 validated: supervised ownership, message gating, feedback repair, and parked red failure");

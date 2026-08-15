import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContext } from "./context.ts";
import type { TestRequest } from "../src/contract.ts";
import { StubLlm } from "../src/llm.ts";
import { createFoundryServer } from "../src/server.ts";

const root = mkdtempSync(join(tmpdir(), "foundry-worker-restart-"));
const workspace = join(root, "workspace");
const state = join(root, "idempotency");
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "src/value.py"), "def value():\n    return 42\n");

const request: TestRequest = {
  ...fixtureContext("restart:test:1", "none"),
  node_id: "value",
  language: "python",
  workspace,
  write_target: "src/value.py",
  provides: {
    name: "Value",
    operations: [{ name: "value", signature: "value() -> number" }],
  },
  acceptance: {
    mandate_owner: "spec",
    language: "python",
    cases: [{ name: "value", call: "value()", expect: 42 }],
  },
  deps: [],
};

async function serve(): Promise<{
  base: string;
  close: () => Promise<void>;
} | null> {
  const server = createFoundryServer({
    llm: new StubLlm(() => ""),
    authToken: "restart-secret",
    workspaceRoot: workspace,
    idempotencyDir: state,
  });
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") resolve(false);
      else reject(error);
    });
    server.listen(0, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return null;
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/test`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer restart-secret",
    },
    body: JSON.stringify(body),
  });
}

try {
  const first = await serve();
  if (!first) {
    console.log("SKIP — this host forbids loopback listeners");
    process.exit(0);
  }
  const initial = await post(first.base, request);
  if (initial.status !== 200)
    throw new Error(`initial status ${initial.status}`);
  const original = await initial.text();
  await first.close();

  const restarted = await serve();
  if (!restarted) throw new Error("worker could not restart");
  try {
    const replay = await post(restarted.base, request);
    const replayBody = await replay.text();
    if (replay.status !== 200 || replayBody !== original) {
      throw new Error("completed job was not replayed after worker restart");
    }
    const conflict = await post(restarted.base, {
      ...request,
      acceptance: {
        ...request.acceptance,
        cases: [{ name: "changed", call: "value()", expect: 7 }],
      },
    });
    if (conflict.status !== 409) {
      throw new Error(`restart conflict status ${conflict.status}`);
    }
  } finally {
    await restarted.close();
  }
  console.log("OK durable worker idempotency survives restart");
} finally {
  rmSync(root, { recursive: true, force: true });
}

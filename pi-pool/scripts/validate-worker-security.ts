import { createFoundryServer } from "../src/server.ts";
import { StubLlm } from "../src/llm.ts";
import type { TestRequest, TestRequestV2 } from "../src/contract.ts";
import { fixtureContext } from "./context.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const workspace = mkdtempSync(join(tmpdir(), "foundry-security-"));
mkdirSync(join(workspace, "src"));
writeFileSync(
  join(workspace, "src/doubler.py"),
  "def double(value):\n    return value * 2\n",
);

const request: TestRequest = {
  ...fixtureContext("security:test:1", "none"),
  node_id: "doubler",
  language: "python",
  workspace,
  write_target: "src/doubler.py",
  provides: {
    name: "Doubler",
    operations: [{ name: "double", signature: "double(value) -> number" }],
  },
  acceptance: {
    mandate_owner: "spec",
    language: "python",
    cases: [{ name: "double", call: "double(21)", expect: 42 }],
  },
  deps: [],
};
const v2Request: TestRequestV2 = {
  ...request,
  protocol_version: 2,
  job_id: "security:test:v2",
  dependency_layer: null,
  test_environment: null,
  migration_phase: "not_required",
};

const server = createFoundryServer({
  llm: new StubLlm(() => ""),
  authToken: "test-secret",
  workspaceRoot: workspace,
  maxBodyBytes: 4096,
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

async function post(
  body: unknown,
  token = "test-secret",
  path = "/test",
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

let failures = 0;
async function expect(
  label: string,
  wanted: number,
  action: () => Promise<Response>,
): Promise<void> {
  const response = await action();
  const ok = response.status === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "OK " : "BAD"} ${label}: ${response.status}`);
  await response.text();
}

try {
  await expect("rejects invalid token", 401, () => post(request, "wrong"));
  await expect("rejects unknown field", 400, () =>
    post({ ...request, surprise: true }),
  );
  await expect("rejects traversal", 400, () =>
    post({ ...request, write_target: "../escape.py" }),
  );
  await expect("accepts authenticated request", 200, () => post(request));
  await expect("rejects v2 test fallback without OCI project runner", 503, () =>
    post(v2Request),
  );
  await expect("replays identical job", 200, () => post(request));
  await expect("rejects changed idempotent job", 409, () =>
    post({
      ...request,
      acceptance: {
        ...request.acceptance,
        cases: [{ name: "changed", call: "double(1)", expect: 2 }],
      },
    }),
  );
  await expect("rejects oversized body", 413, () =>
    post({ ...request, padding: "x".repeat(5000) }),
  );
  await expect("accepts cooperative cancellation", 202, () =>
    post({ effect_id: "cancelled-job" }, "test-secret", "/cancel"),
  );
  await expect("rejects a cancelled job", 409, () =>
    post({ ...request, job_id: "cancelled-job" }),
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
}

process.exitCode = failures === 0 ? 0 : 1;

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string")
      return reject(new Error("no port"));
    const selected = address.port;
    server.close((error) => (error ? reject(error) : resolve(selected)));
  });
});
const child = spawn(process.execPath, ["src/runtime/integration-emulator.ts"], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    PATH: process.env.PATH ?? "",
    PORT: String(port),
    FOUNDRY_INTEGRATION_ID: "payments",
    FOUNDRY_INTEGRATION_KIND: "stripe",
    FOUNDRY_INTEGRATION_OPERATIONS: JSON.stringify(["create-payment"]),
    FOUNDRY_INTEGRATION_EXPECTATIONS: JSON.stringify([
      {
        node: "api",
        integration_id: "payments",
        operation: "create-payment",
        request: { amount: 1000 },
        response: { status: "accepted" },
      },
    ]),
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));
const base = `http://127.0.0.1:${port}`;

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      ready = (await fetch(`${base}/ready`)).ok;
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!ready) throw new Error(`emulator did not start: ${stderr}`);
  const accepted = await fetch(`${base}/v1/payment_intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-foundry-operation": "create-payment",
    },
    body: JSON.stringify({ amount: 1000 }),
  });
  if (
    !accepted.ok ||
    ((await accepted.json()) as { status?: string }).status !== "accepted"
  ) {
    throw new Error(
      "declared contract did not return its deterministic response",
    );
  }
  console.log("OK  serves the exact declared contract response");
  const mismatch = await fetch(`${base}/v1/payment_intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-foundry-operation": "create-payment",
    },
    body: JSON.stringify({ amount: 999 }),
  });
  if (mismatch.status !== 422)
    throw new Error("mismatched request was accepted");
  console.log("OK  rejects and records an undeclared request shape");
  const evidence = (await fetch(`${base}/__foundry/evidence`).then((response) =>
    response.json(),
  )) as {
    unexpected_requests: number;
    contracts: Array<{ observed_count: number; matched: boolean }>;
  };
  if (
    evidence.unexpected_requests !== 1 ||
    evidence.contracts[0]?.observed_count !== 1 ||
    !evidence.contracts[0]?.matched
  ) {
    throw new Error("contract evidence counters are incorrect");
  }
  console.log("OK  exposes only hashed bounded interaction evidence");
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

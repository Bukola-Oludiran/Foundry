import { createHash } from "node:crypto";
import { createServer } from "node:http";

const integrationId = process.env.FOUNDRY_INTEGRATION_ID ?? "integration";
const kind = process.env.FOUNDRY_INTEGRATION_KIND ?? "http";
const operations = JSON.parse(
  process.env.FOUNDRY_INTEGRATION_OPERATIONS ?? "[]",
) as unknown;
if (
  !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(integrationId) ||
  !["http", "webhook", "stripe", "openai"].includes(kind) ||
  !Array.isArray(operations) ||
  operations.some((operation) => typeof operation !== "string")
) {
  throw new Error("invalid integration emulator configuration");
}
const allowed = new Set(operations as string[]);
const port = Number(process.env.PORT ?? 8080);

const reply = (
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
) => {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(bytes);
};

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ready") {
    return reply(response, 200, {
      ready: true,
      integration_id: integrationId,
      kind,
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 256 * 1024)
      return reply(response, 413, { code: "BODY_TOO_LARGE" });
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks);
  const requestDigest = createHash("sha256").update(raw).digest("hex");
  const operation = request.headers["x-foundry-operation"];
  if (typeof operation === "string" && !allowed.has(operation)) {
    return reply(response, 422, { code: "UNDECLARED_OPERATION" });
  }
  if (kind === "openai" && request.url === "/v1/chat/completions") {
    return reply(response, 200, {
      id: `chatcmpl_${requestDigest.slice(0, 24)}`,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "deterministic response" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  }
  if (kind === "stripe" && request.url?.startsWith("/v1/payment_intents")) {
    return reply(response, 200, {
      id: `pi_${requestDigest.slice(0, 24)}`,
      object: "payment_intent",
      status: "succeeded",
      livemode: false,
    });
  }
  return reply(response, 200, {
    integration_id: integrationId,
    kind,
    operation: typeof operation === "string" ? operation : null,
    request_digest: requestDigest,
    accepted: true,
  });
}).listen(port, "0.0.0.0");

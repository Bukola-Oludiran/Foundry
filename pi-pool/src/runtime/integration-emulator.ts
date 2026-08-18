import { createHash } from "node:crypto";
import { createServer } from "node:http";

const integrationId = process.env.FOUNDRY_INTEGRATION_ID ?? "integration";
const kind = process.env.FOUNDRY_INTEGRATION_KIND ?? "http";
const operations = JSON.parse(
  process.env.FOUNDRY_INTEGRATION_OPERATIONS ?? "[]",
) as unknown;
const expectations = JSON.parse(
  process.env.FOUNDRY_INTEGRATION_EXPECTATIONS ?? "[]",
) as unknown;
if (
  !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(integrationId) ||
  !["http", "webhook", "stripe", "openai"].includes(kind) ||
  !Array.isArray(operations) ||
  operations.some((operation) => typeof operation !== "string") ||
  !Array.isArray(expectations) ||
  expectations.length > 1024 ||
  expectations.some((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return true;
    const value = candidate as Record<string, unknown>;
    return (
      Object.keys(value).some(
        (key) =>
          ![
            "node",
            "integration_id",
            "operation",
            "request",
            "response",
          ].includes(key),
      ) ||
      typeof value.node !== "string" ||
      value.integration_id !== integrationId ||
      typeof value.operation !== "string" ||
      !(operations as string[]).includes(value.operation) ||
      JSON.stringify(value).length > 64 * 1024 ||
      /authorization|bearer |cookie|password|private[_ -]?key|nsec1|ghp_|github_pat_/i.test(
        JSON.stringify(value),
      )
    );
  })
) {
  throw new Error("invalid integration emulator configuration");
}
const allowed = new Set(operations as string[]);
const port = Number(process.env.PORT ?? 8080);
type Expectation = {
  node: string;
  integration_id: string;
  operation: string;
  request: unknown;
  response: unknown;
};
const contracts = (expectations as Expectation[]).map((expectation) => ({
  ...expectation,
  observed_count: 0,
}));
let unexpectedRequests = 0;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

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
  if (request.method === "GET" && request.url === "/__foundry/evidence") {
    return reply(response, 200, {
      integration_id: integrationId,
      unexpected_requests: unexpectedRequests,
      contracts: contracts.map((contract) => ({
        node: contract.node,
        integration_id: contract.integration_id,
        operation: contract.operation,
        request_sha256: sha256(contract.request),
        response_sha256: sha256(contract.response),
        observed_count: contract.observed_count,
        matched: contract.observed_count > 0,
        diagnostic:
          contract.observed_count > 0
            ? null
            : "declared interaction was not observed",
      })),
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
  if (typeof operation !== "string" || !allowed.has(operation)) {
    return reply(response, 422, { code: "UNDECLARED_OPERATION" });
  }
  let parsed: unknown = null;
  try {
    parsed =
      raw.length === 0 ? null : (JSON.parse(raw.toString("utf8")) as unknown);
  } catch {
    return reply(response, 400, { code: "INVALID_JSON" });
  }
  const contract = contracts.find(
    (candidate) =>
      candidate.operation === operation &&
      canonical(candidate.request) === canonical(parsed),
  );
  if (contract) {
    contract.observed_count++;
    return reply(response, 200, contract.response);
  }
  if (contracts.some((candidate) => candidate.operation === operation)) {
    unexpectedRequests++;
    return reply(response, 422, { code: "CONTRACT_REQUEST_MISMATCH" });
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

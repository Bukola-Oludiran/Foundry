import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import {
  validateApplyMigrationsRequest,
  validateEnvironmentActionRequest,
  validateStartEnvironmentRequest,
} from "../validation.ts";
import { DockerEnvironmentController } from "./environment-controller.ts";

const token = process.env.FOUNDRY_ENVIRONMENT_CONTROLLER_TOKEN ?? "";
if (token.length < 32 || /[\r\n]/.test(token)) {
  throw new Error(
    "FOUNDRY_ENVIRONMENT_CONTROLLER_TOKEN must contain at least 32 safe characters",
  );
}
const workspaceRoot = resolve(
  process.env.FOUNDRY_WORKSPACE_ROOT ?? "/workspaces",
);
const controller = new DockerEnvironmentController({
  stateDirectory: resolve(
    process.env.FOUNDRY_CONTROLLER_STATE_DIR ?? "/var/lib/foundry/state",
  ),
  artifactDirectory: resolve(
    process.env.FOUNDRY_CONTROLLER_ARTIFACT_DIR ?? "/var/lib/foundry/artifacts",
  ),
  workspaceRoot,
});
const port = Number(process.env.PORT ?? 8080);

function authorized(request: IncomingMessage): boolean {
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(token);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

createServer(async (request, response) => {
  try {
    if (!authorized(request))
      return send(response, 401, { code: "UNAUTHORIZED" });
    if (request.method === "GET" && request.url === "/ready") {
      const readiness = await controller.readiness();
      return send(response, readiness.ready ? 200 : 503, readiness);
    }
    if (request.method !== "POST")
      return send(response, 404, { code: "NOT_FOUND" });
    const raw = await body(request);
    const signal = AbortSignal.timeout(300_000);
    if (request.url === "/v1/environments/start") {
      return send(
        response,
        200,
        await controller.start(validateStartEnvironmentRequest(raw), signal),
      );
    }
    if (request.url === "/v1/environments/health") {
      return send(
        response,
        200,
        await controller.health(validateEnvironmentActionRequest(raw), signal),
      );
    }
    if (request.url === "/v1/environments/migrations") {
      return send(
        response,
        200,
        await controller.migrate(
          validateApplyMigrationsRequest(raw, workspaceRoot),
          signal,
        ),
      );
    }
    if (request.url === "/v1/environments/snapshot") {
      return send(
        response,
        200,
        controller.snapshot(validateEnvironmentActionRequest(raw)),
      );
    }
    if (request.url === "/v1/environments/teardown") {
      return send(
        response,
        200,
        await controller.teardown(
          validateEnvironmentActionRequest(raw),
          signal,
        ),
      );
    }
    return send(response, 404, { code: "NOT_FOUND" });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "CONTROLLER_OPERATION_FAILED";
    send(response, 422, { code });
  }
}).listen(port, "0.0.0.0");

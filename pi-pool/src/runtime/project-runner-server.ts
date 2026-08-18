import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import type { TestRequestV2 } from "../contract.ts";
import { validateTestRequest } from "../validation.ts";
import { OciProjectRunnerService } from "./project-runner-service.ts";

const token = process.env.FOUNDRY_PROJECT_RUNNER_TOKEN ?? "";
if (token.length < 32 || /[\r\n]/.test(token)) {
  throw new Error(
    "FOUNDRY_PROJECT_RUNNER_TOKEN must contain at least 32 safe characters",
  );
}
const workspaceRoot = resolve(
  process.env.FOUNDRY_WORKSPACE_ROOT ?? "/workspaces",
);
const service = new OciProjectRunnerService({
  jobDirectory: resolve(
    process.env.FOUNDRY_RUNNER_JOB_DIR ?? "/var/lib/foundry/jobs",
  ),
  hostJobDirectory: resolve(
    process.env.FOUNDRY_RUNNER_HOST_JOB_DIR ?? "/var/lib/foundry/jobs",
  ),
  dependencyArtifactDirectory: resolve(
    process.env.FOUNDRY_DEPENDENCY_ARTIFACT_DIR ??
      "/var/lib/foundry/dependencies",
  ),
  resultArtifactDirectory: resolve(
    process.env.FOUNDRY_RUNNER_ARTIFACT_DIR ?? "/var/lib/foundry/results",
  ),
});

const authorized = (request: IncomingMessage): boolean => {
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(token);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
};
const send = (response: ServerResponse, status: number, value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(bytes);
};
const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("request body is oversized");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

createServer(async (request, response) => {
  try {
    if (!authorized(request))
      return send(response, 401, { code: "UNAUTHORIZED" });
    if (request.method === "GET" && request.url === "/ready") {
      const readiness = await service.readiness();
      return send(response, readiness.ready ? 200 : 503, readiness);
    }
    if (request.method === "POST" && request.url === "/v2/tests/run") {
      const candidate = validateTestRequest(await body(request), workspaceRoot);
      if (candidate.protocol_version !== 2)
        throw new Error("protocol v2 is required");
      return send(
        response,
        200,
        await service.test(
          candidate as TestRequestV2,
          AbortSignal.timeout(300_000),
        ),
      );
    }
    return send(response, 404, { code: "NOT_FOUND" });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "PROJECT_RUNNER_FAILED";
    return send(response, 422, { code });
  }
}).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");

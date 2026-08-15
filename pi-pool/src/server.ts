// pi-pool HTTP server — the data-plane endpoint the GraphReact host drives.
//   POST /build  → doer (LLM → sandboxed write)      → BuildResult
//   POST /test   → tester (runner → python3/Piston)  → TestResult
//   GET  /health → { ok: true }
// The LLM is injected: StubLlm for now (fixture-driven), pi-ai at M5.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { buildNode } from "./doer.ts";
import { executeTest, type TesterConfig } from "./tester.ts";
import { StubLlm, PiAiLlm, type LlmClient } from "./llm.ts";
import {
  validateBuildRequest,
  validateTestRequest,
  RequestError,
} from "./validation.ts";
import { sandboxAvailability } from "./sandbox.ts";

function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge)
        return reject(
          new RequestError(
            413,
            "BODY_TOO_LARGE",
            `request exceeds ${maxBytes} bytes`,
          ),
        );
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(
          new RequestError(400, "INVALID_JSON", String((e as Error).message)),
        );
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  // Set Content-Length so the response is NOT chunked (keeps the host's minimal HTTP
  // client — read-to-EOF + parse body — simple and robust).
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(s);
}

export interface FoundryServerOptions {
  llm: LlmClient;
  tester?: TesterConfig;
  authToken?: string;
  allowUnauthenticated?: boolean;
  maxBodyBytes?: number;
  workspaceRoot?: string;
  requireSandbox?: boolean;
  idempotencyDir?: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestDigest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return (
    supplied.byteLength === wanted.byteLength &&
    timingSafeEqual(supplied, wanted)
  );
}

export function createFoundryServer(opts: FoundryServerOptions): Server {
  if (!opts.authToken && !opts.allowUnauthenticated) {
    throw new Error(
      "worker authentication is required unless allowUnauthenticated is explicitly enabled",
    );
  }
  const tester: TesterConfig = opts.tester ?? { mode: "local" };
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const idempotency = new Map<
    string,
    { digest: string; result: Promise<unknown> }
  >();
  const activeJobs = new Map<string, AbortController>();
  const cancelledJobs = new Set<string>();

  if (opts.idempotencyDir) mkdirSync(opts.idempotencyDir, { recursive: true });

  const recordPath = (key: string): string | undefined =>
    opts.idempotencyDir
      ? join(
          opts.idempotencyDir,
          `${createHash("sha256").update(key).digest("hex")}.json`,
        )
      : undefined;

  const loadRecord = (
    key: string,
  ): { digest: string; result: unknown } | undefined => {
    const path = recordPath(key);
    if (!path || !existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        version?: unknown;
        key?: unknown;
        digest?: unknown;
        result?: unknown;
      };
      if (
        parsed.version !== 1 ||
        parsed.key !== key ||
        typeof parsed.digest !== "string"
      ) {
        throw new Error("invalid idempotency record");
      }
      return { digest: parsed.digest, result: parsed.result };
    } catch (error) {
      throw new RequestError(
        500,
        "IDEMPOTENCY_STORE_CORRUPT",
        `cannot read durable job record: ${String((error as Error).message)}`,
      );
    }
  };

  const persistRecord = (
    key: string,
    digest: string,
    result: unknown,
  ): void => {
    const path = recordPath(key);
    if (!path) return;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const bytes = JSON.stringify({ version: 1, key, digest, result });
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, bytes, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing to clean up after a successful rename.
      }
      throw new RequestError(
        500,
        "IDEMPOTENCY_STORE_WRITE_FAILED",
        `cannot persist durable job result: ${String((error as Error).message)}`,
        true,
      );
    }
  };

  const once = (
    route: string,
    jobId: string,
    body: unknown,
    action: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> => {
    const key = `${route}:${jobId}`;
    const digest = requestDigest(body);
    const prior = idempotency.get(key);
    if (prior) {
      if (prior.digest !== digest) {
        throw new RequestError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "job_id was reused with different content",
        );
      }
      return prior.result;
    }
    const durable = loadRecord(key);
    if (durable) {
      if (durable.digest !== digest) {
        throw new RequestError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "job_id was reused with different content",
        );
      }
      const result = Promise.resolve(durable.result);
      idempotency.set(key, { digest, result });
      return result;
    }
    if (cancelledJobs.has(jobId)) {
      throw new RequestError(409, "JOB_CANCELLED", "job was cancelled");
    }
    const controller = new AbortController();
    activeJobs.set(jobId, controller);
    const result = action(controller.signal)
      .then((value) => {
        persistRecord(key, digest, value);
        return value;
      })
      .catch((error: unknown) => {
        idempotency.delete(key);
        throw error;
      })
      .finally(() => {
        activeJobs.delete(jobId);
      });
    if (idempotency.size >= 10_000) {
      const oldest = idempotency.keys().next().value;
      if (oldest) idempotency.delete(oldest);
    }
    idempotency.set(key, { digest, result });
    return result;
  };

  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health")
        return send(res, 200, { ok: true });
      if (req.method === "GET" && req.url === "/ready") {
        const sandbox = sandboxAvailability();
        const ready = !opts.requireSandbox || sandbox.available;
        return send(res, ready ? 200 : 503, {
          ready,
          authenticated: Boolean(opts.authToken),
          workspace_root: Boolean(opts.workspaceRoot),
          sandbox,
        });
      }
      if (
        !opts.allowUnauthenticated &&
        !tokenMatches(req.headers.authorization, opts.authToken ?? "")
      ) {
        throw new RequestError(
          401,
          "UNAUTHORIZED",
          "missing or invalid bearer token",
        );
      }
      if (req.method === "POST" && req.url === "/cancel") {
        const raw = await readJson(req, maxBodyBytes);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).some((key) => key !== "effect_id") ||
          typeof (raw as { effect_id?: unknown }).effect_id !== "string" ||
          !(raw as { effect_id: string }).effect_id.trim()
        ) {
          throw new RequestError(
            400,
            "INVALID_REQUEST",
            "cancel requires only a non-empty effect_id",
          );
        }
        const effectId = (raw as { effect_id: string }).effect_id;
        cancelledJobs.add(effectId);
        activeJobs.get(effectId)?.abort();
        return send(res, 202, { effect_id: effectId, cancelled: true });
      }
      if (req.method === "POST" && req.url === "/build") {
        const raw = await readJson(req, maxBodyBytes);
        const body = validateBuildRequest(raw, opts.workspaceRoot);
        return send(
          res,
          200,
          await once("build", body.job_id, raw, (signal) =>
            buildNode(body, opts.llm, undefined, signal),
          ),
        );
      }
      if (req.method === "POST" && req.url === "/test") {
        const raw = await readJson(req, maxBodyBytes);
        const body = validateTestRequest(raw, opts.workspaceRoot);
        return send(
          res,
          200,
          await once("test", body.job_id, raw, () => executeTest(body, tester)),
        );
      }
      throw new RequestError(404, "NOT_FOUND", "route not found");
    } catch (e) {
      const error =
        e instanceof RequestError
          ? e
          : new RequestError(
              500,
              "INTERNAL",
              String((e as Error)?.message ?? e),
              true,
            );
      return send(res, error.status, {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      });
    }
  });
}

// Run directly: `node src/server.ts`. FOUNDRY_STUB_IMPLS points at a {nodeId: code} JSON
// fixture (fenced or raw). Until a real provider is wired (M5), unmatched nodes get a stub.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void (async () => {
    const fixture = process.env.FOUNDRY_STUB_IMPLS;
    // A fixture value may be a string (same every attempt) or string[] (per-attempt,
    // clamped) — the latter lets the stub emit a buggy first draft then a fix on retry.
    let impls: Record<string, string | string[]> = {};
    if (fixture) {
      impls = fixture.endsWith(".json")
        ? (JSON.parse(readFileSync(fixture, "utf-8")) as Record<
            string,
            string | string[]
          >)
        : ((await import(pathToFileURL(fixture).href)).default as Record<
            string,
            string | string[]
          >);
    }
    const pick = (v: string | string[] | undefined, attempt: number): string =>
      Array.isArray(v)
        ? (v[Math.min(attempt - 1, v.length - 1)] ?? "# none\n")
        : (v ?? "# stub: no impl configured\n");
    // Live provider when FOUNDRY_LLM_PROVIDER + FOUNDRY_LLM_MODEL are set (M5); else stub.
    const provider = process.env.FOUNDRY_LLM_PROVIDER;
    const modelId = process.env.FOUNDRY_LLM_MODEL;
    const llm: LlmClient =
      provider && modelId
        ? new PiAiLlm({ provider, model: modelId })
        : new StubLlm((r) =>
            pick(
              impls[(r.meta?.node_id as string) ?? ""],
              (r.meta?.attempt as number) ?? 1,
            ),
          );
    const llmLabel = provider && modelId ? `${provider}/${modelId}` : "stub";
    const tester: TesterConfig =
      process.env.FOUNDRY_TESTER === "piston"
        ? {
            mode: "piston",
            pistonUrl: process.env.PISTON_URL ?? "http://127.0.0.1:2000",
          }
        : process.env.FOUNDRY_ALLOW_LOCAL_TESTER === "1"
          ? { mode: "local" }
          : (() => {
              throw new Error(
                "FOUNDRY_TESTER=piston is required unless FOUNDRY_ALLOW_LOCAL_TESTER=1",
              );
            })();
    const port = Number(process.env.PORT ?? 8787);
    const authToken = process.env.FOUNDRY_WORKER_TOKEN;
    const allowUnauthenticated =
      process.env.FOUNDRY_ALLOW_INSECURE_LOCAL === "1";
    const workspaceRoot = process.env.FOUNDRY_WORKSPACE_ROOT;
    const idempotencyDir = process.env.FOUNDRY_WORKER_STATE_DIR;
    if (!allowUnauthenticated && (!authToken || authToken.length < 32)) {
      throw new Error(
        "FOUNDRY_WORKER_TOKEN must contain at least 32 characters",
      );
    }
    if (!allowUnauthenticated && !workspaceRoot) {
      throw new Error("FOUNDRY_WORKSPACE_ROOT is required");
    }
    if (!allowUnauthenticated && !idempotencyDir) {
      throw new Error("FOUNDRY_WORKER_STATE_DIR is required");
    }
    createFoundryServer({
      llm,
      tester,
      authToken,
      allowUnauthenticated,
      workspaceRoot,
      requireSandbox: !allowUnauthenticated,
      idempotencyDir,
    }).listen(port, "127.0.0.1", () => {
      console.log(
        `[pi-pool] listening on :${port} — LLM=${llmLabel}, tester=${tester.mode}`,
      );
    });
  })();
}

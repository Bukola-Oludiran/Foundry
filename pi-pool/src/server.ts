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
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildNode } from "./doer.ts";
import { executeTest, type TesterConfig } from "./tester.ts";
import { StubLlm, PiAiLlm, type LlmClient } from "./llm.ts";
import type { BuildRequest, TestRequest } from "./contract.ts";

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
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
  });
  res.end(s);
}

export function createFoundryServer(opts: {
  llm: LlmClient;
  tester?: TesterConfig;
}): Server {
  const tester: TesterConfig = opts.tester ?? { mode: "local" };
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health")
        return send(res, 200, { ok: true });
      if (req.method === "POST" && req.url === "/build") {
        const body = (await readJson(req)) as BuildRequest;
        return send(res, 200, await buildNode(body, opts.llm));
      }
      if (req.method === "POST" && req.url === "/test") {
        const body = (await readJson(req)) as TestRequest;
        return send(res, 200, await executeTest(body, tester));
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: String((e as Error)?.message ?? e) });
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
        : { mode: "local" };
    const port = Number(process.env.PORT ?? 8787);
    createFoundryServer({ llm, tester }).listen(port, () => {
      console.log(
        `[pi-pool] listening on :${port} — LLM=${llmLabel}, tester=${tester.mode}`,
      );
    });
  })();
}

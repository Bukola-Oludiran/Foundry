// pi-pool HTTP server — the data-plane endpoint the GraphReact host drives.
//   POST /build  → doer (LLM → sandboxed write)      → BuildResult
//   POST /test   → tester (runner → python3/Piston)  → TestResult
//   GET  /health → { ok: true }
// The LLM is injected: StubLlm for now (fixture-driven), pi-ai at M5.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildNode } from "./doer.ts";
import { executeTest, type TesterConfig } from "./tester.ts";
import { applyAndTest } from "./apply.ts";
import { executeAssembly } from "./assembly.ts";
import { executeMutation } from "./mutation.ts";
import { applyAndTestProduct, assembleProduct, integrateProduct } from "./product.ts";
import { StubLlm, PiAiLlm, type LlmClient } from "./llm.ts";
import type { ApplyAndTestRequest, AssemblyRequest, BuildRequest, ProductApplyRequest, ProductAssemblyRequest, ProductIntegrationRequest, TestRequest } from "./contract.ts";

// Direct runs load Foundry/.env when present. Node preserves variables already supplied
// by the caller, so deployment-level environment always wins over local defaults.
try {
  loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

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
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

export function createFoundryServer(opts: { llm: LlmClient; tester?: TesterConfig }): Server {
  const tester: TesterConfig = opts.tester ?? { mode: "local" };
  let activeWork = 0, lastSuccessfulVerification: string | null = null;
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        let piston: any = { required: tester.mode === "piston", reachable: tester.mode !== "piston", runtimes: [] };
        if (tester.mode === "piston") { try { const response = await fetch(`${tester.pistonUrl ?? "http://127.0.0.1:2000"}/api/v2/runtimes`), runtimes = response.ok ? await response.json() as any[] : []; const names = runtimes.map((runtime) => `${runtime.language}:${runtime.version}`); piston = { required: true, reachable: response.ok, runtimes: names, productRuntimeReady: runtimes.some((runtime) => runtime.language === "foundry-product") }; } catch (error) { piston = { required: true, reachable: false, runtimes: [], productRuntimeReady: false, error: (error as Error).message }; } }
        return send(res, 200, { ok: true, ready: piston.reachable, productReady: piston.reachable && piston.productRuntimeReady === true, workerVersion: "0.2.0", testerMode: tester.mode === "piston" ? "piston" : "local-control", piston, activeWork, lastSuccessfulVerification });
      }
      if (req.method === "POST" && req.url === "/build") {
        const body = (await readJson(req)) as BuildRequest;
        return send(res, 200, await buildNode(body, opts.llm));
      }
      if (req.method === "POST" && req.url === "/test") {
        const body = (await readJson(req)) as TestRequest;
        return send(res, 200, await executeTest(body, tester));
      }
      if (req.method === "POST" && req.url === "/apply-and-test") {
        const body = (await readJson(req)) as ApplyAndTestRequest;
        activeWork++; try { const result = await applyAndTest(body, tester); if (result.verdict === "green") lastSuccessfulVerification = new Date().toISOString(); return send(res, 200, result); } finally { activeWork--; }
      }
      if (req.method === "POST" && req.url === "/assemble") {
        const body = (await readJson(req)) as AssemblyRequest;
        return send(res, 200, await executeAssembly(body, tester));
      }
      if (req.method === "POST" && req.url === "/mutation") return send(res, 200, await executeMutation(await readJson(req) as any, tester));
      if (req.method === "POST" && req.url === "/product/apply-and-test") { activeWork++; try { const result = await applyAndTestProduct(await readJson(req) as ProductApplyRequest, tester); if (result.verdict === "green") lastSuccessfulVerification = new Date().toISOString(); return send(res, 200, result); } finally { activeWork--; } }
      if (req.method === "POST" && req.url === "/product/integrate") { activeWork++; try { const result = await integrateProduct(await readJson(req) as ProductIntegrationRequest, tester); if (result.verdict === "green") lastSuccessfulVerification = new Date().toISOString(); return send(res, 200, result); } finally { activeWork--; } }
      if (req.method === "POST" && req.url === "/product/assemble") { activeWork++; try { return send(res, 200, await assembleProduct(await readJson(req) as ProductAssemblyRequest, tester)); } finally { activeWork--; } }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: String((e as Error)?.message ?? e) });
    }
  });
}

export async function createConfiguredFoundryServer(): Promise<Server> {
  const fixture = process.env.FOUNDRY_STUB_IMPLS;
  // A fixture value may be a string (same every attempt) or string[] (per-attempt,
  // clamped) — the latter lets the stub emit a buggy first draft then a fix on retry.
  let impls: Record<string, string | string[]> = {};
  if (fixture) {
    impls = fixture.endsWith(".json")
      ? (JSON.parse(readFileSync(fixture, "utf-8")) as Record<string, string | string[]>)
      : ((await import(pathToFileURL(fixture).href)).default as Record<string, string | string[]>);
  }
  const pick = (v: string | string[] | undefined, attempt: number): string =>
    Array.isArray(v) ? v[Math.min(attempt - 1, v.length - 1)] ?? "# none\n" : v ?? "# stub: no impl configured\n";
  // Live provider when FOUNDRY_LLM_PROVIDER + FOUNDRY_LLM_MODEL are set (M5); else stub.
  const provider = process.env.FOUNDRY_LLM_PROVIDER;
  const modelId = process.env.FOUNDRY_LLM_MODEL;
  const providerHasKey = provider === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY) : provider === "openai" ? Boolean(process.env.OPENAI_API_KEY) : Boolean(provider);
  const liveProvider = process.env.FOUNDRY_ENABLE_LEGACY_PROVIDER === "1" && Boolean(provider && modelId && providerHasKey);
  const llm: LlmClient = liveProvider ? new PiAiLlm({ provider: provider!, model: modelId! }) : new StubLlm((r) => pick(impls[(r.meta?.node_id as string) ?? ""], (r.meta?.attempt as number) ?? 1));
  const tester: TesterConfig = process.env.FOUNDRY_TESTER === "piston" ? { mode: "piston", pistonUrl: process.env.PISTON_URL ?? "http://127.0.0.1:2000" } : { mode: "local" };
  return createFoundryServer({ llm, tester });
}

// Run directly: `node src/server.ts`. FOUNDRY_STUB_IMPLS points at a {nodeId: code} JSON
// fixture (fenced or raw). Until a real provider is wired (M5), unmatched nodes get a stub.
const isMain = Boolean(process.argv[1]) && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void (async () => {
    const port = Number(process.env.PORT ?? 8787), server = await createConfiguredFoundryServer();
    server.listen(port, () => console.log(`[pi-pool] listening on :${port} — tester=${process.env.FOUNDRY_TESTER === "piston" ? "piston" : "local"}`));
  })();
}

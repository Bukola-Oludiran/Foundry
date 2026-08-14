import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../core/artifacts.ts";
import { FoundryCommandService, HttpWorker } from "../core/commands.ts";
import { InProcessEngine, RustEngineClient, type EnginePort } from "../core/engine-client.ts";
import { FoundryStore } from "../core/store.ts";
import type { FoundryAuthorizationContext, FoundryScope } from "../core/types.ts";
import type { AuthInfo } from "@modelcontextprotocol/server";

const LOCAL_CONTEXT_ID = process.env.FOUNDRY_CONTEXT_ID ?? `stdio:${randomUUID()}`;

function roots(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (process.env.FOUNDRY_WORKSPACE_ROOTS ?? "").split(",").filter(Boolean)) { const at = entry.indexOf("="); if (at > 0) out[entry.slice(0, at)] = resolve(entry.slice(at + 1)); }
  return out;
}

export function localAuth(transport: "stdio" | "http" | "test" = "stdio"): FoundryAuthorizationContext {
  return { tenantId: process.env.FOUNDRY_TENANT_ID ?? "local", userId: process.env.FOUNDRY_USER_ID ?? "local-user", clientId: process.env.FOUNDRY_CLIENT_ID ?? "local-client", contextId: LOCAL_CONTEXT_ID, scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"] satisfies FoundryScope[], transport };
}

export function httpAuth(info: AuthInfo | undefined): FoundryAuthorizationContext {
  if (!info) throw new Error("Validated HTTP authorization is required");
  const allowed = new Set<FoundryScope>(["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"]);
  const tenantId = String(info.extra?.tenantId ?? info.extra?.tenant_id ?? ""), userId = String(info.extra?.subject ?? info.extra?.sub ?? "");
  if (!tenantId || !userId || !info.clientId) throw new Error("Validated HTTP identity must contain tenant, subject, and client identifiers");
  const explicitContext = info.extra?.foundryContextId ?? info.extra?.mcpSessionId ?? info.extra?.sid ?? info.extra?.jti;
  const contextId = explicitContext ? String(explicitContext) : `http-token:${createHash("sha256").update(info.token).digest("hex").slice(0, 24)}`;
  return { tenantId, userId, clientId: info.clientId, contextId, scopes: info.scopes.filter((scope): scope is FoundryScope => allowed.has(scope as FoundryScope)), transport: "http" };
}

export function createService(): FoundryCommandService {
  const data = resolve(process.env.FOUNDRY_DATA_DIR ?? join(tmpdir(), "foundry-mcp")); mkdirSync(data, { recursive: true });
  const store = new FoundryStore(join(data, "foundry.sqlite")), artifacts = new ArtifactStore(join(data, "artifacts"));
  let engine: EnginePort;
  if (process.env.FOUNDRY_ENGINE_IN_PROCESS === "1") engine = new InProcessEngine();
  else engine = new RustEngineClient(resolve(process.env.FOUNDRY_ENGINE_BIN ?? "gr-host/target/debug/foundry-engine-sidecar"));
  const worker = process.env.FOUNDRY_WORKER_URL === "disabled" ? null : new HttpWorker(process.env.FOUNDRY_WORKER_URL ?? "http://127.0.0.1:8787");
  return new FoundryCommandService(store, artifacts, engine, worker, { roots: roots(), runRoot: join(data, "build-overlays"), allowLegacyHarness: process.env.FOUNDRY_ALLOW_LEGACY_HARNESS === "1", mutationMode: process.env.FOUNDRY_MUTATION_MODE === "enforce" ? "enforce" : process.env.FOUNDRY_MUTATION_MODE === "off" ? "off" : "shadow", productIrV5: process.env.FOUNDRY_PRODUCT_IR_V5 === "enabled" });
}

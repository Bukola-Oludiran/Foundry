import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createMcpHandler, verifyBearerToken, type AuthInfo, type McpHttpHandler, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FoundryCommandService } from "../core/commands.ts";
import { createService, httpAuth } from "./bootstrap.ts";
import { createFoundryMcpServer } from "./server.ts";

export interface FoundryHttpOptions {
  verifier: OAuthTokenVerifier;
  allowedHosts?: string[];
  allowedOriginHosts?: string[];
  rateLimitPerMinute?: number;
  maxRequestBytes?: number;
  protectedResource?: { resource: string; authorizationServers: string[]; scopesSupported?: string[] };
}

export function staticTokenVerifier(token: string, tenantId = "local", userId = "local-user"): OAuthTokenVerifier {
  return { async verifyAccessToken(candidate): Promise<AuthInfo> { if (candidate !== token) throw new Error("invalid bearer token"); return { token: candidate, clientId: "local-http-client", scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { tenantId, subject: userId } }; } };
}

export function oidcVerifier(input: { issuer: string; audience: string; jwksUrl?: string; authorizedParties?: string[]; tenantClaims?: string[]; revokedSubjects?: (subject: string) => boolean | Promise<boolean> }): OAuthTokenVerifier {
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  const keySet = async () => { if (jwks) return jwks; let url = input.jwksUrl; if (!url) { const response = await fetch(`${input.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`); if (!response.ok) throw new Error("OIDC discovery unavailable"); const metadata = await response.json() as any; if (metadata.issuer !== input.issuer || typeof metadata.jwks_uri !== "string") throw new Error("OIDC discovery metadata mismatch"); url = metadata.jwks_uri; } if (!url) throw new Error("OIDC JWKS URL unavailable"); jwks = createRemoteJWKSet(new URL(url)); return jwks; };
  return { async verifyAccessToken(token): Promise<AuthInfo> { const result = await jwtVerify(token, await keySet(), { issuer: input.issuer, audience: input.audience, requiredClaims: ["sub", "exp", "iat"] }); const subject = String(result.payload.sub), clientId = result.payload.azp ?? result.payload.client_id; if (typeof clientId !== "string" || !clientId) throw new Error("token has no authorized party"); if (input.authorizedParties?.length && !input.authorizedParties.includes(clientId)) throw new Error("unauthorized token client"); if (await input.revokedSubjects?.(subject)) throw new Error("token subject is revoked"); const tenant = (input.tenantClaims ?? ["tenant_id", "org_id"]).map((claim) => result.payload[claim]).find((value) => typeof value === "string" && value); if (typeof tenant !== "string") throw new Error("token has no tenant claim"); const scopes = typeof result.payload.scope === "string" ? result.payload.scope.split(/\s+/).filter(Boolean) : Array.isArray(result.payload.scp) ? result.payload.scp.map(String) : []; return { token, clientId, scopes, expiresAt: result.payload.exp, resource: new URL(input.audience), extra: { ...result.payload, tenantId: tenant, subject } }; } };
}

export function createFoundryHttpServer(service: FoundryCommandService, options: FoundryHttpOptions): { server: HttpServer; handler: McpHttpHandler } {
  const validateHost = hostHeaderValidation(options.allowedHosts ?? ["127.0.0.1", "localhost"]), validateOrigin = originValidation(options.allowedOriginHosts ?? ["127.0.0.1", "localhost"]);
  const calls = new Map<string, { windowStarted: number; count: number }>(), rateLimit = options.rateLimitPerMinute ?? 120, maxRequestBytes = options.maxRequestBytes ?? 2_000_000;
  const handler = createMcpHandler((ctx) => createFoundryMcpServer(service, httpAuth(ctx.authInfo)), { legacy: "stateless", responseMode: "auto", onerror: (error) => console.error(error) });
  const nodeHandler = toNodeHandler(handler);
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/.well-known/oauth-protected-resource" || req.url === "/.well-known/oauth-protected-resource/mcp") && options.protectedResource) { const body = JSON.stringify({ resource: options.protectedResource.resource, authorization_servers: options.protectedResource.authorizationServers, scopes_supported: options.protectedResource.scopesSupported ?? ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"] }); res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body); return; }
    if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(404).end(); return; }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const declaredSize = Number(req.headers["content-length"] ?? 0); if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxRequestBytes) { res.writeHead(413).end("request too large"); return; }
    let auth: AuthInfo;
    try {
      auth = await verifyBearerToken(req.headers.authorization, { verifier: options.verifier });
      const sessionId = req.headers["mcp-session-id"];
      auth.extra = { ...auth.extra, ...(typeof sessionId === "string" && sessionId ? { mcpSessionId: sessionId } : {}) };
      (req as typeof req & { auth?: AuthInfo }).auth = auth;
    }
    catch { res.writeHead(401, { "www-authenticate": "Bearer" }).end("unauthorized"); return; }
    const now = Date.now(), key = `${auth.extra?.tenantId ?? auth.extra?.tenant_id ?? ""}:${auth.clientId}`, current = calls.get(key); if (!current || now - current.windowStarted >= 60_000) calls.set(key, { windowStarted: now, count: 1 }); else if (++current.count > rateLimit) { res.writeHead(429, { "retry-after": String(Math.max(1, Math.ceil((60_000 - (now - current.windowStarted)) / 1000))) }).end("rate limit exceeded"); return; }
    await nodeHandler(req, res);
  });
  return { server, handler };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const service = createService(), issuer = process.env.FOUNDRY_OIDC_ISSUER, audience = process.env.FOUNDRY_OIDC_AUDIENCE, bearer = process.env.FOUNDRY_HTTP_BEARER_TOKEN;
  if (!((issuer && audience) || (bearer && process.env.FOUNDRY_ALLOW_STATIC_BEARER === "1"))) throw new Error("Configure OIDC, or explicitly enable FOUNDRY_ALLOW_STATIC_BEARER=1 for local development");
  const verifier = issuer && audience ? oidcVerifier({ issuer, audience, jwksUrl: process.env.FOUNDRY_OIDC_JWKS_URL, authorizedParties: process.env.FOUNDRY_OIDC_CLIENT_IDS?.split(",").filter(Boolean) }) : staticTokenVerifier(bearer!, process.env.FOUNDRY_TENANT_ID, process.env.FOUNDRY_USER_ID);
  const { server, handler } = createFoundryHttpServer(service, { verifier, protectedResource: issuer && audience ? { resource: audience, authorizationServers: [issuer] } : undefined, allowedHosts: (process.env.FOUNDRY_ALLOWED_HOSTS ?? "127.0.0.1,localhost").split(","), allowedOriginHosts: (process.env.FOUNDRY_ALLOWED_ORIGIN_HOSTS ?? "127.0.0.1,localhost").split(",") }); const port = Number(process.env.PORT ?? 8790);
  server.listen(port, "127.0.0.1", () => console.error(`[foundry-mcp] Streamable HTTP listening at http://127.0.0.1:${port}/mcp`));
  process.on("SIGINT", async () => { server.close(); await handler.close(); await service.engine.close(); service.store.close(); });
}

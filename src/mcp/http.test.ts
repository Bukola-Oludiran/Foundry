import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ArtifactStore } from "../core/artifacts.ts";
import { FoundryCommandService } from "../core/commands.ts";
import { InProcessEngine } from "../core/engine-client.ts";
import { FoundryStore } from "../core/store.ts";
import { createFoundryHttpServer, oidcVerifier, staticTokenVerifier } from "./http.ts";

test("Streamable HTTP serves modern and legacy MCP with bearer, Host, and Origin protection", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-http-")), store = new FoundryStore(join(root, "db.sqlite")), service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: {} });
  const { server, handler } = createFoundryHttpServer(service, { verifier: staticTokenVerifier("secret", "tenant", "user") }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  try {
    for (const mode of ["legacy", "modern"] as const) {
      const client = new Client({ name: `${mode}-http`, version: "1" }, mode === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : { versionNegotiation: { mode: "legacy" } }); const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => "secret" } }); await client.connect(transport);
      try { assert.ok((await client.listTools()).tools.some((tool) => tool.name === "foundry_create_project")); } finally { await client.close(); }
    }
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer secret", origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  } finally { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
});

test("Streamable HTTP rejects oversized and rate-limited authenticated calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-http-limits-")), store = new FoundryStore(":memory:"), service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: {} });
  const { server, handler } = createFoundryHttpServer(service, { verifier: staticTokenVerifier("secret", "tenant", "user"), rateLimitPerMinute: 1, maxRequestBytes: 128 }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), headers = { authorization: "Bearer secret", "content-type": "application/json" }, ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  try {
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ payload: "x".repeat(256) }) })).status, 413);
    assert.notEqual((await fetch(url, { method: "POST", headers, body: ping })).status, 429);
    const limited = await fetch(url, { method: "POST", headers, body: ping }); assert.equal(limited.status, 429); assert.ok(limited.headers.has("retry-after"));
  } finally { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
});

test("OIDC verification binds signature, issuer, audience, authorized party, subject, tenant, scopes, and revocation", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256"), jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: "key-1", alg: "RS256", use: "sig" });
  const issuerServer = createServer((req, res) => { const origin = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`; const body = req.url?.includes("openid-configuration") ? { issuer: origin, jwks_uri: `${origin}/jwks` } : { keys: [jwk] }; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)); }); await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`, audience = "http://127.0.0.1:8790/mcp", now = Math.floor(Date.now() / 1000), sign = (claims: Record<string, unknown>, subject = "user-1") => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "key-1" }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt(now).setNotBefore(now - 1).setExpirationTime(now + 60).sign(privateKey);
  try {
    const verifier = oidcVerifier({ issuer, audience, authorizedParties: ["codex"], revokedSubjects: (subject) => subject === "revoked" }); const valid = await verifier.verifyAccessToken(await sign({ azp: "codex", tenant_id: "tenant-1", scope: "foundry:read foundry:build" })); assert.equal(valid.clientId, "codex"); assert.equal(valid.extra?.tenantId, "tenant-1"); assert.deepEqual(valid.scopes, ["foundry:read", "foundry:build"]);
    await assert.rejects(verifier.verifyAccessToken(await sign({ azp: "other", tenant_id: "tenant-1", scope: "foundry:read" })), /unauthorized token client/); await assert.rejects(verifier.verifyAccessToken(await sign({ azp: "codex", scope: "foundry:read" })), /tenant claim/); await assert.rejects(verifier.verifyAccessToken(await sign({ azp: "codex", tenant_id: "tenant-1", scope: "foundry:read" }, "revoked")), /revoked/);
  } finally { await new Promise<void>((resolve) => issuerServer.close(() => resolve())); }
});

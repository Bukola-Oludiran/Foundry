import assert from "node:assert/strict";
import { oidcVerifier } from "./http.ts";

const issuer = process.env.FOUNDRY_KEYCLOAK_ISSUER ?? "http://127.0.0.1:8081/realms/foundry-test", audience = process.env.FOUNDRY_OIDC_AUDIENCE ?? "http://127.0.0.1:8790/mcp", clientId = "foundry-test-client";
const discovery = await fetch(`${issuer}/.well-known/openid-configuration`); assert.equal(discovery.ok, true, "Keycloak discovery is unavailable");
const tokenResponse = await fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: clientId, client_secret: "foundry-test-secret", username: "foundry-user", password: "foundry-user-test-only" }) }); if (!tokenResponse.ok) throw new Error(`Keycloak token request failed: ${await tokenResponse.text()}`); const token = (await tokenResponse.json() as any).access_token; assert.equal(typeof token, "string");
const auth = await oidcVerifier({ issuer, audience, authorizedParties: [clientId] }).verifyAccessToken(token); assert.equal(auth.clientId, clientId); assert.equal(auth.extra?.tenantId, "tenant-keycloak"); for (const scope of ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"]) assert.ok(auth.scopes.includes(scope), `missing ${scope}`);
console.log("✅ live Keycloak OIDC validated (discovery → signature/audience/azp/tenant/scopes)");

# Deterministic OIDC fixture

This Keycloak realm is for hosted MCP integration tests only. It issues five-minute tokens bound to the Foundry MCP resource, an authorized client, a subject, a tenant, and the six Foundry scopes.

```bash
docker compose -f deploy/keycloak/compose.yaml up -d
curl -s http://127.0.0.1:8081/realms/foundry-test/.well-known/openid-configuration
```

Configure Foundry with:

```text
FOUNDRY_OIDC_ISSUER=http://127.0.0.1:8081/realms/foundry-test
FOUNDRY_OIDC_AUDIENCE=http://127.0.0.1:8790/mcp
FOUNDRY_OIDC_CLIENT_IDS=foundry-test-client
```

The realm, client secret, users, and passwords are deliberately non-production fixtures.

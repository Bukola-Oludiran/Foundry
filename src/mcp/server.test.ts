import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ArtifactStore, sha256 } from "../core/artifacts.ts";
import { FoundryCommandService } from "../core/commands.ts";
import { InProcessEngine } from "../core/engine-client.ts";
import { FoundryStore } from "../core/store.ts";
import type { FoundryAuthorizationContext } from "../core/types.ts";
import { createFoundryMcpServer, normalizeCommandResult } from "./server.ts";
import { FOUNDRY_SERVER_INSTRUCTIONS, FOUNDRY_WORKFLOWS, renderFoundryWorkflow } from "./workflows.ts";

const auth: FoundryAuthorizationContext = { tenantId: "tenant", userId: "user", clientId: "test-client", scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"], transport: "test" };

test("MCP exposes tools, resources, prompts, and structured command results", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-mcp-test-")), store = new FoundryStore(join(root, "db.sqlite"));
  const service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: { test: root } });
  const server = createFoundryMcpServer(service, auth), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools(); assert.ok(tools.tools.some((t) => t.name === "foundry_create_project")); assert.ok(tools.tools.some((t) => t.name === "foundry_render_architecture")); assert.ok(tools.tools.some((t) => t.name === "foundry_begin_product_architecture")); assert.ok(tools.tools.some((t) => t.name === "foundry_validate_product_architecture")); assert.ok(tools.tools.some((t) => t.name === "foundry_apply_repository_update"));
    assert.equal(client.getInstructions(), FOUNDRY_SERVER_INSTRUCTIONS);
    const created = await client.callTool({ name: "foundry_create_project", arguments: { name: "MCP project" } }); assert.equal(created.isError, undefined); const state = (created.structuredContent as any).state; assert.equal(state.name, "MCP project");
    const resources = await client.listResources(); assert.ok(resources.resources.some((r) => r.uri === "foundry://workflows/architect-from-spec")); assert.ok(resources.resources.some((r) => r.uri === `foundry://projects/${state.id}`)); const resource = await client.readResource({ uri: `foundry://projects/${state.id}` }); assert.match((resource.contents[0] as any).text, /MCP project/);
    const prompts = await client.listPrompts(); assert.ok(prompts.prompts.some((p) => p.name === "architect-from-spec")); const prompt = await client.getPrompt({ name: "review-ownership-and-dependencies" }); assert.match((prompt.messages[0]!.content as any).text, /Never infer ownership/);
    const workflow = await client.readResource({ uri: "foundry://workflows/review-ownership-and-dependencies" });
    assert.equal((workflow.contents[0] as any).mimeType, "text/markdown");
    assert.equal((workflow.contents[0] as any).text, (prompt.messages[0]!.content as any).text);
  } finally { await client.close(); await server.close(); store.close(); }
});

test("MCP exposes recursive v5 trees, revision nodes, composite DAGs, and capability resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-mcp-product-")), store = new FoundryStore(join(root, "db.sqlite")), artifacts = new ArtifactStore(join(root, "artifacts"));
  const service = new FoundryCommandService(store, artifacts, new InProcessEngine(), null, { roots: { test: root }, productIrV5: true }), server = createFoundryMcpServer(service, auth), [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: "recursive-client", version: "1" }); await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const created = await client.callTool({ name: "foundry_create_project", arguments: { name: "HashRelay" } }), projectId = (created.structuredContent as any).state.id;
    await client.callTool({ name: "foundry_submit_spec", arguments: { projectId, spec: "Build a deterministic mixed Rust and Node checksum relay." } });
    const begun = await client.callTool({ name: "foundry_begin_product_architecture", arguments: { projectId, productId: "hash-relay" } }), draftId = (begun.structuredContent as any).state.id;
    const tree = await client.readResource({ uri: `foundry://projects/${projectId}/architecture/drafts/${draftId}/tree` }); assert.match((tree.contents[0] as any).text, /hash-relay/);
    const architecture = JSON.parse(readFileSync(new URL("../../fixtures/hash-relay/foundry-v5.ir.json", import.meta.url), "utf8")), revision = store.commitRevision(projectId, null, architecture, sha256(JSON.stringify(architecture)), null, { fixture: true });
    const node = await client.readResource({ uri: `foundry://projects/${projectId}/architecture/revisions/${revision.id}/nodes/${encodeURIComponent("hash-relay/engine/checksum-core")}` }); assert.match((node.contents[0] as any).text, /rust-library/);
    const dag = await client.readResource({ uri: `foundry://projects/${projectId}/architecture/revisions/${revision.id}/composites/${encodeURIComponent("hash-relay/engine")}/dag` }); assert.match((dag.contents[0] as any).text, /checksum-cli/);
    const capability = await client.readResource({ uri: "foundry://capabilities/rust-binary/versions/1.0.0" }); assert.match((capability.contents[0] as any).text, /pistonRuntime/);
  } finally { await client.close(); await server.close(); store.close(); }
});

test("every prompt has a promptless-client workflow resource with identical canonical content", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-mcp-workflows-")), store = new FoundryStore(":memory:");
  const service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: {} });
  const server = createFoundryMcpServer(service, auth), [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "promptless-codex-fixture", version: "1" }); await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    assert.match(client.getInstructions() ?? "", /foundry:\/\/workflows\/architect-from-spec/);
    for (const definition of FOUNDRY_WORKFLOWS) {
      const resource = await client.readResource({ uri: `foundry://workflows/${definition.id}` });
      assert.equal((resource.contents[0] as any).text, renderFoundryWorkflow(definition));
    }
  } finally { await client.close(); await server.close(); store.close(); }
});

test("MCP returns structured authorization failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-mcp-auth-")), store = new FoundryStore(":memory:"); const service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: {} });
  const server = createFoundryMcpServer(service, { ...auth, scopes: ["foundry:read"] }), [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "read-only", version: "1" }); await Promise.all([server.connect(st), client.connect(ct)]);
  try { const result = await client.callTool({ name: "foundry_create_project", arguments: { name: "forbidden" } }); assert.equal(result.isError, true); assert.equal((result.structuredContent as any).error.code, "FORBIDDEN"); }
  finally { await client.close(); await server.close(); store.close(); }
});

test("MCP awaits and validates every transport-neutral command result", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-mcp-async-result-")), store = new FoundryStore(":memory:");
  const service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: {} });
  service.getAssemblyEvidence = async () => ({ accepted: true, state: { buildId: "build", status: "green" }, diagnostics: [], provenance: { operationId: "operation", clientId: auth.clientId, at: new Date(0).toISOString() } });
  const server = createFoundryMcpServer(service, auth), [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "async-result", version: "1" }); await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const result = await client.callTool({ name: "foundry_get_assembly_evidence", arguments: { buildId: "build" } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as any).state.status, "green");
    await assert.rejects(normalizeCommandResult(Promise.resolve({ accepted: true })), /invalid transport-neutral result/);
  } finally { await client.close(); await server.close(); store.close(); }
});

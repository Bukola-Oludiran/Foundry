import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { FoundryHostClient, type CommandRunner } from "../core/host-client.ts";
import { WorkspaceRegistry } from "../core/workspaces.ts";
import { createFoundryMcpServer } from "./server.ts";
import { FOUNDRY_SERVER_INSTRUCTIONS, FOUNDRY_WORKFLOWS, renderFoundryWorkflow } from "./workflows.ts";

test("MCP exposes durable host tools, workflow parity, and opaque workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-mcp-"));
  writeFileSync(join(root, "accepted.ir.json"), "{}");
  mkdirSync(join(root, ".foundry", "durability"), { recursive: true });
  const runner: CommandRunner = { async run() { return { code: 0, stdout: "valid IR v1: leaf → root", stderr: "" }; } };
  const host = new FoundryHostClient(new WorkspaceRegistry({ project: root }), runner);
  const server = createFoundryMcpServer(host);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "foundry-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["foundry_architect", "foundry_architecture_status", "foundry_begin_architecture_review", "foundry_build", "foundry_cancel", "foundry_publish", "foundry_rearchitect", "foundry_revise_architecture_draft", "foundry_status", "foundry_submit_architecture_review", "foundry_validate"]);
    const validated = await client.callTool({ name: "foundry_validate", arguments: { workspaceId: "project", ir: "accepted.ir.json" } });
    assert.equal(validated.isError, undefined);
    assert.equal((validated.structuredContent as any).accepted, true);
    assert.equal(client.getInstructions(), FOUNDRY_SERVER_INSTRUCTIONS);
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "foundry://workspaces/project"));
    assert.doesNotMatch(JSON.stringify(resources), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const workflow of FOUNDRY_WORKFLOWS) {
      const resource = await client.readResource({ uri: `foundry://workflows/${workflow.id}` });
      const prompt = await client.getPrompt({ name: workflow.id });
      assert.equal((resource.contents[0] as any).text, renderFoundryWorkflow(workflow));
      assert.equal((prompt.messages[0]!.content as any).text, renderFoundryWorkflow(workflow));
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP returns structured workspace containment failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-mcp-error-"));
  const runner: CommandRunner = { async run() { throw new Error("runner must not be reached"); } };
  const server = createFoundryMcpServer(new FoundryHostClient(new WorkspaceRegistry({ project: root }), runner));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "foundry-error-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "foundry_validate", arguments: { workspaceId: "project", ir: "../secret.json" } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, "PATH_ESCAPE");
    const malformed = await client.callTool({ name: "foundry_build", arguments: { workspaceId: "project", ir: "accepted.ir.json", durabilityDir: ".foundry", dryRun: "yes" as any } });
    assert.equal(malformed.isError, true);
    assert.equal((malformed.structuredContent as any).error.code, "INVALID_ARGUMENT");
    const extra = await client.callTool({ name: "foundry_validate", arguments: { workspaceId: "project", ir: "accepted.ir.json", command: "sh" } });
    assert.equal(extra.isError, true);
    assert.equal((extra.structuredContent as any).error.code, "INVALID_ARGUMENT");
  } finally {
    await client.close();
    await server.close();
  }
});

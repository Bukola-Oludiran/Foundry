import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { FOUNDRY_SERVER_INSTRUCTIONS } from "./workflows.ts";

async function connect(mode: "legacy" | "modern"): Promise<void> {
  const workspace = mkdtempSync(`${tmpdir()}/foundry-stdio-`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/stdio.ts"],
    cwd: process.cwd(),
    env: { ...process.env, FOUNDRY_HOST_BIN: process.execPath, FOUNDRY_HOST_TRANSPORT: "direct", FOUNDRY_WORKSPACE_ROOTS: `test=${workspace}` } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: `${mode}-foundry-test`, version: "1" }, mode === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : { versionNegotiation: { mode: "legacy" } });
  await client.connect(transport);
  try {
    assert.equal(client.getInstructions(), FOUNDRY_SERVER_INSTRUCTIONS);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "foundry_build"));
    const workflow = await client.readResource({ uri: "foundry://workflows/run-durable-build" });
    assert.match((workflow.contents[0] as any).text, /GraphReact/);
  } finally {
    await client.close();
  }
}

test("stdio serves the compatible MCP protocol", () => connect("legacy"));
test("stdio serves MCP 2026-07-28", () => connect("modern"));

test("Claude Code project launcher keeps stdout protocol-clean", async () => {
  const root = process.cwd();
  const transport = new StdioClientTransport({
    command: "npm",
    args: ["--silent", "--prefix", root, "run", "mcp:claude"],
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, FOUNDRY_HOST_BIN: process.execPath, FOUNDRY_HOST_TRANSPORT: "direct" } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "claude-code-foundry-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "foundry://workspaces/foundry"));
  } finally {
    await client.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function connect(mode: "legacy" | "modern"): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/stdio.ts"], cwd: process.cwd(), env: { ...process.env, FOUNDRY_ENGINE_IN_PROCESS: "1", FOUNDRY_WORKER_URL: "disabled", FOUNDRY_DATA_DIR: mkdtempSync(join(tmpdir(), `foundry-${mode}-`)) } as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: `${mode}-client`, version: "1" }, mode === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : { versionNegotiation: { mode: "legacy" } });
  await client.connect(transport);
  try {
    const tools = await client.listTools(); assert.ok(tools.tools.some((tool) => tool.name === "foundry_create_project"));
    assert.match(client.getInstructions() ?? "", /Foundry is the authoritative architecture and build engine/);
    const workflow = await client.readResource({ uri: "foundry://workflows/implement-ready-node" }); assert.match((workflow.contents[0] as any).text, /Implement ready node/);
  }
  finally { await client.close(); }
}

test("stdio serves the 2025 compatibility protocol", () => connect("legacy"));
test("stdio serves MCP 2026-07-28", () => connect("modern"));

test("stdio owns the local deterministic worker lifecycle", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/stdio.ts"], cwd: process.cwd(), env: { ...process.env, FOUNDRY_ENGINE_IN_PROCESS: "1", FOUNDRY_WORKER_URL: "http://127.0.0.1:8787", FOUNDRY_TESTER: "local", FOUNDRY_DATA_DIR: mkdtempSync(join(tmpdir(), "foundry-managed-worker-")) } as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "managed-worker-client", version: "1" }, { versionNegotiation: { mode: "legacy" } }); await client.connect(transport);
  const tools = await client.listTools(); assert.ok(tools.tools.some((tool) => tool.name === "foundry_submit_node_changes"));
  await client.close();
});

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = process.cwd();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/mcp/stdio.ts"],
  cwd: root,
  env: {
    ...process.env,
    FOUNDRY_HOST_BIN: resolve("gr-host/target/debug/foundry-host"),
    FOUNDRY_HOST_TRANSPORT: "sidecar",
    FOUNDRY_WORKSPACE_ROOTS: `foundry=${root}`,
  } as Record<string, string>,
  stderr: "pipe",
});
const client = new Client({ name: "foundry-live-sidecar-check", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
await client.connect(transport);
try {
  const result = await client.callTool({ name: "foundry_validate", arguments: { workspaceId: "foundry", ir: "ir/examples/string-utils.ir.json" } });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as any).accepted, true);
  assert.match((result.structuredContent as any).state.stdout, /valid IR v1/);
  console.log("VALID MCP → Rust sidecar → Foundry host");
} finally {
  await client.close();
}

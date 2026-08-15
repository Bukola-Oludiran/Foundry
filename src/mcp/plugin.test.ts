import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FOUNDRY_WORKFLOWS } from "./workflows.ts";

test("Codex plugin registers the workspace-scoped Foundry MCP server", () => {
  const root = resolve("plugins/foundry");
  const manifest = JSON.parse(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  const config = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
  assert.equal(manifest.name, "foundry");
  assert.equal(manifest.author.name, "Bukola-Oludiran");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(config.mcpServers.foundry.args, ["--silent", "--prefix", "${PLUGIN_ROOT}/../..", "run", "mcp:stdio"]);
  assert.ok(config.mcpServers.foundry.env_vars.includes("FOUNDRY_WORKSPACE_ROOTS"));
});

test("Claude Code project configuration registers the same Foundry MCP server", () => {
  const config = JSON.parse(readFileSync(resolve(".mcp.json"), "utf8"));
  assert.deepEqual(config.mcpServers.foundry, {
    type: "stdio",
    command: "npm",
    args: ["--silent", "--prefix", "${CLAUDE_PROJECT_DIR:-.}", "run", "mcp:claude"],
  });
  assert.equal(JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts["mcp:claude"], "node --import tsx src/mcp/claude-stdio.ts");
});

test("plugin skills cover every canonical workflow without duplicating its body", () => {
  const skills = resolve("plugins/foundry/skills");
  const references = new Set<string>();
  for (const directory of readdirSync(skills)) {
    const body = readFileSync(resolve(skills, directory, "SKILL.md"), "utf8");
    assert.doesNotMatch(body, /\[TODO:|SQLite|IR v5/);
    for (const match of body.matchAll(/foundry:\/\/workflows\/([a-z0-9-]+)/g)) references.add(match[1]!);
  }
  assert.deepEqual([...references].sort(), FOUNDRY_WORKFLOWS.map((workflow) => workflow.id).sort());
});

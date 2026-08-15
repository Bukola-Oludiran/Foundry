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
  assert.deepEqual(config.mcpServers.foundry.args, ["--prefix", "${PLUGIN_ROOT}/../..", "run", "mcp:stdio"]);
  assert.ok(config.mcpServers.foundry.env_vars.includes("FOUNDRY_WORKSPACE_ROOTS"));
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

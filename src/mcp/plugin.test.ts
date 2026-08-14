import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FOUNDRY_WORKFLOWS } from "./workflows.ts";

const pluginRoot = resolve("plugins/foundry");

test("Codex plugin registers the local Foundry MCP server", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
  const config = JSON.parse(readFileSync(resolve(pluginRoot, ".mcp.json"), "utf8"));
  assert.equal(manifest.name, "foundry");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(config.mcpServers.foundry.command, "npm");
  assert.deepEqual(config.mcpServers.foundry.args, ["--prefix", "${PLUGIN_ROOT}/../..", "run", "mcp:stdio"]);
});

test("Codex skills cover every canonical workflow resource without embedding workflow bodies", () => {
  const skillsRoot = resolve(pluginRoot, "skills"), referenced = new Set<string>();
  for (const directory of readdirSync(skillsRoot)) {
    const body = readFileSync(resolve(skillsRoot, directory, "SKILL.md"), "utf8");
    assert.doesNotMatch(body, /\[TODO:|Structuring This Skill/);
    for (const match of body.matchAll(/foundry:\/\/workflows\/([a-z0-9-]+)/g)) referenced.add(match[1]!);
  }
  assert.deepEqual([...referenced].sort(), FOUNDRY_WORKFLOWS.map((workflow) => workflow.id).sort());
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoundryHostClient, type CommandExecution, type CommandRunner } from "./host-client.ts";
import { WorkspaceRegistry } from "./workspaces.ts";

class RecordingRunner implements CommandRunner {
  calls: Array<{ args: string[]; cwd?: string }> = [];
  result: CommandExecution = { code: 0, stdout: "valid IR v1: leaf → root", stderr: "" };

  async run(args: string[], options: { cwd?: string } = {}): Promise<CommandExecution> {
    this.calls.push({ args, cwd: options.cwd });
    return this.result;
  }
}

function fixture(): { root: string; client: FoundryHostClient; runner: RecordingRunner } {
  const root = mkdtempSync(join(tmpdir(), "foundry-host-client-"));
  writeFileSync(join(root, "accepted.ir.json"), "{}");
  mkdirSync(join(root, ".foundry", "durability"), { recursive: true });
  const runner = new RecordingRunner();
  const canonicalRoot = realpathSync(root);
  return { root: canonicalRoot, runner, client: new FoundryHostClient(new WorkspaceRegistry({ project: root }), runner) };
}

test("host adapter preserves GraphReact local durability arguments", async () => {
  const { root, client, runner } = fixture();
  runner.result = { code: 0, stdout: "  durable run: run-0123456789abcdef (Running)", stderr: "" };
  const result = await client.build({ workspaceId: "project", ir: "accepted.ir.json", durabilityDir: ".foundry/durability", base: "abc123" });
  assert.equal(result.state.runId, "run-0123456789abcdef");
  assert.deepEqual(runner.calls[0], { cwd: root, args: ["build", "--ir", join(root, "accepted.ir.json"), "--repo", root, "--workspace", root, "--base", "abc123", "--durability", "local", "--durability-dir", join(root, ".foundry", "durability")] });
});

test("host adapter parses durable status without exposing workspace roots", async () => {
  const { client, runner } = fixture();
  runner.result = { code: 0, stdout: "run-0123456789abcdef: Succeeded", stderr: "" };
  const result = await client.status({ workspaceId: "project", runId: "run-0123456789abcdef", durabilityDir: ".foundry/durability" });
  assert.deepEqual({ runId: result.state.runId, status: result.state.status }, { runId: "run-0123456789abcdef", status: "succeeded" });
});

test("workspace paths reject traversal and symlink escape", async () => {
  const { root, client } = fixture();
  assert.throws(() => client.validate({ workspaceId: "project", ir: "../outside.json" }), (error: any) => error.code === "PATH_ESCAPE");
  const outside = mkdtempSync(join(tmpdir(), "foundry-outside-"));
  writeFileSync(join(outside, "secret.json"), "{}");
  symlinkSync(outside, join(root, "linked"));
  assert.throws(() => client.validate({ workspaceId: "project", ir: "linked/secret.json" }), (error: any) => error.code === "SYMLINK_ESCAPE");
});

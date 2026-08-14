import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { FoundryProductArchitectureV5, FoundryProductNodeV5 } from "../../src/core/types.ts";

const repository = resolve(import.meta.dirname, "../..");
const architecture = JSON.parse(readFileSync(join(repository, "fixtures/hash-relay/foundry-v5.ir.json"), "utf8")) as FoundryProductArchitectureV5;
const workspace = mkdtempSync(join(tmpdir(), "foundry-product-runtime-local-"));
cpSync(join(repository, "fixtures/hash-relay/workspace"), workspace, { recursive: true });

function run(request: unknown): any {
  const requestPath = join(workspace, "foundry-product-request.json"); writeFileSync(requestPath, JSON.stringify(request));
  const execution = spawnSync(process.execPath, [join(repository, "deploy/piston/product-runtime.js"), "foundry-product-request.json"], { cwd: workspace, encoding: "utf8", env: { ...process.env, FOUNDRY_PRODUCT_SELF_TEST: "1" }, timeout: 180_000, maxBuffer: 1024 * 1024 });
  assert.equal(execution.status, 0, execution.stderr); const line = execution.stdout.split(/\r?\n/).find(entry => entry.startsWith("FOUNDRY_PRODUCT_RESULT=")); assert.ok(line, execution.stdout);
  return JSON.parse(Buffer.from(line.slice("FOUNDRY_PRODUCT_RESULT=".length), "base64").toString("utf8"));
}
function walk(node: FoundryProductNodeV5, path = node.id, output: Array<{ node: FoundryProductNodeV5; path: string }> = []): typeof output { output.push({ node, path }); for (const child of node.children ?? []) walk(child, `${path}/${child.id}`, output); return output; }

try {
  for (const { node, path } of walk(architecture.product).filter(entry => entry.node.kind === "leaf")) {
    const result = run({ protocol: 1, operation: "verify-work", workId: `${path}:implementation`, nodePath: path, node, architectureDigest: "local-control" }); assert.equal(result.verdict, "green", JSON.stringify(result.diagnostics));
  }
  for (const { node, path } of walk(architecture.product).filter(entry => entry.node.kind === "composite").sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
    const childEvidenceDigests = Object.fromEntries((node.children ?? []).map(child => [`${path}/${child.id}`, `sha256:${"0".repeat(64)}`])), result = run({ protocol: 1, operation: "integrate", nodePath: path, node, architecture, architectureDigest: "local-control", childEvidenceDigests }); assert.equal(result.verdict, "green", JSON.stringify(result.diagnostics));
  }
  const declarations = walk(architecture.product).flatMap(({ node, path }) => (node.deliverables ?? []).map(entry => ({ ...entry, ownerPath: path }))), first = run({ protocol: 1, operation: "assemble", architecture, architectureDigest: "local-control", deliverables: declarations }), second = run({ protocol: 1, operation: "assemble", architecture, architectureDigest: "local-control", deliverables: declarations });
  assert.equal(first.verdict, "green", JSON.stringify(first.diagnostics)); assert.equal(first.deliverables.length, 6); assert.deepEqual(first.deliverables, second.deliverables);
  console.log("✅ foundry-product local control validated HashRelay leaves, composite integrations, six deliverables, and deterministic replay");
} finally { rmSync(workspace, { recursive: true, force: true }); }

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyAndTestProduct, assembleProduct, integrateProduct } from "../src/product.ts";
import type { FoundryProductArchitectureV5, FoundryProductNodeV5 } from "../../src/core/types.ts";

const repository = resolve(import.meta.dirname, "../.."), pistonUrl = process.env.PISTON_URL ?? "http://127.0.0.1:2000", config = { mode: "piston" as const, pistonUrl };
const architecture = JSON.parse(readFileSync(join(repository, "fixtures/hash-relay/foundry-v5.ir.json"), "utf8")) as FoundryProductArchitectureV5, workspace = mkdtempSync(join(tmpdir(), "foundry-product-piston-")); cpSync(join(repository, "fixtures/hash-relay/workspace"), workspace, { recursive: true });
function walk(node: FoundryProductNodeV5, path = node.id, output: Array<{ node: FoundryProductNodeV5; path: string }> = []): typeof output { output.push({ node, path }); for (const child of node.children ?? []) walk(child, `${path}/${child.id}`, output); return output; }
function targets(node: FoundryProductNodeV5) { return node.kind === "leaf" ? node.implementation!.targets : node.integration!.glue?.targets ?? []; }

try {
  const runtimes = await fetch(`${pistonUrl}/api/v2/runtimes`).then(response => response.json()) as Array<{ language: string; version: string }>; assert.ok(runtimes.some(runtime => runtime.language === "foundry-product" && runtime.version === "1.0.0"));
  const evidence = new Map<string, string>();
  for (const { node, path } of walk(architecture.product).filter(entry => entry.node.kind === "leaf")) {
    const files = targets(node).map(target => ({ targetId: target.targetId, path: target.path, content: readFileSync(join(workspace, target.path), "utf8") })), result = await applyAndTestProduct({ workspace, workId: `${path}:implementation`, nodePath: path, node, architecture, plan: {}, files }, config); assert.equal(result.verdict, "green", JSON.stringify(result.diagnostics)); evidence.set(path, result.digest);
  }
  for (const { node, path } of walk(architecture.product).filter(entry => entry.node.kind === "composite").sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
    const childEvidenceDigests = Object.fromEntries((node.children ?? []).map(child => [`${path}/${child.id}`, evidence.get(`${path}/${child.id}`)!])), result = await integrateProduct({ workspace, buildId: "hash-relay-live", revisionId: "hash-relay-v5", nodePath: path, node, architecture, childEvidenceDigests }, config); assert.equal(result.verdict, "green", JSON.stringify(result.diagnostics)); evidence.set(path, `sha256:${"1".repeat(64)}`);
  }
  const deliverables = walk(architecture.product).flatMap(({ node, path }) => (node.deliverables ?? []).map(item => ({ deliverableId: item.deliverableId, ownerPath: path, kind: item.kind, output: item.output }))), first = await assembleProduct({ workspace, buildId: "hash-relay-live", revisionId: "hash-relay-v5", architecture, deliverables }, config), second = await assembleProduct({ workspace, buildId: "hash-relay-live", revisionId: "hash-relay-v5", architecture, deliverables }, config);
  assert.equal(first.verdict, "green"); assert.equal(first.deliverables.length, 6); assert.deepEqual(first.deliverables, second.deliverables);
  console.log("✅ live foundry-product@1.0.0 Piston verified HashRelay leaves, recursive integrations, six deliverables, and clean replay");
} finally { rmSync(workspace, { recursive: true, force: true }); }

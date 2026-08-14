import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyAndTestProduct, assembleProduct } from "../../pi-pool/src/product.ts";
import type { FoundryProductArchitectureV5 } from "./types.ts";

function fixture(): { workspace: string; architecture: FoundryProductArchitectureV5 } {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-product-worker-")); mkdirSync(join(workspace, "src")); writeFileSync(join(workspace, "src", "index.ts"), "export const run = () => true;\n");
  return { workspace, architecture: { version: 5, requirements: [], product: { id: "product", kind: "leaf", mandate: { outcome: "Run" }, contracts: [{ id: "api", name: "Api", operations: [{ name: "run", signature: "run(): boolean" }] }], acceptance: [{ id: "accept", name: "runs", covers: [], steps: [{ id: "step", operation: "run", arguments: [], expect: { kind: "equals", value: true } }] }], capabilityRefs: [{ id: "typescript-package", version: "1.0.0" }], implementation: { targets: [{ targetId: "source", path: "src/index.ts", mediaType: "text/typescript", role: "source" }] } } } };
}

test("IR v5 worker refuses non-Piston local-control verification", async () => {
  const { workspace, architecture } = fixture();
  await assert.rejects(applyAndTestProduct({ workspace, workId: "product:implementation", nodePath: "product", node: architecture.product, architecture, plan: {}, files: [{ targetId: "source", path: "src/index.ts", content: "export const run = () => true;\n" }] }, { mode: "local" }), /PRODUCTION_VERIFIER_REQUIRED/);
});

test("Piston product assembly rejects undeclared artifact egress", async () => {
  const { workspace, architecture } = fixture(), original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/api/v2/runtimes")) return new Response(JSON.stringify([{ language: "foundry-product", version: "1.0.0" }]), { status: 200 });
    const result = { verdict: "green", deliverables: [{ deliverableId: "forged", artifactBase64: Buffer.from("forged").toString("base64") }], evidence: {} }, stdout = `FOUNDRY_PRODUCT_RESULT=${Buffer.from(JSON.stringify(result)).toString("base64")}\n`;
    return new Response(JSON.stringify({ run: { code: 0, signal: null, stdout, stderr: "" } }), { status: 200 });
  };
  try { await assert.rejects(assembleProduct({ workspace, buildId: "build", revisionId: "revision", architecture, deliverables: [{ deliverableId: "release", ownerPath: "product", kind: "bundle", output: { mediaType: "application/zip", maxBytes: 100 } }] }, { mode: "piston", pistonUrl: "http://piston.invalid" }), /UNDECLARED_ARTIFACT_EGRESS/); }
  finally { globalThis.fetch = original; }
});

test("Piston product verification sends proposed source instead of the accepted overlay", async () => {
  const { workspace, architecture } = fixture(), original = globalThis.fetch; let submitted = "";
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/v2/runtimes")) return new Response(JSON.stringify([{ language: "foundry-product", version: "1.0.0" }]), { status: 200 });
    const body = JSON.parse(String(init?.body)); submitted = body.files.find((file: any) => file.name === "src/index.ts")?.content;
    const result = { verdict: "green", outcome: "accepted_green", diagnostics: {}, evidence: {} }, stdout = `FOUNDRY_PRODUCT_RESULT=${Buffer.from(JSON.stringify(result)).toString("base64")}\n`;
    return new Response(JSON.stringify({ run: { code: 0, signal: null, stdout, stderr: "" } }), { status: 200 });
  };
  try {
    await applyAndTestProduct({ workspace, workId: "product:implementation", nodePath: "product", node: architecture.product, architecture, plan: {}, files: [{ targetId: "source", path: "src/index.ts", content: "export const run = () => false;\n" }] }, { mode: "piston", pistonUrl: "http://piston.invalid" });
    assert.equal(submitted, "export const run = () => false;\n");
  } finally { globalThis.fetch = original; }
});

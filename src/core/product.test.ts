import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInCapabilities } from "./capabilities.ts";
import { ArtifactStore } from "./artifacts.ts";
import { renderArchitecture } from "./projections.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileProductArchitecture, findProductNode } from "./product.ts";
import type { FoundryAcceptanceScenario, FoundryProductArchitectureV5, FoundryProductNodeV5 } from "./types.ts";

const scenario = (id: string, covers: string[] = []): FoundryAcceptanceScenario => ({ id, name: id, covers, steps: [{ id: `${id}-step`, operation: "run", arguments: [], expect: { kind: "equals", value: true } }] });
const contract = (id: string) => ({ id, name: id, operations: [{ name: "run", signature: "run(): boolean", returns: "boolean" }] });
const capability = (id: string) => ({ id, version: "1.0.0" });
const leaf = (id: string, cap: "rust-library" | "rust-binary" | "typescript-package"): FoundryProductNodeV5 => ({ id, kind: "leaf", mandate: { outcome: `${id} outcome` }, contracts: [contract(`${id}-api`)], acceptance: [scenario(`${id}-acceptance`)], capabilityRefs: [capability(cap)], implementation: { targets: [{ targetId: `${id}-source`, path: `src/${id}.${cap.startsWith("rust") ? "rs" : "ts"}`, mediaType: "text/plain", role: "source" }] } });

export function hashRelay(): FoundryProductArchitectureV5 {
  const engine: FoundryProductNodeV5 = { id: "engine", kind: "composite", mandate: { outcome: "Produce checksums" }, contracts: [contract("checksum-process")], acceptance: [scenario("engine-public")], capabilityRefs: [capability("process-contract")], children: [leaf("checksum-core", "rust-library"), leaf("checksum-cli", "rust-binary")], dependencies: [{ provider: "checksum-core", consumer: "checksum-cli", contractId: "checksum-core-api" }], integration: { scenarios: [scenario("engine-integrates")], capabilityRefs: [capability("process-contract")] }, allocations: [] };
  const gateway: FoundryProductNodeV5 = { id: "gateway", kind: "composite", mandate: { outcome: "Expose checksum HTTP API" }, contracts: [contract("checksum-http")], acceptance: [scenario("gateway-public")], capabilityRefs: [capability("http-contract")], children: [leaf("protocol", "typescript-package"), { ...leaf("server", "typescript-package"), capabilityRefs: [capability("typescript-package")] }], dependencies: [{ provider: "protocol", consumer: "server", contractId: "protocol-api" }], integration: { scenarios: [scenario("gateway-integrates")], capabilityRefs: [capability("node-service")] }, allocations: [] };
  const distribution: FoundryProductNodeV5 = { id: "distribution", kind: "composite", mandate: { outcome: "Bundle release" }, contracts: [contract("release")], acceptance: [scenario("release-public")], capabilityRefs: [capability("artifact-bundle")], children: [leaf("release-manifest", "typescript-package")], integration: { scenarios: [scenario("release-integrates")] }, deliverables: [{ deliverableId: "release-bundle", kind: "bundle", capabilityRef: capability("artifact-bundle"), required: true, output: { artifactId: "release", mediaType: "application/zip", maxBytes: 1048576 } }], allocations: [] };
  return { version: 5, requirements: [{ id: "req-digest", kind: "functional", text: "Returns deterministic digest", priority: "must" }], product: { id: "hash-relay", kind: "composite", mandate: { outcome: "Deliver checksums" }, contracts: [contract("product-api")], acceptance: [scenario("product-acceptance", ["req-digest"])], capabilityRefs: [capability("mixed-rust-node-product")], children: [engine, gateway, distribution], dependencies: [{ provider: "engine", consumer: "gateway", contractId: "checksum-process" }, { provider: "gateway", consumer: "distribution", contractId: "checksum-http" }], integration: { scenarios: [scenario("product-integrates", ["req-digest"])], capabilityRefs: [capability("mixed-rust-node-product")] }, allocations: [{ requirementId: "req-digest", targets: [{ node: "engine", responsibility: "compute" }, { node: "gateway", responsibility: "expose" }], integrationScenarioIds: ["product-integrates"] }] } };
}

test("built-in capabilities are curated and versioned", () => {
  assert.ok(builtInCapabilities.get("rust-library", "1.0.0"));
  assert.equal(builtInCapabilities.get("not-real", "1.0.0"), undefined);
});

test("compiles HashRelay into recursive post-order work and scoped DAGs", () => {
  const result = compileProductArchitecture(hashRelay());
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  const plan = result.plan!;
  assert.equal(plan.rootPath, "hash-relay");
  assert.ok(plan.postOrder.indexOf("hash-relay/engine/checksum-core") < plan.postOrder.indexOf("hash-relay/engine"));
  assert.deepEqual(plan.compositeGenerations["hash-relay"], [["hash-relay/engine"], ["hash-relay/gateway"], ["hash-relay/distribution"]]);
  assert.equal(plan.workItems.find((item) => item.workId === "hash-relay/engine:integration")?.actor, "system");
  assert.ok(plan.invalidation["hash-relay/engine/checksum-core"].includes("hash-relay"));
  assert.ok(plan.invalidation["hash-relay/engine"].includes("hash-relay/gateway"));
  assert.equal(plan.deliverables[0]?.ownerPath, "hash-relay/distribution");
});

test("executable HashRelay fixture compiles with six required deliverables and typed boundary evidence", () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "fixtures/hash-relay/foundry-v5.ir.json"), "utf8")) as FoundryProductArchitectureV5, result = compileProductArchitecture(fixture);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.plan!.deliverables.length, 6);
  assert.equal(result.plan!.deliverables.every((entry) => entry.required), true);
  assert.deepEqual(result.plan!.compositeGenerations["hash-relay"], [["hash-relay/engine"], ["hash-relay/gateway"], ["hash-relay/distribution"]]);
  for (const requirement of fixture.requirements) assert.ok(result.plan!.requirementTrace[requirement.id]?.some((entry) => entry.scenarioIds.length), requirement.id);
});

test("rejects composition cycles, internal targets, missing review, and unallocated must requirements", () => {
  const ir = hashRelay();
  ir.product.dependencies!.push({ provider: "distribution", consumer: "engine", contractId: "release" });
  ir.product.dependencyExceptions = [{ providerPath: "hash-relay/engine/checksum-core", consumerPath: "hash-relay/gateway/server", contractId: "checksum-core-api", reason: "temporary", responsibleOwnerPath: "hash-relay" }];
  ir.requirements.push({ id: "req-uncovered", kind: "functional", text: "Uncovered", priority: "must" });
  ir.product.children![0]!.children![0]!.implementation!.targets[0]!.path = "../escape.rs";
  const codes = compileProductArchitecture(ir).diagnostics.map((entry) => entry.code);
  for (const code of ["SCOPED_DEPENDENCY_CYCLE", "DEPENDENCY_EXCEPTION_REVIEW_REQUIRED", "MUST_REQUIREMENT_UNALLOCATED", "INVALID_WRITE_TARGET"]) assert.ok(codes.includes(code), code);
});

test("finds nodes using canonical hierarchical paths", () => {
  assert.equal(findProductNode(hashRelay().product, "hash-relay/gateway/server")?.id, "server");
  assert.equal(findProductNode(hashRelay().product, "hash-relay/nope"), undefined);
});

function generatedProduct(count: number): FoundryProductArchitectureV5 {
  const composites = Math.ceil((count - 1) / 129), leaves = count - 1 - composites; let leafIndex = 0;
  const children: FoundryProductNodeV5[] = Array.from({ length: composites }, (_, compositeIndex) => { const size = Math.min(128, leaves - leafIndex), nested = Array.from({ length: size }, () => leaf(`leaf-${leafIndex++}`, "typescript-package")); return { id: `group-${compositeIndex}`, kind: "composite", mandate: { outcome: "Integrate group" }, contracts: [contract("group-api")], acceptance: [scenario("group-public")], capabilityRefs: [], children: nested, integration: { scenarios: [scenario("group-integration")] }, allocations: [] }; });
  return { version: 5, requirements: [], product: { id: "large-product", kind: "composite", mandate: { outcome: "Compile at scale" }, contracts: [contract("product-api")], acceptance: [scenario("product-public")], capabilityRefs: [], children, integration: { scenarios: [scenario("product-integration")] }, allocations: [] } };
}

test("recursive compiler meets interactive and maximum-scale deterministic gates", () => {
  const medium = generatedProduct(512), samples: number[] = []; for (let index = 0; index < 10; index++) { const started = performance.now(), compiled = compileProductArchitecture(medium); samples.push(performance.now() - started); assert.equal(compiled.valid, true); }
  samples.sort((a, b) => a - b); assert.ok(samples[9]! <= 500, `512-node p95 ${samples[9]}ms`);
  const maximum = generatedProduct(2048), started = performance.now(), first = compileProductArchitecture(maximum); assert.equal(first.valid, true); assert.ok(performance.now() - started <= 2000); const second = compileProductArchitecture(maximum); assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan)); assert.equal(Object.keys(first.plan!.nodes).length, 2048);
});

test("v5 projections include composition, every composite DAG, contracts, and evidence tree", () => {
  const store = new ArtifactStore(join(mkdtempSync(join(tmpdir(), "foundry-product-diagrams-")), "artifacts")), first = renderArchitecture(hashRelay(), "revision", store), second = renderArchitecture(hashRelay(), "revision", store), ids = first.diagrams.map((diagram) => diagram.viewId);
  for (const id of ["ownership", "interfaces", "evidence-tree", "dependencies-hash-relay", "dependencies-hash-relay/engine", "dependencies-hash-relay/gateway", "dependencies-hash-relay/distribution", "state-foundry-product-build"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(first, second); const excalidraw = store.get(first.excalidraw.digest).toString("utf8"); assert.match(excalidraw, /hash-relay\/engine\/checksum-core/); assert.match(excalidraw, /evidence digest ascends/);
});

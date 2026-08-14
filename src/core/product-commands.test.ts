import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore, sha256 } from "./artifacts.ts";
import { FoundryCommandService } from "./commands.ts";
import { InProcessEngine } from "./engine-client.ts";
import { FoundryStore } from "./store.ts";
import type { FoundryAuthorizationContext, FoundryProductArchitectureV5 } from "./types.ts";

const auth: FoundryAuthorizationContext = { tenantId: "tenant", userId: "user", clientId: "client", contextId: "architect-a", scopes: ["foundry:read", "foundry:architect", "foundry:activate"], transport: "test" };

test("IR v5 authoring is rollout-gated", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-product-disabled-")), store = new FoundryStore(":memory:"), service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: {} }), project = service.createProject(auth, { name: "Disabled" }).state; service.submitSpec(auth, { projectId: project.id, spec: "x" });
  assert.throws(() => service.beginProductArchitecture(auth, { projectId: project.id }), (error: any) => error.code === "PRODUCT_IR_V5_DISABLED"); store.close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "foundry-product-commands-")), store = new FoundryStore(join(root, "db.sqlite")), service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), null, { roots: {}, productIrV5: true });
  const project = service.createProject(auth, { name: "HashRelay" }).state; service.submitSpec(auth, { projectId: project.id, spec: "Build HashRelay" });
  const architecture = JSON.parse(readFileSync(new URL("../../fixtures/hash-relay/foundry-v5.ir.json", import.meta.url), "utf8")) as FoundryProductArchitectureV5, revision = store.commitRevision(project.id, null, architecture, sha256(JSON.stringify(architecture)), null, {}); store.activate(project.id, null, revision.id);
  const draft = service.beginProductArchitecture(auth, { projectId: project.id }).state; return { store, service, project, draft };
}

test("incremental product commands enforce draft CAS and leased subtree authority", () => {
  const { store, service, draft } = fixture(), scope = service.acquireArchitectureScope(auth, { draftId: draft.id, nodePath: "hash-relay/engine" }).state;
  const gateway = service.getProductTree(auth, draft.id).state.product.children.find((node: any) => node.id === "gateway");
  assert.throws(() => service.updateProductNode(auth, { draftId: draft.id, expectedVersion: draft.version, nodePath: "hash-relay/gateway", node: gateway, scopeLeaseId: scope.scopeLeaseId }), (error: any) => error.code === "ARCHITECTURE_SCOPE_CONFLICT");
  const engine = service.getProductTree(auth, draft.id).state.product.children.find((node: any) => node.id === "engine");
  const updated = service.updateProductNode(auth, { draftId: draft.id, expectedVersion: draft.version, nodePath: "hash-relay/engine", node: { ...engine, mandate: { outcome: "Updated engine" } }, scopeLeaseId: scope.scopeLeaseId }); assert.equal(updated.accepted, true);
  assert.throws(() => service.updateProductNode(auth, { draftId: draft.id, expectedVersion: draft.version, nodePath: "hash-relay/engine", node: engine, scopeLeaseId: scope.scopeLeaseId }), (error: any) => error.code === "DRAFT_CONFLICT" && error.details.currentVersion === draft.version + 1);
  store.close();
});

test("subtree moves require lowest common scope and preserve hierarchical lineage", () => {
  const { store, service, draft } = fixture(), scope = service.acquireArchitectureScope(auth, { draftId: draft.id, nodePath: "hash-relay" }).state;
  assert.throws(() => service.moveProductSubtree(auth, { draftId: draft.id, expectedVersion: draft.version, nodePath: "hash-relay/engine/checksum-core", newParentPath: "hash-relay/distribution", scopeLeaseId: scope.scopeLeaseId }), (error: any) => error.code === "MOVE_EXTERNAL_REFERENCES");
  const source = service.getProductTree(auth, draft.id).state.product.children.find((node: any) => node.id === "distribution").children.find((node: any) => node.id === "release-manifest"), detached = structuredClone(source);
  detached.id = "detached-release-notes"; detached.acceptance = []; detached.implementation.targets = detached.implementation.targets.map((target: any) => ({ ...target, targetId: "detached-" + target.targetId, path: target.path.replace("distribution/release-manifest", "distribution/detached-release-notes") }));
  const added = service.addProductNode(auth, { draftId: draft.id, expectedVersion: draft.version, parentPath: "hash-relay/distribution", node: detached, scopeLeaseId: scope.scopeLeaseId }); assert.equal(added.accepted, true);
  const moved = service.moveProductSubtree(auth, { draftId: draft.id, expectedVersion: draft.version + 1, nodePath: "hash-relay/distribution/detached-release-notes", newParentPath: "hash-relay/engine", newId: "release-notes", scopeLeaseId: scope.scopeLeaseId }); assert.equal(moved.accepted, true);
  const tree = service.getProductTree(auth, draft.id).state.product, engine = tree.children.find((node: any) => node.id === "engine"), node = engine.children.find((child: any) => child.id === "release-notes"); assert.equal(node.supersedes, "hash-relay/distribution/detached-release-notes");
  store.close();
});

test("recursive subtree proposals preserve parent contracts and unrelated subtrees", async () => {
  const { store, service, project } = fixture(), active = store.revision(store.project(project.id).activeRevisionId), originalGateway = JSON.stringify(active.document.product.children.find((node: any) => node.id === "gateway")), target = structuredClone(active.document.product.children.find((node: any) => node.id === "engine")); target.mandate.outcome = "Rearchitected checksum engine";
  const proposal = (await service.beginRearchitecture(auth, { projectId: project.id, targetNodeId: "hash-relay/engine" })).state; assert.ok(proposal.invalidates.includes("hash-relay")); service.submitSubtreeProposal(auth, { proposalId: proposal.id, nodes: [target] }); const validation = await service.validateProposal(auth, proposal.id); assert.equal(validation.state.valid, true);
  const merged = service.getProposal(auth, proposal.id).state.proposed; assert.equal(JSON.stringify(merged.product.children.find((node: any) => node.id === "gateway")), originalGateway); assert.equal(merged.product.children.find((node: any) => node.id === "engine").mandate.outcome, "Rearchitected checksum engine"); store.close();
});

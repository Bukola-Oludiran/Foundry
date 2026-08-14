import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore, sha256 } from "./artifacts.ts";
import { FoundryCommandService, type WorkerPort } from "./commands.ts";
import { InProcessEngine } from "./engine-client.ts";
import { FoundryStore } from "./store.ts";
import type { FoundryAuthorizationContext, FoundryProductArchitectureV5 } from "./types.ts";

const auth: FoundryAuthorizationContext = { tenantId: "tenant", userId: "user", clientId: "codex", contextId: "product-author", scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"], transport: "test" };
const architecture = JSON.parse(readFileSync(new URL("../../fixtures/hash-relay/foundry-v5.ir.json", import.meta.url), "utf8")) as FoundryProductArchitectureV5;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "foundry-product-build-")), store = new FoundryStore(join(root, "foundry.sqlite")), artifacts = new ArtifactStore(join(root, "artifacts"));
  const worker: WorkerPort = {
    async applyAndTest() { throw new Error("legacy path must not run"); },
    async applyAndTestProduct(input) { return { verdict: "green", outcome: "accepted_green", diagnostics: { sandbox: "piston", workId: input.workId }, digest: sha256(JSON.stringify(input.files)), evidence: { runtime: input.node.capabilityRefs[0] } }; },
    async integrateProduct(input) { return { verdict: "green", diagnostics: { sandbox: "piston", nodePath: input.nodePath }, evidence: { children: input.childEvidenceDigests } }; },
    async assembleProduct(input) { return { verdict: "green", deliverables: input.deliverables.map((entry) => ({ deliverableId: entry.deliverableId, artifactBase64: Buffer.from(`artifact:${entry.deliverableId}`).toString("base64"), mediaType: (entry.output as any)?.mediaType ?? "application/octet-stream" })), evidence: { sandbox: "piston", normalized: true } }; },
  };
  return { root, store, service: new FoundryCommandService(store, artifacts, new InProcessEngine(), worker, { roots: { workspace: root }, runRoot: root, productIrV5: true }) };
}

test("recursive build gates sibling subtrees and integrates every composite before assembly", async () => {
  const { root, store, service } = fixture(), project = service.createProject(auth, { name: "HashRelay" }).state!; service.bindWorkspace(auth, { projectId: project.id, rootId: "workspace" });
  const revision = store.commitRevision(project.id, null, architecture, sha256(JSON.stringify(architecture)), null, { fixture: true }); store.activate(project.id, null, revision.id);
  const build = await service.startBuild(auth, { projectId: project.id, revisionId: revision.id }), buildId = build.state.build_id;
  const submitted: string[] = [];
  while (true) {
    const ready = (await service.getReadyWork(auth, { buildId, limit: 16 })).state!;
    if (!ready.length) break;
    for (const item of ready) {
      const context = (await service.getNodeContext(auth, { buildId, nodeId: item.workId })).state, files = context.writeTargets.map((target: any) => ({ targetId: target.targetId, baseDigest: null, content: `// ${item.nodePath}\n` }));
      await service.submitNodeChanges(auth, { buildId, changeSet: { submissionId: `submission-${submitted.length}`, leaseId: item.leaseId, targetId: item.workId, baseDigest: item.baseDigest, files, summary: `Implement ${item.nodePath}` } }); submitted.push(item.nodePath);
    }
  }
  assert.deepEqual(submitted, ["hash-relay/engine/checksum-core", "hash-relay/engine/checksum-cli", "hash-relay/gateway/protocol", "hash-relay/gateway/server", "hash-relay/distribution/release-manifest"]);
  const final = (await service.getBuild(auth, buildId)).state; assert.equal(final.assembly.status, "green"); assert.equal(final.deliverables[0].status, "green"); assert.ok(Object.values(final.nodes).every((state) => state === "green"));
  const integrations = store.db.prepare("SELECT node_path,status FROM integration_attempts WHERE build_id=? ORDER BY created_at").all(buildId) as any[]; assert.deepEqual(integrations.map((entry) => entry.node_path), ["hash-relay/engine", "hash-relay/gateway", "hash-relay/distribution", "hash-relay"]); assert.ok(integrations.every((entry) => entry.status === "green"));
  const evidence = store.db.prepare("SELECT node_path,status FROM node_evidence WHERE build_id=? ORDER BY node_path").all(buildId) as any[]; assert.equal(evidence.length, 9); assert.ok(evidence.every((entry) => entry.status === "green")); assert.ok(readFileSync(join(root, buildId, "gateway", "server", "src", "index.mjs"), "utf8").includes("gateway/server"));
});

test("a composite integration failure preserves green child evidence and blocks ancestors", async () => {
  const { root, store } = fixture(), project = store.createProject("tenant", "Failure"), artifacts = new ArtifactStore(join(root, "failing-artifacts")); let failed = false;
  const worker: WorkerPort = { async applyAndTest() { throw new Error("legacy"); }, async applyAndTestProduct(input) { return { verdict: "green", diagnostics: {}, digest: sha256(input.workId) }; }, async integrateProduct(input) { if (input.nodePath === "hash-relay/engine" && !failed) { failed = true; return { verdict: "red", diagnostics: { code: "PROCESS_CONTRACT_MISMATCH" }, evidence: {} }; } return { verdict: "green", diagnostics: {}, evidence: {} }; }, async assembleProduct() { throw new Error("must not assemble"); } };
  store.bindWorkspace(project.id as string, "workspace", ".", root); const revision = store.commitRevision(project.id as string, null, architecture, sha256(JSON.stringify(architecture)), null, {}); store.activate(project.id as string, null, revision.id); const service = new FoundryCommandService(store, artifacts, new InProcessEngine(), worker, { roots: { workspace: root }, productIrV5: true }), build = await service.startBuild(auth, { projectId: project.id as string, revisionId: revision.id }), buildId = build.state.build_id;
  for (let count = 0; count < 2; count++) { const item = (await service.getReadyWork(auth, { buildId })).state![0], context = (await service.getNodeContext(auth, { buildId, nodeId: item.workId })).state; await service.submitNodeChanges(auth, { buildId, changeSet: { submissionId: `failure-${count}`, leaseId: item.leaseId, targetId: item.workId, baseDigest: item.baseDigest, files: context.writeTargets.map((target: any) => ({ targetId: target.targetId, baseDigest: null, content: "// green\n" })), summary: "green child" } }); }
  const state = (await service.getBuild(auth, buildId)).state; assert.equal(state.nodes["hash-relay/engine:integration"], "red"); assert.equal(state.nodes["hash-relay/engine/checksum-core:implementation"], "green"); assert.equal(state.nodes["hash-relay/engine/checksum-cli:implementation"], "green"); assert.equal(state.nodes["hash-relay/gateway/protocol:implementation"], "waiting_children"); assert.equal(state.assembly.status, "pending");
});

test("authored-red product attempts never promote their target overlay", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-product-red-")), store = new FoundryStore(join(root, "foundry.sqlite")), artifacts = new ArtifactStore(join(root, "artifacts")), worker: WorkerPort = { async applyAndTest() { throw new Error("legacy"); }, async applyAndTestProduct() { return { verdict: "red", outcome: "authored_red", diagnostics: { code: "TEST_FAILED" }, digest: sha256("red") }; }, async integrateProduct() { throw new Error("must not integrate"); }, async assembleProduct() { throw new Error("must not assemble"); } }, service = new FoundryCommandService(store, artifacts, new InProcessEngine(), worker, { roots: { workspace: root }, runRoot: root, productIrV5: true }), project = service.createProject(auth, { name: "Red" }).state; service.bindWorkspace(auth, { projectId: project.id, rootId: "workspace" }); const revision = store.commitRevision(project.id, null, architecture, sha256(JSON.stringify(architecture)), null, {}); store.activate(project.id, null, revision.id); const buildId = (await service.startBuild(auth, { projectId: project.id, revisionId: revision.id })).state.build_id, item = (await service.getReadyWork(auth, { buildId })).state![0]!, context = (await service.getNodeContext(auth, { buildId, nodeId: item.workId })).state;
  const result = await service.submitNodeChanges(auth, { buildId, changeSet: { submissionId: "authored-red", leaseId: item.leaseId, targetId: item.workId, baseDigest: item.baseDigest, files: context.writeTargets.map((target: any) => ({ targetId: target.targetId, baseDigest: null, content: "malformed source" })), summary: "bad implementation" } }); assert.equal(result.state.result.outcome, "authored_red"); assert.equal(existsSync(join(root, buildId, context.writeTargets[0]!.path)), false); assert.equal((await service.getBuild(auth, buildId)).state.nodes[item.workId], "red");
});

test("recursive build state rehydrates without reopening accepted work", async () => {
  const { root, store, service } = fixture(), project = service.createProject(auth, { name: "Restart" }).state; service.bindWorkspace(auth, { projectId: project.id, rootId: "workspace" }); const revision = store.commitRevision(project.id, null, architecture, sha256(JSON.stringify(architecture)), null, {}); store.activate(project.id, null, revision.id); const buildId = (await service.startBuild(auth, { projectId: project.id, revisionId: revision.id })).state.build_id, item = (await service.getReadyWork(auth, { buildId })).state![0]!, context = (await service.getNodeContext(auth, { buildId, nodeId: item.workId })).state; await service.submitNodeChanges(auth, { buildId, changeSet: { submissionId: "before-restart", leaseId: item.leaseId, targetId: item.workId, baseDigest: item.baseDigest, files: context.writeTargets.map((target: any) => ({ targetId: target.targetId, baseDigest: null, content: "// accepted\n" })), summary: "accepted before restart" } });
  const worker = (service as any).worker as WorkerPort, restarted = new FoundryCommandService(store, new ArtifactStore(join(root, "restart-artifacts")), new InProcessEngine(), worker, { roots: { workspace: root }, runRoot: root, productIrV5: true }), recovered = (await restarted.getBuild(auth, buildId)).state; assert.equal(recovered.nodes[item.workId], "green"); const ready = await restarted.getReadyWork(auth, { buildId, limit: 16 }); assert.ok(ready.state!.every((entry: any) => entry.workId !== item.workId));
});

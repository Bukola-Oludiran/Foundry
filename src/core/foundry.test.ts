import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "./artifacts.ts";
import { FoundryCommandService } from "./commands.ts";
import type { WorkerPort } from "./commands.ts";
import { InProcessEngine } from "./engine-client.ts";
import { renderArchitecture, validateLayoutImport } from "./projections.ts";
import { FoundryStore } from "./store.ts";
import type { FoundryArchitecture, FoundryAuthorizationContext } from "./types.ts";

const example = JSON.parse(readFileSync(new URL("../../ir/examples/string-utils.ir.json", import.meta.url), "utf8")) as FoundryArchitecture;
const auth: FoundryAuthorizationContext = { tenantId: "t1", userId: "u1", clientId: "codex", contextId: "author-context", scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"], transport: "test" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "foundry-core-"));
  const store = new FoundryStore(join(root, "db.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  return { root, store, artifacts, service: new FoundryCommandService(store, artifacts, new InProcessEngine(), null, { roots: { test: root } }) };
}

test("SQLite state survives restart and draft updates use compare-and-swap", () => {
  const { root, store, service } = fixture();
  const project = service.createProject(auth, { name: "Example" }).state!;
  service.submitSpec(auth, { projectId: project.id, spec: "Build string utilities" });
  const draft = service.beginArchitecture(auth, { projectId: project.id }).state!;
  const updated = service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: example });
  assert.equal(updated.accepted, true); assert.equal(updated.state.version, 2);
  assert.throws(() => service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: example }), /Draft changed/);
  store.close();
  const reopened = new FoundryStore(join(root, "db.sqlite"));
  assert.equal(reopened.project(project.id).name, "Example"); assert.equal(reopened.draft(draft.id).version, 2); reopened.close();
});

test("architecture projections are deterministic and reject phantom Excalidraw semantics", () => {
  const { artifacts } = fixture();
  const first = renderArchitecture(example, "r1", artifacts), second = renderArchitecture(structuredClone(example), "r1", artifacts);
  assert.equal(first.digest, second.digest); assert.ok(first.diagrams.some((d) => d.kind === "ownership" && d.status === "rendered")); assert.ok(first.diagrams.some((d) => d.kind === "dependencies" && d.status === "rendered"));
  assert.match(artifacts.get(first.diagrams[0]!.artifacts.find((a) => a.format === "plantuml")!.digest).toString(), /@startuml/);
  assert.match(artifacts.get(first.diagrams[0]!.artifacts.find((a) => a.format === "svg")!.digest).toString(), /data-from-semantic-id/); assert.match(artifacts.get(first.excalidraw.digest).toString(), /"type": "arrow"/);
  assert.equal(artifacts.get(first.diagrams[0]!.artifacts.find((a) => a.format === "png")!.digest).subarray(1, 4).toString(), "PNG");
  assert.throws(() => validateLayoutImport(example, { elements: [{ x: 0, y: 0, customData: { semanticId: "phantom" } }] }), /PHANTOM/);
  assert.throws(() => validateLayoutImport(example, { elements: [{ customData: { viewId: "ownership", relationshipKind: "ownership", fromSemanticId: "trim", toSemanticId: "lowercase", label: "owns" } }] }), /PHANTOM_SEMANTIC_RELATIONSHIP/);
});

test("adaptive architecture requires an independent review or authorized waiver", async () => {
  const { service } = fixture(); const project = service.createProject(auth, { name: "Example" }).state!;
  service.submitSpec(auth, { projectId: project.id, spec: "Build string utilities" }); const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "adaptive" }).state!;
  service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: example });
  await assert.rejects(service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }), /review/i);
  const self = service.submitReview(auth, { draftId: draft.id, verdict: "approve", body: "Self review is recorded but not independent." }); assert.equal(self.state.independent, false);
  await assert.rejects(service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }), /independent context/);
  service.submitReview(auth, { draftId: draft.id, verdict: "approve", body: "Ownership, interfaces, scenarios, and failure boundaries are acceptable.", reviewerContextId: "independent-critic" });
  const activated = await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null });
  assert.equal(activated.accepted, true); assert.match(activated.revisionId!, /^[0-9a-f-]+$/); assert.equal(service.getProject(auth, project.id).state.activeRevisionId, activated.revisionId);
});

test("council mode is explicit, bounded, and requires every selected role", async () => {
  const { service } = fixture(); const project = service.createProject(auth, { name: "Council" }).state!; service.submitSpec(auth, { projectId: project.id, spec: "Build a sensitive service" });
  assert.throws(() => service.beginArchitecture(auth, { projectId: project.id, mode: "council", specialistRoles: ["security"] }), /two to four/);
  const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "council", specialistRoles: ["security", "reliability"] }).state!; assert.deepEqual(draft.councilRoles, ["reliability", "security"]); service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: example });
  service.submitReview(auth, { draftId: draft.id, verdict: "approve", body: "Security boundaries are acceptable.", kind: "security", reviewerContextId: "security-critic" }); await assert.rejects(service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }), /independent context/);
  service.submitReview(auth, { draftId: draft.id, verdict: "approve", body: "Failure recovery is acceptable.", kind: "reliability", reviewerContextId: "security-critic" }); await assert.rejects(service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }), /independent context/);
  service.submitReview(auth, { draftId: draft.id, verdict: "approve", body: "An independently reviewed recovery path is acceptable.", kind: "reliability", reviewerContextId: "reliability-critic" }); assert.equal((await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null })).accepted, true);
});

test("public drafts reject executable harness source", () => {
  const { service } = fixture(); const project = service.createProject(auth, { name: "Example" }).state!; service.submitSpec(auth, { projectId: project.id, spec: "x" }); const draft = service.beginArchitecture(auth, { projectId: project.id }).state!;
  const unsafe = structuredClone(example); unsafe.nodes[0]!.acceptance.cases[0]!.harness = "import os";
  const result = service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: unsafe }); assert.equal(result.accepted, false); assert.ok(result.diagnostics.some((d) => d.code === "EXECUTABLE_HARNESS_FORBIDDEN"));
});

test("legacy string interfaces are normalized into typed contracts", () => {
  const { service } = fixture(); const project = service.createProject(auth, { name: "Legacy" }).state!; service.submitSpec(auth, { projectId: project.id, spec: "x" }); const draft = service.beginArchitecture(auth, { projectId: project.id }).state!, legacy = structuredClone(example) as any; legacy.nodes[0].provides = "LegacyApi";
  const updated = service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: legacy }); assert.equal(updated.state.document.nodes[0].provides.name, "LegacyApi"); assert.equal(updated.state.document.nodes[0].provides.operations[0].signature, "LegacyApi");
});

test("client-driven leases advance a provider-free build without an embedded model", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-build-")), store = new FoundryStore(join(root, "db.sqlite")), worker: WorkerPort = { async applyAndTest(input) { return { verdict: "green", diagnostics: { node: input.node.id }, digest: `sha256:${"a".repeat(64)}` }; } };
  const service = new FoundryCommandService(store, new ArtifactStore(join(root, "artifacts")), new InProcessEngine(), worker, { roots: { test: root } }); const project = service.createProject(auth, { name: "Build" }).state!; service.bindWorkspace(auth, { projectId: project.id, rootId: "test" }); service.submitSpec(auth, { projectId: project.id, spec: "Build string utilities" }); const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "solo" }).state!; service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: example }); const revision = await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null });
  const build = await service.startBuild(auth, { projectId: project.id, revisionId: revision.revisionId }); let ready = (await service.getReadyWork(auth, { buildId: build.state.build_id, limit: 16 })).state!; assert.equal(ready.length, 3);
  for (const work of ready) await service.submitNodeChanges(auth, { buildId: build.state.build_id, changeSet: { leaseId: work.leaseId, targetId: work.nodeId, baseDigest: work.baseDigest, content: "# client-authored\n", summary: "implement leaf" } });
  ready = (await service.getReadyWork(auth, { buildId: build.state.build_id })).state!; assert.equal(ready[0].nodeId, "string-utils"); await service.submitNodeChanges(auth, { buildId: build.state.build_id, changeSet: { leaseId: ready[0].leaseId, targetId: ready[0].nodeId, baseDigest: ready[0].baseDigest, content: "# client-authored integrator\n", summary: "integrate" } });
  const final = await service.getBuild(auth, build.state.build_id); assert.ok(Object.values(final.state.nodes).every((verdict) => verdict === "green")); assert.equal(existsSync(join(root, "src", "lowercase.py")), false, "client changes remain in the build overlay until publication"); store.close();
});

test("subtree proposals preserve the parent-facing M4 authority boundary", async () => {
  const { service } = fixture(); const project = service.createProject(auth, { name: "Rearchitecture" }).state!; service.submitSpec(auth, { projectId: project.id, spec: "x" }); const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "solo" }).state!; service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: example }); await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }); const proposal = await service.beginRearchitecture(auth, { projectId: project.id, targetNodeId: "hyphenate" });
  const replacement = structuredClone(example.nodes.find((node) => node.id === "hyphenate")!); replacement.implementation.composition = "new internal algorithm"; assert.equal(service.submitSubtreeProposal(auth, { proposalId: proposal.state.id, nodes: [replacement] }).accepted, true); assert.equal((await service.validateProposal(auth, proposal.state.id)).state.valid, true);
  replacement.provides.name = "UnauthorizedInterface"; assert.throws(() => service.submitSubtreeProposal(auth, { proposalId: proposal.state.id, nodes: [replacement] }), /preserve target ID/);
});

test("repository publication applies exactly a prepared digest and preserves unrelated dirt", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-publish-")); writeFileSync(join(root, "README.md"), "initial\n"); execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "foundry@test.invalid"], { cwd: root }); execFileSync("git", ["config", "user.name", "Foundry Test"], { cwd: root }); execFileSync("git", ["add", "README.md"], { cwd: root }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  const store = new FoundryStore(join(root, ".foundry-test.sqlite")), service = new FoundryCommandService(store, new ArtifactStore(join(root, ".artifacts")), new InProcessEngine(), null, { roots: { repo: root } }); const project = service.createProject(auth, { name: "Publish" }).state!; service.bindWorkspace(auth, { projectId: project.id, rootId: "repo" }); service.submitSpec(auth, { projectId: project.id, spec: "x" }); const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "solo" }).state!; service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture: example }); const revision = await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }); writeFileSync(join(root, "README.md"), "unrelated dirty edit\n");
  const prepared = service.prepareRepositoryUpdate(auth, { projectId: project.id, revisionId: revision.revisionId }).state!;
  assert.ok(prepared.changes.length > 4); assert.match(prepared.diff, /architecture\.excalidraw/); assert.match(prepared.diff, /Binary file .*\.png/);
  const applied = service.applyRepositoryUpdate(auth, { projectId: project.id, revisionId: revision.revisionId!, preparedDigest: prepared.preparedDigest, confirmationToken: prepared.confirmationToken });
  assert.equal(applied.state.committed, true); assert.equal(applied.state.recovered, false); assert.equal((store.db.prepare("SELECT status FROM outbox WHERE id=?").get(prepared.confirmationToken) as any).status, "completed"); assert.match(readFileSync(join(root, "architecture", "foundry.ir.json"), "utf8"), /string-utils/); assert.ok(existsSync(join(root, "architecture", "architecture.excalidraw"))); assert.ok(applied.state.paths.some((path: string) => path.endsWith(".puml"))); assert.ok(applied.state.paths.some((path: string) => path.endsWith(".svg"))); assert.ok(applied.state.paths.some((path: string) => path.endsWith(".png")));
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "unrelated dirty edit\n"); assert.match(execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: root, encoding: "utf8" }), /foundry: publish architecture/);
  // Simulate a crash after Git commit but before the SQLite completion transaction.
  store.db.prepare("UPDATE confirmations SET used_at=NULL WHERE token=?").run(prepared.confirmationToken); store.db.prepare("UPDATE outbox SET status='pending',completed_at=NULL WHERE id=?").run(prepared.confirmationToken); const recovered = service.applyRepositoryUpdate(auth, { projectId: project.id, revisionId: revision.revisionId!, preparedDigest: prepared.preparedDigest, confirmationToken: prepared.confirmationToken }); assert.equal(recovered.state.recovered, true); assert.throws(() => service.applyRepositoryUpdate(auth, { projectId: project.id, revisionId: revision.revisionId!, preparedDigest: prepared.preparedDigest, confirmationToken: prepared.confirmationToken }), /Confirmation/);
  const generated = applied.state.paths.find((path: string) => path.endsWith(".puml")); writeFileSync(join(root, generated), "uncommitted overlap\n"); assert.throws(() => service.prepareRepositoryUpdate(auth, { projectId: project.id, revisionId: revision.revisionId }), /uncommitted changes/); store.close();
});

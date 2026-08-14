import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { executeTest } from "../../pi-pool/src/tester.ts";
import { executeAssembly } from "../../pi-pool/src/assembly.ts";
import { applyAndTest } from "../../pi-pool/src/apply.ts";
import { executeMutation } from "../../pi-pool/src/mutation.ts";
import { deliveryDiagnostics, generatePythonConformance } from "./delivery.ts";
import type { FoundryArchitecture, FoundryAuthorizationContext } from "./types.ts";
import { ArtifactStore } from "./artifacts.ts";
import { FoundryCommandService, HttpWorker, type WorkerPort } from "./commands.ts";
import { InProcessEngine } from "./engine-client.ts";
import { FoundryStore } from "./store.ts";

const fixture = (variant: "broken" | "fixed") => resolve("fixtures", "python-pricing-engine", variant);

const architecture: FoundryArchitecture = {
  version: 3,
  spec: { name: "python-pricing-engine", language: "python" },
  root: "pricing-engine",
  requirements: [{ id: "identity", kind: "functional", text: "Expose identity", priority: "must" }],
  delivery: { profile: "python-library", integrationNode: "pricing-engine", runtime: { language: "python", versionRange: ">=3.11" }, sourceRoot: ".", distributionName: "python-pricing-engine", publicModule: "pricing_engine", dependencyPolicy: "none", metadataTargetId: "metadata", readmeTargetId: "readme" },
  nodes: [
    { id: "catalog", kind: "leaf", owner: "pricing-engine", provides: { name: "Catalog", operations: [{ name: "Catalog", signature: "Catalog()" }] }, requires: [], implementation: { language: "python", targets: [{ targetId: "catalog-source", path: "pricing_engine/catalog.py", mediaType: "text/x-python", role: "source" }] }, acceptance: { mandate_owner: "pricing-engine", language: "python", cases: [{ name: "construct", call: "Catalog().__class__.__name__", expect: "Catalog", covers: ["identity"] }] } },
    { id: "pricing-engine", kind: "integrator", owner: null, provides: { name: "PricingEngine", operations: [{ name: "identity", signature: "identity(value)" }] }, requires: [{ node: "catalog", interface: "Catalog" }], implementation: { children: ["catalog"], primaryTargetId: "engine-source", targets: [{ targetId: "engine-source", path: "pricing_engine/pricing_engine.py", mediaType: "text/x-python", role: "entrypoint" }, { targetId: "package-init", path: "pricing_engine/__init__.py", mediaType: "text/x-python", role: "source" }, { targetId: "build-backend", path: "foundry_backend.py", mediaType: "text/x-python", role: "source" }, { targetId: "metadata", path: "pyproject.toml", mediaType: "text/plain", role: "metadata" }, { targetId: "readme", path: "README.md", mediaType: "text/markdown", role: "documentation" }] }, acceptance: { mandate_owner: "spec", language: "python", cases: [{ name: "identity", call: "identity('ok')", expect: "ok", covers: ["identity"] }] } },
  ],
};

test("pricing-engine control passes flattened acceptance but fails repository-shaped import", async () => {
  const flat = await executeTest({ node_id: "pricing-engine", language: "python", workspace: fixture("broken"), write_target: "pricing_engine/pricing_engine.py", provides: architecture.nodes[1]!.provides, acceptance: architecture.nodes[1]!.acceptance, deps: [{ import_name: "catalog", read_path: "pricing_engine/catalog.py" }] }, { mode: "local" });
  assert.equal(flat.verdict, "green");
  const repository = await executeTest({ node_id: "pricing-engine", language: "python", workspace: fixture("broken"), write_target: "pricing_engine/pricing_engine.py", provides: architecture.nodes[1]!.provides, acceptance: architecture.nodes[1]!.acceptance, deps: [], repository_layout: true, module_import_name: "pricing_engine.pricing_engine", runtime_version_range: ">=3.11", repository_files: ["pricing_engine/catalog.py", "pricing_engine/pricing_engine.py"] }, { mode: "local" });
  assert.equal(repository.verdict, "red"); assert.match(repository.failures[0]!.error!, /catalog/);
});

test("IR v3 delivery validates coverage and multi-target ownership", () => {
  assert.deepEqual(deliveryDiagnostics(architecture), []);
  const uncovered = structuredClone(architecture); for (const node of uncovered.nodes) for (const acceptance of node.acceptance.cases) acceptance.covers = [];
  assert.ok(deliveryDiagnostics(uncovered).some((diagnostic) => diagnostic.code === "MUST_REQUIREMENT_UNCOVERED"));
  const overlap = structuredClone(architecture); overlap.nodes[1]!.implementation.targets![0]!.path = "pricing_engine/catalog.py";
  assert.ok(deliveryDiagnostics(overlap).some((diagnostic) => diagnostic.code === "DUPLICATE_TARGET_PATH"));
});

test("IR v4 generates eval-free discoverable typed conformance for every node", { timeout: 180_000 }, async () => {
  const typed = structuredClone(architecture); typed.version = 4;
  typed.nodes[0]!.provides.operations[0]!.parameters = []; typed.nodes[0]!.provides.operations[0]!.returns = "Catalog";
  typed.nodes[0]!.acceptance.cases = []; typed.nodes[0]!.acceptance.scenarios = [{ id: "construct", name: "construct catalog", covers: [], steps: [{ id: "create", operation: "Catalog", arguments: [], bind: "catalog" }] }];
  typed.nodes[1]!.provides.operations[0]!.parameters = [{ name: "value", type: "string" }]; typed.nodes[1]!.provides.operations[0]!.returns = "string";
  typed.nodes[1]!.acceptance.cases = []; typed.nodes[1]!.acceptance.scenarios = [{ id: "identity", name: "returns the supplied value", covers: ["identity"], steps: [{ id: "call", operation: "identity", arguments: ["ok"], expect: { kind: "equals", value: "ok" } }] }];
  assert.deepEqual(deliveryDiagnostics(typed), []);
  const conformance = generatePythonConformance(typed); assert.doesNotMatch(conformance, /eval\s*\(/); assert.match(conformance, /setattr\(FoundryAcceptance/);
  const result = await executeAssembly({ workspace: fixture("fixed"), buildId: "build-v4", revisionId: "revision-v4", architecture: typed, conformance }, { mode: "local" });
  assert.equal(result.verdict, "green", JSON.stringify(result.evidence.diagnostics)); assert.match(result.evidence.diagnostics.checks.find((check: any) => check.name === "conformance").detail, /Ran 2 tests/);
  const unsafe = structuredClone(typed); unsafe.nodes[1]!.acceptance.scenarios![0]!.steps[0]!.operation = "missing";
  assert.ok(deliveryDiagnostics(unsafe).some((diagnostic) => diagnostic.code === "UNKNOWN_ACCEPTANCE_OPERATION"));
});

test("fixed pricing package passes clean wheel assembly and generated conformance", { timeout: 180_000 }, async () => {
  const conformance = generatePythonConformance(architecture); assert.match(conformance, /from pricing_engine import identity/);
  const result = await executeAssembly({ workspace: fixture("fixed"), buildId: "build-fixed", revisionId: "revision-fixed", architecture, conformance }, { mode: "local" });
  assert.equal(result.verdict, "green", JSON.stringify(result.evidence.diagnostics)); assert.equal(result.evidence.failed, 0);
});

test("assembly fails closed when the declared Python runtime is unavailable", async () => {
  const unsupported = structuredClone(architecture); unsupported.delivery!.runtime.versionRange = ">=99.0";
  const result = await executeAssembly({ workspace: fixture("fixed"), buildId: "build-runtime", revisionId: "revision-runtime", architecture: unsupported, conformance: generatePythonConformance(unsupported) }, { mode: "local" });
  assert.equal(result.verdict, "red"); assert.equal(result.evidence.diagnostics.code, "RUNTIME_UNAVAILABLE");
});

test("assembly rejects missing delivery files and undeclared wheel dependencies", { timeout: 180_000 }, async () => {
  const missing = mkdtempSync(join(tmpdir(), "foundry-missing-readme-")); cpSync(fixture("fixed"), missing, { recursive: true }); unlinkSync(join(missing, "README.md"));
  const missingResult = await executeAssembly({ workspace: missing, buildId: "build-missing", revisionId: "revision-missing", architecture, conformance: generatePythonConformance(architecture) }, { mode: "local" });
  assert.equal(missingResult.verdict, "red"); assert.ok(missingResult.evidence.diagnostics.checks.some((check: any) => check.name === "readme" && !check.passed));
  const dependency = mkdtempSync(join(tmpdir(), "foundry-dependency-")); cpSync(fixture("fixed"), dependency, { recursive: true }); const backend = join(dependency, "foundry_backend.py"); writeFileSync(backend, readFileSync(backend, "utf8").replace("Requires-Python: >=3.11\\n", "Requires-Python: >=3.11\\nRequires-Dist: requests>=2\\n"));
  const dependencyResult = await executeAssembly({ workspace: dependency, buildId: "build-dependency", revisionId: "revision-dependency", architecture, conformance: generatePythonConformance(architecture) }, { mode: "local" });
  assert.equal(dependencyResult.verdict, "red"); assert.ok(dependencyResult.evidence.diagnostics.checks.some((check: any) => check.name === "dependency-policy-none" && !check.passed));
});

test("multi-target submissions fail before writes when their aggregate exceeds 2 MB", async () => {
  await assert.rejects(applyAndTest({ workspace: fixture("fixed"), node: architecture.nodes[0]!, architecture, plan: { import_names: { catalog: "catalog", "pricing-engine": "pricing_engine" }, write_targets: {}, read_sets: { catalog: [] } }, files: [{ targetId: "catalog-source", path: "pricing_engine/catalog.py", content: "x".repeat(2 * 1024 * 1024 + 1) }] }, { mode: "local" }), /exceeds 2 MB/);
});

test("worker rejects hard-linked compiler targets without modifying the linked host file", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-hardlink-workspace-")), outside = join(dirname(workspace), `foundry-hardlink-host-${Date.now()}.py`); mkdirSync(join(workspace, "pricing_engine")); writeFileSync(outside, "class Catalog: pass\n"); linkSync(outside, join(workspace, "pricing_engine/catalog.py"));
  await assert.rejects(applyAndTest({ workspace, node: architecture.nodes[0]!, architecture, plan: { import_names: { catalog: "catalog" }, write_targets: {}, read_sets: { catalog: [] } }, files: [{ targetId: "catalog-source", path: "pricing_engine/catalog.py", content: "changed=True\n" }] }, { mode: "local" }), /hard link/); assert.equal(readFileSync(outside, "utf8"), "class Catalog: pass\n"); unlinkSync(outside);
});

test("red verification is transactional and leaves the durable overlay unchanged", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-red-overlay-")); cpSync(fixture("fixed"), workspace, { recursive: true }); const target = join(workspace, "pricing_engine/catalog.py"), before = readFileSync(target);
  const result = await applyAndTest({ workspace, node: architecture.nodes[0]!, architecture, plan: { import_names: { catalog: "catalog" }, write_targets: {}, read_sets: { catalog: [] } }, files: [{ targetId: "catalog-source", path: "pricing_engine/catalog.py", content: "raise RuntimeError('broken')\n" }] }, { mode: "local" });
  assert.equal(result.outcome, "authored_red"); assert.deepEqual(readFileSync(target), before);
});

test("Python AST mutation reports surviving and killed mutants deterministically", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-mutation-fixture-")); writeFileSync(join(workspace, "calc.py"), "__all__ = ['allowed', 'rounded']\ndef allowed(value):\n    return value > 0\ndef rounded(value):\n    return round(value, 2)\n");
  const conformance = "import calc\nassert calc.__all__ == ['allowed', 'rounded']\nassert calc.allowed(1) is True\nassert calc.allowed(0) is False\nassert calc.rounded(1.235) == 1.24\n";
  const first = await executeMutation({ workspace, sourcePath: "calc.py", repositoryFiles: ["calc.py"], conformance, maxMutants: 64 }, { mode: "local" }); const second = await executeMutation({ workspace, sourcePath: "calc.py", repositoryFiles: ["calc.py"], conformance, maxMutants: 64 }, { mode: "local" });
  assert.deepEqual(first, second); assert.equal(first.generated, first.killed); assert.equal(first.score, 1); assert.deepEqual([...new Set(first.mutants.map((mutant: any) => mutant.operation))].sort(), ["compare", "public-export", "rounding"]);
});

test("subscription benchmark kills tenant, transaction, idempotency, and balance mutation classes", { timeout: 30_000 }, async () => {
  const workspace = resolve("fixtures", "python-subscription-service"), serviceArchitecture = JSON.parse(readFileSync(join(workspace, "foundry-v4.ir.json"), "utf8")) as FoundryArchitecture, report = await executeMutation({ workspace, sourcePath: "subscription_service/service.py", repositoryFiles: serviceArchitecture.nodes.flatMap((node) => node.implementation.targets!.map((target) => target.path)), conformance: generatePythonConformance(serviceArchitecture), maxMutants: 24 }, { mode: "local" });
  assert.equal(report.score, 1); assert.equal(report.survived.length, 0); const operations = new Set(report.mutants.map((mutant: any) => mutant.operation)); for (const expected of ["condition", "compare", "boolop", "transaction-call", "tuple-element"]) assert.ok(operations.has(expected), `missing ${expected} mutation`);
});

test("IR v4 Python service profile installs, starts outside source, serves typed HTTP scenarios, persists SQLite schema, and shuts down", { timeout: 180_000 }, async () => {
  const workspace = resolve("fixtures", "python-subscription-service"), serviceArchitecture = JSON.parse(readFileSync(join(workspace, "foundry-v4.ir.json"), "utf8")) as FoundryArchitecture; assert.deepEqual(deliveryDiagnostics(serviceArchitecture), []); const conformance = generatePythonConformance(serviceArchitecture); assert.doesNotMatch(conformance, /eval\s*\(/); assert.match(conformance, /FoundryServiceAcceptance/);
  const result = await executeAssembly({ workspace, buildId: "subscription-service", revisionId: "service-v4", architecture: serviceArchitecture, conformance }, { mode: "local" }); assert.equal(result.verdict, "green", JSON.stringify(result.evidence.diagnostics)); assert.ok(result.evidence.diagnostics.checks.some((check: any) => check.name === "conformance" && check.passed));
});

test("infrastructure failures preserve source and authored retry budget and replay by submission id", { timeout: 15_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-infra-workspace-")), stateRoot = mkdtempSync(join(tmpdir(), "foundry-infra-state-")), store = new FoundryStore(join(stateRoot, "foundry.sqlite"));
  const worker: WorkerPort = { async applyAndTest() { throw new Error("piston unavailable"); } };
  const service = new FoundryCommandService(store, new ArtifactStore(join(stateRoot, "artifacts")), new InProcessEngine(), worker, { roots: { fixture: workspace }, runRoot: join(stateRoot, "runs") }); const auth: FoundryAuthorizationContext = { tenantId: "t", userId: "u", clientId: "codex", contextId: "author", transport: "test", scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:admin"] };
  const project = service.createProject(auth, { name: "Infra" }).state!; service.bindWorkspace(auth, { projectId: project.id, rootId: "fixture" }); service.submitSpec(auth, { projectId: project.id, spec: "Build" }); const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "solo" }).state!; service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture }); const revision = await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }), build = await service.startBuild(auth, { projectId: project.id, revisionId: revision.revisionId }), lease = (await service.getReadyWork(auth, { buildId: build.state.build_id })).state![0];
  const changeSet = { submissionId: "submission-infra-1", leaseId: lease.leaseId, targetId: "catalog", baseDigest: null, content: "class Catalog: pass\n", summary: "catalog" }; const first = await service.submitNodeChanges(auth, { buildId: build.state.build_id, changeSet }); const replay = await service.submitNodeChanges(auth, { buildId: build.state.build_id, changeSet });
  assert.equal(first.state.result.outcome, "infrastructure_error"); assert.equal(first.state.build.nodes.catalog, "infrastructure_blocked"); assert.deepEqual(replay, first); assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM attempts").get() as any).count, 0); assert.equal(existsSync(join(stateRoot, "runs", build.state.build_id, "pricing_engine/catalog.py")), false); store.close();
});

test("IR v4 command path requires two matching Piston assemblies and exposes evidence v2", { timeout: 15_000 }, async () => {
  const source = resolve("fixtures", "python-subscription-service"), architecture = JSON.parse(readFileSync(join(source, "foundry-v4.ir.json"), "utf8")) as FoundryArchitecture, workspace = mkdtempSync(join(tmpdir(), "foundry-replay-workspace-")), stateRoot = mkdtempSync(join(tmpdir(), "foundry-replay-state-")); let assemblies = 0;
  const worker: WorkerPort = { async applyAndTest() { return { verdict: "green", outcome: "accepted_green", diagnostics: { passed: 1 }, digest: "sha256:" + "1".repeat(64) }; }, async assemble(input) { assemblies++; return { verdict: "green", evidence: { schemaVersion: 2, buildId: input.buildId, revisionId: input.revisionId, profile: "python-service", runtime: { requested: ">=3.11", resolved: "3.11.2" }, environment: { worker: "fixture", sandbox: "piston", oracle: "piston:python:3.11.2" }, tooling: {}, wheelDigest: `raw-${assemblies}`, packageDigest: "sha256:" + "2".repeat(64), targetDigests: { service: "sha256:" + "3".repeat(64) }, passed: 4, failed: 0, diagnostics: { checks: [{ name: "conformance", passed: true }] }, durationMs: assemblies } }; } };
  const store = new FoundryStore(join(stateRoot, "foundry.sqlite")), service = new FoundryCommandService(store, new ArtifactStore(join(stateRoot, "artifacts")), new InProcessEngine(), worker, { roots: { fixture: workspace }, runRoot: join(stateRoot, "runs"), mutationMode: "shadow" }), auth: FoundryAuthorizationContext = { tenantId: "t", userId: "u", clientId: "codex", contextId: "author", transport: "test", scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:admin"] };
  const project = service.createProject(auth, { name: "Replay" }).state!; service.bindWorkspace(auth, { projectId: project.id, rootId: "fixture" }); service.submitSpec(auth, { projectId: project.id, spec: "Service" }); const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "solo" }).state!; service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture }); const revision = await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }), build = await service.startBuild(auth, { projectId: project.id, revisionId: revision.revisionId }), lease = (await service.getReadyWork(auth, { buildId: build.state.build_id })).state![0], node = architecture.nodes[0]!, files = node.implementation.targets!.map((target) => ({ targetId: target.targetId, baseDigest: null, content: readFileSync(join(source, target.path), "utf8") }));
  const submitted = await service.submitNodeChanges(auth, { buildId: build.state.build_id, changeSet: { submissionId: "reproducible-submit", leaseId: lease.leaseId, targetId: node.id, baseDigest: null, files, summary: "service" } }); assert.equal(submitted.state.assembly.status, "green"); assert.equal(assemblies, 2); const conformance = (await service.getConformance(auth, build.state.build_id)).state, reproducibility = (await service.getReproducibilityEvidence(auth, build.state.build_id)).state; assert.equal(conformance.schemaVersion, 2); assert.equal(conformance.testSourceDigest, conformance.conformanceDigest); assert.equal(reproducibility.status, "green"); assert.deepEqual(reproducibility.differences, []); store.close();
});

test("local Piston limits admit bounded assembly evidence", () => {
  const compose = readFileSync(resolve("deploy", "piston", "compose.yaml"), "utf8");
  assert.match(compose, /PISTON_RUN_TIMEOUT: "180000"/); assert.match(compose, /PISTON_RUN_CPU_TIME: "180000"/); assert.match(compose, /PISTON_OUTPUT_MAX_SIZE: "16777216"/);
});

test("an unavailable deterministic worker returns a structured error", async () => {
  await assert.rejects(new HttpWorker("http://127.0.0.1:1").assemble({ workspace: fixture("fixed"), buildId: "offline", revisionId: "offline", architecture, conformance: generatePythonConformance(architecture) }), (error: any) => error?.code === "WORKER_UNAVAILABLE" && /unreachable/.test(error.message));
});

test("multi-target GraphReact build remains assembling until mandatory assembly evidence is green", { timeout: 180_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-v3-workspace-")); writeFileSync(join(workspace, ".gitignore"), ".foundry\n"); execFileSync("git", ["init", "-q"], { cwd: workspace }); execFileSync("git", ["config", "user.email", "foundry@test.invalid"], { cwd: workspace }); execFileSync("git", ["config", "user.name", "Foundry Test"], { cwd: workspace }); execFileSync("git", ["add", ".gitignore"], { cwd: workspace }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: workspace });
  const stateRoot = mkdtempSync(join(tmpdir(), "foundry-v3-state-")), store = new FoundryStore(join(stateRoot, "foundry.sqlite"));
  const worker: WorkerPort = { applyAndTest: (input) => applyAndTest(input, { mode: "local" }), assemble: (input) => executeAssembly(input, { mode: "local" }) };
  const service = new FoundryCommandService(store, new ArtifactStore(join(stateRoot, "artifacts")), new InProcessEngine(), worker, { roots: { fixture: workspace }, runRoot: join(stateRoot, "runs") });
  const auth: FoundryAuthorizationContext = { tenantId: "t", userId: "u", clientId: "codex", contextId: "author", transport: "test", scopes: ["foundry:read", "foundry:architect", "foundry:build", "foundry:activate", "foundry:publish", "foundry:admin"] };
  const project = service.createProject(auth, { name: "Pricing" }).state!; service.bindWorkspace(auth, { projectId: project.id, rootId: "fixture" }); service.submitSpec(auth, { projectId: project.id, spec: "Build a package" }); const draft = service.beginArchitecture(auth, { projectId: project.id, mode: "solo" }).state!; assert.equal(service.updateArchitecture(auth, { draftId: draft.id, expectedVersion: 1, architecture }).accepted, true); const revision = await service.activateArchitecture(auth, { draftId: draft.id, expectedActiveRevision: null }); const build = await service.startBuild(auth, { projectId: project.id, revisionId: revision.revisionId });
  let ready = (await service.getReadyWork(auth, { buildId: build.state.build_id })).state!; assert.equal(ready[0].nodeId, "catalog"); const leaf = await service.submitNodeChanges(auth, { buildId: build.state.build_id, changeSet: { leaseId: ready[0].leaseId, targetId: "catalog", baseDigest: null, content: readFileSync(join(fixture("fixed"), "pricing_engine/catalog.py"), "utf8"), summary: "catalog" } }); assert.equal(leaf.state.result.verdict, "green", JSON.stringify(leaf.state.result.diagnostics));
  ready = (await service.getReadyWork(auth, { buildId: build.state.build_id })).state!; assert.equal(ready[0].nodeId, "pricing-engine"); const root = architecture.nodes[1]!; const files = root.implementation.targets!.map((target) => ({ targetId: target.targetId, baseDigest: null, content: readFileSync(join(fixture("fixed"), target.path), "utf8") })); const submitted = await service.submitNodeChanges(auth, { buildId: build.state.build_id, changeSet: { leaseId: ready[0].leaseId, targetId: "pricing-engine", baseDigest: null, files, summary: "integrate package" } }); assert.equal(submitted.state.assembly.status, "green");
  const persisted = store.db.prepare("SELECT status FROM builds WHERE id=?").get(build.state.build_id) as any; assert.equal(persisted.status, "green"); const evidence = (await service.getAssemblyEvidence(auth, build.state.build_id)).state; assert.equal(evidence.status, "green"); assert.match(evidence.evidenceDigest, /^sha256:/);
  assert.throws(() => service.prepareRepositoryUpdate(auth, { projectId: project.id, revisionId: revision.revisionId, buildId: build.state.build_id }), (error: any) => error.code === "DELIVERY_PROFILE_REQUIRED");
  const architectureOnly = service.prepareRepositoryUpdate(auth, { projectId: project.id, revisionId: revision.revisionId }).state; assert.equal(architectureOnly.buildId, null); assert.ok(architectureOnly.changes.some((change: any) => change.path === "architecture/foundry.ir.json")); store.close();
});

import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ArtifactStore } from "./artifacts.ts";
import { sha256 } from "./artifacts.ts";
import type { EnginePort, EngineBuildState } from "./engine-client.ts";
import { renderArchitecture, validateLayoutImport } from "./projections.ts";
import { deliveryDiagnostics, generatePythonConformance, MAX_CHANGESET_BYTES, primaryTarget, targetsFor } from "./delivery.ts";
import { assertRepoRelative, requireProject, requireScope, resolveBoundPath } from "./security.ts";
import type { AnyFoundryArchitecture, ArchitectMode, CommandResult, Diagnostic, FoundryArchitecture, FoundryAuthorizationContext, FoundryDependencyException, FoundryNodeEvidenceV3, FoundryProductArchitectureV5, FoundryProductEvidenceV3, FoundryProductNodeV5, FoundryRequirementAllocation, FoundryScopedDependency, FoundryInfrastructureFailure, FoundryVerificationOutcome, NodeChangeSet } from "./types.ts";
import { FoundryCommandError } from "./types.ts";
import type { FoundryStore } from "./store.ts";
import { cloneProductArchitecture, compileProductArchitecture, findProductNode } from "./product.ts";
import { builtInCapabilities } from "./capabilities.ts";

export interface WorkerPort {
  applyAndTest(input: { workspace: string; node: FoundryArchitecture["nodes"][number]; architecture: FoundryArchitecture; plan: EngineBuildState["plan"]; files: Array<{ targetId: string; path: string; content: string }> }): Promise<{ verdict: "green" | "red"; outcome?: "accepted_green" | "authored_red"; diagnostics: unknown; digest: string }>;
  assemble?(input: { workspace: string; buildId: string; revisionId: string; architecture: FoundryArchitecture; conformance: string }): Promise<{ verdict: "green" | "red"; evidence: any }>;
  health?(): Promise<unknown>;
  mutate?(input: { workspace: string; sourcePath: string; repositoryFiles: string[]; conformance: string; maxMutants?: number }): Promise<any>;
  applyAndTestProduct?(input: { workspace: string; workId: string; nodePath: string; node: FoundryProductNodeV5; architecture: FoundryProductArchitectureV5; plan: EngineBuildState["plan"]; files: Array<{ targetId: string; path: string; content: string }> }): Promise<{ verdict: "green" | "red"; outcome?: "accepted_green" | "authored_red" | "contract_weak"; diagnostics: unknown; digest: string; evidence?: unknown }>;
  integrateProduct?(input: { workspace: string; buildId: string; revisionId: string; nodePath: string; node: FoundryProductNodeV5; architecture: FoundryProductArchitectureV5; childEvidenceDigests: Record<string, string> }): Promise<{ verdict: "green" | "red"; diagnostics: unknown; evidence: unknown }>;
  assembleProduct?(input: { workspace: string; buildId: string; revisionId: string; architecture: FoundryProductArchitectureV5; deliverables: Array<{ deliverableId: string; ownerPath: string; kind: string; output?: unknown }> }): Promise<{ verdict: "green" | "red"; deliverables: Array<{ deliverableId: string; artifactBase64?: string; mediaType?: string; diagnostics?: unknown }>; evidence: unknown }>;
}

export class HttpWorker implements WorkerPort {
  constructor(private readonly baseUrl: string) {}
  async applyAndTest(input: Parameters<WorkerPort["applyAndTest"]>[0]): Promise<{ verdict: "green" | "red"; diagnostics: unknown; digest: string }> {
    let response: Response; try { response = await fetch(`${this.baseUrl}/apply-and-test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); } catch (error) { throw new FoundryCommandError("WORKER_UNAVAILABLE", `Deterministic worker is unreachable: ${(error as Error).message}`); }
    if (!response.ok) throw new FoundryCommandError("WORKER_ERROR", `Worker returned ${response.status}`);
    return await response.json() as any;
  }
  async assemble(input: Parameters<NonNullable<WorkerPort["assemble"]>>[0]): Promise<{ verdict: "green" | "red"; evidence: any }> {
    let response: Response; try { response = await fetch(`${this.baseUrl}/assemble`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); } catch (error) { throw new FoundryCommandError("WORKER_UNAVAILABLE", `Deterministic worker is unreachable: ${(error as Error).message}`); }
    if (!response.ok) throw new FoundryCommandError("WORKER_ERROR", `Assembly worker returned ${response.status}`);
    return await response.json() as any;
  }
  async health(): Promise<unknown> { let response: Response; try { response = await fetch(`${this.baseUrl}/health`); } catch (error) { throw new FoundryCommandError("WORKER_UNAVAILABLE", `Deterministic worker is unreachable: ${(error as Error).message}`); } if (!response.ok) throw new FoundryCommandError("WORKER_ERROR", `Worker health returned ${response.status}`); return response.json(); }
  async mutate(input: Parameters<NonNullable<WorkerPort["mutate"]>>[0]): Promise<any> { let response: Response; try { response = await fetch(`${this.baseUrl}/mutation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); } catch (error) { throw new FoundryCommandError("WORKER_UNAVAILABLE", `Mutation worker is unreachable: ${(error as Error).message}`); } if (!response.ok) throw new FoundryCommandError("WORKER_ERROR", `Mutation worker returned ${response.status}`); return response.json(); }
  async applyAndTestProduct(input: Parameters<NonNullable<WorkerPort["applyAndTestProduct"]>>[0]): Promise<any> { return this.productCall("/product/apply-and-test", input); }
  async integrateProduct(input: Parameters<NonNullable<WorkerPort["integrateProduct"]>>[0]): Promise<any> { return this.productCall("/product/integrate", input); }
  async assembleProduct(input: Parameters<NonNullable<WorkerPort["assembleProduct"]>>[0]): Promise<any> { return this.productCall("/product/assemble", input); }
  private async productCall(path: string, input: unknown): Promise<any> { let response: Response; try { response = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); } catch (error) { throw new FoundryCommandError("WORKER_UNAVAILABLE", `Product verifier is unreachable: ${(error as Error).message}`); } if (!response.ok) throw new FoundryCommandError("WORKER_ERROR", `Product verifier returned ${response.status}`); return response.json(); }
}

export interface CommandConfig {
  roots: Record<string, string>;
  leaseMs?: number;
  confirmationMs?: number;
  allowLegacyHarness?: boolean;
  runRoot?: string;
  mutationMode?: "off" | "shadow" | "enforce";
  artifactQuotaBytes?: number;
  productIrV5?: boolean;
}

function provenance(auth: FoundryAuthorizationContext) { return { operationId: randomUUID(), clientId: auth.clientId, at: new Date().toISOString() }; }
const infrastructureSchedule = [250, 1_000, 4_000] as const;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const workIdForBuild = (buildId: string, workId: string): string => sha256(`${buildId}\0${workId}`);
function decodeArtifactBase64(value: string | undefined): Buffer | undefined { if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined; return Buffer.from(value, "base64"); }
function success<T>(auth: FoundryAuthorizationContext, state: T, extra: Partial<CommandResult<T>> = {}): CommandResult<T> { return { accepted: true, state, diagnostics: [], provenance: provenance(auth), ...extra }; }
function normalizeArchitecture(ir: FoundryArchitecture): FoundryArchitecture {
  return { ...ir, version: ir.version === 3 || ir.version === 4 ? ir.version : 2, nodes: ir.nodes.map((node) => { const legacy = node.provides as unknown; return typeof legacy === "string" ? { ...node, provides: { name: legacy, operations: [{ name: legacy, signature: legacy, description: "Normalized from legacy string interface" }] } } : node; }) };
}

function acceptanceCount(node: FoundryArchitecture["nodes"][number]): number { return node.acceptance.scenarios?.length ?? node.acceptance.cases.length; }

function architectureDiagnostics(ir: FoundryArchitecture, allowLegacyHarness: boolean): Diagnostic[] {
  const out: Diagnostic[] = [...deliveryDiagnostics(ir)], ids = new Set<string>();
  for (const [index, node] of ir.nodes.entries()) {
    if (ids.has(node.id)) out.push({ code: "DUPLICATE_NODE", severity: "error", message: `Duplicate node ${node.id}`, path: `/nodes/${index}/id` });
    ids.add(node.id);
    for (const target of targetsFor(node)) try { assertRepoRelative(target.path); } catch (error) { out.push({ code: "INVALID_TARGET", severity: "error", message: (error as Error).message, path: `/nodes/${index}/implementation/targets/${target.targetId}` }); }
    if (!allowLegacyHarness && node.acceptance.cases.some((test) => test.harness !== undefined)) out.push({ code: "EXECUTABLE_HARNESS_FORBIDDEN", severity: "error", message: "Public architecture drafts may not introduce executable harness source", path: `/nodes/${index}/acceptance/cases` });
  }
  const semantic = new Set([...ids, ...(ir.deployment?.nodes.map((n) => n.id) ?? [])]);
  for (const scenario of ir.scenarios ?? []) for (const step of scenario.steps) if (!semantic.has(step.from) || !semantic.has(step.to)) out.push({ code: "DANGLING_SCENARIO_STEP", severity: "error", message: `${step.from} -> ${step.to} references an unknown element`, path: `/scenarios/${scenario.id}` });
  const deploymentIds = new Set(ir.deployment?.nodes.map((n) => n.id));
  for (const link of ir.deployment?.links ?? []) if (!deploymentIds.has(link.from) || !deploymentIds.has(link.to)) out.push({ code: "DANGLING_DEPLOYMENT_LINK", severity: "error", message: `${link.from} -> ${link.to} references an unknown deployment node`, path: "/deployment/links" });
  for (const model of ir.stateModels ?? []) { const states = new Set(model.states); if (!states.has(model.initial)) out.push({ code: "INVALID_INITIAL_STATE", severity: "error", message: `${model.initial} is not a state in ${model.id}`, path: `/stateModels/${model.id}/initial` }); for (const transition of model.transitions) if (!states.has(transition.from) || !states.has(transition.to)) out.push({ code: "DANGLING_STATE_TRANSITION", severity: "error", message: `${transition.from} -> ${transition.to} references an unknown state`, path: `/stateModels/${model.id}/transitions` }); }
  const layoutSemantic = new Set([...semantic, ...(ir.stateModels ?? []).flatMap((model) => model.states.map((state) => `${model.id}:${state}`)), ...["pending", "ready", "leased", "verifying", "green", "red", "contract_weak", "infrastructure_blocked", "rearchitecture", "cancelled"].map((state) => `build:${state}`)]);
  for (const layout of ir.layouts ?? []) for (const [semanticId, box] of Object.entries(layout.positions)) { if (!layoutSemantic.has(semanticId)) out.push({ code: "PHANTOM_LAYOUT_ELEMENT", severity: "error", message: `${semanticId} is not a canonical semantic element`, path: `/layouts/${layout.viewId}/positions/${semanticId}` }); if (![box.x, box.y, box.width ?? 1, box.height ?? 1].every(Number.isFinite) || (box.width ?? 1) <= 0 || (box.height ?? 1) <= 0) out.push({ code: "INVALID_LAYOUT", severity: "error", message: `${semanticId} has invalid geometry`, path: `/layouts/${layout.viewId}/positions/${semanticId}` }); }
  if (!(ir.scenarios ?? []).some((s) => s.critical)) out.push({ code: "NO_CRITICAL_SCENARIO", severity: "warning", message: "Architecture has no critical scenario for sequence review" });
  return out;
}

function adaptiveRisks(current: FoundryArchitecture, base?: FoundryArchitecture): string[] {
  const risks: string[] = [];
  if (!base) return ["initial-architecture"];
  const before = new Map(base.nodes.map((n) => [n.id, n]));
  for (const node of current.nodes) {
    const old = before.get(node.id); if (!old) continue;
    if (old.owner !== node.owner) risks.push(`ownership:${node.id}`);
    if (sha256(JSON.stringify(old.provides)) !== sha256(JSON.stringify(node.provides))) risks.push(`public-contract:${node.id}`);
    if (acceptanceCount(node) < acceptanceCount(old)) risks.push(`weakened-acceptance:${node.id}`);
  }
  if (sha256(JSON.stringify(current.deployment ?? null)) !== sha256(JSON.stringify(base.deployment ?? null))) risks.push("deployment-boundary");
  return [...new Set(risks)];
}

function architectureForRow(store: FoundryStore, row: any): AnyFoundryArchitecture {
  return row.revision_id.startsWith("proposal:")
    ? JSON.parse((store.db.prepare("SELECT proposed_json FROM proposals WHERE id=?").get(row.revision_id.slice(9)) as any).proposed_json)
    : store.revision(row.revision_id).document;
}

function productTargets(node: FoundryProductNodeV5, workKind: "implementation" | "integration" = "implementation") {
  if (workKind === "integration") return [];
  return node.kind === "leaf" ? node.implementation?.targets ?? [] : node.integration?.glue?.targets ?? [];
}

function allProductTargets(root: FoundryProductNodeV5): Array<{ nodePath: string; target: ReturnType<typeof productTargets>[number] }> {
  const out: Array<{ nodePath: string; target: ReturnType<typeof productTargets>[number] }> = [];
  const walk = (node: FoundryProductNodeV5, parent: string | null) => { const path = parent ? `${parent}/${node.id}` : node.id; for (const target of productTargets(node)) out.push({ nodePath: path, target }); for (const child of node.children ?? []) walk(child, path); };
  walk(root, null); return out;
}

function allProductNodes(root: FoundryProductNodeV5): Array<{ nodePath: string; node: FoundryProductNodeV5 }> {
  const out: Array<{ nodePath: string; node: FoundryProductNodeV5 }> = []; const walk = (node: FoundryProductNodeV5, parent: string | null) => { const nodePath = parent ? `${parent}/${node.id}` : node.id; out.push({ nodePath, node }); for (const child of node.children ?? []) walk(child, nodePath); }; walk(root, null); return out;
}

function requireProductNode(document: FoundryProductArchitectureV5, nodePath: string): FoundryProductNodeV5 {
  const node = findProductNode(document.product, nodePath); if (!node) throw new FoundryCommandError("NODE_NOT_FOUND", `${nodePath} was not found`); return node;
}

function requireComposite(document: FoundryProductArchitectureV5, nodePath: string): FoundryProductNodeV5 {
  const node = requireProductNode(document, nodePath); if (node.kind !== "composite") throw new FoundryCommandError("NODE_NOT_COMPOSITE", `${nodePath} is not a composite`); return node;
}

function markLineage(node: FoundryProductNodeV5, oldPath: string, newPath: string): void {
  node.supersedes = oldPath;
  for (const child of node.children ?? []) markLineage(child, `${oldPath}/${child.id}`, `${newPath}/${child.id}`);
}

function rewriteProductPaths(root: FoundryProductNodeV5, oldPrefix: string, newPrefix: string): void {
  const rewrite = (value: string): string => value === oldPrefix ? newPrefix : value.startsWith(`${oldPrefix}/`) ? `${newPrefix}${value.slice(oldPrefix.length)}` : value;
  for (const exception of root.dependencyExceptions ?? []) { exception.providerPath = rewrite(exception.providerPath); exception.consumerPath = rewrite(exception.consumerPath); exception.responsibleOwnerPath = rewrite(exception.responsibleOwnerPath); }
  for (const deliverable of root.deliverables ?? []) for (const input of deliverable.inputArtifacts ?? []) input.node = rewrite(input.node);
  for (const child of root.children ?? []) rewriteProductPaths(child, oldPrefix, newPrefix);
}

function rewriteArchitectureSemanticPaths(document: FoundryProductArchitectureV5, oldPrefix: string, newPrefix: string): void {
  const rewrite = (value: string): string => value === oldPrefix ? newPrefix : value.startsWith(`${oldPrefix}/`) ? `${newPrefix}${value.slice(oldPrefix.length)}` : value;
  rewriteProductPaths(document.product, oldPrefix, newPrefix);
  for (const scenario of document.scenarios ?? []) for (const step of scenario.steps) { step.from = rewrite(step.from); step.to = rewrite(step.to); }
  if (document.deployment) { for (const node of document.deployment.nodes) node.id = rewrite(node.id); for (const link of document.deployment.links) { link.from = rewrite(link.from); link.to = rewrite(link.to); } }
  for (const layout of document.layouts ?? []) layout.positions = Object.fromEntries(Object.entries(layout.positions).map(([id, box]) => [rewrite(id), box]));
}

function replaceProductSubtree(document: FoundryProductArchitectureV5, nodePath: string, replacement: FoundryProductNodeV5): void {
  const parentPath = nodePath.split("/").slice(0, -1).join("/"); if (!parentPath) { document.product = structuredClone(replacement); return; }
  const parent = findProductNode(document.product, parentPath), index = parent?.children?.findIndex((child) => `${parentPath}/${child.id}` === nodePath) ?? -1; if (!parent?.children || index < 0) throw new FoundryCommandError("NODE_NOT_FOUND", "Proposal target is absent from its base revision"); parent.children[index] = structuredClone(replacement);
}

type ReviewApproval = { id: string; kind: string; contextId: string | null };
function selectIndependentCouncilReviews(roles: string[], approvals: ReviewApproval[], at = 0, used = new Set<string>()): ReviewApproval[] | null {
  if (at === roles.length) return [];
  for (const approval of approvals) {
    if (approval.kind !== roles[at] || !approval.contextId || used.has(approval.contextId)) continue;
    used.add(approval.contextId); const rest = selectIndependentCouncilReviews(roles, approvals, at + 1, used); used.delete(approval.contextId);
    if (rest) return [approval, ...rest];
  }
  return null;
}

export class FoundryCommandService {
  constructor(
    readonly store: FoundryStore,
    readonly artifacts: ArtifactStore,
    readonly engine: EnginePort,
    readonly worker: WorkerPort | null,
    readonly config: CommandConfig,
  ) {}

  private recordArtifact(digest: string, mediaType: string, provenanceData: unknown): void { const size = this.artifacts.get(digest).length; this.store.db.prepare("INSERT OR IGNORE INTO artifact_records VALUES(?,?,?,?,?)").run(digest, mediaType, size, JSON.stringify(provenanceData), new Date().toISOString()); }
  private linkArtifact(projectId: string, digest: string): void { const exists = this.store.db.prepare("SELECT 1 FROM artifact_projects WHERE digest=? AND project_id=?").get(digest, projectId); if (exists) return; const project = this.store.project(projectId), usage = Number((this.store.db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM artifact_records WHERE digest IN (SELECT DISTINCT ap.digest FROM artifact_projects ap JOIN projects p ON p.id=ap.project_id WHERE p.tenant_id=?)").get(project.tenantId) as any).bytes), alreadyTenantOwned = this.store.db.prepare("SELECT 1 FROM artifact_projects ap JOIN projects p ON p.id=ap.project_id WHERE ap.digest=? AND p.tenant_id=?").get(digest, project.tenantId), size = alreadyTenantOwned ? 0 : Number((this.store.db.prepare("SELECT size FROM artifact_records WHERE digest=?").get(digest) as any)?.size ?? 0), quota = this.config.artifactQuotaBytes ?? 2 * 1024 * 1024 * 1024; if (usage + size > quota) throw new FoundryCommandError("ARTIFACT_QUOTA_EXCEEDED", `Tenant artifact quota of ${quota} bytes would be exceeded`, { tenantId: project.tenantId, usage, size, quota }); this.store.db.prepare("INSERT INTO artifact_projects VALUES(?,?)").run(digest, projectId); }
  private journal(operationId: string, buildId: string, nodeId: string | null, phase: string, payload: unknown): void { this.store.db.prepare("INSERT INTO verification_journal(operation_id,build_id,node_id,phase,payload_json,created_at) VALUES(?,?,?,?,?,?)").run(operationId, buildId, nodeId, phase, JSON.stringify(payload), new Date().toISOString()); }

  private recordManifest(projectId: string, manifest: ReturnType<typeof renderArchitecture>, manifestDigest: string): void {
    const media: Record<string, string> = { plantuml: "text/vnd.plantuml", svg: "image/svg+xml", png: "image/png" };
    for (const diagram of manifest.diagrams) for (const artifact of diagram.artifacts) this.recordArtifact(artifact.digest, media[artifact.format]!, { revisionId: manifest.revisionId, viewId: diagram.viewId, sourceDigest: manifest.sourceDigest });
    this.recordArtifact(manifest.excalidraw.digest, "application/vnd.excalidraw+json", { revisionId: manifest.revisionId, sourceDigest: manifest.sourceDigest }); this.recordArtifact(manifestDigest, "application/json", { revisionId: manifest.revisionId, kind: "diagram-manifest", sourceDigest: manifest.sourceDigest });
    const digests = [manifestDigest, manifest.excalidraw.digest, ...manifest.diagrams.flatMap((diagram) => diagram.artifacts.map((artifact) => artifact.digest))]; for (const digest of digests) this.linkArtifact(projectId, digest);
  }

  readArtifact(auth: FoundryAuthorizationContext, digest: string): Buffer { requireScope(auth, "foundry:read"); const allowed = this.store.db.prepare("SELECT 1 FROM artifact_projects ap JOIN projects p ON p.id=ap.project_id WHERE ap.digest=? AND p.tenant_id=? LIMIT 1").get(digest, auth.tenantId); if (!allowed) throw new FoundryCommandError("ARTIFACT_NOT_FOUND", "Artifact was not found"); return this.artifacts.get(digest); }

  private project(auth: FoundryAuthorizationContext, projectId: string): any {
    requireProject(auth, projectId); const project = this.store.project(projectId);
    if (!project || project.tenantId !== auth.tenantId) throw new FoundryCommandError("PROJECT_NOT_FOUND", "Project was not found");
    return project;
  }

  listProjects(auth: FoundryAuthorizationContext): CommandResult<any[]> { requireScope(auth, "foundry:read"); return success(auth, this.store.listProjects(auth.tenantId)); }

  createProject(auth: FoundryAuthorizationContext, input: { name: string }): CommandResult<any> {
    requireScope(auth, "foundry:architect");
    const state = this.store.createProject(auth.tenantId, input.name.trim()); this.store.event(String(state.id), "project.created", state); return success(auth, state);
  }

  getProject(auth: FoundryAuthorizationContext, projectId: string): CommandResult<any> { requireScope(auth, "foundry:read"); return success(auth, this.project(auth, projectId)); }

  bindWorkspace(auth: FoundryAuthorizationContext, input: { projectId: string; rootId: string; relativePath?: string }): CommandResult<any> {
    requireScope(auth, "foundry:admin"); this.project(auth, input.projectId);
    const root = this.config.roots[input.rootId]; if (!root) throw new FoundryCommandError("UNKNOWN_ROOT", "The configured workspace root does not exist");
    const internal = resolveBoundPath(root, input.relativePath ?? ".");
    return success(auth, this.store.bindWorkspace(input.projectId, input.rootId, input.relativePath ?? ".", internal));
  }

  submitSpec(auth: FoundryAuthorizationContext, input: { projectId: string; spec: string }): CommandResult<any> {
    requireScope(auth, "foundry:architect"); this.project(auth, input.projectId);
    if (!input.spec.trim() || input.spec.length > 200_000) throw new FoundryCommandError("INVALID_SPEC", "Spec must contain 1–200,000 characters");
    const state = this.store.putSpec(input.projectId, input.spec); this.store.event(input.projectId, "spec.updated", { version: state.version }); return success(auth, state);
  }

  beginArchitecture(auth: FoundryAuthorizationContext, input: { projectId: string; mode?: ArchitectMode; specialistRoles?: string[] }): CommandResult<any> {
    requireScope(auth, "foundry:architect"); const project = this.project(auth, input.projectId); const spec = this.store.spec(input.projectId);
    if (!spec) throw new FoundryCommandError("SPEC_REQUIRED", "Submit a specification before beginning architecture");
    const mode = input.mode ?? "adaptive", roles = [...new Set((input.specialistRoles ?? []).map((role) => role.trim()).filter(Boolean))];
    if (mode === "council" && (roles.length < 2 || roles.length > 4)) throw new FoundryCommandError("INVALID_COUNCIL", "Council mode requires two to four explicitly selected specialist roles");
    if (mode !== "council" && roles.length) throw new FoundryCommandError("INVALID_COUNCIL", "Specialist roles are accepted only in explicit council mode");
    const base = project.activeRevisionId ? this.store.revision(project.activeRevisionId)?.document : undefined;
    const seed: FoundryArchitecture = base ? normalizeArchitecture(base) : { version: 2, spec: { name: project.name, description: spec.body }, root: "system", nodes: [] };
    const draft = this.store.createDraft(input.projectId, project.activeRevisionId, mode, seed); if (roles.length) this.store.setCouncilRoles(draft.id, roles); return success(auth, this.store.draft(draft.id));
  }

  beginProductArchitecture(auth: FoundryAuthorizationContext, input: { projectId: string; productId?: string; mode?: ArchitectMode }): CommandResult<any> {
    if (!this.config.productIrV5) throw new FoundryCommandError("PRODUCT_IR_V5_DISABLED", "Recursive product authoring requires FOUNDRY_PRODUCT_IR_V5=enabled");
    requireScope(auth, "foundry:architect"); const project = this.project(auth, input.projectId), spec = this.store.spec(input.projectId);
    if (!spec) throw new FoundryCommandError("SPEC_REQUIRED", "Submit a specification before beginning product architecture");
    const base = project.activeRevisionId ? this.store.revision(project.activeRevisionId)?.document : undefined;
    const productId = input.productId ?? (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product");
    const document: FoundryProductArchitectureV5 = base?.version === 5 ? cloneProductArchitecture(base) : { version: 5, requirements: [], product: { id: productId, kind: "composite", mandate: { outcome: spec.body }, contracts: [], acceptance: [], capabilityRefs: [], children: [], integration: { scenarios: [] }, allocations: [] } };
    const draft = this.store.createDraft(input.projectId, project.activeRevisionId, input.mode ?? "adaptive", document);
    return success(auth, draft, { diagnostics: [{ code: "PRODUCT_DRAFT_INCOMPLETE", severity: "warning", message: "Add contracts, children, requirement allocations, and integration acceptance before activation" }] });
  }

  getProductTree(auth: FoundryAuthorizationContext, draftId: string): CommandResult<any> {
    const draft = this.getDraft(auth, draftId).state!; if (draft.document.version !== 5) throw new FoundryCommandError("PRODUCT_IR_REQUIRED", "Draft is not a recursive product architecture");
    const compilation = compileProductArchitecture(draft.document); return { ...success(auth, { draftId, projectId: draft.projectId, version: draft.version, product: draft.document.product, compiled: compilation.plan }), diagnostics: compilation.diagnostics };
  }

  private mutateProduct(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; scopeLeaseId?: string }, affectedPaths: string[], mutate: (document: FoundryProductArchitectureV5) => void): CommandResult<any> {
    if (!this.config.productIrV5) throw new FoundryCommandError("PRODUCT_IR_V5_DISABLED", "Recursive product authoring requires FOUNDRY_PRODUCT_IR_V5=enabled");
    requireScope(auth, "foundry:architect"); const draft = this.getDraft(auth, input.draftId).state!;
    if (draft.document.version !== 5) throw new FoundryCommandError("PRODUCT_IR_REQUIRED", "Incremental product tools require an IR v5 draft");
    this.assertArchitectureScope(auth, draft.id, input.scopeLeaseId, affectedPaths);
    const document = cloneProductArchitecture(draft.document); mutate(document); const compilation = compileProductArchitecture(document);
    const safety = new Set(["PRODUCT_IR_TOO_LARGE", "PRODUCT_DEPTH_EXCEEDED", "PRODUCT_NODE_LIMIT", "COMPOSITE_CHILD_LIMIT", "DEPENDENCY_EXCEPTION_LIMIT", "INVALID_NODE_SEGMENT", "INVALID_WRITE_TARGET", "OVERLAPPING_WRITE_TARGET", "CAPABILITY_NOT_FOUND", "CAPABILITY_SCOPE_MISMATCH", "CAPABILITY_CONFIG_UNKNOWN"]);
    const fatal = compilation.diagnostics.filter((entry) => entry.severity === "error" && safety.has(entry.code));
    if (fatal.length) return { accepted: false, diagnostics: compilation.diagnostics, provenance: provenance(auth) };
    const warnings = compilation.diagnostics.map((entry) => entry.severity === "error" ? { ...entry, severity: "warning" as const } : entry);
    try {
      const state = this.store.updateDraft(draft.id, input.expectedVersion, document, warnings); const now = new Date().toISOString();
      this.store.db.prepare("INSERT INTO draft_authors VALUES(?,?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET user_id=excluded.user_id,client_id=excluded.client_id,context_id=excluded.context_id,updated_at=excluded.updated_at").run(draft.id, auth.userId, auth.clientId, auth.contextId ?? `${auth.transport}:${auth.clientId}`, now);
      this.store.event(draft.projectId, "product.draft_updated", { draftId: draft.id, version: state.version }); return { ...success(auth, state), diagnostics: warnings };
    } catch (error) {
      if ((error as Error).message === "DRAFT_CONFLICT") { const current = this.store.draft(draft.id); throw new FoundryCommandError("DRAFT_CONFLICT", "Draft changed; reload before updating", { expectedVersion: input.expectedVersion, currentVersion: current?.version }); }
      throw error;
    }
  }

  acquireArchitectureScope(auth: FoundryAuthorizationContext, input: { draftId: string; nodePath: string; ttlMs?: number }): CommandResult<any> {
    requireScope(auth, "foundry:architect"); const draft = this.getDraft(auth, input.draftId).state!; if (draft.document.version !== 5 || !findProductNode(draft.document.product, input.nodePath)) throw new FoundryCommandError("NODE_NOT_FOUND", "Architecture scope does not identify a v5 node");
    const now = Date.now(); this.store.db.prepare("DELETE FROM architecture_scope_leases WHERE expires_at<=?").run(new Date(now).toISOString());
    const leases = this.store.db.prepare("SELECT * FROM architecture_scope_leases WHERE draft_id=?").all(draft.id) as any[];
    const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    if (leases.some((lease) => overlaps(lease.node_path, input.nodePath))) throw new FoundryCommandError("ARCHITECTURE_SCOPE_CONFLICT", "An overlapping architecture subtree is already leased", { nodePath: input.nodePath });
    const id = randomUUID(), expiresAt = new Date(now + Math.min(Math.max(input.ttlMs ?? 15 * 60_000, 1_000), 60 * 60_000)).toISOString();
    this.store.db.prepare("INSERT INTO architecture_scope_leases VALUES(?,?,?,?,?,?,?,?,?)").run(id, draft.id, input.nodePath, auth.tenantId, auth.userId, auth.clientId, auth.contextId ?? "", expiresAt, new Date(now).toISOString());
    return success(auth, { scopeLeaseId: id, draftId: draft.id, nodePath: input.nodePath, expiresAt });
  }

  private assertArchitectureScope(auth: FoundryAuthorizationContext, draftId: string, leaseId: string | undefined, affectedPaths: string[]): void {
    const active = this.store.db.prepare("SELECT * FROM architecture_scope_leases WHERE draft_id=? AND expires_at>?").all(draftId, new Date().toISOString()) as any[];
    if (!active.length && !leaseId) return;
    const owned = leaseId && active.find((lease) => lease.id === leaseId && lease.tenant_id === auth.tenantId && lease.user_id === auth.userId && lease.client_id === auth.clientId && lease.context_id === (auth.contextId ?? ""));
    if (!owned) throw new FoundryCommandError("ARCHITECTURE_SCOPE_CONFLICT", "A valid context-bound scope lease is required while scoped architecture work is active");
    if (affectedPaths.some((path) => path !== owned.node_path && !path.startsWith(`${owned.node_path}/`))) throw new FoundryCommandError("ARCHITECTURE_SCOPE_CONFLICT", "Mutation falls outside the leased architecture subtree", { leasedPath: owned.node_path, affectedPaths });
  }

  addProductNode(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; parentPath: string; node: FoundryProductNodeV5; scopeLeaseId?: string }): CommandResult<any> {
    return this.mutateProduct(auth, input, [input.parentPath], (document) => { const parent = findProductNode(document.product, input.parentPath); if (!parent) throw new FoundryCommandError("NODE_NOT_FOUND", `Parent ${input.parentPath} was not found`); if (parent.kind !== "composite") throw new FoundryCommandError("PARENT_NOT_COMPOSITE", "Only a composite may receive children"); if (parent.children?.some((child) => child.id === input.node.id)) throw new FoundryCommandError("DUPLICATE_NODE_PATH", `${input.parentPath}/${input.node.id} already exists`); (parent.children ??= []).push(structuredClone(input.node)); });
  }

  updateProductNode(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; node: FoundryProductNodeV5; scopeLeaseId?: string }): CommandResult<any> {
    return this.mutateProduct(auth, input, [input.nodePath], (document) => { const node = findProductNode(document.product, input.nodePath); if (!node) throw new FoundryCommandError("NODE_NOT_FOUND", `${input.nodePath} was not found`); if (node.id !== input.node.id || node.kind !== input.node.kind) throw new FoundryCommandError("NODE_IDENTITY_CHANGE_REQUIRES_MOVE", "Use move_product_subtree to change a node path; node kind is immutable"); Object.assign(node, structuredClone(input.node)); });
  }

  removeProductSubtree(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; scopeLeaseId?: string }): CommandResult<any> {
    return this.mutateProduct(auth, input, [input.nodePath], (document) => { const parentPath = input.nodePath.split("/").slice(0, -1).join("/"); if (!parentPath) throw new FoundryCommandError("ROOT_MUTATION_FORBIDDEN", "The product root cannot be removed"); const parent = findProductNode(document.product, parentPath); const before = parent?.children?.length ?? 0; if (!parent || !parent.children || before === (parent.children = parent.children.filter((child) => `${parentPath}/${child.id}` !== input.nodePath)).length) throw new FoundryCommandError("NODE_NOT_FOUND", `${input.nodePath} was not found`); });
  }

  moveProductSubtree(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; newParentPath: string; newId?: string; scopeLeaseId?: string }): CommandResult<any> {
    return this.mutateProduct(auth, input, [input.nodePath, input.newParentPath], (document) => {
      if (input.newParentPath === input.nodePath || input.newParentPath.startsWith(`${input.nodePath}/`)) throw new FoundryCommandError("MOVE_CYCLE", "A subtree cannot move beneath itself");
      const oldParentPath = input.nodePath.split("/").slice(0, -1).join("/"); if (!oldParentPath) throw new FoundryCommandError("ROOT_MUTATION_FORBIDDEN", "The product root cannot be moved");
      const oldParent = findProductNode(document.product, oldParentPath), newParent = findProductNode(document.product, input.newParentPath); if (!oldParent?.children || !newParent) throw new FoundryCommandError("NODE_NOT_FOUND", "Move source or destination was not found"); if (newParent.kind !== "composite") throw new FoundryCommandError("PARENT_NOT_COMPOSITE", "Move destination must be a composite");
      const index = oldParent.children.findIndex((child) => `${oldParentPath}/${child.id}` === input.nodePath); if (index < 0) throw new FoundryCommandError("NODE_NOT_FOUND", `${input.nodePath} was not found`); const [moved] = oldParent.children.splice(index, 1); const nextId = input.newId ?? moved!.id; if (newParent.children?.some((child) => child.id === nextId)) throw new FoundryCommandError("DUPLICATE_NODE_PATH", `${input.newParentPath}/${nextId} already exists`);
      const localId = moved!.id, unresolvedDependencies = (oldParent.dependencies ?? []).filter((edge) => edge.provider === localId || edge.consumer === localId), unresolvedAllocations = (oldParent.allocations ?? []).filter((allocation) => allocation.targets.some((target) => target.node === localId));
      if (unresolvedDependencies.length || unresolvedAllocations.length) throw new FoundryCommandError("MOVE_EXTERNAL_REFERENCES", "Subtree move would leave unresolved owning-composite dependencies or requirement allocations", { dependencies: unresolvedDependencies, requirements: unresolvedAllocations.map((entry) => entry.requirementId) });
      const newPrefix = `${input.newParentPath}/${nextId}`; markLineage(moved!, input.nodePath, newPrefix); moved!.id = nextId; (newParent.children ??= []).push(moved!); rewriteArchitectureSemanticPaths(document, input.nodePath, newPrefix);
    });
  }

  setCompositeDependencies(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; dependencies: FoundryScopedDependency[]; scopeLeaseId?: string }): CommandResult<any> { return this.mutateProduct(auth, input, [input.nodePath], (document) => { const node = requireComposite(document, input.nodePath); node.dependencies = structuredClone(input.dependencies); }); }
  declareDependencyException(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; exception: FoundryDependencyException; scopeLeaseId?: string }): CommandResult<any> { return this.mutateProduct(auth, input, [input.nodePath], (document) => { const node = requireComposite(document, input.nodePath); (node.dependencyExceptions ??= []).push(structuredClone(input.exception)); }); }
  allocateRequirement(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; allocation: FoundryRequirementAllocation; scopeLeaseId?: string }): CommandResult<any> { return this.mutateProduct(auth, input, [input.nodePath], (document) => { const node = requireProductNode(document, input.nodePath); node.allocations = [...(node.allocations ?? []).filter((entry) => entry.requirementId !== input.allocation.requirementId), structuredClone(input.allocation)]; }); }
  setNodeAcceptance(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; acceptance: FoundryProductNodeV5["acceptance"]; integrationScenarios?: FoundryProductNodeV5["acceptance"]; scopeLeaseId?: string }): CommandResult<any> { return this.mutateProduct(auth, input, [input.nodePath], (document) => { const node = requireProductNode(document, input.nodePath); node.acceptance = structuredClone(input.acceptance); if (node.kind === "composite" && input.integrationScenarios) node.integration!.scenarios = structuredClone(input.integrationScenarios); }); }
  setNodeCapabilities(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; capabilityRefs: FoundryProductNodeV5["capabilityRefs"]; scopeLeaseId?: string }): CommandResult<any> { return this.mutateProduct(auth, input, [input.nodePath], (document) => { requireProductNode(document, input.nodePath).capabilityRefs = structuredClone(input.capabilityRefs); }); }
  setNodeDeliverables(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; nodePath: string; deliverables: NonNullable<FoundryProductNodeV5["deliverables"]>; scopeLeaseId?: string }): CommandResult<any> { return this.mutateProduct(auth, input, [input.nodePath], (document) => { requireProductNode(document, input.nodePath).deliverables = structuredClone(input.deliverables); }); }

  listCapabilities(auth: FoundryAuthorizationContext): CommandResult<any> { requireScope(auth, "foundry:read"); return success(auth, builtInCapabilities.list()); }

  getDraft(auth: FoundryAuthorizationContext, draftId: string): CommandResult<any> {
    requireScope(auth, "foundry:read"); const draft = this.store.draft(draftId); if (!draft) throw new FoundryCommandError("DRAFT_NOT_FOUND", "Draft was not found"); this.project(auth, draft.projectId); return success(auth, draft);
  }

  updateArchitecture(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; architecture: FoundryArchitecture }): CommandResult<any> {
    requireScope(auth, "foundry:architect"); const draft = this.getDraft(auth, input.draftId).state!;
    if ((input.architecture as any).version === 5 || draft.document.version === 5) throw new FoundryCommandError("INCREMENTAL_PRODUCT_AUTHORING_REQUIRED", "IR v5 is authored with typed subtree tools; whole-document replacement is reserved for migration and tests");
    const normalized = normalizeArchitecture(input.architecture), diagnostics = architectureDiagnostics(normalized, this.config.allowLegacyHarness === true);
    const fatal = diagnostics.filter((d) => d.severity === "error"); if (fatal.length) return { accepted: false, diagnostics, provenance: provenance(auth) };
    try { const state = this.store.updateDraft(input.draftId, input.expectedVersion, normalized, diagnostics); const now = new Date().toISOString(); this.store.db.prepare("INSERT INTO draft_authors VALUES(?,?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET user_id=excluded.user_id,client_id=excluded.client_id,context_id=excluded.context_id,updated_at=excluded.updated_at").run(input.draftId, auth.userId, auth.clientId, auth.contextId ?? `${auth.transport}:${auth.clientId}`, now); this.store.event(draft.projectId, "architecture.draft_updated", { draftId: input.draftId, version: state.version }); return { ...success(auth, state), diagnostics }; }
    catch (error) { if ((error as Error).message === "DRAFT_CONFLICT") throw new FoundryCommandError("DRAFT_CONFLICT", "Draft changed; reload before updating"); throw error; }
  }

  setScenarios(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; scenarios: FoundryArchitecture["scenarios"] }): CommandResult<any> { const draft = this.getDraft(auth, input.draftId).state!; return this.updateArchitecture(auth, { draftId: input.draftId, expectedVersion: input.expectedVersion, architecture: { ...draft.document, scenarios: input.scenarios } }); }
  setDeployment(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; deployment: FoundryArchitecture["deployment"] }): CommandResult<any> { const draft = this.getDraft(auth, input.draftId).state!; return this.updateArchitecture(auth, { draftId: input.draftId, expectedVersion: input.expectedVersion, architecture: { ...draft.document, deployment: input.deployment } }); }
  setViewLayout(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; viewId: string; positions: Record<string, { x: number; y: number; width?: number; height?: number }> }): CommandResult<any> {
    const draft = this.getDraft(auth, input.draftId).state!, productPaths = draft.document.version === 5 ? Object.keys(compileProductArchitecture(draft.document).plan?.nodes ?? {}) : draft.document.nodes.map((node: any) => node.id), semantic = new Set([...productPaths, ...(draft.document.deployment?.nodes.map((node: any) => node.id) ?? []), ...(draft.document.stateModels ?? []).flatMap((model: any) => model.states.map((state: string) => `${model.id}:${state}`)), ...["pending", "ready", "leased", "green", "red", "rearchitecture", "cancelled", "waiting_children", "integration_ready", "integrating"].flatMap((state) => [`build:${state}`, `product-build:${state}`])]);
    for (const [semanticId, box] of Object.entries(input.positions)) { if (!semantic.has(semanticId)) throw new FoundryCommandError("PHANTOM_SEMANTIC_ELEMENT", `${semanticId} is not present in canonical architecture IR`); if (![box.x, box.y, box.width ?? 1, box.height ?? 1].every(Number.isFinite) || (box.width ?? 1) <= 0 || (box.height ?? 1) <= 0) throw new FoundryCommandError("INVALID_LAYOUT", `Layout box ${semanticId} is invalid`); }
    const layouts = [...(draft.document.layouts ?? []).filter((entry: any) => entry.viewId !== input.viewId), { viewId: input.viewId, positions: input.positions }];
    if (draft.document.version === 5) return this.mutateProduct(auth, input, [draft.document.product.id], (document) => { document.layouts = layouts; });
    return this.updateArchitecture(auth, { draftId: input.draftId, expectedVersion: input.expectedVersion, architecture: { ...draft.document, layouts } });
  }

  importLayout(auth: FoundryAuthorizationContext, input: { draftId: string; expectedVersion: number; viewId: string; excalidraw: unknown }): CommandResult<any> {
    const draft = this.getDraft(auth, input.draftId).state!; const positions = validateLayoutImport(draft.document, input.excalidraw);
    const layouts = [...(draft.document.layouts ?? []).filter((x: any) => x.viewId !== input.viewId), { viewId: input.viewId, positions }];
    if (draft.document.version === 5) return this.mutateProduct(auth, input, [draft.document.product.id], (document) => { document.layouts = layouts; });
    return this.updateArchitecture(auth, { draftId: input.draftId, expectedVersion: input.expectedVersion, architecture: { ...draft.document, layouts } });
  }

  async validateArchitecture(auth: FoundryAuthorizationContext, draftId: string): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:architect"); const draft = this.getDraft(auth, draftId).state!;
    if (draft.document.version === 5) {
      if (!this.config.productIrV5) throw new FoundryCommandError("PRODUCT_IR_V5_DISABLED", "Recursive product validation requires FOUNDRY_PRODUCT_IR_V5=enabled");
      const compilation = compileProductArchitecture(draft.document), risks = [...new Set(allProductNodes(draft.document.product).flatMap(({ nodePath, node }) => (node.dependencyExceptions ?? []).map(() => `deep cross-tree dependency:${nodePath}`)))];
      if (compilation.plan) this.store.db.prepare("INSERT INTO compiled_product_plans VALUES(?,?,?) ON CONFLICT(architecture_digest) DO UPDATE SET plan_json=excluded.plan_json").run(compilation.plan.architectureDigest, JSON.stringify(compilation.plan), new Date().toISOString());
      const diagnostics = [...compilation.diagnostics]; if (draft.mode === "adaptive" && risks.length) diagnostics.push({ code: "ARCHITECTURE_CRITIC_REQUESTED", severity: "warning", message: `Independent critique requested: ${risks.join(", ")}` });
      return { ...success(auth, { valid: compilation.valid, risks, planDigest: compilation.plan?.architectureDigest }), diagnostics };
    }
    const diagnostics = architectureDiagnostics(draft.document, this.config.allowLegacyHarness === true);
    try { await this.engine.compile(draft.document); } catch (error) { diagnostics.push({ code: "IR_COMPILE_FAILED", severity: "error", message: (error as Error).message }); }
    const base = draft.baseRevisionId ? this.store.revision(draft.baseRevisionId)?.document : undefined;
    const risks = draft.mode === "adaptive" ? adaptiveRisks(draft.document, base) : [];
    if (risks.length) diagnostics.push({ code: "ARCHITECTURE_CRITIC_REQUESTED", severity: "warning", message: `Independent critique requested: ${risks.join(", ")}` });
    return { ...success(auth, { valid: !diagnostics.some((d) => d.severity === "error"), risks }), diagnostics };
  }

  renderDraft(auth: FoundryAuthorizationContext, draftId: string): CommandResult<any> {
    requireScope(auth, "foundry:architect"); const draft = this.getDraft(auth, draftId).state!; const manifest = renderArchitecture(draft.document, `draft:${draft.id}:${draft.version}`, this.artifacts); const saved = this.artifacts.put(JSON.stringify(manifest, null, 2)); this.recordManifest(draft.projectId, manifest, saved.digest);
    return success(auth, manifest, { resources: [{ uri: `foundry://artifacts/${saved.digest}`, name: "architecture-manifest", mimeType: "application/json" }, { uri: manifest.excalidraw.uri, name: "architecture.excalidraw", mimeType: "application/vnd.excalidraw+json" }] });
  }

  compareRevisions(auth: FoundryAuthorizationContext, input: { projectId: string; fromRevisionId: string; toRevisionId: string }): CommandResult<any> {
    requireScope(auth, "foundry:read"); this.project(auth, input.projectId); const from = this.store.revision(input.fromRevisionId), to = this.store.revision(input.toRevisionId); if (!from || !to || from.projectId !== input.projectId || to.projectId !== input.projectId) throw new FoundryCommandError("REVISION_NOT_FOUND", "Both revisions must belong to the project");
    if (from.document.version === 5 || to.document.version === 5) {
      if (from.document.version !== 5 || to.document.version !== 5) return success(auth, { fromRevisionId: from.id, toRevisionId: to.id, formatChanged: true, sourceDigests: { from: from.digest, to: to.digest } });
      const before = compileProductArchitecture(from.document).plan?.nodes ?? {}, after = compileProductArchitecture(to.document).plan?.nodes ?? {};
      return success(auth, { fromRevisionId: from.id, toRevisionId: to.id, added: Object.keys(after).filter((path) => !(path in before)), removed: Object.keys(before).filter((path) => !(path in after)), changed: Object.keys(after).filter((path) => path in before && sha256(JSON.stringify(before[path])) !== sha256(JSON.stringify(after[path]))), lineage: Object.values(after).filter((node) => node.supersedes).map((node) => ({ nodePath: node.nodePath, supersedes: node.supersedes })), sourceDigests: { from: from.digest, to: to.digest } });
    }
    const before = new Map<string, FoundryArchitecture["nodes"][number]>(from.document.nodes.map((n: any) => [n.id, n])), after = new Map<string, FoundryArchitecture["nodes"][number]>(to.document.nodes.map((n: any) => [n.id, n]));
    return success(auth, { fromRevisionId: from.id, toRevisionId: to.id, added: [...after.keys()].filter((id) => !before.has(id)), removed: [...before.keys()].filter((id) => !after.has(id)), changed: [...after.keys()].filter((id) => before.has(id) && sha256(JSON.stringify(before.get(id))) !== sha256(JSON.stringify(after.get(id)))), sourceDigests: { from: from.digest, to: to.digest } });
  }

  submitReview(auth: FoundryAuthorizationContext, input: { draftId: string; verdict: "approve" | "changes_requested"; body: string; kind?: string; reviewerContextId?: string }): CommandResult<any> {
    requireScope(auth, "foundry:architect"); const draft = this.getDraft(auth, input.draftId).state!; const id = randomUUID(), now = new Date().toISOString();
    if (draft.mode === "council" && (!input.kind || !draft.councilRoles.includes(input.kind))) throw new FoundryCommandError("INVALID_COUNCIL_REVIEW", "Council reviews must name one of the draft's selected specialist roles");
    this.store.transaction(() => { this.store.db.prepare("INSERT INTO reviews VALUES(?,?,?,?,?,?,?)").run(id, draft.id, input.kind ?? "critic", auth.clientId, input.verdict, input.body, now); this.store.db.prepare("INSERT INTO review_contexts VALUES(?,?,?,?)").run(id, auth.userId, auth.clientId, input.reviewerContextId ?? auth.contextId ?? `${auth.transport}:${auth.clientId}`); });
    return success(auth, { id, ...input, reviewer: auth.clientId, independent: this.isReviewIndependent(draft.id, id), createdAt: now });
  }

  private isReviewIndependent(draftId: string, reviewId: string): boolean {
    const author = this.store.db.prepare("SELECT * FROM draft_authors WHERE draft_id=?").get(draftId) as any;
    const reviewer = this.store.db.prepare("SELECT * FROM review_contexts WHERE review_id=?").get(reviewId) as any;
    return Boolean(author && reviewer && author.context_id !== reviewer.context_id);
  }

  waiveReview(auth: FoundryAuthorizationContext, input: { draftId: string; reason: string }): CommandResult<any> {
    requireScope(auth, "foundry:activate"); const draft = this.getDraft(auth, input.draftId).state!; const id = randomUUID(), now = new Date().toISOString();
    this.store.db.prepare("INSERT INTO waivers VALUES(?,?,?,?,?)").run(id, draft.id, input.reason, auth.clientId, now); return success(auth, { id, reason: input.reason, createdAt: now });
  }

  async activateArchitecture(auth: FoundryAuthorizationContext, input: { draftId: string; expectedActiveRevision: string | null }): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:activate"); const draft = this.getDraft(auth, input.draftId).state!; const validation = await this.validateArchitecture(auth, draft.id);
    if (!validation.state?.valid) return { accepted: false, diagnostics: validation.diagnostics, provenance: provenance(auth) };
    const approvals = this.store.db.prepare("SELECT r.id,r.kind,rc.context_id AS contextId FROM reviews r LEFT JOIN review_contexts rc ON rc.review_id=r.id WHERE r.draft_id=? AND r.verdict='approve'").all(draft.id) as ReviewApproval[], independentApprovals = approvals.filter((approval) => this.isReviewIndependent(draft.id, approval.id)), review = independentApprovals[0];
    const waiver = this.store.db.prepare("SELECT * FROM waivers WHERE draft_id=? ORDER BY created_at DESC LIMIT 1").get(draft.id);
    const needsReview = draft.mode === "architect-critic" || draft.mode === "council" || (draft.mode === "adaptive" && validation.state.risks.length > 0);
    const councilReviews = draft.mode === "council" ? selectIndependentCouncilReviews(draft.councilRoles, independentApprovals) : [];
    const councilComplete = draft.mode !== "council" || councilReviews !== null;
    if (needsReview && ((!review || !councilComplete) && !waiver)) throw new FoundryCommandError("ARCHITECTURE_REVIEW_REQUIRED", "Submit an approving review from an independent context or an authorized waiver before activation", { risks: validation.state.risks, selfReviews: approvals.length - independentApprovals.length, missingCouncilRoles: draft.mode === "council" ? draft.councilRoles.filter((role: string) => !independentApprovals.some((approval) => approval.kind === role)) : [], duplicateCouncilContexts: draft.mode === "council" && councilReviews === null && draft.councilRoles.every((role: string) => independentApprovals.some((approval) => approval.kind === role)) });
    const digest = sha256(JSON.stringify(draft.document));
    return this.store.transaction(() => {
      const revision = this.store.commitRevision(draft.projectId, draft.baseRevisionId, draft.document, digest, null, { clientId: auth.clientId, draftId: draft.id, review: Boolean(review), waiver: Boolean(waiver) });
      const manifest = renderArchitecture(draft.document, revision.id, this.artifacts); const manifestArtifact = this.artifacts.put(JSON.stringify(manifest, null, 2)); this.recordManifest(draft.projectId, manifest, manifestArtifact.digest);
      this.store.db.prepare("UPDATE revisions SET manifest_digest=? WHERE id=?").run(manifestArtifact.digest, revision.id);
      try { this.store.activate(draft.projectId, input.expectedActiveRevision, revision.id); } catch (error) { if ((error as Error).message === "ACTIVE_REVISION_CONFLICT") throw new FoundryCommandError("ACTIVE_REVISION_CONFLICT", "A newer architecture revision is active"); throw error; }
      this.store.db.prepare("UPDATE drafts SET status='committed' WHERE id=?").run(draft.id); this.store.event(draft.projectId, "architecture.activated", { revisionId: revision.id, digest });
      return success(auth, { ...revision, manifestDigest: manifestArtifact.digest }, { revisionId: revision.id, diagnostics: validation.diagnostics, resources: [{ uri: `foundry://projects/${draft.projectId}/architecture/revisions/${revision.id}`, name: "architecture-revision", mimeType: "application/json" }, { uri: `foundry://artifacts/${manifestArtifact.digest}`, name: "diagram-manifest", mimeType: "application/json" }] });
    });
  }

  async startBuild(auth: FoundryAuthorizationContext, input: { projectId: string; revisionId?: string }): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:build"); const project = this.project(auth, input.projectId); const revisionId = input.revisionId ?? project.activeRevisionId;
    if (!revisionId) throw new FoundryCommandError("ACTIVE_ARCHITECTURE_REQUIRED", "Activate an architecture before starting a build"); const revision = this.store.revision(revisionId);
    if (!revision || revision.projectId !== input.projectId) throw new FoundryCommandError("REVISION_NOT_FOUND", "Architecture revision was not found");
    if (revision.document.version === 5 && !this.config.productIrV5) throw new FoundryCommandError("PRODUCT_IR_V5_DISABLED", "Recursive product builds require FOUNDRY_PRODUCT_IR_V5=enabled");
    const id = randomUUID(), state = await this.engine.startBuild(id, revisionId, revision.document); const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO builds VALUES(?,?,?,?,?,?,?)").run(id, input.projectId, revisionId, "running", JSON.stringify(state), now, now);
      if (revision.document.version === 5) {
        const required = new Map(compileProductArchitecture(revision.document).plan!.deliverables.map((entry) => [entry.deliverableId, entry.required !== false]));
        for (const workId of state.plan.order) this.store.db.prepare("INSERT INTO product_work_items(work_id,build_id,node_path,kind,actor,state,dependencies_json,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(workIdForBuild(id, workId), id, state.plan.node_paths?.[workId] ?? workId, state.plan.work_kinds?.[workId] ?? "implementation", state.plan.work_actors?.[workId] ?? "client", state.nodes[workId], JSON.stringify(state.plan.dependencies[workId] ?? []), now);
        for (const [deliverableId, ownerPath] of Object.entries(state.plan.deliverables ?? {})) this.store.db.prepare("INSERT INTO product_deliverables(build_id,deliverable_id,owner_path,required,status,artifact_digest,evidence_digest,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, deliverableId, ownerPath, required.get(deliverableId) ? 1 : 0, "pending", null, null, now);
      }
      this.store.event(input.projectId, "build.started", { buildId: id, revisionId, recursive: revision.document.version === 5 });
    });
    if (revision.document.version === 5) await this.advanceProductIntegrations(auth, this.build(auth, id));
    return success(auth, await this.engine.getBuild(id));
  }

  private build(auth: FoundryAuthorizationContext, buildId: string): any { const row = this.store.db.prepare("SELECT * FROM builds WHERE id=?").get(buildId) as any; if (!row) throw new FoundryCommandError("BUILD_NOT_FOUND", "Build was not found"); this.project(auth, row.project_id); return row; }

  private async engineBuild(row: any): Promise<EngineBuildState> {
    try { return await this.engine.getBuild(row.id); }
    catch {
      const revision = row.revision_id.startsWith("proposal:")
        ? { document: JSON.parse((this.store.db.prepare("SELECT proposed_json FROM proposals WHERE id=?").get(row.revision_id.slice(9)) as any).proposed_json) }
        : this.store.revision(row.revision_id);
      let state = await this.engine.startBuild(row.id, row.revision_id, revision.document);
      const stored = JSON.parse(row.state_json) as EngineBuildState;
      let recoveredState = false, recoveredInfrastructure = false;
      for (const nodeId of state.plan.order) {
        const persisted = stored.nodes[nodeId];
        if (persisted === "leased") { const activeLease = this.store.db.prepare("SELECT 1 FROM leases WHERE build_id=? AND node_id=? AND expires_at>?").get(row.id, nodeId, new Date().toISOString()); state = await this.engine.recordNode(row.id, nodeId, activeLease ? "leased" : "ready"); if (!activeLease) { recoveredState = true; this.store.db.prepare("DELETE FROM leases WHERE build_id=? AND node_id=?").run(row.id, nodeId); } }
        else if (persisted === "green" || persisted === "red" || persisted === "contract_weak" || persisted === "infrastructure_blocked" || persisted === "integration_ready") state = await this.engine.recordNode(row.id, nodeId, persisted);
        else if (persisted === "verifying" || persisted === "integrating") { state = await this.engine.recordNode(row.id, nodeId, "infrastructure_blocked"); recoveredState = recoveredInfrastructure = true; }
      }
      if (stored.assembly === "running") { state = await this.engine.recordAssembly(row.id, "pending"); recoveredState = recoveredInfrastructure = true; }
      else if (stored.assembly && stored.assembly !== "pending" && Object.values(state.nodes).every((node) => node === "green")) state = await this.engine.recordAssembly(row.id, stored.assembly);
      if (stored.cancelled) state = await this.engine.cancelBuild(row.id);
      if (recoveredState) { const now = new Date().toISOString(); this.store.db.prepare("UPDATE builds SET status=?,state_json=?,updated_at=? WHERE id=?").run(recoveredInfrastructure ? "infrastructure_blocked" : "running", JSON.stringify(state), now, row.id); for (const [workId, workState] of Object.entries(state.nodes)) this.store.db.prepare("UPDATE product_work_items SET state=?,updated_at=? WHERE work_id=?").run(workState, now, workIdForBuild(row.id, workId)); }
      return state;
    }
  }

  private buildWorkspace(row: any, state: EngineBuildState): string {
    const source = this.store.workspace(row.project_id); if (!source) throw new FoundryCommandError("WORKSPACE_REQUIRED", "Bind a workspace before building"); const overlay = join(this.config.runRoot ?? join(tmpdir(), "foundry-build-overlays"), row.id); mkdirSync(overlay, { recursive: true });
    const architecture = architectureForRow(this.store, row);
    const targets = architecture.version === 5 ? allProductTargets(architecture.product).map((entry) => entry.target) : architecture.nodes.flatMap(targetsFor);
    for (const target of targets) { const from = resolveBoundPath(source.internal_path, target.path), to = resolveBoundPath(overlay, target.path); if (existsSync(from) && !existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); } }
    return overlay;
  }

  private nodeBaseDigest(overlay: string, node: FoundryArchitecture["nodes"][number]): string | null {
    const entries = targetsFor(node).map((target) => { const path = resolveBoundPath(overlay, target.path); return [target.targetId, existsSync(path) ? sha256(readFileSync(path)) : null]; });
    return entries.some(([, digest]) => digest !== null) ? sha256(JSON.stringify(entries)) : null;
  }

  private productBaseDigest(overlay: string, node: FoundryProductNodeV5): string | null {
    const entries = productTargets(node).map((target) => { const path = resolveBoundPath(overlay, target.path); return [target.targetId, existsSync(path) ? sha256(readFileSync(path)) : null]; });
    return entries.some(([, digest]) => digest !== null) ? sha256(JSON.stringify(entries)) : null;
  }

  async getBuild(auth: FoundryAuthorizationContext, buildId: string): Promise<CommandResult<any>> { requireScope(auth, "foundry:read"); const row = this.build(auth, buildId), assembly = this.latestAssembly(buildId), state = await this.engineBuild(row); const recursive = Boolean(state.plan.product), deliverables = recursive ? this.store.db.prepare("SELECT deliverable_id AS deliverableId,owner_path AS ownerPath,required,status,artifact_digest AS artifactDigest,evidence_digest AS evidenceDigest,updated_at AS updatedAt FROM product_deliverables WHERE build_id=? ORDER BY deliverable_id").all(buildId) : undefined, nodeEvidence = recursive ? Object.fromEntries((this.store.db.prepare("SELECT node_path,status,evidence_digest FROM node_evidence WHERE build_id=? ORDER BY node_path").all(buildId) as any[]).map((entry) => [entry.node_path, { status: entry.status, evidenceDigest: entry.evidence_digest }])) : undefined; return success(auth, { ...state, recursive, ...(deliverables ? { deliverables, nodeEvidence } : {}), assembly: assembly ? { status: assembly.status, attempts: assembly.attempt, evidenceDigest: assembly.evidence_digest, diagnostics: JSON.parse(assembly.diagnostics_json) } : { status: "pending", attempts: 0 } }); }

  async getNodeContext(auth: FoundryAuthorizationContext, input: { buildId: string; nodeId: string }): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:read"); const row = this.build(auth, input.buildId), state = await this.engineBuild(row);
    const anyArchitecture = architectureForRow(this.store, row);
    if (anyArchitecture.version === 5) {
      const workId = state.plan.node_paths?.[input.nodeId] ? input.nodeId : state.plan.order.find((candidate) => state.plan.node_paths?.[candidate] === input.nodeId && state.plan.work_actors?.[candidate] === "client");
      if (!workId) throw new FoundryCommandError("NODE_NOT_FOUND", "Node path or client work item is absent from this build"); const nodePath = state.plan.node_paths![workId]!, node = findProductNode(anyArchitecture.product, nodePath)!;
      const attempts = this.store.db.prepare("SELECT id,node_id AS workId,attempt,verdict,diagnostics_json AS diagnosticsJson,change_digest AS changeDigest,created_at AS createdAt FROM attempts WHERE build_id=? AND node_id=? ORDER BY attempt").all(input.buildId, workId);
      return success(auth, { buildId: input.buildId, architectureRevision: row.revision_id, workId, nodePath, workKind: state.plan.work_kinds?.[workId], actor: state.plan.work_actors?.[workId], node, owner: state.plan.owners[workId], dependencies: state.plan.dependencies[workId], dependents: state.plan.dependents[workId], readTargets: state.plan.read_sets[workId], writeTargets: productTargets(node), attempts });
    }
    const architecture = anyArchitecture;
    const node = architecture.nodes.find((n) => n.id === input.nodeId); if (!node) throw new FoundryCommandError("NODE_NOT_FOUND", "Node is absent from this build");
    const attempts = this.store.db.prepare("SELECT id,node_id AS nodeId,attempt,verdict,diagnostics_json AS diagnosticsJson,change_digest AS changeDigest,created_at AS createdAt FROM attempts WHERE build_id=? AND node_id=? ORDER BY attempt").all(input.buildId, input.nodeId);
    return success(auth, { buildId: input.buildId, architectureRevision: row.revision_id, node, owner: state.plan.owners[input.nodeId], dependencies: state.plan.dependencies[input.nodeId], dependents: state.plan.dependents[input.nodeId], readTargets: state.plan.read_sets[input.nodeId], writeTargetId: input.nodeId, attempts });
  }

  getNodeAttempts(auth: FoundryAuthorizationContext, input: { buildId: string; nodeId: string }): CommandResult<any[]> { requireScope(auth, "foundry:read"); this.build(auth, input.buildId); return success(auth, this.store.db.prepare("SELECT id,node_id AS nodeId,attempt,verdict,diagnostics_json AS diagnosticsJson,change_digest AS changeDigest,created_at AS createdAt FROM attempts WHERE build_id=? AND node_id=? ORDER BY attempt").all(input.buildId, input.nodeId) as any[]); }

  async getReadyWork(auth: FoundryAuthorizationContext, input: { buildId: string; limit?: number }): Promise<CommandResult<any[]>> {
    requireScope(auth, "foundry:build"); const row = this.build(auth, input.buildId); if (!this.worker) throw new FoundryCommandError("WORKER_UNAVAILABLE", "No deterministic execution worker is configured");
    if (this.worker.health) { try { const health: any = await this.worker.health(), version = architectureForRow(this.store, row).version ?? 2; if (health?.ready === false || health?.piston?.reachable === false && [4, 5].includes(version) || version === 5 && health?.productReady === false) throw new Error(version === 5 ? "required foundry-product Piston runtime is not ready" : "required Piston verifier is not ready"); } catch (error) { throw new FoundryCommandError("WORKER_UNAVAILABLE", `No leases issued: ${(error as Error).message}`); } }
    const state = await this.engineBuild(row), overlay = this.buildWorkspace(row, state); const now = Date.now(), limit = Math.min(Math.max(input.limit ?? 1, 1), 16), work: any[] = [];
    const architecture = architectureForRow(this.store, row);
    if (architecture.version === 5) {
      if (!this.worker.applyAndTestProduct) throw new FoundryCommandError("WORKER_UNAVAILABLE", "Worker does not support IR v5 product verification");
      for (const workId of state.plan.order.filter((id) => state.nodes[id] === "ready" && state.plan.work_actors?.[id] === "client").slice(0, limit)) {
        const nodePath = state.plan.node_paths![workId]!, node = findProductNode(architecture.product, nodePath)!; const id = randomUUID(), expiresAt = new Date(now + (this.config.leaseMs ?? 15 * 60_000)).toISOString(), baseDigest = this.productBaseDigest(overlay, node);
        try { this.store.db.prepare("INSERT INTO leases(id,build_id,node_id,client_id,expires_at,base_digest,tenant_id,user_id,context_id,transport) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, input.buildId, workId, auth.clientId, expiresAt, baseDigest, auth.tenantId, auth.userId, auth.contextId ?? "", auth.transport); work.push({ leaseId: id, workId, nodeId: workId, nodePath, workKind: "implementation", expiresAt, baseDigest, contextUri: `foundry://builds/${input.buildId}/work/${encodeURIComponent(workId)}` }); } catch {}
      }
      return success(auth, work);
    }
    for (const nodeId of state.plan.order.filter((id) => state.nodes[id] === "ready").slice(0, limit)) {
      const id = randomUUID(), expiresAt = new Date(now + (this.config.leaseMs ?? 15 * 60_000)).toISOString(), node = architecture.nodes.find((candidate: any) => candidate.id === nodeId)!; const baseDigest = this.nodeBaseDigest(overlay, node);
      try { this.store.db.prepare("INSERT INTO leases(id,build_id,node_id,client_id,expires_at,base_digest,tenant_id,user_id,context_id,transport) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, input.buildId, nodeId, auth.clientId, expiresAt, baseDigest, auth.tenantId, auth.userId, auth.contextId ?? "", auth.transport); work.push({ leaseId: id, nodeId, expiresAt, baseDigest, contextUri: `foundry://builds/${input.buildId}/nodes/${nodeId}/context` }); } catch {}
    }
    return success(auth, work);
  }

  async submitNodeChanges(auth: FoundryAuthorizationContext, input: { buildId: string; changeSet: NodeChangeSet }): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:build"); if (!this.worker) throw new FoundryCommandError("WORKER_UNAVAILABLE", "No deterministic execution worker is configured"); const row = this.build(auth, input.buildId);
    const operationId = input.changeSet.submissionId ?? randomUUID();
    const prior = this.store.db.prepare("SELECT result_json FROM operation_results WHERE operation_id=? AND tenant_id=? AND client_id=?").get(operationId, auth.tenantId, auth.clientId) as { result_json: string } | undefined;
    if (prior) return JSON.parse(prior.result_json) as CommandResult<any>;
    const lease = this.store.db.prepare("SELECT * FROM leases WHERE id=? AND build_id=? AND node_id=?").get(input.changeSet.leaseId, input.buildId, input.changeSet.targetId) as any;
    if (!lease || lease.client_id !== auth.clientId || lease.tenant_id !== auth.tenantId || lease.user_id !== auth.userId || lease.context_id !== (auth.contextId ?? "") || lease.transport !== auth.transport || Date.parse(lease.expires_at) <= Date.now()) throw new FoundryCommandError("LEASE_CONFLICT", "The node lease is missing, expired, or owned by another authenticated context");
    if (input.changeSet.baseDigest !== lease.base_digest) throw new FoundryCommandError("BASE_DIGEST_CONFLICT", "Change set is not based on the leased target digest");
    if (input.changeSet.patch !== undefined) throw new FoundryCommandError("PATCH_NOT_SUPPORTED", "Use complete target content in v1; patch application is intentionally deferred");
    const architecture = architectureForRow(this.store, row);
    if (architecture.version === 5) return this.submitProductChanges(auth, input, row, architecture, operationId, lease);
    if (architecture.version === 4 && !input.changeSet.submissionId) throw new FoundryCommandError("SUBMISSION_ID_REQUIRED", "IR v4 submissions require a stable submissionId for replay safety");
    const state = await this.engineBuild(row), overlay = this.buildWorkspace(row, state); const node = architecture.nodes.find((n: any) => n.id === input.changeSet.targetId); if (!node) throw new FoundryCommandError("NODE_NOT_FOUND", "Node is absent from the active architecture");
    const declared = targetsFor(node), submitted = input.changeSet.files ?? (input.changeSet.content !== undefined ? [{ targetId: primaryTarget(node).targetId, baseDigest: input.changeSet.baseDigest, content: input.changeSet.content }] : []);
    if (!submitted.length || new Set(submitted.map((file) => file.targetId)).size !== submitted.length || submitted.length !== declared.length || submitted.some((file) => !declared.some((target) => target.targetId === file.targetId))) throw new FoundryCommandError("INVALID_CHANGE_SET", "Submit every compiler-issued target exactly once");
    if (submitted.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > MAX_CHANGESET_BYTES) throw new FoundryCommandError("INVALID_CHANGE_SET", "Change set exceeds the 2 MB aggregate cap");
    if (this.nodeBaseDigest(overlay, node) !== lease.base_digest) throw new FoundryCommandError("TARGET_CHANGED", "A target changed after its lease was issued");
    for (const file of submitted) { const target = declared.find((candidate) => candidate.targetId === file.targetId)!; const path = resolveBoundPath(overlay, target.path), current = existsSync(path) ? sha256(readFileSync(path)) : null; if (file.baseDigest !== current && !(declared.length === 1 && file.baseDigest === lease.base_digest)) throw new FoundryCommandError("BASE_DIGEST_CONFLICT", `${file.targetId} is stale`); }
    const files = submitted.map((file) => ({ targetId: file.targetId, path: declared.find((target) => target.targetId === file.targetId)!.path, content: file.content }));
    const changeArtifact = this.artifacts.put(JSON.stringify(files)); this.recordArtifact(changeArtifact.digest, "application/json", { buildId: input.buildId, nodeId: node.id, clientId: auth.clientId, operationId }); this.linkArtifact(row.project_id, changeArtifact.digest);
    this.journal(operationId, input.buildId, node.id, "submitted", { changeDigest: changeArtifact.digest });
    let verifying = await this.engine.recordNode(input.buildId, node.id, "verifying"); this.store.db.prepare("UPDATE builds SET status='verifying',state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(verifying), new Date().toISOString(), input.buildId);
    this.journal(operationId, input.buildId, node.id, "worker_dispatched", { attempt: 1 });
    let result: Awaited<ReturnType<WorkerPort["applyAndTest"]>> | undefined, failure: FoundryInfrastructureFailure | undefined;
    for (let index = 0; index < infrastructureSchedule.length; index++) {
      try { result = await this.worker.applyAndTest({ workspace: overlay, node, architecture, plan: state.plan, files }); this.journal(operationId, input.buildId, node.id, "result_received", { verdict: result.verdict, digest: result.digest }); failure = undefined; break; }
      catch (error) {
        const retryAfterMs = infrastructureSchedule[index]!; failure = { component: error instanceof FoundryCommandError && error.code.startsWith("WORKER") ? "worker" : "sandbox", operation: "verify_node", retryable: true, attempt: index + 1, diagnosticCode: error instanceof FoundryCommandError ? error.code : "VERIFIER_FAILURE", observedHealth: undefined, retryAfterMs };
        try { failure.observedHealth = await this.worker.health?.(); } catch { failure.observedHealth = { ready: false }; }
        this.store.db.prepare("INSERT INTO infrastructure_failures VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), operationId, input.buildId, node.id, failure.component, failure.attempt, 1, failure.diagnosticCode, JSON.stringify({ message: (error as Error).message, health: failure.observedHealth }), retryAfterMs, new Date().toISOString());
        if (index + 1 < infrastructureSchedule.length) { this.store.db.prepare("UPDATE leases SET expires_at=? WHERE id=?").run(new Date(Date.now() + (this.config.leaseMs ?? 15 * 60_000)).toISOString(), lease.id); await wait(retryAfterMs); }
      }
    }
    if (!result) {
      const blocked = await this.engine.recordNode(input.buildId, node.id, "infrastructure_blocked");
      const response = success(auth, { build: blocked, result: { outcome: "infrastructure_error" as FoundryVerificationOutcome, failure, changeDigest: changeArtifact.digest } }, { provenance: { operationId, clientId: auth.clientId, at: new Date().toISOString() } });
      const stableResponse = JSON.parse(JSON.stringify(response)) as CommandResult<any>;
      this.store.transaction(() => { this.store.db.prepare("UPDATE builds SET status='infrastructure_blocked',state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(blocked), new Date().toISOString(), input.buildId); this.store.db.prepare("INSERT INTO operation_results VALUES(?,?,?,?,?,?,?)").run(operationId, input.buildId, node.id, auth.tenantId, auth.clientId, JSON.stringify(stableResponse), new Date().toISOString()); this.journal(operationId, input.buildId, node.id, "state_transition", { state: "infrastructure_blocked", failure }); this.store.event(row.project_id, "build.infrastructure_blocked", { buildId: input.buildId, nodeId: node.id, operationId, failure }); });
      return stableResponse;
    }
    const outcome: FoundryVerificationOutcome = result.outcome ?? (result.verdict === "green" ? "accepted_green" : "authored_red");
    const mutationMode = this.config.mutationMode ?? "shadow"; let mutationReport: any;
    if (architecture.version === 4 && result.verdict === "green" && mutationMode !== "off" && this.worker.mutate) {
      try { const raw = await this.worker.mutate({ workspace: overlay, sourcePath: primaryTarget(node).path, repositoryFiles: architecture.nodes.flatMap(targetsFor).map((target) => target.path), conformance: generatePythonConformance({ ...architecture, nodes: [node] }), maxMutants: 64 }); mutationReport = { mode: mutationMode, status: raw.score >= 0.8 ? "strong" : "weak", generated: raw.generated, killed: raw.killed, mutants: raw.mutants, survived: raw.survived, score: raw.score, threshold: 0.8 }; }
      catch (error) { mutationReport = { mode: mutationMode, status: "not_run", generated: 0, killed: 0, survived: [], score: null, threshold: 0.8, infrastructureError: (error as Error).message }; }
      const artifact = this.artifacts.put(JSON.stringify(mutationReport, null, 2)); this.recordArtifact(artifact.digest, "application/json", { buildId: input.buildId, nodeId: node.id, kind: "mutation-report" }); this.linkArtifact(row.project_id, artifact.digest); this.store.db.prepare("INSERT INTO mutation_reports VALUES(?,?,?,?,?,?,?)").run(randomUUID(), input.buildId, node.id, mutationMode, JSON.stringify(mutationReport), artifact.digest, new Date().toISOString());
      if (mutationMode === "enforce" && mutationReport.status !== "strong") {
        const weak = await this.engine.recordNode(input.buildId, node.id, mutationReport.status === "weak" ? "contract_weak" : "infrastructure_blocked"); const weakOutcome: FoundryVerificationOutcome = mutationReport.status === "weak" ? "contract_weak" : "infrastructure_error"; const response = success(auth, { build: weak, result: { ...result, outcome: weakOutcome, mutationReport, mandateOwner: node.acceptance.mandate_owner } }, { provenance: { operationId, clientId: auth.clientId, at: new Date().toISOString() } }); const stableResponse = JSON.parse(JSON.stringify(response)) as CommandResult<any>; this.store.transaction(() => { this.store.db.prepare("DELETE FROM leases WHERE id=?").run(lease.id); this.store.db.prepare("UPDATE builds SET status=?,state_json=?,updated_at=? WHERE id=?").run(weakOutcome, JSON.stringify(weak), new Date().toISOString(), input.buildId); this.store.db.prepare("INSERT INTO operation_results VALUES(?,?,?,?,?,?,?)").run(operationId, input.buildId, node.id, auth.tenantId, auth.clientId, JSON.stringify(stableResponse), new Date().toISOString()); this.journal(operationId, input.buildId, node.id, "state_transition", { state: weakOutcome, mutationReport }); this.store.event(row.project_id, "build.contract_weak", { buildId: input.buildId, nodeId: node.id, mandateOwner: node.acceptance.mandate_owner, mutationReport }); }); return stableResponse;
      }
    }
    const updated = await this.engine.recordNode(input.buildId, node.id, result.verdict); const attempt = Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE build_id=? AND node_id=?").get(input.buildId, node.id) as any).count) + 1;
    const complete = Object.values(updated.nodes).every((v) => v === "green");
    let response: CommandResult<any>;
    this.store.transaction(() => { this.store.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), input.buildId, node.id, attempt, result.verdict, JSON.stringify({ outcome, diagnostics: result.diagnostics, operationId }), changeArtifact.digest, new Date().toISOString()); this.store.db.prepare("DELETE FROM leases WHERE id=?").run(lease.id); this.store.db.prepare("UPDATE builds SET status=?,state_json=?,updated_at=? WHERE id=?").run(complete ? "assembling" : "running", JSON.stringify(updated), new Date().toISOString(), input.buildId); this.journal(operationId, input.buildId, node.id, result.verdict === "green" ? "overlay_promoted" : "authored_rejected", { verdict: result.verdict, changeDigest: changeArtifact.digest }); this.journal(operationId, input.buildId, node.id, "state_transition", { state: complete ? "assembling" : "running" }); this.store.event(row.project_id, "build.node_tested", { buildId: input.buildId, nodeId: node.id, attempt, verdict: result.verdict, outcome, digest: changeArtifact.digest, operationId }); });
    const assembly = complete ? await this.runAssembly(auth, input.buildId) : undefined;
    response = success(auth, { build: updated, result: { ...result, outcome, mutationReport }, assembly: assembly?.state }, { provenance: { operationId, clientId: auth.clientId, at: new Date().toISOString() } });
    const stableResponse = JSON.parse(JSON.stringify(response)) as CommandResult<any>; this.store.db.prepare("INSERT INTO operation_results VALUES(?,?,?,?,?,?,?)").run(operationId, input.buildId, node.id, auth.tenantId, auth.clientId, JSON.stringify(stableResponse), new Date().toISOString());
    return stableResponse;
  }

  private async submitProductChanges(auth: FoundryAuthorizationContext, input: { buildId: string; changeSet: NodeChangeSet }, row: any, architecture: FoundryProductArchitectureV5, operationId: string, lease: any): Promise<CommandResult<any>> {
    if (!input.changeSet.submissionId) throw new FoundryCommandError("SUBMISSION_ID_REQUIRED", "IR v5 submissions require a stable submissionId");
    if (!this.worker?.applyAndTestProduct) throw new FoundryCommandError("WORKER_UNAVAILABLE", "Worker does not support recursive product verification");
    const state = await this.engineBuild(row), workId = input.changeSet.targetId, nodePath = state.plan.node_paths?.[workId];
    if (!nodePath || state.plan.work_actors?.[workId] !== "client" || state.plan.work_kinds?.[workId] !== "implementation") throw new FoundryCommandError("WORK_NOT_CLIENT_AUTHORABLE", "Only compiler-issued client implementation work accepts source changes");
    const node = findProductNode(architecture.product, nodePath)!; const overlay = this.buildWorkspace(row, state), declared = productTargets(node);
    if (input.changeSet.patch !== undefined) throw new FoundryCommandError("PATCH_NOT_SUPPORTED", "Submit complete compiler-issued targets");
    const submitted = input.changeSet.files ?? (input.changeSet.content !== undefined && declared.length === 1 ? [{ targetId: declared[0]!.targetId, baseDigest: input.changeSet.baseDigest, content: input.changeSet.content }] : []);
    if (!submitted.length || submitted.length !== declared.length || new Set(submitted.map((file) => file.targetId)).size !== submitted.length || submitted.some((file) => !declared.some((target) => target.targetId === file.targetId))) throw new FoundryCommandError("INVALID_CHANGE_SET", "Submit every compiler-issued product target exactly once");
    if (submitted.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > MAX_CHANGESET_BYTES) throw new FoundryCommandError("INVALID_CHANGE_SET", "Change set exceeds the 2 MB aggregate cap");
    if (this.productBaseDigest(overlay, node) !== lease.base_digest) throw new FoundryCommandError("TARGET_CHANGED", "A product target changed after its lease was issued");
    for (const file of submitted) { const target = declared.find((candidate) => candidate.targetId === file.targetId)!, path = resolveBoundPath(overlay, target.path), current = existsSync(path) ? sha256(readFileSync(path)) : null; if (file.baseDigest !== current && !(declared.length === 1 && file.baseDigest === lease.base_digest)) throw new FoundryCommandError("BASE_DIGEST_CONFLICT", `${file.targetId} is stale`); }
    const files = submitted.map((file) => ({ targetId: file.targetId, path: declared.find((target) => target.targetId === file.targetId)!.path, content: file.content })), changeArtifact = this.artifacts.put(JSON.stringify(files));
    this.recordArtifact(changeArtifact.digest, "application/json", { buildId: input.buildId, workId, nodePath, clientId: auth.clientId, operationId }); this.linkArtifact(row.project_id, changeArtifact.digest); this.journal(operationId, input.buildId, workId, "submitted", { changeDigest: changeArtifact.digest, nodePath });
    let verifying = await this.engine.recordNode(input.buildId, workId, "verifying"); this.persistProductState(row, verifying, "verifying");
    const attemptRoot = mkdtempSync(join(tmpdir(), "foundry-product-attempt-")); cpSync(overlay, attemptRoot, { recursive: true });
    let result: Awaited<ReturnType<NonNullable<WorkerPort["applyAndTestProduct"]>>> | undefined, failure: FoundryInfrastructureFailure | undefined;
    try {
      for (let index = 0; index < infrastructureSchedule.length; index++) {
        try { result = await this.worker.applyAndTestProduct({ workspace: attemptRoot, workId, nodePath, node, architecture, plan: state.plan, files }); failure = undefined; break; }
        catch (error) { const retryAfterMs = infrastructureSchedule[index]!; failure = { component: error instanceof FoundryCommandError && error.code.startsWith("WORKER") ? "worker" : "piston", operation: "verify_product_work", retryable: true, attempt: index + 1, diagnosticCode: error instanceof FoundryCommandError ? error.code : "VERIFIER_FAILURE", retryAfterMs }; try { failure.observedHealth = await this.worker.health?.(); } catch { failure.observedHealth = { ready: false }; } this.store.db.prepare("INSERT INTO infrastructure_failures VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), operationId, input.buildId, workId, failure.component, failure.attempt, 1, failure.diagnosticCode, JSON.stringify({ message: (error as Error).message, health: failure.observedHealth }), retryAfterMs, new Date().toISOString()); if (index + 1 < infrastructureSchedule.length) { this.store.db.prepare("UPDATE leases SET expires_at=? WHERE id=?").run(new Date(Date.now() + (this.config.leaseMs ?? 15 * 60_000)).toISOString(), lease.id); await wait(retryAfterMs); } }
      }
      if (!result) { const blocked = await this.engine.recordNode(input.buildId, workId, "infrastructure_blocked"); this.persistProductState(row, blocked, "infrastructure_blocked"); const response = success(auth, { build: blocked, result: { outcome: "infrastructure_error", failure, changeDigest: changeArtifact.digest } }, { provenance: { operationId, clientId: auth.clientId, at: new Date().toISOString() } }); this.store.db.prepare("INSERT INTO operation_results VALUES(?,?,?,?,?,?,?)").run(operationId, input.buildId, workId, auth.tenantId, auth.clientId, JSON.stringify(response), new Date().toISOString()); return response; }
      let outcome: FoundryVerificationOutcome = result.outcome ?? (result.verdict === "green" ? "accepted_green" : "authored_red"); const mutationMode = this.config.mutationMode ?? "shadow", rawMutation = (result.evidence as any)?.result?.mutation ?? (result.evidence as any)?.mutation, mutationReport = mutationMode === "off" ? undefined : rawMutation ? { ...rawMutation, mode: mutationMode, status: Number(rawMutation.score) >= 0.8 ? "strong" : "weak", threshold: 0.8, maxMutants: 64 } : { mode: mutationMode, status: "not_run", threshold: 0.8, maxMutants: 64, score: null, survived: [] };
      if (mutationReport) { const mutationArtifact = this.artifacts.put(JSON.stringify(mutationReport, null, 2)); this.recordArtifact(mutationArtifact.digest, "application/json", { buildId: input.buildId, nodeId: workId, nodePath, kind: "mutation-report-v5" }); this.linkArtifact(row.project_id, mutationArtifact.digest); this.store.db.prepare("INSERT INTO mutation_reports VALUES(?,?,?,?,?,?,?)").run(randomUUID(), input.buildId, workId, mutationMode, JSON.stringify(mutationReport), mutationArtifact.digest, new Date().toISOString()); if (mutationMode === "enforce" && mutationReport.status !== "strong") outcome = "contract_weak"; }
      const acceptedGreen = result.verdict === "green" && outcome === "accepted_green";
      if (acceptedGreen) for (const file of files) { const target = resolveBoundPath(overlay, file.path); mkdirSync(dirname(target), { recursive: true }); const temporary = `${target}.tmp-${operationId}`; writeFileSync(temporary, file.content, { flag: "wx" }); renameSync(temporary, target); }
      const updated = await this.engine.recordNode(input.buildId, workId, outcome === "contract_weak" ? "contract_weak" : result.verdict); const attempt = Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE build_id=? AND node_id=?").get(input.buildId, workId) as any).count) + 1;
      const implementationEvidence = this.artifacts.put(JSON.stringify({ schemaVersion: 3, kind: "implementation", buildId: input.buildId, revisionId: row.revision_id, workId, nodePath, changeDigest: changeArtifact.digest, verifierDigest: result.digest, outcome, diagnostics: result.diagnostics, evidence: result.evidence ?? null }, null, 2));
      this.recordArtifact(implementationEvidence.digest, "application/json", { buildId: input.buildId, nodePath, kind: "product-implementation-evidence" }); this.linkArtifact(row.project_id, implementationEvidence.digest);
      this.store.db.prepare("INSERT INTO product_implementation_evidence(build_id,work_id,evidence_digest,created_at) VALUES(?,?,?,?) ON CONFLICT(build_id,work_id) DO UPDATE SET evidence_digest=excluded.evidence_digest,created_at=excluded.created_at").run(input.buildId, workId, implementationEvidence.digest, new Date().toISOString());
      this.store.transaction(() => { this.store.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), input.buildId, workId, attempt, outcome === "contract_weak" ? "contract_weak" : result!.verdict, JSON.stringify({ outcome, diagnostics: result!.diagnostics, operationId }), changeArtifact.digest, new Date().toISOString()); this.store.db.prepare("DELETE FROM leases WHERE id=?").run(lease.id); this.store.db.prepare("UPDATE product_work_items SET state=?,updated_at=? WHERE work_id=?").run(updated.nodes[workId], new Date().toISOString(), workIdForBuild(input.buildId, workId)); this.store.db.prepare("UPDATE builds SET status=?,state_json=?,updated_at=? WHERE id=?").run(acceptedGreen ? "running" : outcome, JSON.stringify(updated), new Date().toISOString(), input.buildId); this.store.event(row.project_id, "product.work_tested", { buildId: input.buildId, workId, nodePath, attempt, verdict: result!.verdict, outcome, evidenceDigest: implementationEvidence.digest }); });
      if (node.kind === "leaf" && acceptedGreen) this.storeNodeEvidence(row, architecture, nodePath, { implementationEvidenceDigest: implementationEvidence.digest, childEvidenceDigests: {}, integrationEvidenceDigest: undefined, deliverableEvidenceDigests: {}, status: "green" });
      const advanced = acceptedGreen ? await this.advanceProductIntegrations(auth, row) : updated;
      const response = success(auth, { build: advanced, result: { ...result, outcome, implementationEvidenceDigest: implementationEvidence.digest } }, { provenance: { operationId, clientId: auth.clientId, at: new Date().toISOString() } }); this.store.db.prepare("INSERT INTO operation_results VALUES(?,?,?,?,?,?,?)").run(operationId, input.buildId, workId, auth.tenantId, auth.clientId, JSON.stringify(response), new Date().toISOString()); return response;
    } finally { rmSync(attemptRoot, { recursive: true, force: true }); }
  }

  private persistProductState(row: any, state: EngineBuildState, status: string): void {
    const now = new Date().toISOString(); this.store.transaction(() => { this.store.db.prepare("UPDATE builds SET status=?,state_json=?,updated_at=? WHERE id=?").run(status, JSON.stringify(state), now, row.id); for (const [workId, workState] of Object.entries(state.nodes)) this.store.db.prepare("UPDATE product_work_items SET state=?,updated_at=? WHERE work_id=?").run(workState, now, workIdForBuild(row.id, workId)); });
  }

  private storeNodeEvidence(row: any, architecture: FoundryProductArchitectureV5, nodePath: string, input: Omit<FoundryNodeEvidenceV3, "nodePath" | "architectureDigest" | "requirementResults">): string {
    const node = findProductNode(architecture.product, nodePath)!, revision = row.revision_id.startsWith("proposal:") ? undefined : this.store.revision(row.revision_id), architectureDigest = revision?.digest ?? sha256(JSON.stringify(architecture)), requirementResults = [...node.acceptance, ...(node.integration?.scenarios ?? [])].flatMap((scenario) => scenario.covers.map((requirementId) => ({ requirementId, scenarioIds: [scenario.id], passed: input.status === "green" })));
    const evidence: FoundryNodeEvidenceV3 = { nodePath, architectureDigest, requirementResults, ...input }, artifact = this.artifacts.put(JSON.stringify(evidence, null, 2)); this.recordArtifact(artifact.digest, "application/json", { buildId: row.id, nodePath, kind: "product-node-evidence" }); this.linkArtifact(row.project_id, artifact.digest); this.store.db.prepare("INSERT INTO node_evidence VALUES(?,?,?,?,?) ON CONFLICT(build_id,node_path) DO UPDATE SET evidence_digest=excluded.evidence_digest,status=excluded.status,created_at=excluded.created_at").run(row.id, nodePath, artifact.digest, input.status, new Date().toISOString()); return artifact.digest;
  }

  private async advanceProductIntegrations(auth: FoundryAuthorizationContext, row: any): Promise<EngineBuildState> {
    const architecture = architectureForRow(this.store, row); if (architecture.version !== 5) return this.engineBuild(row);
    let state = await this.engineBuild(row), progressed = true;
    while (progressed) {
      progressed = false;
      for (const workId of state.plan.order.filter((id) => state.nodes[id] === "integration_ready")) {
        progressed = true; const nodePath = state.plan.node_paths![workId]!, node = findProductNode(architecture.product, nodePath)!;
        if (!this.worker?.integrateProduct) { state = await this.engine.recordNode(row.id, workId, "infrastructure_blocked"); this.persistProductState(row, state, "infrastructure_blocked"); return state; }
        state = await this.engine.recordNode(row.id, workId, "integrating"); this.persistProductState(row, state, "integrating");
        const childEvidenceDigests = Object.fromEntries((state.plan.children?.[nodePath] ?? []).map((child) => { const evidence = this.store.db.prepare("SELECT evidence_digest FROM node_evidence WHERE build_id=? AND node_path=?").get(row.id, child) as any; return [child, evidence?.evidence_digest]; }).filter(([, value]) => Boolean(value)));
        let result: Awaited<ReturnType<NonNullable<WorkerPort["integrateProduct"]>>> | undefined, lastError: unknown, operationId = randomUUID();
        for (let index = 0; index < infrastructureSchedule.length; index++) {
          try { result = await this.worker.integrateProduct({ workspace: this.buildWorkspace(row, state), buildId: row.id, revisionId: row.revision_id, nodePath, node, architecture, childEvidenceDigests }); break; }
          catch (error) { lastError = error; const retryAfterMs = infrastructureSchedule[index]!; this.store.db.prepare("INSERT INTO infrastructure_failures VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), operationId, row.id, workId, "piston", index + 1, 1, error instanceof FoundryCommandError ? error.code : "INTEGRATION_VERIFIER_FAILURE", JSON.stringify({ message: (error as Error).message }), retryAfterMs, new Date().toISOString()); if (index + 1 < infrastructureSchedule.length) await wait(retryAfterMs); }
        }
        if (!result) { state = await this.engine.recordNode(row.id, workId, "infrastructure_blocked"); this.persistProductState(row, state, "infrastructure_blocked"); this.store.event(row.project_id, "product.integration_infrastructure_blocked", { buildId: row.id, nodePath, workId, operationId, message: (lastError as Error)?.message }); return state; }
        const integrationArtifact = this.artifacts.put(JSON.stringify({ schemaVersion: 3, kind: "integration", buildId: row.id, revisionId: row.revision_id, nodePath, childEvidenceDigests, verdict: result.verdict, diagnostics: result.diagnostics, evidence: result.evidence }, null, 2)); this.recordArtifact(integrationArtifact.digest, "application/json", { buildId: row.id, nodePath, kind: "product-integration-evidence" }); this.linkArtifact(row.project_id, integrationArtifact.digest);
        state = await this.engine.recordNode(row.id, workId, result.verdict); const nodeEvidenceDigest = this.storeNodeEvidence(row, architecture, nodePath, { implementationEvidenceDigest: node.integration?.glue?.targets.length ? (this.store.db.prepare("SELECT evidence_digest FROM product_implementation_evidence WHERE build_id=? AND work_id=?").get(row.id, `${nodePath}:implementation`) as any)?.evidence_digest : undefined, childEvidenceDigests, integrationEvidenceDigest: integrationArtifact.digest, deliverableEvidenceDigests: {}, status: result.verdict });
        const attempt = Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM integration_attempts WHERE build_id=? AND node_path=?").get(row.id, nodePath) as any).count) + 1; this.store.db.prepare("INSERT INTO integration_attempts VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), row.id, nodePath, attempt, result.verdict, integrationArtifact.digest, JSON.stringify(result.diagnostics), new Date().toISOString()); this.persistProductState(row, state, result.verdict === "green" ? "running" : "integration_red"); this.store.event(row.project_id, "product.integration_tested", { buildId: row.id, nodePath, workId, verdict: result.verdict, evidenceDigest: nodeEvidenceDigest });
        if (result.verdict !== "green") return state;
      }
    }
    if (Object.values(state.nodes).every((value) => value === "green") && state.assembly === "pending") return this.assembleProduct(auth, row, architecture, state);
    return state;
  }

  private async assembleProduct(auth: FoundryAuthorizationContext, row: any, architecture: FoundryProductArchitectureV5, state: EngineBuildState): Promise<EngineBuildState> {
    if (!this.worker?.assembleProduct) { const blocked = await this.engine.recordNode(row.id, `${architecture.product.id}:integration`, "infrastructure_blocked"); this.persistProductState(row, blocked, "infrastructure_blocked"); return blocked; }
    const compiled = compileProductArchitecture(architecture).plan!, declarations = compiled.deliverables.map((entry) => ({ deliverableId: entry.deliverableId, ownerPath: entry.ownerPath, kind: entry.kind, output: entry.output }));
    let running = await this.engine.recordAssembly(row.id, "running"); this.persistProductState(row, running, "assembling"); const workspace = this.buildWorkspace(row, running);
    let first: Awaited<ReturnType<NonNullable<WorkerPort["assembleProduct"]>>>, replay: Awaited<ReturnType<NonNullable<WorkerPort["assembleProduct"]>>>;
    try { first = await this.worker.assembleProduct({ workspace, buildId: row.id, revisionId: row.revision_id, architecture, deliverables: declarations }); replay = first.verdict === "green" ? await this.worker.assembleProduct({ workspace, buildId: row.id, revisionId: row.revision_id, architecture, deliverables: declarations }) : first; }
    catch (error) { const operationId = randomUUID(), pending = await this.engine.recordAssembly(row.id, "pending"); this.store.db.prepare("INSERT INTO infrastructure_failures VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), operationId, row.id, `${compiled.rootPath}:assembly`, "piston", 1, 1, error instanceof FoundryCommandError ? error.code : "ASSEMBLY_VERIFIER_FAILURE", JSON.stringify({ message: (error as Error).message }), infrastructureSchedule[0], new Date().toISOString()); this.persistProductState(row, pending, "infrastructure_blocked"); this.store.event(row.project_id, "product.assembly_infrastructure_blocked", { buildId: row.id, operationId, message: (error as Error).message }); return pending; }
    const artifactDigests: Record<string, string> = {}, evidenceDigests: Record<string, string> = {};
    for (const declaration of compiled.deliverables) {
      const output = first.deliverables.find((entry) => entry.deliverableId === declaration.deliverableId), replayOutput = replay.deliverables.find((entry) => entry.deliverableId === declaration.deliverableId), bytes = decodeArtifactBase64(output?.artifactBase64), replayBytes = decodeArtifactBase64(replayOutput?.artifactBase64), limit = declaration.output?.maxBytes ?? builtInCapabilities.get(declaration.capabilityRef.id, declaration.capabilityRef.version)!.limits.maxArtifactBytes;
      if (!bytes || !replayBytes || bytes.length > limit || output?.mediaType && declaration.output?.mediaType && output.mediaType !== declaration.output.mediaType || sha256(bytes) !== sha256(replayBytes)) { first.verdict = "red"; continue; }
      const artifact = this.artifacts.put(bytes), evidence = this.artifacts.put(JSON.stringify({ schemaVersion: 3, deliverableId: declaration.deliverableId, ownerPath: declaration.ownerPath, artifactDigest: artifact.digest, replayDigest: sha256(replayBytes), mediaType: output?.mediaType ?? declaration.output?.mediaType, reproducible: true }, null, 2)); artifactDigests[declaration.deliverableId] = artifact.digest; evidenceDigests[declaration.deliverableId] = evidence.digest; this.recordArtifact(artifact.digest, output?.mediaType ?? declaration.output?.mediaType ?? "application/octet-stream", { buildId: row.id, deliverableId: declaration.deliverableId }); this.recordArtifact(evidence.digest, "application/json", { buildId: row.id, deliverableId: declaration.deliverableId, kind: "deliverable-evidence" }); this.linkArtifact(row.project_id, artifact.digest); this.linkArtifact(row.project_id, evidence.digest); this.store.db.prepare("UPDATE product_deliverables SET status='green',artifact_digest=?,evidence_digest=?,updated_at=? WHERE build_id=? AND deliverable_id=?").run(artifact.digest, evidence.digest, new Date().toISOString(), row.id, declaration.deliverableId);
    }
    const required = compiled.deliverables.filter((entry) => entry.required !== false), green = first.verdict === "green" && replay.verdict === "green" && required.every((entry) => artifactDigests[entry.deliverableId]);
    const rootRow = this.store.db.prepare("SELECT evidence_digest FROM node_evidence WHERE build_id=? AND node_path=?").get(row.id, compiled.rootPath) as any, rootEvidence = rootRow ? JSON.parse(this.artifacts.get(rootRow.evidence_digest).toString("utf8")) : undefined; if (rootEvidence) this.storeNodeEvidence(row, architecture, compiled.rootPath, { implementationEvidenceDigest: rootEvidence.implementationEvidenceDigest, childEvidenceDigests: rootEvidence.childEvidenceDigests, integrationEvidenceDigest: rootEvidence.integrationEvidenceDigest, deliverableEvidenceDigests: evidenceDigests, status: green ? "green" : "red" });
    const replayDigests = Object.fromEntries(replay.deliverables.map((entry) => [entry.deliverableId, sha256(decodeArtifactBase64(entry.artifactBase64) ?? Buffer.alloc(0))]));
    const rootDigest = (this.store.db.prepare("SELECT evidence_digest FROM node_evidence WHERE build_id=? AND node_path=?").get(row.id, compiled.rootPath) as any)?.evidence_digest, mutationEvidenceDigests = Object.fromEntries((this.store.db.prepare("SELECT node_id,evidence_digest FROM mutation_reports WHERE build_id=? ORDER BY node_id,created_at").all(row.id) as any[]).map((entry) => [entry.node_id, entry.evidence_digest])), manifest: FoundryProductEvidenceV3 = { schemaVersion: 3, buildId: row.id, revisionId: row.revision_id, rootNodePath: compiled.rootPath, rootEvidenceDigest: rootDigest, nodeEvidenceDigests: Object.fromEntries((this.store.db.prepare("SELECT node_path,evidence_digest FROM node_evidence WHERE build_id=?").all(row.id) as any[]).map((entry) => [entry.node_path, entry.evidence_digest])), deliverableEvidenceDigests: evidenceDigests, mutationEvidenceDigests }, productEvidence = this.artifacts.put(JSON.stringify({ ...manifest, reproducibility: { status: green ? "green" : "red", executions: [artifactDigests, replayDigests] }, assembly: first.evidence }, null, 2)); this.recordArtifact(productEvidence.digest, "application/json", { buildId: row.id, revisionId: row.revision_id, kind: "product-conformance-evidence-v3" }); this.linkArtifact(row.project_id, productEvidence.digest);
    const final = await this.engine.recordAssembly(row.id, green ? "green" : "red"), assemblyAttempt = Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM assembly_attempts WHERE build_id=?").get(row.id) as any).count) + 1; this.store.transaction(() => { this.store.db.prepare("INSERT INTO assembly_attempts VALUES(?,?,?,?,?,?,?)").run(randomUUID(), row.id, assemblyAttempt, green ? "green" : "red", productEvidence.digest, JSON.stringify({ schemaVersion: 3, reproducible: green, deliverables: artifactDigests }), new Date().toISOString()); this.store.db.prepare("UPDATE builds SET status=?,state_json=?,updated_at=? WHERE id=?").run(green ? "green" : "assembly_red", JSON.stringify(final), new Date().toISOString(), row.id); this.store.event(row.project_id, "product.assembled", { buildId: row.id, status: green ? "green" : "red", evidenceDigest: productEvidence.digest }); }); return final;
  }

  async retryInfrastructure(auth: FoundryAuthorizationContext, input: { buildId: string; nodeId: string }): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:build"); const row = this.build(auth, input.buildId), state = await this.engineBuild(row);
    const architecture = architectureForRow(this.store, row);
    if (architecture.version === 5 && input.nodeId === `${architecture.product.id}:assembly` && state.assembly === "pending" && Object.values(state.nodes).every((entry) => entry === "green")) { if (this.worker?.health) { const health: any = await this.worker.health(); if (health?.productReady === false) throw new FoundryCommandError("WORKER_UNAVAILABLE", "Required foundry-product runtime is still unavailable"); } const updated = await this.assembleProduct(auth, row, architecture, state); return success(auth, updated); }
    if (state.nodes[input.nodeId] !== "infrastructure_blocked") throw new FoundryCommandError("NODE_NOT_INFRASTRUCTURE_BLOCKED", "Only infrastructure-blocked work may use infrastructure retry");
    if (this.worker?.health) { try { await this.worker.health(); } catch (error) { throw new FoundryCommandError("WORKER_UNAVAILABLE", `Production verifier is still unavailable: ${(error as Error).message}`); } }
    const updated = await this.engine.recordNode(input.buildId, input.nodeId, "ready"); this.store.db.prepare("DELETE FROM leases WHERE build_id=? AND node_id=?").run(input.buildId, input.nodeId); this.store.db.prepare("UPDATE builds SET status='running',state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(updated), new Date().toISOString(), input.buildId); this.store.event(row.project_id, "build.infrastructure_retried", input); return success(auth, updated);
  }

  async cancelBuild(auth: FoundryAuthorizationContext, buildId: string): Promise<CommandResult<any>> { requireScope(auth, "foundry:build"); const row = this.build(auth, buildId); const state = await this.engine.cancelBuild(buildId); this.store.db.prepare("UPDATE builds SET status='cancelled',state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(state), new Date().toISOString(), buildId); this.store.event(row.project_id, "build.cancelled", { buildId }); return success(auth, state); }

  async retryNode(auth: FoundryAuthorizationContext, input: { buildId: string; nodeId: string }): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:build"); const row = this.build(auth, input.buildId), state = await this.engineBuild(row); if (state.nodes[input.nodeId] !== "red") throw new FoundryCommandError("NODE_NOT_RED", "Only a red node may be retried");
    const count = Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE build_id=? AND node_id=?").get(input.buildId, input.nodeId) as any).count); if (count >= 3) throw new FoundryCommandError("RETRY_EXHAUSTED", "Node exhausted its repair budget and requires rearchitecture");
    const updated = await this.engine.recordNode(input.buildId, input.nodeId, "ready"); this.store.db.prepare("UPDATE builds SET state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(updated), new Date().toISOString(), input.buildId); this.store.event(row.project_id, "build.node_retried", { buildId: input.buildId, nodeId: input.nodeId, priorAttempts: count }); return success(auth, updated);
  }

  private latestAssembly(buildId: string): any { return this.store.db.prepare("SELECT * FROM assembly_attempts WHERE build_id=? ORDER BY attempt DESC LIMIT 1").get(buildId); }

  async getAssemblyEvidence(auth: FoundryAuthorizationContext, buildId: string): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:read"); this.build(auth, buildId); const attempt = this.latestAssembly(buildId);
    if (!attempt) throw new FoundryCommandError("ASSEMBLY_NOT_RUN", "Assembly has not run");
    return success(auth, { buildId, status: attempt.status, attempt: attempt.attempt, evidenceDigest: attempt.evidence_digest, diagnostics: JSON.parse(attempt.diagnostics_json) }, attempt.evidence_digest ? { resources: [{ uri: `foundry://artifacts/${attempt.evidence_digest}`, name: "assembly-evidence", mimeType: "application/json" }] } : {});
  }

  async getConformance(auth: FoundryAuthorizationContext, buildId: string): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:read");
    const assembly = (await this.getAssemblyEvidence(auth, buildId)).state;
    if (!assembly.evidenceDigest) throw new FoundryCommandError("CONFORMANCE_NOT_AVAILABLE", "The build has no immutable conformance evidence");
    const manifest = JSON.parse(this.readArtifact(auth, assembly.evidenceDigest).toString("utf8"));
    return success(auth, manifest, { resources: [
      { uri: `foundry://artifacts/${assembly.evidenceDigest}`, name: "conformance-manifest", mimeType: "application/json" },
      ...(manifest.conformanceDigest ? [{ uri: `foundry://artifacts/${manifest.conformanceDigest}`, name: "generated-conformance", mimeType: "text/x-python" }] : []),
    ] });
  }

  private async runAssembly(auth: FoundryAuthorizationContext, buildId: string): Promise<CommandResult<any>> {
    const row = this.build(auth, buildId), architecture = architectureForRow(this.store, row), state = await this.engineBuild(row), overlay = this.buildWorkspace(row, state), prior = this.latestAssembly(buildId), attempt = Number(prior?.attempt ?? 0) + 1;
    if (architecture.version === 5) throw new FoundryCommandError("PRODUCT_ASSEMBLY_AUTOMATIC", "IR v5 assembly is driven automatically by recursive integration");
    if (!architecture.delivery || ![3, 4].includes(architecture.version ?? 2)) {
      const diagnostics = { code: "DELIVERY_PROFILE_REQUIRED", message: "IR v3 or v4 delivery profile is required for assembly" };
      const assemblyState = await this.engine.recordAssembly(buildId, "red"); this.store.db.prepare("INSERT INTO assembly_attempts VALUES(?,?,?,?,?,?,?)").run(randomUUID(), buildId, attempt, "red", null, JSON.stringify(diagnostics), new Date().toISOString()); this.store.db.prepare("UPDATE builds SET status='assembly_red',state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(assemblyState), new Date().toISOString(), buildId);
      return success(auth, { status: "red", attempts: attempt, diagnostics });
    }
    if (!this.worker?.assemble) throw new FoundryCommandError("WORKER_UNAVAILABLE", "No deterministic assembly worker is configured");
    const runningState = await this.engine.recordAssembly(buildId, "running"); this.store.db.prepare("UPDATE builds SET status='assembling',state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(runningState), new Date().toISOString(), buildId);
    const conformance = generatePythonConformance(architecture), conformanceArtifact = this.artifacts.put(conformance); this.recordArtifact(conformanceArtifact.digest, "text/x-python", { buildId, revisionId: row.revision_id, kind: "generated-conformance" }); this.linkArtifact(row.project_id, conformanceArtifact.digest);
    let result: { verdict: "green" | "red"; evidence: any };
    try { result = await this.worker.assemble({ workspace: overlay, buildId, revisionId: row.revision_id, architecture, conformance }); }
    catch (error) { result = { verdict: "red", evidence: { code: "ASSEMBLY_INFRASTRUCTURE_FAILURE", message: (error as Error).message } }; }
    let reproducibility: any;
    if (architecture.version === 4 && result.verdict === "green") {
      let replay: { verdict: "green" | "red"; evidence: any };
      try { replay = await this.worker.assemble({ workspace: overlay, buildId, revisionId: row.revision_id, architecture, conformance }); } catch (error) { replay = { verdict: "red", evidence: { code: "ASSEMBLY_INFRASTRUCTURE_FAILURE", message: (error as Error).message } }; }
      const normalize = (entry: any) => ({ packageDigest: entry.packageDigest ?? null, targetDigests: entry.targetDigests ?? {}, passed: entry.passed ?? 0, failed: entry.failed ?? 1, checks: (entry.diagnostics?.checks ?? []).map((check: any) => ({ name: check.name, passed: check.passed })) });
      const first = normalize(result.evidence), second = normalize(replay.evidence), differences = sha256(JSON.stringify(first)) === sha256(JSON.stringify(second)) ? [] : ["normalized-assembly-output"];
      reproducibility = { status: replay.verdict === "green" && differences.length === 0 ? "green" : "red", executions: [first, second], rawExecutions: [result.evidence, replay.evidence], normalizedDigest: sha256(JSON.stringify([first, second])), differences, volatileFields: ["durationMs", "diagnostics.stdout", "diagnostics.stderr", "wheelDigest"] };
      if (result.evidence.environment?.sandbox !== "piston") { reproducibility.status = "red"; reproducibility.differences.push("PISTON_REQUIRED"); }
      if (reproducibility.status !== "green") result = { verdict: "red", evidence: { ...result.evidence, code: differences.length ? "REPRODUCIBILITY_FAILURE" : "PISTON_REQUIRED" } };
    }
    const revision = row.revision_id.startsWith("proposal:") ? undefined : this.store.revision(row.revision_id), authoredAttempts = this.store.db.prepare("SELECT node_id AS nodeId,attempt,verdict,change_digest AS changeDigest,created_at AS createdAt FROM attempts WHERE build_id=? ORDER BY node_id,attempt").all(buildId), infrastructureFailures = this.store.db.prepare("SELECT node_id AS nodeId,component,attempt,diagnostic_code AS diagnosticCode,retry_after_ms AS retryAfterMs,created_at AS createdAt FROM infrastructure_failures WHERE build_id=? ORDER BY created_at").all(buildId), mutationReports = this.store.db.prepare("SELECT node_id AS nodeId,mode,evidence_digest AS evidenceDigest,created_at AS createdAt FROM mutation_reports WHERE build_id=? ORDER BY created_at").all(buildId);
    const evidence = { ...result.evidence, conformanceDigest: conformanceArtifact.digest, projectionDigest: revision?.manifestDigest ?? null, provenance: { authored: authoredAttempts, infrastructure: infrastructureFailures, mutation: mutationReports, waiver: revision?.provenance?.waiver === true, retries: (authoredAttempts as any[]).filter((entry) => entry.attempt > 1).length, cancellation: false }, ...(architecture.version === 4 ? { testSourceDigest: conformanceArtifact.digest, reproducibility } : {}) }, evidenceArtifact = this.artifacts.put(JSON.stringify(evidence, null, 2)); this.recordArtifact(evidenceArtifact.digest, "application/json", { buildId, revisionId: row.revision_id, kind: "assembly-evidence" }); this.linkArtifact(row.project_id, evidenceArtifact.digest);
    const status = result.verdict === "green" ? "green" : "red", finalState = await this.engine.recordAssembly(buildId, status); this.store.transaction(() => { this.store.db.prepare("INSERT INTO assembly_attempts VALUES(?,?,?,?,?,?,?)").run(randomUUID(), buildId, attempt, status, evidenceArtifact.digest, JSON.stringify(evidence), new Date().toISOString()); this.store.db.prepare("UPDATE builds SET status=?,state_json=?,updated_at=? WHERE id=?").run(status === "green" ? "green" : "assembly_red", JSON.stringify(finalState), new Date().toISOString(), buildId); this.store.event(row.project_id, "build.assembly_tested", { buildId, attempt, status, evidenceDigest: evidenceArtifact.digest }); });
    return success(auth, { status, attempts: attempt, evidenceDigest: evidenceArtifact.digest, diagnostics: evidence }, { resources: [{ uri: `foundry://artifacts/${evidenceArtifact.digest}`, name: "assembly-evidence", mimeType: "application/json" }, { uri: `foundry://artifacts/${conformanceArtifact.digest}`, name: "generated-conformance", mimeType: "text/x-python" }] });
  }

  async retryAssembly(auth: FoundryAuthorizationContext, buildId: string): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:build"); const row = this.build(auth, buildId), prior = this.latestAssembly(buildId), state = await this.engineBuild(row);
    if (!prior || prior.status !== "red") throw new FoundryCommandError("ASSEMBLY_NOT_RED", "Only a red assembly may be retried");
    if (prior.attempt >= 3) throw new FoundryCommandError("RETRY_EXHAUSTED", "Assembly exhausted its retry budget");
    if (!Object.values(state.nodes).every((value) => value === "green")) throw new FoundryCommandError("NODES_NOT_GREEN", "Every authored node must remain green");
    const architecture = architectureForRow(this.store, row); if (architecture.version === 5) return success(auth, await this.assembleProduct(auth, row, architecture, state));
    return this.runAssembly(auth, buildId);
  }

  async getReproducibilityEvidence(auth: FoundryAuthorizationContext, buildId: string): Promise<CommandResult<any>> { const manifest = (await this.getConformance(auth, buildId)).state; if (!manifest.reproducibility) throw new FoundryCommandError("REPRODUCIBILITY_NOT_AVAILABLE", "Reproducibility evidence has not been produced"); return success(auth, manifest.reproducibility); }
  getMutationReport(auth: FoundryAuthorizationContext, input: { buildId: string; nodeId?: string }): CommandResult<any> { requireScope(auth, "foundry:read"); this.build(auth, input.buildId); const rows = input.nodeId ? this.store.db.prepare("SELECT node_id AS nodeId,mode,report_json AS reportJson,evidence_digest AS evidenceDigest,created_at AS createdAt FROM mutation_reports WHERE build_id=? AND node_id=? ORDER BY created_at").all(input.buildId, input.nodeId) : this.store.db.prepare("SELECT node_id AS nodeId,mode,report_json AS reportJson,evidence_digest AS evidenceDigest,created_at AS createdAt FROM mutation_reports WHERE build_id=? ORDER BY created_at").all(input.buildId); return success(auth, (rows as any[]).map((row) => ({ ...row, report: JSON.parse(row.reportJson) }))); }

  async getSystemHealth(auth: FoundryAuthorizationContext): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:admin"); const now = Date.now(), activeBuilds = this.store.db.prepare("SELECT id,status,state_json AS stateJson,updated_at AS updatedAt FROM builds WHERE status NOT IN ('green','cancelled')").all() as any[], leases = this.store.db.prepare("SELECT COUNT(*) AS count,MIN(expires_at) AS oldest FROM leases WHERE expires_at>?").get(new Date(now).toISOString()) as any, authored = this.store.db.prepare("SELECT verdict,COUNT(*) AS count FROM attempts GROUP BY verdict").all() as any[], infrastructure = this.store.db.prepare("SELECT COUNT(*) AS count,MAX(created_at) AS latest FROM infrastructure_failures").get() as any;
    let worker: any = { configured: Boolean(this.worker), ready: Boolean(this.worker) }; if (this.worker?.health) try { worker = { configured: true, ...(await this.worker.health() as any) }; } catch (error) { worker = { configured: true, ready: false, error: (error as Error).message }; }
    const scrub = this.artifacts.scrub(), queueDepth = activeBuilds.reduce((sum, build) => sum + Object.values(JSON.parse(build.stateJson).nodes ?? {}).filter((state) => state === "ready").length, 0), lastVerification = this.store.db.prepare("SELECT MAX(created_at) AS value FROM attempts").get() as any, lastAssembly = this.store.db.prepare("SELECT MAX(created_at) AS value FROM assembly_attempts WHERE status='green'").get() as any;
    const quotaBytes = this.config.artifactQuotaBytes ?? 2 * 1024 * 1024 * 1024;
    return success(auth, { ready: worker.ready !== false && scrub.corrupt.length === 0, components: { facade: { ready: true, version: "0.1.0", protocol: ["2026-07-28", "2025-11-25"] }, sidecar: { ready: true, mode: this.engine.constructor.name }, worker, artifactStore: { ready: scrub.corrupt.length === 0, ...scrub, perTenantQuotaBytes: quotaBytes, aggregatePressure: scrub.bytes / quotaBytes }, renderer: { ready: true, name: "foundry-projection" }, git: { ready: true } }, queue: { depth: queueDepth, activeBuilds: activeBuilds.length, activeLeases: Number(leases.count), oldestLeaseExpiry: leases.oldest }, failures: { authored, infrastructure: Number(infrastructure.count), lastInfrastructureFailure: infrastructure.latest }, lastSuccessfulVerification: lastVerification.value, lastSuccessfulAssembly: lastAssembly.value, circuit: { worker: worker.ready === false ? "open" : "closed", artifactStore: scrub.corrupt.length ? "open" : "closed" }, observedAt: new Date(now).toISOString() });
  }

  async beginRearchitecture(auth: FoundryAuthorizationContext, input: { projectId: string; targetNodeId: string }): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:architect"); const project = this.project(auth, input.projectId); if (!project.activeRevisionId) throw new FoundryCommandError("ACTIVE_ARCHITECTURE_REQUIRED", "No active architecture"); const revision = this.store.revision(project.activeRevisionId), architecture = revision.document;
    const node = architecture.version === 5 ? findProductNode(architecture.product, input.targetNodeId) : architecture.nodes.find((candidate: any) => candidate.id === input.targetNodeId); if (!node) throw new FoundryCommandError("NODE_NOT_FOUND", "Target node was not found");
    const ownerId = architecture.version === 5 ? input.targetNodeId.split("/").slice(0, -1).join("/") || "spec" : node.owner ?? "spec", id = randomUUID(), invalidates = await this.engine.invalidationSet(architecture, input.targetNodeId), now = new Date().toISOString(); this.store.db.prepare("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, input.projectId, revision.id, input.targetNodeId, ownerId, "draft", JSON.stringify([]), JSON.stringify(invalidates), now, now); return success(auth, { id, baseRevisionId: revision.id, targetNodeId: input.targetNodeId, ownerId, invalidates, status: "draft", recursive: architecture.version === 5 });
  }

  async getInvalidationSet(auth: FoundryAuthorizationContext, input: { projectId: string; revisionId?: string; nodeId: string }): Promise<CommandResult<any>> { requireScope(auth, "foundry:read"); const project = this.project(auth, input.projectId), revision = this.store.revision(input.revisionId ?? project.activeRevisionId); if (!revision || revision.projectId !== input.projectId) throw new FoundryCommandError("REVISION_NOT_FOUND", "Architecture revision was not found"); return success(auth, { nodeId: input.nodeId, invalidates: await this.engine.invalidationSet(revision.document, input.nodeId) }); }

  getRevision(auth: FoundryAuthorizationContext, projectId: string, revisionId: string): CommandResult<any> { requireScope(auth, "foundry:read"); this.project(auth, projectId); const revision = this.store.revision(revisionId); if (!revision || revision.projectId !== projectId) throw new FoundryCommandError("REVISION_NOT_FOUND", "Architecture revision was not found"); return success(auth, revision); }
  getProductRevisionNode(auth: FoundryAuthorizationContext, projectId: string, revisionId: string, nodePath: string): CommandResult<any> { const revision = this.getRevision(auth, projectId, revisionId).state; if (revision.document.version !== 5) throw new FoundryCommandError("PRODUCT_IR_REQUIRED", "Revision is not recursive IR v5"); const node = findProductNode(revision.document.product, nodePath); if (!node) throw new FoundryCommandError("NODE_NOT_FOUND", "Product node was not found"); const compiled = compileProductArchitecture(revision.document).plan!; return success(auth, { nodePath, node, parentPath: compiled.nodes[nodePath]!.parentPath, children: compiled.children[nodePath] ?? [], effectiveConstraints: compiled.effectiveConstraints[nodePath] ?? [], invalidation: compiled.invalidation[nodePath] ?? [], semanticId: `product-node:${nodePath}` }); }
  getProductCompositeDag(auth: FoundryAuthorizationContext, projectId: string, revisionId: string, nodePath: string): CommandResult<any> { const revision = this.getRevision(auth, projectId, revisionId).state; if (revision.document.version !== 5) throw new FoundryCommandError("PRODUCT_IR_REQUIRED", "Revision is not recursive IR v5"); const node = findProductNode(revision.document.product, nodePath); if (!node || node.kind !== "composite") throw new FoundryCommandError("COMPOSITE_NOT_FOUND", "Composite product node was not found"); const compiled = compileProductArchitecture(revision.document).plan!; return success(auth, { nodePath, generations: compiled.compositeGenerations[nodePath] ?? [], dependencies: Object.fromEntries((node.dependencies ?? []).map((edge) => [edge.consumer, edge.provider])), semanticId: `product-composite:${nodePath}` }); }
  getProductWork(auth: FoundryAuthorizationContext, buildId: string, workId: string): CommandResult<any> { requireScope(auth, "foundry:read"); const build = this.build(auth, buildId), state = JSON.parse(build.state_json) as EngineBuildState; if (!state.plan.product || state.nodes[workId] === undefined) throw new FoundryCommandError("WORK_NOT_FOUND", "Recursive product work item was not found"); const row = this.store.db.prepare("SELECT node_path AS nodePath,kind,actor,state,dependencies_json AS dependenciesJson,updated_at AS updatedAt FROM product_work_items WHERE work_id=?").get(workIdForBuild(buildId, workId)) as any; return success(auth, { workId, ...row, dependencies: JSON.parse(row.dependenciesJson), attempts: this.getNodeAttempts(auth, { buildId, nodeId: workId }).state }); }
  getProductNodeEvidence(auth: FoundryAuthorizationContext, buildId: string, nodePath: string): CommandResult<any> { requireScope(auth, "foundry:read"); this.build(auth, buildId); const row = this.store.db.prepare("SELECT evidence_digest AS evidenceDigest,status,created_at AS createdAt FROM node_evidence WHERE build_id=? AND node_path=?").get(buildId, nodePath) as any; if (!row) throw new FoundryCommandError("EVIDENCE_NOT_FOUND", "Node evidence was not found"); return success(auth, { buildId, nodePath, ...row, evidence: JSON.parse(this.readArtifact(auth, row.evidenceDigest).toString("utf8")) }); }
  getProductDeliverables(auth: FoundryAuthorizationContext, buildId: string): CommandResult<any> { requireScope(auth, "foundry:read"); this.build(auth, buildId); const rows = this.store.db.prepare("SELECT deliverable_id AS deliverableId,owner_path AS ownerPath,required,status,artifact_digest AS artifactDigest,evidence_digest AS evidenceDigest,updated_at AS updatedAt FROM product_deliverables WHERE build_id=? ORDER BY deliverable_id").all(buildId); return success(auth, rows); }
  getCapability(auth: FoundryAuthorizationContext, capabilityId: string, version: string): CommandResult<any> { requireScope(auth, "foundry:read"); const capability = builtInCapabilities.get(capabilityId, version); if (!capability) throw new FoundryCommandError("CAPABILITY_NOT_FOUND", "Curated capability version was not found"); return success(auth, capability); }
  getRevisionDiagrams(auth: FoundryAuthorizationContext, projectId: string, revisionId: string): CommandResult<any> { const revision = this.getRevision(auth, projectId, revisionId).state; if (!revision.manifestDigest) throw new FoundryCommandError("ARTIFACT_NOT_FOUND", "Architecture package was not rendered"); return success(auth, JSON.parse(this.readArtifact(auth, revision.manifestDigest).toString("utf8"))); }
  getBuildEvents(auth: FoundryAuthorizationContext, buildId: string): CommandResult<any[]> { requireScope(auth, "foundry:read"); const build = this.build(auth, buildId); const rows = this.store.db.prepare("SELECT seq,kind,payload_json,created_at FROM events WHERE project_id=? ORDER BY seq").all(build.project_id) as any[]; return success(auth, rows.map((row) => ({ seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload_json), createdAt: row.created_at })).filter((event) => event.payload.buildId === buildId)); }
  getProposal(auth: FoundryAuthorizationContext, proposalId: string): CommandResult<any> { requireScope(auth, "foundry:read"); const proposal = this.proposal(auth, proposalId); return success(auth, { id: proposal.id, projectId: proposal.project_id, baseRevisionId: proposal.base_revision_id, targetNodeId: proposal.target_node_id, ownerId: proposal.owner_id, status: proposal.status, proposed: JSON.parse(proposal.proposed_json), invalidates: JSON.parse(proposal.invalidation_json), createdAt: proposal.created_at, updatedAt: proposal.updated_at }); }

  submitSubtreeProposal(auth: FoundryAuthorizationContext, input: { proposalId: string; nodes: Array<FoundryArchitecture["nodes"][number] | FoundryProductNodeV5> }): CommandResult<any> {
    requireScope(auth, "foundry:architect"); const proposal = this.store.db.prepare("SELECT * FROM proposals WHERE id=?").get(input.proposalId) as any; if (!proposal) throw new FoundryCommandError("PROPOSAL_NOT_FOUND", "Proposal was not found"); this.project(auth, proposal.project_id);
    const base = this.store.revision(proposal.base_revision_id).document;
    if (base.version === 5) { const target = findProductNode(base.product, proposal.target_node_id), replacement = input.nodes.length === 1 ? input.nodes[0] as FoundryProductNodeV5 : undefined; if (!target || !replacement || replacement.id !== target.id || replacement.kind !== target.kind || sha256(JSON.stringify(replacement.contracts)) !== sha256(JSON.stringify(target.contracts)) || replacement.acceptance.length < target.acceptance.length) throw new FoundryCommandError("M4_AUTHORITY_VIOLATION", "Recursive replacement must preserve path segment, node kind, parent-facing contracts, and acceptance strength"); this.store.db.prepare("UPDATE proposals SET proposed_json=?,status='proposed',updated_at=? WHERE id=?").run(JSON.stringify([replacement]), new Date().toISOString(), input.proposalId); return success(auth, { proposalId: input.proposalId, status: "proposed", recursive: true }); }
    const legacyBase = base as FoundryArchitecture, target = legacyBase.nodes.find((n) => n.id === proposal.target_node_id)!; const replacement = (input.nodes as FoundryArchitecture["nodes"]).find((n) => n.id === target.id);
    if (!replacement || replacement.owner !== target.owner || sha256(JSON.stringify(replacement.provides)) !== sha256(JSON.stringify(target.provides)) || replacement.acceptance.mandate_owner !== target.acceptance.mandate_owner || acceptanceCount(replacement) < acceptanceCount(target)) throw new FoundryCommandError("M4_AUTHORITY_VIOLATION", "Replacement must preserve target ID, owner, parent-facing interface, and parent-owned acceptance");
    this.store.db.prepare("UPDATE proposals SET proposed_json=?,status='proposed',updated_at=? WHERE id=?").run(JSON.stringify(input.nodes), new Date().toISOString(), input.proposalId); return success(auth, { proposalId: input.proposalId, status: "proposed" });
  }

  private proposal(auth: FoundryAuthorizationContext, proposalId: string): any { const proposal = this.store.db.prepare("SELECT * FROM proposals WHERE id=?").get(proposalId) as any; if (!proposal) throw new FoundryCommandError("PROPOSAL_NOT_FOUND", "Proposal was not found"); this.project(auth, proposal.project_id); return proposal; }

  private mergedProposal(proposal: any): AnyFoundryArchitecture {
    const source = this.store.revision(proposal.base_revision_id).document; if (source.version === 5) { const proposed = JSON.parse(proposal.proposed_json) as FoundryProductNodeV5[]; if (proposed.length !== 1) throw new FoundryCommandError("PROPOSAL_ROOT_REQUIRED", "Recursive proposal must contain exactly its replacement subtree root"); const merged = cloneProductArchitecture(source); replaceProductSubtree(merged, proposal.target_node_id, proposed[0]!); return merged; }
    const base = source as FoundryArchitecture, proposed = JSON.parse(proposal.proposed_json) as FoundryArchitecture["nodes"];
    const children = new Map<string, string[]>(); for (const node of base.nodes) if (node.owner) (children.get(node.owner) ?? children.set(node.owner, []).get(node.owner)!).push(node.id);
    const oldIds = new Set<string>(), queue = [proposal.target_node_id]; while (queue.length) { const id = queue.shift()!; if (oldIds.has(id)) continue; oldIds.add(id); queue.push(...(children.get(id) ?? [])); }
    const proposedIds = new Set(proposed.map((n) => n.id)); if (!proposedIds.has(proposal.target_node_id)) throw new FoundryCommandError("PROPOSAL_ROOT_REQUIRED", "Proposal must contain its target root");
    for (const node of proposed) if (node.id !== proposal.target_node_id && (!node.owner || !proposedIds.has(node.owner))) throw new FoundryCommandError("PROPOSAL_SCOPE_VIOLATION", `${node.id} is not owned inside the proposed subtree`);
    const unrelated = base.nodes.filter((n) => !oldIds.has(n.id)); const unrelatedTargets = new Set(unrelated.flatMap(targetsFor).map((target) => target.path)); for (const node of proposed) for (const target of targetsFor(node)) { assertRepoRelative(target.path); if (unrelatedTargets.has(target.path)) throw new FoundryCommandError("PERMISSION_BROADENING", `${node.id} collides with an unrelated write target`); }
    for (const node of unrelated) for (const req of node.requires ?? []) if (oldIds.has(req.node) && req.node !== proposal.target_node_id) throw new FoundryCommandError("EXTERNAL_DEPENDENCY_VIOLATION", `Unrelated node ${node.id} depends on replaceable interior node ${req.node}`);
    return { ...base, nodes: [...unrelated, ...proposed] };
  }

  async validateProposal(auth: FoundryAuthorizationContext, proposalId: string): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:architect"); const proposal = this.proposal(auth, proposalId), merged = this.mergedProposal(proposal); const diagnostics = merged.version === 5 ? compileProductArchitecture(merged).diagnostics : architectureDiagnostics(merged, this.config.allowLegacyHarness === true);
    try { const plan = await this.engine.compile(merged); this.store.db.prepare("UPDATE proposals SET proposed_json=?,status='validated',updated_at=? WHERE id=?").run(JSON.stringify(merged), new Date().toISOString(), proposalId); return { ...success(auth, { proposalId, valid: !diagnostics.some((d) => d.severity === "error"), plan }), diagnostics }; }
    catch (error) { diagnostics.push({ code: "IR_COMPILE_FAILED", severity: "error", message: (error as Error).message }); return { accepted: false, state: { proposalId, valid: false }, diagnostics, provenance: provenance(auth) }; }
  }

  async buildProposal(auth: FoundryAuthorizationContext, proposalId: string): Promise<CommandResult<any>> {
    requireScope(auth, "foundry:build"); const validated = await this.validateProposal(auth, proposalId); if (!validated.state?.valid) return validated; const proposal = this.proposal(auth, proposalId), architecture = JSON.parse(proposal.proposed_json) as AnyFoundryArchitecture;
    const id = randomUUID(), state = await this.engine.startBuild(id, `proposal:${proposalId}`, architecture), now = new Date().toISOString(); this.store.transaction(() => { this.store.db.prepare("INSERT INTO builds VALUES(?,?,?,?,?,?,?)").run(id, proposal.project_id, `proposal:${proposalId}`, "running", JSON.stringify(state), now, now); if (architecture.version === 5) { const required = new Map(compileProductArchitecture(architecture).plan!.deliverables.map((entry) => [entry.deliverableId, entry.required !== false])); for (const workId of state.plan.order) this.store.db.prepare("INSERT INTO product_work_items(work_id,build_id,node_path,kind,actor,state,dependencies_json,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(workIdForBuild(id, workId), id, state.plan.node_paths?.[workId] ?? workId, state.plan.work_kinds?.[workId] ?? "implementation", state.plan.work_actors?.[workId] ?? "client", state.nodes[workId], JSON.stringify(state.plan.dependencies[workId] ?? []), now); for (const [deliverableId, ownerPath] of Object.entries(state.plan.deliverables ?? {})) this.store.db.prepare("INSERT INTO product_deliverables(build_id,deliverable_id,owner_path,required,status,artifact_digest,evidence_digest,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, deliverableId, ownerPath, required.get(deliverableId) ? 1 : 0, "pending", null, null, now); } this.store.db.prepare("UPDATE proposals SET status='building',updated_at=? WHERE id=?").run(now, proposalId); }); if (architecture.version === 5) await this.advanceProductIntegrations(auth, this.build(auth, id)); return success(auth, { proposalId, buildId: id, build: await this.engineBuild(this.build(auth, id)) });
  }

  prepareActivation(auth: FoundryAuthorizationContext, proposalId: string): CommandResult<any> {
    requireScope(auth, "foundry:activate"); const proposal = this.proposal(auth, proposalId), build = this.store.db.prepare("SELECT * FROM builds WHERE revision_id=? ORDER BY created_at DESC LIMIT 1").get(`proposal:${proposalId}`) as any; if (!build || build.status !== "green") throw new FoundryCommandError("PROPOSAL_BUILD_NOT_GREEN", "Proposal activation requires an all-green isolated build");
    const project = this.project(auth, proposal.project_id); if (project.activeRevisionId !== proposal.base_revision_id) throw new FoundryCommandError("ACTIVE_REVISION_CONFLICT", "Proposal base is stale"); const preparedDigest = sha256(JSON.stringify({ proposalId, baseRevisionId: proposal.base_revision_id, architecture: JSON.parse(proposal.proposed_json) })), token = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + (this.config.confirmationMs ?? 600_000)).toISOString();
    this.store.db.prepare("INSERT INTO confirmations VALUES(?,?,?,?,?,?,?,NULL)").run(token, proposal.project_id, `proposal:${proposalId}`, preparedDigest, null, JSON.stringify({ kind: "proposal-activation", proposalId }), expiresAt); return success(auth, { proposalId, preparedDigest, confirmationToken: token, expiresAt });
  }

  activateProposal(auth: FoundryAuthorizationContext, input: { proposalId: string; preparedDigest: string; confirmationToken: string }): CommandResult<any> {
    requireScope(auth, "foundry:activate"); const proposal = this.proposal(auth, input.proposalId), confirmation = this.store.db.prepare("SELECT * FROM confirmations WHERE token=?").get(input.confirmationToken) as any;
    if (!confirmation || confirmation.revision_id !== `proposal:${input.proposalId}` || confirmation.prepared_digest !== input.preparedDigest || confirmation.used_at || Date.parse(confirmation.expires_at) <= Date.now()) throw new FoundryCommandError("INVALID_CONFIRMATION", "Proposal confirmation is missing, stale, expired, or used"); const architecture = JSON.parse(proposal.proposed_json) as AnyFoundryArchitecture, digest = sha256(JSON.stringify(architecture));
    return this.store.transaction(() => { const revision = this.store.commitRevision(proposal.project_id, proposal.base_revision_id, architecture, digest, null, { clientId: auth.clientId, proposalId: input.proposalId }); const manifest = renderArchitecture(architecture, revision.id, this.artifacts), artifact = this.artifacts.put(JSON.stringify(manifest, null, 2)); this.recordManifest(proposal.project_id, manifest, artifact.digest); this.store.db.prepare("UPDATE revisions SET manifest_digest=? WHERE id=?").run(artifact.digest, revision.id); try { this.store.activate(proposal.project_id, proposal.base_revision_id, revision.id); } catch { throw new FoundryCommandError("ACTIVE_REVISION_CONFLICT", "Proposal base became stale during activation"); } this.store.db.prepare("UPDATE proposals SET status='activated',updated_at=? WHERE id=?").run(new Date().toISOString(), input.proposalId); this.store.db.prepare("UPDATE confirmations SET used_at=? WHERE token=?").run(new Date().toISOString(), input.confirmationToken); return success(auth, { proposalId: input.proposalId, revisionId: revision.id, invalidates: JSON.parse(proposal.invalidation_json) }, { revisionId: revision.id, resources: [{ uri: `foundry://projects/${proposal.project_id}/architecture/revisions/${revision.id}`, name: "activated-proposal", mimeType: "application/json" }] }); });
  }

  prepareRepositoryUpdate(auth: FoundryAuthorizationContext, input: { projectId: string; revisionId?: string; buildId?: string }): CommandResult<any> {
    requireScope(auth, "foundry:publish"); const project = this.project(auth, input.projectId), revisionId = input.revisionId ?? project.activeRevisionId; if (!revisionId) throw new FoundryCommandError("REVISION_REQUIRED", "No revision was selected"); const revision = this.store.revision(revisionId), workspace = this.store.workspace(input.projectId); if (!workspace) throw new FoundryCommandError("WORKSPACE_REQUIRED", "Bind a workspace before publication");
    if (!revision || revision.projectId !== input.projectId || !revision.manifestDigest) throw new FoundryCommandError("REVISION_NOT_FOUND", "The selected revision or its architecture package was not found");
    const head = spawnSync("git", ["-C", workspace.internal_path, "rev-parse", "HEAD"], { encoding: "utf8" }); if (head.status !== 0) throw new FoundryCommandError("GIT_REQUIRED", "Bound workspace is not a Git checkout");
    const manifestBytes = this.artifacts.get(revision.manifestDigest), manifest = JSON.parse(manifestBytes.toString("utf8")) as ReturnType<typeof renderArchitecture>;
    if (manifest.revisionId !== revisionId || manifest.sourceDigest !== sha256(JSON.stringify(revision.document))) throw new FoundryCommandError("ARTIFACT_INTEGRITY", "The architecture manifest does not match the selected revision");
    const safeViewIds = new Set<string>();
    const diagramFiles = manifest.diagrams.flatMap((diagram) => diagram.artifacts.map((artifact) => {
      const safeViewId = diagram.viewId.replace(/[^A-Za-z0-9._-]/g, "_");
      if (!safeViewId || (safeViewIds.has(`${safeViewId}.${artifact.format}`))) throw new FoundryCommandError("ARTIFACT_PATH_COLLISION", `Diagram view ${diagram.viewId} cannot be projected to a unique repository path`);
      safeViewIds.add(`${safeViewId}.${artifact.format}`);
      const extension = artifact.format === "plantuml" ? "puml" : artifact.format;
      return { path: `architecture/views/${safeViewId}.${extension}`, content: this.artifacts.get(artifact.digest), mediaType: artifact.format === "plantuml" ? "text/vnd.plantuml" : `image/${artifact.format}` };
    }));
    const buildFiles: Array<{ path: string; content: Buffer; mediaType: string }> = []; let assemblyDigest: string | null = null, conformanceDigest: string | null = null, mutationDigests: string[] = [];
    if (input.buildId && revision.document.version === 5) {
      const build = this.build(auth, input.buildId), architecture = revision.document, state = JSON.parse(build.state_json) as EngineBuildState, assembly = this.latestAssembly(build.id);
      if (build.project_id !== input.projectId || build.revision_id !== revisionId || build.status !== "green" || state.assembly !== "green" || !Object.values(state.nodes).every((entry) => entry === "green")) throw new FoundryCommandError("BUILD_NOT_PUBLISHABLE", "Recursive product publication requires a completely green work and integration tree");
      if (!assembly || assembly.status !== "green" || !assembly.evidence_digest) throw new FoundryCommandError("ASSEMBLY_NOT_GREEN", "Recursive product publication requires immutable green assembly evidence");
      const productEvidenceDigest = String(assembly.evidence_digest); assemblyDigest = productEvidenceDigest; conformanceDigest = productEvidenceDigest; const evidence = JSON.parse(this.artifacts.get(productEvidenceDigest).toString("utf8"));
      if (evidence.schemaVersion !== 3 || evidence.reproducibility?.status !== "green" || evidence.assembly?.runtime?.language !== "foundry-product" || !evidence.rootEvidenceDigest) throw new FoundryCommandError("TRUSTWORTHY_EVIDENCE_REQUIRED", "IR v5 code publication requires hierarchical evidence v3, Piston product verification, and reproducible deliverables");
      const compiled = compileProductArchitecture(architecture).plan!, overlay = this.buildWorkspace(build, state), nodeEvidence = new Set(Object.keys(evidence.nodeEvidenceDigests ?? {}));
      const missingEvidence = Object.keys(compiled.nodes).filter((nodePath) => !nodeEvidence.has(nodePath)); if (missingEvidence.length) throw new FoundryCommandError("INCOMPLETE_EVIDENCE_TREE", "Every recursive product node requires immutable evidence", { nodePaths: missingEvidence });
      for (const { target } of allProductTargets(architecture.product)) { const path = resolveBoundPath(overlay, target.path); if (!existsSync(path)) throw new FoundryCommandError("BUILD_ARTIFACT_MISSING", `Green target ${target.targetId} is missing`); buildFiles.push({ path: target.path, content: readFileSync(path), mediaType: target.mediaType }); }
      const deliverables = this.store.db.prepare("SELECT deliverable_id AS deliverableId,required,status,artifact_digest AS artifactDigest,evidence_digest AS evidenceDigest FROM product_deliverables WHERE build_id=? ORDER BY deliverable_id").all(build.id) as any[];
      const missingDeliverables = deliverables.filter((entry) => entry.required && (entry.status !== "green" || !entry.artifactDigest || !entry.evidenceDigest)); if (missingDeliverables.length) throw new FoundryCommandError("DELIVERABLE_GATE_FAILED", "Every required deliverable must have green reproducible evidence", { deliverables: missingDeliverables.map((entry) => entry.deliverableId) });
      mutationDigests = (this.store.db.prepare("SELECT evidence_digest AS evidenceDigest FROM mutation_reports WHERE build_id=? ORDER BY node_id,created_at").all(build.id) as any[]).map((entry) => entry.evidenceDigest); if (this.config.mutationMode === "enforce" && mutationDigests.length < compiled.workItems.filter((item) => item.kind === "implementation").length) throw new FoundryCommandError("MUTATION_GATE_FAILED", "Enforced IR v5 publication requires a mutation report for every implementation work item");
      for (const entry of deliverables) if (entry.status === "green") { const safeId = String(entry.deliverableId).replace(/[^A-Za-z0-9._-]/g, "_"); buildFiles.push({ path: `dist/foundry/${safeId}`, content: this.artifacts.get(entry.artifactDigest), mediaType: "application/octet-stream" }, { path: `architecture/evidence/deliverables/${safeId}.json`, content: this.artifacts.get(entry.evidenceDigest), mediaType: "application/json" }); }
      buildFiles.push({ path: "architecture/evidence/product-conformance-v3.json", content: this.artifacts.get(productEvidenceDigest), mediaType: "application/json" });
    } else if (input.buildId) { const build = this.build(auth, input.buildId), architecture = revision.document as FoundryArchitecture; if (architecture.version !== 4 || !architecture.delivery) throw new FoundryCommandError("DELIVERY_PROFILE_REQUIRED", "New code publication requires IR v4 with a delivery profile; legacy revisions remain architecture-publishable"); if (build.project_id !== input.projectId || build.revision_id !== revisionId || build.status !== "green") throw new FoundryCommandError("BUILD_NOT_PUBLISHABLE", "Build publication requires green authored nodes and a green assembly gate"); const state = JSON.parse(build.state_json) as EngineBuildState, overlay = this.buildWorkspace(build, state), assembly = this.latestAssembly(build.id); if (!assembly || assembly.status !== "green" || !assembly.evidence_digest) throw new FoundryCommandError("ASSEMBLY_NOT_GREEN", "Build publication requires immutable green assembly evidence"); assemblyDigest = assembly.evidence_digest; const evidence = JSON.parse(this.artifacts.get(assemblyDigest!).toString("utf8")); if (evidence.schemaVersion !== 2 || evidence.environment?.sandbox !== "piston" || evidence.reproducibility?.status !== "green") throw new FoundryCommandError("TRUSTWORTHY_EVIDENCE_REQUIRED", "Code publication requires evidence v2, Piston verification, and reproducible clean builds"); if (this.config.mutationMode === "enforce") { const reports = this.store.db.prepare("SELECT node_id AS nodeId,report_json AS reportJson FROM mutation_reports WHERE build_id=? ORDER BY created_at DESC").all(build.id) as any[], latest = new Map<string, any>(); for (const report of reports) if (!latest.has(report.nodeId)) latest.set(report.nodeId, JSON.parse(report.reportJson)); const weak = architecture.nodes.filter((node) => latest.get(node.id)?.status !== "strong").map((node) => node.id); if (weak.length) throw new FoundryCommandError("MUTATION_GATE_FAILED", "Every node requires a strong mutation report", { nodes: weak }); } conformanceDigest = evidence.conformanceDigest; for (const node of architecture.nodes) for (const declared of targetsFor(node)) { const target = resolveBoundPath(overlay, declared.path); if (!existsSync(target)) throw new FoundryCommandError("BUILD_ARTIFACT_MISSING", `Green target ${declared.targetId} is missing`); buildFiles.push({ path: declared.path, content: readFileSync(target), mediaType: declared.mediaType }); } buildFiles.push({ path: "tests/__init__.py", content: Buffer.from(""), mediaType: "text/x-python" }, { path: "tests/foundry/__init__.py", content: Buffer.from(""), mediaType: "text/x-python" }); buildFiles.push({ path: "tests/foundry/test_acceptance.py", content: this.artifacts.get(conformanceDigest!), mediaType: "text/x-python" }, { path: "architecture/conformance.json", content: this.artifacts.get(assemblyDigest!), mediaType: "application/json" }); }
    const files = [
      { path: "architecture/foundry.ir.json", content: Buffer.from(JSON.stringify(revision.document, null, 2) + "\n"), mediaType: "application/json" },
      { path: "architecture/manifest.json", content: manifestBytes, mediaType: "application/json" },
      { path: "architecture/architecture.excalidraw", content: this.artifacts.get(manifest.excalidraw.digest), mediaType: "application/vnd.excalidraw+json" },
      ...diagramFiles,
      ...buildFiles,
    ];
    const publicationPaths = new Set<string>(); for (const file of files) { assertRepoRelative(file.path); if (publicationPaths.has(file.path)) throw new FoundryCommandError("PUBLICATION_PATH_COLLISION", `${file.path} is claimed by more than one prepared artifact`); publicationPaths.add(file.path); }
    const changes = files.map((file) => { const target = join(workspace.internal_path, file.path), before = existsSync(target) ? readFileSync(target) : null; return { path: file.path, mediaType: file.mediaType, size: file.content.length, beforeDigest: before === null ? null : sha256(before), afterDigest: sha256(file.content), contentBase64: file.content.toString("base64"), changed: before === null || !before.equals(file.content) }; }).filter((x) => x.changed);
    for (const change of changes) { const status = spawnSync("git", ["-C", workspace.internal_path, "status", "--porcelain", "--", change.path], { encoding: "utf8" }); if (status.status !== 0) throw new FoundryCommandError("GIT_STATUS_FAILED", status.stderr); if (status.stdout.trim()) throw new FoundryCommandError("OVERLAPPING_DIRTY_FILE", `${change.path} has uncommitted changes`); }
    const publicChanges = changes.map(({ contentBase64: _, changed: __, ...rest }) => rest);
    const preparedDigest = sha256(JSON.stringify({ revisionId, buildId: input.buildId ?? null, manifestDigest: revision.manifestDigest, assemblyDigest, conformanceDigest, mutationDigests, head: head.stdout.trim(), changes: publicChanges })), token = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + (this.config.confirmationMs ?? 600_000)).toISOString();
    const diff = changes.map((change) => change.mediaType.startsWith("text/") || change.mediaType === "application/json" || change.mediaType.includes("excalidraw") ? `--- a/${change.path}\n+++ b/${change.path}\n@@ complete generated file @@\n${Buffer.from(change.contentBase64, "base64").toString("utf8")}` : `Binary file ${change.path} (${change.size} bytes, ${change.afterDigest})`).join("\n");
    this.store.db.prepare("INSERT INTO confirmations VALUES(?,?,?,?,?,?,?,NULL)").run(token, input.projectId, revisionId, preparedDigest, head.stdout.trim(), JSON.stringify(changes), expiresAt); return success(auth, { revisionId, buildId: input.buildId ?? null, baseHead: head.stdout.trim(), manifestDigest: revision.manifestDigest, assemblyDigest, conformanceDigest, mutationDigests, preparedDigest, confirmationToken: token, expiresAt, changes: publicChanges, diff });
  }

  applyRepositoryUpdate(auth: FoundryAuthorizationContext, input: { projectId: string; revisionId: string; preparedDigest: string; confirmationToken: string }): CommandResult<any> {
    requireScope(auth, "foundry:publish"); const project = this.project(auth, input.projectId), workspace = this.store.workspace(input.projectId); const confirmation = this.store.db.prepare("SELECT * FROM confirmations WHERE token=?").get(input.confirmationToken) as any;
    if (!confirmation || confirmation.project_id !== input.projectId || confirmation.revision_id !== input.revisionId || confirmation.prepared_digest !== input.preparedDigest || confirmation.used_at || Date.parse(confirmation.expires_at) <= Date.now()) throw new FoundryCommandError("INVALID_CONFIRMATION", "Confirmation is missing, expired, used, or bound to different content");
    if (!workspace) throw new FoundryCommandError("WORKSPACE_REQUIRED", "The project workspace binding is missing");
    if (project.activeRevisionId !== input.revisionId) throw new FoundryCommandError("ACTIVE_REVISION_CONFLICT", "Prepared revision is no longer active");
    const changes = JSON.parse(confirmation.payload_json) as Array<{ path: string; beforeDigest: string | null; afterDigest: string; contentBase64: string }>;
    const paths = changes.map((c) => c.path), headResult = spawnSync("git", ["-C", workspace.internal_path, "rev-parse", "HEAD"], { encoding: "utf8" }); if (headResult.status !== 0) throw new FoundryCommandError("GIT_REQUIRED", "Bound workspace is not a Git checkout"); const head = headResult.stdout.trim();
    if (head !== confirmation.base_head) {
      // A process may have crashed after Git committed but before SQLite consumed the
      // confirmation. Recover only when the current commit and every prepared file
      // prove that this exact outbox operation completed.
      const message = spawnSync("git", ["-C", workspace.internal_path, "log", "-1", "--pretty=%B"], { encoding: "utf8" }).stdout;
      const exactFiles = changes.every((change) => { const target = resolveBoundPath(workspace.internal_path, change.path); return existsSync(target) && sha256(readFileSync(target)) === change.afterDigest; });
      const pending = this.store.db.prepare("SELECT status FROM outbox WHERE id=? AND aggregate_id=? AND kind='repository-publication'").get(input.confirmationToken, input.projectId) as { status: string } | undefined;
      if (pending?.status === "pending" && message.includes(`Prepared: ${input.preparedDigest}`) && exactFiles) {
        const completedAt = new Date().toISOString(); this.store.transaction(() => { this.store.db.prepare("UPDATE confirmations SET used_at=? WHERE token=?").run(completedAt, input.confirmationToken); this.store.db.prepare("UPDATE outbox SET status='completed',completed_at=? WHERE id=?").run(completedAt, input.confirmationToken); }); return success(auth, { revisionId: input.revisionId, committed: paths.length > 0, paths, recovered: true });
      }
      throw new FoundryCommandError("GIT_HEAD_CONFLICT", "Git HEAD changed after preparation");
    }
    for (const change of changes) { assertRepoRelative(change.path); const target = resolveBoundPath(workspace.internal_path, change.path), before = existsSync(target) ? sha256(readFileSync(target)) : null; if (before !== change.beforeDigest) throw new FoundryCommandError("FILE_CONFLICT", `${change.path} changed after preparation`); }
    const outboxPayload = JSON.stringify({ projectId: input.projectId, revisionId: input.revisionId, preparedDigest: input.preparedDigest, baseHead: confirmation.base_head, paths });
    this.store.transaction(() => { this.store.db.prepare("INSERT INTO outbox(id,aggregate_id,kind,payload_json,status,created_at,completed_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,status='pending',completed_at=NULL").run(input.confirmationToken, input.projectId, "repository-publication", outboxPayload, "pending", new Date().toISOString()); });
    const originals = new Map<string, Buffer | null>(), temporary: string[] = [];
    try {
      for (const change of changes) {
        const target = resolveBoundPath(workspace.internal_path, change.path), content = Buffer.from(change.contentBase64, "base64");
        if (sha256(content) !== change.afterDigest) throw new FoundryCommandError("ARTIFACT_INTEGRITY", `${change.path} does not match its prepared digest`);
        originals.set(target, existsSync(target) ? readFileSync(target) : null); mkdirSync(dirname(target), { recursive: true });
        const staged = `${target}.foundry-${input.confirmationToken.slice(0, 12)}.tmp`; writeFileSync(staged, content, { flag: "wx" }); temporary.push(staged);
      }
      for (let index = 0; index < changes.length; index++) renameSync(temporary[index]!, resolveBoundPath(workspace.internal_path, changes[index]!.path));
      if (paths.length) { const add = spawnSync("git", ["-C", workspace.internal_path, "add", "--", ...paths], { encoding: "utf8" }); if (add.status !== 0) throw new FoundryCommandError("GIT_ADD_FAILED", add.stderr); const includesBuild = paths.some((path) => !path.startsWith("architecture/") && !path.endsWith(".excalidraw")); const commit = spawnSync("git", ["-C", workspace.internal_path, "commit", "-m", `foundry: publish ${includesBuild ? "architecture and build" : "architecture"} ${input.revisionId}\n\nProject: ${input.projectId}\nManifest: ${this.store.revision(input.revisionId)?.manifestDigest}\nPrepared: ${input.preparedDigest}`], { encoding: "utf8" }); if (commit.status !== 0) throw new FoundryCommandError("GIT_COMMIT_FAILED", commit.stderr); }
    } catch (error) {
      for (const staged of temporary) if (existsSync(staged)) unlinkSync(staged);
      for (const [target, original] of originals) { if (original === null) { if (existsSync(target)) unlinkSync(target); } else writeFileSync(target, original); }
      if (paths.length) spawnSync("git", ["-C", workspace.internal_path, "restore", "--staged", "--", ...paths], { encoding: "utf8" });
      this.store.db.prepare("UPDATE outbox SET status='failed',completed_at=? WHERE id=?").run(new Date().toISOString(), input.confirmationToken); throw error;
    }
    const completedAt = new Date().toISOString(); this.store.transaction(() => { this.store.db.prepare("UPDATE confirmations SET used_at=? WHERE token=?").run(completedAt, input.confirmationToken); this.store.db.prepare("UPDATE outbox SET status='completed',completed_at=? WHERE id=?").run(completedAt, input.confirmationToken); }); return success(auth, { revisionId: input.revisionId, committed: paths.length > 0, paths, recovered: false });
  }
}

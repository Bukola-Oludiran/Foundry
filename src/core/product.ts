import { createHash } from "node:crypto";
import { posix } from "node:path";
import { builtInCapabilities, FoundryCapabilityRegistry } from "./capabilities.ts";
import type {
  Diagnostic, FoundryAcceptanceScenario, FoundryConstraint, FoundryDeliverableDeclaration,
  FoundryDependencyException, FoundryProductArchitectureV5, FoundryProductNodeV5,
  FoundryPublicContract, FoundryRequirementAllocation, FoundryScopedDependency, FoundryTarget,
} from "./types.ts";

export const PRODUCT_LIMITS = Object.freeze({ maxDepth: 16, maxNodes: 2_048, maxChildren: 128, maxExceptions: 64, maxBytes: 4 * 1024 * 1024 });

export interface CompiledProductNode {
  nodePath: string;
  parentPath: string | null;
  depth: number;
  kind: "leaf" | "composite";
  childPaths: string[];
  contracts: string[];
  effectiveConstraints: FoundryConstraint[];
  implementationTargets: FoundryTarget[];
  hasGlue: boolean;
  capabilityRefs: string[];
  deliverableIds: string[];
  supersedes?: string;
}

export interface CompiledProductWorkItem {
  workId: string;
  nodePath: string;
  kind: "implementation" | "integration";
  actor: "client" | "system";
  dependencies: string[];
  writeTargets: string[];
}

export interface CompiledProductPlan {
  schemaVersion: 1;
  architectureDigest: string;
  rootPath: string;
  order: string[];
  postOrder: string[];
  nodes: Record<string, CompiledProductNode>;
  owners: Record<string, string | null>;
  children: Record<string, string[]>;
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
  compositeGenerations: Record<string, string[][]>;
  contractEdges: Array<{ providerPath: string; consumerPath: string; contractId: string; exception: boolean }>;
  effectiveConstraints: Record<string, FoundryConstraint[]>;
  requirementTrace: Record<string, Array<{ nodePath: string; scenarioIds: string[] }>>;
  workItems: CompiledProductWorkItem[];
  deliverables: Array<FoundryDeliverableDeclaration & { ownerPath: string }>;
  invalidation: Record<string, string[]>;
}

export interface ProductCompilation { valid: boolean; diagnostics: Diagnostic[]; plan?: CompiledProductPlan }

const segmentPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const stable = (value: unknown): string => JSON.stringify(sortValue(value));
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortValue(nested)]));
  return value;
}
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const targetValid = (path: string): boolean => path.length > 0 && !path.startsWith("/") && !path.includes("\\") && posix.normalize(path) === path && path.split("/").every((part) => part !== ".." && part !== "." && part.length > 0);
const scenarioIds = (scenarios: FoundryAcceptanceScenario[]): Set<string> => new Set(scenarios.map((scenario) => scenario.id));

function generations(children: string[], deps: Record<string, string[]>): string[][] | null {
  const degree = new Map(children.map((child) => [child, deps[child]?.length ?? 0]));
  const out: string[][] = [];
  let ready = children.filter((child) => degree.get(child) === 0).sort();
  let visited = 0;
  while (ready.length) {
    out.push(ready); visited += ready.length;
    const next: string[] = [];
    for (const provider of ready) for (const consumer of children) if ((deps[consumer] ?? []).includes(provider)) { const value = degree.get(consumer)! - 1; degree.set(consumer, value); if (value === 0) next.push(consumer); }
    ready = next.sort();
  }
  return visited === children.length ? out : null;
}

function publicContract(contracts: FoundryPublicContract[], id: string): FoundryPublicContract | undefined { return contracts.find((contract) => contract.id === id); }
function localPath(parentPath: string, segment: string): string { return parentPath ? `${parentPath}/${segment}` : segment; }

export function compileProductArchitecture(ir: FoundryProductArchitectureV5, registry: FoundryCapabilityRegistry = builtInCapabilities): ProductCompilation {
  const diagnostics: Diagnostic[] = [];
  let encodedBytes = Number.POSITIVE_INFINITY;
  try { encodedBytes = Buffer.byteLength(JSON.stringify(ir)); } catch {}
  if (encodedBytes > PRODUCT_LIMITS.maxBytes) diagnostics.push({ code: "PRODUCT_IR_TOO_LARGE", severity: "error", message: `IR exceeds ${PRODUCT_LIMITS.maxBytes} bytes` });
  if (ir.version !== 5) diagnostics.push({ code: "PRODUCT_IR_VERSION", severity: "error", message: "Recursive product architecture requires version 5" });

  const byPath = new Map<string, FoundryProductNodeV5>();
  const parent = new Map<string, string | null>();
  const depth = new Map<string, number>();
  const effective = new Map<string, FoundryConstraint[]>();
  const targetOwners = new Map<string, string>();
  const contractIds = new Map<string, Set<string>>();
  const deliverableIds = new Map<string, string>();
  let exceptionCount = 0;

  const walk = (node: FoundryProductNodeV5, parentPath: string | null, inherited: FoundryConstraint[], currentDepth: number): void => {
    const path = localPath(parentPath ?? "", node.id);
    if (!segmentPattern.test(node.id)) diagnostics.push({ code: "INVALID_NODE_SEGMENT", severity: "error", message: `${node.id} is not a canonical path segment`, path });
    if (currentDepth > PRODUCT_LIMITS.maxDepth) diagnostics.push({ code: "PRODUCT_DEPTH_EXCEEDED", severity: "error", message: `${path} exceeds depth ${PRODUCT_LIMITS.maxDepth}`, path });
    if (byPath.has(path)) diagnostics.push({ code: "DUPLICATE_NODE_PATH", severity: "error", message: `Duplicate node path ${path}`, path });
    byPath.set(path, node); parent.set(path, parentPath); depth.set(path, currentDepth);
    const contractSet = new Set<string>();
    for (const [index, contract] of node.contracts.entries()) {
      if (!contract.id || contractSet.has(contract.id)) diagnostics.push({ code: "DUPLICATE_CONTRACT", severity: "error", message: `${path} repeats contract ${contract.id}`, path: `${path}/contracts/${index}` });
      contractSet.add(contract.id);
      const operations = new Set<string>(); for (const operation of contract.operations) { if (operations.has(operation.name)) diagnostics.push({ code: "DUPLICATE_OPERATION", severity: "error", message: `${path}/${contract.id} repeats operation ${operation.name}` }); operations.add(operation.name); }
    }
    contractIds.set(path, contractSet);
    const ownOperations = new Map(node.contracts.flatMap((contract) => contract.operations.map((operation) => [operation.name, operation] as const)));
    for (const scenario of node.acceptance) for (const step of scenario.steps) { const operation = ownOperations.get(step.operation); if (!operation) diagnostics.push({ code: "ACCEPTANCE_OPERATION_NOT_FOUND", severity: "error", message: `${path} acceptance step ${step.id} cannot resolve ${step.operation} against its public contracts`, path }); else if (operation.parameters && operation.parameters.length !== step.arguments.length) diagnostics.push({ code: "ACCEPTANCE_ARGUMENT_MISMATCH", severity: "error", message: `${path}/${step.id} supplies ${step.arguments.length} arguments to ${operation.parameters.length}-argument operation ${step.operation}`, path }); }
    const constraints = new Map(inherited.map((constraint) => [constraint.id, constraint]));
    for (const constraint of node.constraints ?? []) {
      if (constraints.has(constraint.id) && constraint.mode !== "narrow" && stable(constraints.get(constraint.id)!.value) !== stable(constraint.value)) diagnostics.push({ code: "CONSTRAINT_BROADENING", severity: "error", message: `${path} must explicitly narrow inherited constraint ${constraint.id}`, path });
      constraints.set(constraint.id, constraint);
    }
    effective.set(path, [...constraints.values()].sort((a, b) => a.id.localeCompare(b.id)));
    for (const [index, ref] of node.capabilityRefs.entries()) diagnostics.push(...registry.validate(ref, node.kind, `${path}/capabilityRefs/${index}`));
    for (const [index, deliverable] of (node.deliverables ?? []).entries()) {
      if (deliverableIds.has(deliverable.deliverableId)) diagnostics.push({ code: "DUPLICATE_DELIVERABLE", severity: "error", message: `${deliverable.deliverableId} is owned by both ${deliverableIds.get(deliverable.deliverableId)} and ${path}` });
      deliverableIds.set(deliverable.deliverableId, path);
      diagnostics.push(...registry.validate(deliverable.capabilityRef, "deliverable", `${path}/deliverables/${index}/capabilityRef`));
      if (deliverable.output && (deliverable.output.maxBytes ?? 1) <= 0) diagnostics.push({ code: "INVALID_ARTIFACT_LIMIT", severity: "error", message: `${deliverable.deliverableId} has an invalid output cap` });
    }
    const children = node.children ?? [];
    if (node.kind === "leaf") {
      if (children.length || node.integration || node.dependencies?.length || node.dependencyExceptions?.length) diagnostics.push({ code: "LEAF_HAS_COMPOSITION", severity: "error", message: `${path} is a leaf but declares composition state`, path });
      if (!node.implementation?.targets.length) diagnostics.push({ code: "LEAF_IMPLEMENTATION_REQUIRED", severity: "error", message: `${path} requires implementation targets`, path });
    } else {
      if (!children.length) diagnostics.push({ code: "COMPOSITE_CHILDREN_REQUIRED", severity: "error", message: `${path} requires children`, path });
      if (children.length > PRODUCT_LIMITS.maxChildren) diagnostics.push({ code: "COMPOSITE_CHILD_LIMIT", severity: "error", message: `${path} exceeds ${PRODUCT_LIMITS.maxChildren} children`, path });
      if (!node.integration?.scenarios.length) diagnostics.push({ code: "COMPOSITE_INTEGRATION_REQUIRED", severity: "error", message: `${path} requires executable integration scenarios`, path });
      if (node.implementation) diagnostics.push({ code: "COMPOSITE_LEAF_IMPLEMENTATION", severity: "error", message: `${path} must put optional glue under integration.glue`, path });
      for (const [index, ref] of (node.integration?.capabilityRefs ?? []).entries()) diagnostics.push(...registry.validate(ref, "composite", `${path}/integration/capabilityRefs/${index}`));
      const childOperations = new Set(children.flatMap((child) => child.contracts.filter((contract) => contract.visibility !== "product").flatMap((contract) => contract.operations.map((operation) => operation.name))));
      for (const scenario of node.integration?.scenarios ?? []) for (const step of scenario.steps) if (!childOperations.has(step.operation) && !ownOperations.has(step.operation)) diagnostics.push({ code: "INTEGRATION_OPERATION_NOT_FOUND", severity: "error", message: `${path} integration step ${step.id} cannot resolve ${step.operation} against child public surfaces`, path });
    }
    const implementationTargets = [...(node.implementation?.targets ?? []), ...(node.integration?.glue?.targets ?? [])], localTargetIds = new Set<string>();
    for (const target of implementationTargets) {
      if (!targetValid(target.path)) diagnostics.push({ code: "INVALID_WRITE_TARGET", severity: "error", message: `${path} has invalid target ${target.path}`, path });
      if (localTargetIds.has(target.targetId)) diagnostics.push({ code: "DUPLICATE_TARGET_ID", severity: "error", message: `${path} repeats target id ${target.targetId}`, path }); localTargetIds.add(target.targetId);
      const prior = targetOwners.get(target.path); if (prior) diagnostics.push({ code: "OVERLAPPING_WRITE_TARGET", severity: "error", message: `${path} and ${prior} share ${target.path}` }); else targetOwners.set(target.path, path);
    }
    const primary = node.implementation?.primaryTargetId ?? node.integration?.glue?.primaryTargetId; if (primary && !localTargetIds.has(primary)) diagnostics.push({ code: "PRIMARY_TARGET_NOT_FOUND", severity: "error", message: `${path} primary target ${primary} is not declared`, path });
    for (const ref of [...node.capabilityRefs, ...(node.integration?.capabilityRefs ?? [])]) { const definition = registry.get(ref.id, ref.version); if (!definition || definition.targetRoles.length === 0) continue; if (implementationTargets.length > definition.limits.maxTargets) diagnostics.push({ code: "CAPABILITY_TARGET_LIMIT", severity: "error", message: `${path} exceeds ${ref.id} target ceiling`, path }); for (const target of implementationTargets) if (!definition.targetRoles.includes(target.role)) diagnostics.push({ code: "CAPABILITY_TARGET_ROLE", severity: "error", message: `${ref.id} does not allow target role ${target.role}`, path }); }
    exceptionCount += node.dependencyExceptions?.length ?? 0;
    for (const child of children) walk(child, path, effective.get(path)!, currentDepth + 1);
  };
  walk(ir.product, null, [], 0);
  if (byPath.size > PRODUCT_LIMITS.maxNodes) diagnostics.push({ code: "PRODUCT_NODE_LIMIT", severity: "error", message: `IR exceeds ${PRODUCT_LIMITS.maxNodes} nodes` });
  if (exceptionCount > PRODUCT_LIMITS.maxExceptions) diagnostics.push({ code: "DEPENDENCY_EXCEPTION_LIMIT", severity: "error", message: `IR exceeds ${PRODUCT_LIMITS.maxExceptions} dependency exceptions` });

  const deliverableDependencies: Record<string, string[]> = Object.fromEntries([...deliverableIds].map(([id]) => [id, []])), artifactOwners = new Map<string, string>();
  for (const [path, node] of byPath) for (const deliverable of node.deliverables ?? []) if (deliverable.output) artifactOwners.set(`${path}\0${deliverable.output.artifactId}`, deliverable.deliverableId);
  for (const [path, node] of byPath) for (const deliverable of node.deliverables ?? []) for (const input of deliverable.inputArtifacts ?? []) { const providerPath = input.node === "self" ? path : input.node.includes("/") ? input.node : `${path}/${input.node}`, provider = artifactOwners.get(`${providerPath}\0${input.artifactId}`); if (!provider) diagnostics.push({ code: "DELIVERABLE_INPUT_NOT_FOUND", severity: "error", message: `${path}/${deliverable.deliverableId} references undeclared artifact ${input.node}:${input.artifactId}` }); else deliverableDependencies[deliverable.deliverableId]!.push(provider); }
  if (generations(Object.keys(deliverableDependencies), deliverableDependencies) === null) diagnostics.push({ code: "DELIVERABLE_CYCLE", severity: "error", message: "Product deliverable graph contains a cycle" });

  const dependencies: Record<string, string[]> = Object.fromEntries([...byPath.keys()].map((path) => [path, []]));
  const dependents: Record<string, string[]> = Object.fromEntries([...byPath.keys()].map((path) => [path, []]));
  const compositeGenerations: Record<string, string[][]> = {};
  const contractEdges: CompiledProductPlan["contractEdges"] = [];
  for (const [path, node] of byPath) {
    if (node.kind !== "composite") continue;
    const childPaths = (node.children ?? []).map((child) => `${path}/${child.id}`), childSet = new Set(childPaths);
    for (const [index, edge] of (node.dependencies ?? []).entries()) {
      const provider = `${path}/${edge.provider}`, consumer = `${path}/${edge.consumer}`;
      if (!childSet.has(provider) || !childSet.has(consumer) || provider === consumer) { diagnostics.push({ code: "DEPENDENCY_OUTSIDE_COMPOSITE", severity: "error", message: `${path} dependency ${edge.provider} -> ${edge.consumer} must join distinct immediate children`, path: `${path}/dependencies/${index}` }); continue; }
      if (!contractIds.get(provider)?.has(edge.contractId)) { diagnostics.push({ code: "DEPENDENCY_CONTRACT_NOT_FOUND", severity: "error", message: `${provider} does not expose ${edge.contractId}` }); continue; }
      dependencies[consumer]!.push(provider); dependents[provider]!.push(consumer); contractEdges.push({ providerPath: provider, consumerPath: consumer, contractId: edge.contractId, exception: false });
    }
    const graph = generations(childPaths, dependencies);
    if (!graph) diagnostics.push({ code: "SCOPED_DEPENDENCY_CYCLE", severity: "error", message: `${path} child dependency graph contains a cycle`, path }); else compositeGenerations[path] = graph;
    for (const [index, edge] of (node.dependencyExceptions ?? []).entries()) validateException(edge, path, index, byPath, contractIds, dependencies, dependents, contractEdges, diagnostics);
  }
  for (const list of Object.values(dependencies)) list.sort(); for (const list of Object.values(dependents)) list.sort();

  const requirementTrace: CompiledProductPlan["requirementTrace"] = {};
  const must = new Set(ir.requirements.filter((requirement) => requirement.priority === "must").map((requirement) => requirement.id));
  const knownRequirements = new Set(ir.requirements.map((requirement) => requirement.id));
  for (const [path, node] of byPath) validateAllocations(path, node, knownRequirements, byPath, requirementTrace, diagnostics);
  for (const requirementId of must) if (!requirementTrace[requirementId]?.some((entry) => entry.scenarioIds.length)) diagnostics.push({ code: "MUST_REQUIREMENT_UNALLOCATED", severity: "error", message: `Must requirement ${requirementId} has no executable recursive allocation` });

  const allPaths = [...byPath.keys()].sort();
  const postOrder = [...allPaths].sort((a, b) => (depth.get(b)! - depth.get(a)!) || a.localeCompare(b));
  const workItems: CompiledProductWorkItem[] = [];
  const finalWork = (path: string): string => byPath.get(path)!.kind === "composite" ? `${path}:integration` : `${path}:implementation`;
  const entryWork = (path: string): string[] => {
    const node = byPath.get(path)!; if (node.kind === "leaf") return [`${path}:implementation`];
    const childPaths = (node.children ?? []).map((child) => `${path}/${child.id}`), ready = childPaths.filter((child) => !(dependencies[child]?.length));
    if (!ready.length && !childPaths.length && node.integration?.glue?.targets.length) return [`${path}:implementation`];
    return ready.flatMap(entryWork);
  };
  for (const path of postOrder) {
    const node = byPath.get(path)!; const childPaths = (node.children ?? []).map((child) => `${path}/${child.id}`);
    if (node.kind === "leaf" || node.integration?.glue?.targets.length) workItems.push({ workId: `${path}:implementation`, nodePath: path, kind: "implementation", actor: "client", dependencies: node.kind === "leaf" ? [] : childPaths.map(finalWork), writeTargets: [...(node.implementation?.targets ?? node.integration?.glue?.targets ?? [])].map((target) => target.path).sort() });
    if (node.kind === "composite") workItems.push({ workId: `${path}:integration`, nodePath: path, kind: "integration", actor: "system", dependencies: [...childPaths.map(finalWork), ...(node.integration?.glue?.targets.length ? [`${path}:implementation`] : [])], writeTargets: [] });
  }
  const byWorkId = new Map(workItems.map((item) => [item.workId, item]));
  for (const [consumer, providers] of Object.entries(dependencies)) for (const provider of providers) for (const entry of entryWork(consumer)) byWorkId.get(entry)?.dependencies.push(finalWork(provider));
  for (const item of workItems) item.dependencies = [...new Set(item.dependencies)].sort();
  const workDependencies = Object.fromEntries(workItems.map((item) => [item.workId, item.dependencies])); if (generations(workItems.map((item) => item.workId), workDependencies) === null) diagnostics.push({ code: "COMBINED_EXECUTION_CYCLE", severity: "error", message: "Ownership, dependency, integration, and deliverable execution edges form a combined cycle" });
  const invalidation: Record<string, string[]> = {};
  for (const changed of allPaths) {
    const affected = new Set<string>(); let cursor: string | null | undefined = changed;
    while (cursor) { affected.add(cursor); cursor = parent.get(cursor); }
    const queue = [changed]; while (queue.length) for (const consumer of dependents[queue.shift()!] ?? []) if (!affected.has(consumer)) { affected.add(consumer); queue.push(consumer); let owner = parent.get(consumer); while (owner) { affected.add(owner); owner = parent.get(owner); } }
    affected.delete(changed); invalidation[changed] = [...affected].sort();
  }

  const nodes = Object.fromEntries(allPaths.map((path) => { const node = byPath.get(path)!; return [path, { nodePath: path, parentPath: parent.get(path)!, depth: depth.get(path)!, kind: node.kind, childPaths: (node.children ?? []).map((child) => `${path}/${child.id}`).sort(), contracts: node.contracts.map((contract) => contract.id).sort(), effectiveConstraints: effective.get(path)!, implementationTargets: [...(node.implementation?.targets ?? node.integration?.glue?.targets ?? [])], hasGlue: Boolean(node.integration?.glue?.targets.length), capabilityRefs: [...node.capabilityRefs, ...(node.integration?.capabilityRefs ?? [])].map((ref) => `${ref.id}@${ref.version}`).sort(), deliverableIds: (node.deliverables ?? []).map((entry) => entry.deliverableId).sort(), ...(node.supersedes ? { supersedes: node.supersedes } : {}) } satisfies CompiledProductNode]; }));
  const owners = Object.fromEntries(allPaths.map((path) => [path, parent.get(path)!]));
  const children = Object.fromEntries(allPaths.map((path) => [path, nodes[path]!.childPaths]));
  const deliverables = allPaths.flatMap((path) => (byPath.get(path)!.deliverables ?? []).map((entry) => ({ ...entry, ownerPath: path })));
  const planWithoutDigest = { schemaVersion: 1 as const, rootPath: ir.product.id, order: allPaths, postOrder, nodes, owners, children, dependencies, dependents, compositeGenerations, contractEdges: contractEdges.sort((a, b) => stable(a).localeCompare(stable(b))), effectiveConstraints: Object.fromEntries(allPaths.map((path) => [path, effective.get(path)!])), requirementTrace, workItems, deliverables, invalidation };
  const plan: CompiledProductPlan = { architectureDigest: digest(ir), ...planWithoutDigest };
  return { valid: diagnostics.every((entry) => entry.severity !== "error"), diagnostics, ...(diagnostics.some((entry) => entry.severity === "error") ? {} : { plan }) };
}

function validateException(edge: FoundryDependencyException, ownerPath: string, index: number, byPath: Map<string, FoundryProductNodeV5>, contracts: Map<string, Set<string>>, dependencies: Record<string, string[]>, dependents: Record<string, string[]>, contractEdges: CompiledProductPlan["contractEdges"], diagnostics: Diagnostic[]): void {
  const path = `${ownerPath}/dependencyExceptions/${index}`;
  if (!byPath.has(edge.providerPath) || !byPath.has(edge.consumerPath)) { diagnostics.push({ code: "DEPENDENCY_EXCEPTION_NODE_NOT_FOUND", severity: "error", message: `${edge.providerPath} -> ${edge.consumerPath} references an unknown node`, path }); return; }
  if (!edge.reason.trim()) diagnostics.push({ code: "DEPENDENCY_EXCEPTION_REASON_REQUIRED", severity: "error", message: "Deep dependency exception requires a reason", path });
  const common = lowestCommonOwner(edge.providerPath, edge.consumerPath);
  if (edge.responsibleOwnerPath !== common || ownerPath !== common) diagnostics.push({ code: "DEPENDENCY_EXCEPTION_OWNER_MISMATCH", severity: "error", message: `Exception must be declared and owned by ${common}`, path });
  if (!edge.reviewId) diagnostics.push({ code: "DEPENDENCY_EXCEPTION_REVIEW_REQUIRED", severity: "error", message: "Deep dependency exception requires independent review evidence", path });
  if (!contracts.get(edge.providerPath)?.has(edge.contractId)) diagnostics.push({ code: "DEPENDENCY_CONTRACT_NOT_FOUND", severity: "error", message: `${edge.providerPath} does not expose ${edge.contractId}`, path });
  dependencies[edge.consumerPath]!.push(edge.providerPath); dependents[edge.providerPath]!.push(edge.consumerPath); contractEdges.push({ providerPath: edge.providerPath, consumerPath: edge.consumerPath, contractId: edge.contractId, exception: true });
}

function lowestCommonOwner(a: string, b: string): string {
  const left = a.split("/"), right = b.split("/"); const common: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length) && left[index] === right[index]; index++) common.push(left[index]!);
  return common.join("/");
}

function validateAllocations(path: string, node: FoundryProductNodeV5, known: Set<string>, byPath: Map<string, FoundryProductNodeV5>, trace: CompiledProductPlan["requirementTrace"], diagnostics: Diagnostic[]): void {
  const ownScenarios = new Set([...scenarioIds(node.acceptance), ...scenarioIds(node.integration?.scenarios ?? [])]);
  for (const [index, allocation] of (node.allocations ?? []).entries()) {
    if (!known.has(allocation.requirementId)) diagnostics.push({ code: "ALLOCATION_REQUIREMENT_NOT_FOUND", severity: "error", message: `${path} allocates unknown requirement ${allocation.requirementId}` });
    if (!allocation.targets.length) diagnostics.push({ code: "ALLOCATION_TARGET_REQUIRED", severity: "error", message: `${path} allocation ${allocation.requirementId} has no targets` });
    for (const target of allocation.targets) if (target.node !== "self" && !byPath.has(`${path}/${target.node}`)) diagnostics.push({ code: "ALLOCATION_TARGET_NOT_CHILD", severity: "error", message: `${path} allocation target ${target.node} is not an immediate child`, path: `${path}/allocations/${index}` });
    const ids = allocation.integrationScenarioIds ?? [];
    for (const scenarioId of ids) if (!ownScenarios.has(scenarioId)) diagnostics.push({ code: "ALLOCATION_SCENARIO_NOT_FOUND", severity: "error", message: `${path} allocation references unknown scenario ${scenarioId}` });
    (trace[allocation.requirementId] ??= []).push({ nodePath: path, scenarioIds: [...ids].sort() });
  }
  for (const scenario of [...node.acceptance, ...(node.integration?.scenarios ?? [])]) for (const requirementId of scenario.covers) (trace[requirementId] ??= []).push({ nodePath: path, scenarioIds: [scenario.id] });
}

export function findProductNode(root: FoundryProductNodeV5, nodePath: string): FoundryProductNodeV5 | undefined {
  const segments = nodePath.split("/"); if (segments.shift() !== root.id) return undefined;
  let node = root; for (const segment of segments) { const next = node.children?.find((child) => child.id === segment); if (!next) return undefined; node = next; } return node;
}

export function cloneProductArchitecture(ir: FoundryProductArchitectureV5): FoundryProductArchitectureV5 { return structuredClone(ir); }

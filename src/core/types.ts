export type FoundryScope =
  | "foundry:read"
  | "foundry:architect"
  | "foundry:build"
  | "foundry:activate"
  | "foundry:publish"
  | "foundry:admin";

export interface FoundryAuthorizationContext {
  tenantId: string;
  userId: string;
  clientId: string;
  scopes: FoundryScope[];
  projectIds?: string[];
  transport: "stdio" | "http" | "test";
  /** Distinguishes independent MCP/critic contexts using the same client binary. */
  contextId?: string;
}

export type ArchitectMode = "solo" | "adaptive" | "architect-critic" | "council";

export interface Requirement {
  id: string;
  kind: "functional" | "quality" | "constraint";
  text: string;
  priority?: "must" | "should" | "could";
}

export interface ArchitectureScenarioStep {
  from: string;
  to: string;
  message: string;
  order: number;
}

export interface ArchitectureScenario {
  id: string;
  name: string;
  critical?: boolean;
  steps: ArchitectureScenarioStep[];
}

export interface DeploymentNode {
  id: string;
  name: string;
  kind: "device" | "process" | "container" | "service" | "database" | "external";
  hosts?: string[];
  boundary?: string;
}

export interface DeploymentLink {
  from: string;
  to: string;
  protocol?: string;
  label?: string;
}

export interface StateModel {
  id: string;
  subject: string;
  initial: string;
  states: string[];
  transitions: Array<{ from: string; to: string; event: string }>;
}

export interface ViewLayout {
  viewId: string;
  positions: Record<string, { x: number; y: number; width?: number; height?: number }>;
}

export interface FoundryInterface {
  name: string;
  operations: Array<{ name: string; signature: string; description?: string; properties?: string[]; parameters?: Array<{ name: string; type: string }>; returns?: string; http?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string } }>;
  types?: Array<{ name: string; definition: string }>;
}

export type FoundryTypedValue = null | boolean | number | string | FoundryTypedValue[] | { [key: string]: FoundryTypedValue } | { $ref: string } | { $type: "datetime" | "decimal" | "bytes"; value: string };
export type FoundryExpectation = { kind: "equals" | "subset"; value: FoundryTypedValue } | { kind: "error"; errorType: string; messageIncludes?: string };
export interface FoundryAcceptanceStep { id: string; operation: string; receiver?: string; arguments: FoundryTypedValue[]; bind?: string; expect?: FoundryExpectation }
export interface FoundryAcceptanceScenario { id: string; name: string; covers: string[]; steps: FoundryAcceptanceStep[] }

export interface FoundryNode {
  id: string;
  kind: "leaf" | "integrator";
  owner: string | null;
  provides: FoundryInterface;
  requires?: Array<{ node: string; interface: string }>;
  implementation: {
    language?: string;
    write_target?: string;
    targets?: FoundryTarget[];
    primaryTargetId?: string;
    entrypoint?: string;
    children?: string[];
    composition?: string;
  };
  acceptance: {
    mandate_owner: string;
    language: string;
    cases: Array<{ name: string; call?: string; expect?: unknown; harness?: string; covers?: string[] }>;
    scenarios?: FoundryAcceptanceScenario[];
    properties?: string[];
    perf?: { time_ms?: number; mem_mb?: number };
  };
}

export interface FoundryArchitecture {
  version?: 2 | 3 | 4;
  spec: { name: string; description?: string; language?: string };
  root: string;
  nodes: FoundryNode[];
  requirements?: Requirement[];
  scenarios?: ArchitectureScenario[];
  deployment?: { nodes: DeploymentNode[]; links: DeploymentLink[] };
  stateModels?: StateModel[];
  layouts?: ViewLayout[];
  research?: Array<{ claim: string; source: string; accessedAt: string }>;
  delivery?: FoundryDeliveryProfile;
}

export interface FoundryNodeMandate {
  outcome: string;
  requirementIds?: string[];
}

export interface FoundryConstraint {
  id: string;
  kind: "security" | "performance" | "runtime" | "delivery" | "quality" | "custom";
  value: FoundryTypedValue;
  /** Narrowing keeps an inherited constraint; replacing it requires an ancestor edit. */
  mode?: "inherit" | "narrow";
}

export interface FoundryPublicContract extends FoundryInterface {
  id: string;
  visibility?: "public" | "product";
}

export interface FoundryCapabilityRef {
  id: string;
  version: string;
  config?: Record<string, FoundryTypedValue>;
}

export interface FoundryDeliverableDeclaration {
  deliverableId: string;
  kind: "library" | "binary" | "package" | "service" | "bundle" | "manifest" | "architecture" | "conformance";
  capabilityRef: FoundryCapabilityRef;
  inputArtifacts?: Array<{ node: string; artifactId: string }>;
  required?: boolean;
  output?: { artifactId: string; mediaType: string; maxBytes?: number };
}

export interface FoundryScopedDependency {
  provider: string;
  consumer: string;
  contractId: string;
}

export interface FoundryDependencyException {
  providerPath: string;
  consumerPath: string;
  contractId: string;
  reason: string;
  responsibleOwnerPath: string;
  reviewId?: string;
}

export interface FoundryRequirementAllocation {
  requirementId: string;
  targets: Array<{ node: string | "self"; responsibility: string }>;
  integrationScenarioIds?: string[];
}

export interface FoundryLeafImplementation {
  targets: FoundryTarget[];
  primaryTargetId?: string;
  entrypoint?: string;
}

export interface FoundryCompositeIntegration {
  scenarios: FoundryAcceptanceScenario[];
  capabilityRefs?: FoundryCapabilityRef[];
  glue?: FoundryLeafImplementation;
}

export interface FoundryProductNodeV5 {
  id: string;
  kind: "leaf" | "composite";
  mandate: FoundryNodeMandate;
  contracts: FoundryPublicContract[];
  constraints?: FoundryConstraint[];
  acceptance: FoundryAcceptanceScenario[];
  capabilityRefs: FoundryCapabilityRef[];
  deliverables?: FoundryDeliverableDeclaration[];
  supersedes?: string;
  implementation?: FoundryLeafImplementation;
  children?: FoundryProductNodeV5[];
  dependencies?: FoundryScopedDependency[];
  dependencyExceptions?: FoundryDependencyException[];
  allocations?: FoundryRequirementAllocation[];
  integration?: FoundryCompositeIntegration;
}

export interface FoundryProductArchitectureV5 {
  version: 5;
  product: FoundryProductNodeV5;
  requirements: Requirement[];
  scenarios?: ArchitectureScenario[];
  deployment?: { nodes: DeploymentNode[]; links: DeploymentLink[] };
  stateModels?: StateModel[];
  layouts?: ViewLayout[];
  research?: Array<{ claim: string; source: string; accessedAt: string }>;
}

export type AnyFoundryArchitecture = FoundryArchitecture | FoundryProductArchitectureV5;

export type FoundryWorkState =
  | "waiting_children"
  | "ready"
  | "leased"
  | "verifying"
  | "integration_ready"
  | "integrating"
  | "green"
  | "red"
  | "contract_weak"
  | "infrastructure_blocked"
  | "cancelled";

export interface FoundryWorkItem {
  workId: string;
  nodePath: string;
  kind: "implementation" | "integration";
  actor: "client" | "system";
  state: FoundryWorkState;
}

export interface FoundryCapabilityDefinition {
  id: string;
  version: string;
  appliesTo: Array<"leaf" | "composite" | "deliverable">;
  targetRoles: FoundryTarget["role"][];
  artifactKinds: FoundryDeliverableDeclaration["kind"][];
  runtime: { language: string; version: string; pistonRuntime: string };
  toolchain: { offline: true; components: string[]; dependencyLock: "required" | "not-applicable" };
  recipes: { verification: string; mutation: string | "not-applicable"; integration: string; packaging: string; reproducibility: string };
  evidenceSchemaVersion: number;
  configKeys: string[];
  limits: { maxTargets: number; maxArtifactBytes: number; maxArtifacts: number };
}

export interface FoundryRequirementEvidence {
  requirementId: string;
  scenarioIds: string[];
  passed: boolean;
}

export type FoundryNodeEvidenceStatus = "pending" | "green" | "red" | "contract_weak" | "infrastructure_blocked" | "cancelled";

export interface FoundryNodeEvidenceV3 {
  nodePath: string;
  architectureDigest: string;
  implementationEvidenceDigest?: string;
  childEvidenceDigests: Record<string, string>;
  integrationEvidenceDigest?: string;
  requirementResults: FoundryRequirementEvidence[];
  deliverableEvidenceDigests: Record<string, string>;
  status: FoundryNodeEvidenceStatus;
}

export interface FoundryProductEvidenceV3 {
  schemaVersion: 3;
  buildId: string;
  revisionId: string;
  rootNodePath: string;
  rootEvidenceDigest: string;
  nodeEvidenceDigests: Record<string, string>;
  deliverableEvidenceDigests: Record<string, string>;
  mutationEvidenceDigests: Record<string, string>;
}

export interface FoundryTarget {
  targetId: string;
  path: string;
  mediaType: string;
  role: "source" | "entrypoint" | "metadata" | "documentation" | "lockfile" | "service-entrypoint" | "migration";
}

export interface PythonLibraryDeliveryProfile {
  profile: "python-library";
  integrationNode: string;
  runtime: { language: "python"; versionRange: string };
  sourceRoot: string;
  distributionName: string;
  publicModule: string;
  dependencyPolicy: "none";
  metadataTargetId: string;
  readmeTargetId: string;
}

export interface PythonServiceDeliveryProfile {
  profile: "python-service";
  integrationNode: string;
  runtime: { language: "python"; versionRange: string };
  sourceRoot: string;
  distributionName: string;
  publicModule: string;
  dependencyPolicy: "locked";
  metadataTargetId: string;
  readmeTargetId: string;
  lockfileTargetId: string;
  serviceEntrypointTargetId: string;
  entrypoint: { module: string; symbol: string };
  healthRoute: string;
  persistence: { engine: "sqlite"; schemaVersion: number };
  migrationOperationId: string;
  readinessOperationId: string;
}

export type FoundryDeliveryProfile = PythonLibraryDeliveryProfile | PythonServiceDeliveryProfile;

export interface FoundryAssemblyState {
  status: "pending" | "running" | "green" | "red" | "cancelled";
  attempts: number;
  evidenceDigest?: string;
  diagnostics?: unknown;
}

export interface FoundryAssemblyEvidence {
  schemaVersion: 1 | 2;
  buildId: string;
  revisionId: string;
  profile: string;
  runtime: { requested: string; resolved: string };
  targetDigests: Record<string, string>;
  passed: number;
  failed: number;
  diagnostics: unknown;
  conformanceDigest: string;
  durationMs: number;
}

export interface FoundryConformanceManifestV2 extends FoundryAssemblyEvidence {
  schemaVersion: 2;
  environment: { worker: string; sandbox: string; oracle: string };
  requirements: Array<{ requirementId: string; priority?: string | null; scenarioIds: string[] }>;
  nodes: Array<{ nodeId: string; mandateOwner: string; properties: string[]; scenarios: unknown[] }>;
  acceptance: Array<{ nodeId: string; scenarioId: string; covers: string[]; passed: boolean; steps: Array<{ stepId: string; operation: string; expectation: unknown; passed: boolean }> }>;
  testSourceDigest: string;
}

export interface FoundryReproducibilityEvidence {
  status: "green" | "red";
  executions: Array<{ packageDigest: string | null; targetDigests: Record<string, string>; passed: number; failed: number }>;
  rawExecutions: unknown[];
  normalizedDigest: string;
  differences: string[];
  volatileFields: string[];
}

export interface FoundryMutationReport {
  mode: "off" | "shadow" | "enforce";
  status: "not_run" | "strong" | "weak";
  generated: number;
  killed: number;
  mutants?: Array<{ mutantId: string; operation: string; location?: string; killed: boolean }>;
  survived: Array<{ mutantId: string; operation: string; location?: string }>;
  score: number | null;
  threshold: number;
}

export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
}

export interface CommandResult<T> {
  accepted: boolean;
  state?: T;
  diagnostics: Diagnostic[];
  revisionId?: string;
  provenance: { operationId: string; clientId: string; at: string };
  resources?: Array<{ uri: string; name: string; mimeType?: string }>;
}

export interface DiagramArtifact {
  viewId: string;
  kind: "ownership" | "dependencies" | "interfaces" | "sequence" | "deployment" | "state";
  status: "rendered" | "not_applicable";
  reason?: string;
  semanticIds: string[];
  relationships?: Array<{ from: string; to: string; label?: string }>;
  artifacts: Array<{ format: "plantuml" | "svg" | "png"; digest: string; uri: string }>;
}

export interface ArchitecturePackageManifest {
  schemaVersion: 1;
  revisionId: string;
  sourceDigest: string;
  renderer: { name: "foundry-projection"; version: string; rasterizer: string; font: string };
  diagrams: DiagramArtifact[];
  excalidraw: { digest: string; uri: string };
  digest: string;
}

export interface NodeChangeSet {
  /** Stable client-generated idempotency key. Required for IR v4 submissions. */
  submissionId?: string;
  leaseId: string;
  targetId: string;
  baseDigest: string | null;
  content?: string;
  files?: Array<{ targetId: string; baseDigest: string | null; content: string }>;
  patch?: string;
  summary: string;
}

export type FoundryVerificationOutcome = "accepted_green" | "authored_red" | "contract_weak" | "infrastructure_error" | "cancelled";

export interface FoundryInfrastructureFailure {
  component: "worker" | "piston" | "sandbox" | "artifact-store" | "engine";
  operation: string;
  retryable: boolean;
  attempt: number;
  diagnosticCode: string;
  observedHealth?: unknown;
  retryAfterMs: number;
}

export class FoundryCommandError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

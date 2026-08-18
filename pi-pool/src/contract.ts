// Authoritative wire types for the GR-host ↔ pi-pool HTTP contract.
// The Rust host (Foundry/gr-host) mirrors these shapes. Prose spec: Foundry/docs/contract.md.
// These reference the IR shapes in Foundry/ir/schema.json.

export type NodeKind = "leaf" | "integrator";
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_PROTOCOL_V2 = 2;

export interface ResourcePolicy {
  timeout_ms: number;
  memory_mb: number;
  cpu_count: number;
  pids: number;
  network: "none" | "model-egress" | "registry-egress" | "private-integration";
}

export interface JobContext {
  protocol_version: 1;
  job_id: string;
  run_id: string;
  ir_digest: string;
  semantic_digest?: string;
  base_commit: string;
  proposal_id?: string;
  revision_id?: string;
  resource_policy: ResourcePolicy;
}

export interface ContentArtifact {
  sha256: string;
  size: number;
  media_type: string;
}

export interface DependencyFileBundleV1 {
  bundle_version: 1;
  kind: "manifest" | "lockfile";
  files: Array<{
    path: string;
    sha256: string;
    content_base64: string;
  }>;
}

export interface ArchitectureRequest {
  architecture_version: 1;
  product_spec: string;
  repository: string;
  base_revision: string;
  allowed_languages: ("python" | "typescript" | "go")[];
  policy_constraints: string[];
  existing_ir?: unknown;
}

export interface ArchitectureJobRequest {
  protocol_version: 1;
  job_id: string;
  attempt: number;
  diagnostics: string[];
  request: ArchitectureRequest;
}

export interface ArchitectureResult {
  proposal: unknown;
  rationale: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface Operation {
  name: string;
  signature: string;
  description?: string;
  properties?: string[]; // behavioral contract clauses (leaky-interface guard)
}

export interface Interface {
  name: string;
  operations: Operation[];
  types?: { name: string; definition: string }[];
}

export interface TestCase {
  name: string;
  call?: string; // expression exercising `provides`, e.g. "slugify('  Hi ')"
  expect?: unknown; // expected result of `call`
  harness?: string; // optional full test-body source
}

export interface TestBundle {
  mandate_owner: string; // parent id (or "spec"); never the node's own id
  language: string;
  cases: TestCase[];
  properties?: string[];
  perf?: { time_ms?: number; mem_mb?: number };
}

/** A dependency reference passed to the doer/tester: interface + how to import + where to read it. */
export interface DepRef {
  node: string;
  interface: Interface;
  import_name: string; // flat module name (bridges workspace paths ↔ Piston flat layout)
  read_path: string; // repo-relative, mounted read-only in the sandbox
}

// ---------- POST /build ----------

export interface BuildRequest extends JobContext {
  node_id: string;
  kind: NodeKind;
  language: string;
  workspace: string; // abs path to the data-plane repo/worktree
  write_target: string; // repo-relative path the doer may write (sandbox write scope)
  provides: Interface;
  requires: DepRef[]; // sandbox read scope = these read_paths (read-only)
  composition: string | null; // integrator only
  children: Omit<DepRef, "interface">[]; // integrator only
  attempt: number; // retry counter
  feedback: string | null; // prior tester failure detail on retry
}

export interface BuildResult {
  node_id: string;
  ok: boolean;
  wrote: string[]; // repo-relative paths written
  summary: string;
  error: string | null;
  failure_code: string | null;
  artifact: ContentArtifact | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

// ---------- POST /test ----------

export interface TestRequest extends JobContext {
  attempt?: number;
  node_id: string;
  language: string;
  workspace: string;
  write_target: string; // the module under test
  provides: Interface;
  acceptance: TestBundle;
  deps: { import_name: string; read_path: string }[]; // modules the runner must also load
}

export interface Failure {
  case: string;
  expected: unknown;
  actual: unknown | null;
  error: string | null;
}

export interface AcceptanceCaseResultV1 {
  name: string;
  status: "passed" | "failed" | "not_run";
  failure: Failure | null;
}

export type EvidenceSymbolKind =
  "function" | "method" | "type" | "constant" | "state";

export interface EvidenceSourceFileV1 {
  path: string;
  sha256: string;
}

export interface EvidenceSymbolV1 {
  name: string;
  kind: EvidenceSymbolKind;
  signature: string | null;
  visibility: "public" | "internal";
  path: string;
  line: number;
}

export interface ContractSymbolMappingV1 {
  operation: string;
  status: "matched" | "missing" | "ambiguous";
  symbols: string[];
}

/** Bounded source metadata for one exact node build. Never contains source text. */
export interface NodeImplementationEvidenceV1 {
  evidence_version: 1;
  node_id: string;
  build_run_id: string;
  proposal_id: string | null;
  revision_id: string | null;
  semantic_digest: string;
  base_commit: string;
  attempt: number;
  language: string;
  source_snapshot_digest: string;
  source_files: EvidenceSourceFileV1[];
  symbols: EvidenceSymbolV1[];
  contract_mappings: ContractSymbolMappingV1[];
  case_results: AcceptanceCaseResultV1[];
  measurements: { duration_ms: number; memory_mb: number | null };
  completeness: "complete" | "partial";
  diagnostics: string[];
  created_at_ms: number;
}

export interface TestResult {
  node_id: string;
  verdict: "green" | "red";
  passed: number;
  failed: number;
  failures: Failure[];
  case_results: AcceptanceCaseResultV1[];
  failure_code: string | null;
  implementation_evidence: NodeImplementationEvidenceV1;
  measurements: { duration_ms: number; memory_mb: number | null };
  artifact: ContentArtifact;
  piston: {
    code: number;
    signal: string | null;
    stdout: string;
    stderr: string;
  };
}

// ---------- Piston /api/v2/execute (subset we use) ----------

export interface PistonFile {
  name?: string;
  content: string;
  encoding?: "utf8" | "base64" | "hex";
}

export interface PistonExecuteRequest {
  language: string;
  version: string; // SemVer selector; resolve from GET /api/v2/runtimes
  files: PistonFile[]; // files[0] is the main file
  stdin?: string;
  args?: string[];
  run_timeout?: number; // ms
  run_memory_limit?: number; // bytes, -1 = unlimited
}

export interface PistonStage {
  stdout: string;
  stderr: string;
  code: number;
  signal: string | null;
  output: string;
}

// ---------- Worker protocol v2: verified dependencies and test environments ----------

export interface DependencyLayerRefV2 {
  artifact_id: string;
  sha256: string;
  package_root: string;
  manifest_path: string;
  lockfile_path: string;
  resolver_image: string;
  platform: string;
}

export interface ResourceBindingV2 {
  resource_id: string;
  kind: "postgresql" | "redis" | "s3" | "nats" | "smtp" | "oidc";
  alias: string;
  permissions: ("read" | "write" | "publish" | "consume" | "admin")[];
  environment: Record<string, string>;
  secret_handles: string[];
}

export interface IntegrationBindingV2 {
  integration_id: string;
  kind: "http" | "webhook" | "stripe" | "openai";
  alias: string;
  operations: string[];
  timeout_ms: number;
  idempotency: boolean;
  secret_handles: string[];
}

export interface TestEnvironmentRefV2 {
  environment_id: string;
  network_id: string;
  snapshot_digest: string;
  resources: ResourceBindingV2[];
  integrations: IntegrationBindingV2[];
}

export type BuildRequestV2 = Omit<BuildRequest, "protocol_version"> & {
  protocol_version: 2;
  dependency_layer: DependencyLayerRefV2 | null;
  resource_bindings: ResourceBindingV2[];
  integration_bindings: IntegrationBindingV2[];
  secret_handles: string[];
};

export type TestRequestV2 = Omit<TestRequest, "protocol_version"> & {
  protocol_version: 2;
  dependency_layer: DependencyLayerRefV2 | null;
  test_environment: TestEnvironmentRefV2 | null;
  migration_phase: "not_required" | "pending" | "applied" | "verified";
};

export type TestResultV2 = TestResult & {
  protocol_version: 2;
  job_id: string;
  run_id: string;
  dependency_layer_sha256: string | null;
  environment_snapshot_digest: string | null;
};

export type PackageEcosystemV2 = "npm" | "pypi" | "go";

export interface PackageDependencyResolutionV2 {
  id: string;
  ecosystem: PackageEcosystemV2;
  name: string;
  version: string;
  integrity: string;
  features: string[];
  extras: string[];
  scope: "runtime" | "development" | "build";
  owner_node: string;
  package_root: string;
}

export interface PackageResolutionRootV2 {
  package_root: string;
  ecosystem: PackageEcosystemV2;
  language: "python" | "typescript" | "go";
  manifest_path: string;
  lockfile_path: string;
  resolver: { mode: "locked"; allow_prereleases: boolean };
  registry_allowlist: string[];
  packages: PackageDependencyResolutionV2[];
}

export interface DependencyResolutionPlanV1 {
  resolution_version: 1;
  ir_digest: string;
  plan_digest: string;
  roots: PackageResolutionRootV2[];
}

export interface SupplyChainPolicyV1 {
  allowed_licenses: string[];
  deny_at_or_above: "unknown" | "low" | "medium" | "high" | "critical";
}

export interface ResolveDependenciesRequestV2 {
  protocol_version: 2;
  job_id: string;
  run_id: string;
  ir_digest: string;
  base_commit: string;
  workspace: string;
  resolver_image: string;
  platform: string;
  existing_repository: boolean;
  resource_policy: ResourcePolicy;
  plan: DependencyResolutionPlanV1;
  policy: SupplyChainPolicyV1;
}

export interface ResolvedPackageV1 {
  package_id: string;
  name: string;
  version: string;
  integrity: string;
  licenses: string[];
}

export interface VulnerabilityFindingV1 {
  package_id: string;
  advisory_id: string;
  severity: "unknown" | "low" | "medium" | "high" | "critical";
  summary: string;
}

export interface DependencyResolutionEvidenceV1 {
  resolution_version: 1;
  plan_digest: string;
  resolver_image: string;
  platform: string;
  manifest_sha256: string;
  lockfile_sha256: string;
  dependency_layer_sha256: string;
  sbom_sha256: string;
  packages: ResolvedPackageV1[];
  vulnerabilities: VulnerabilityFindingV1[];
}

export interface ResolveDependenciesResultV2 {
  ok: boolean;
  evidence: DependencyResolutionEvidenceV1 | null;
  manifest: ContentArtifact | null;
  lockfile: ContentArtifact | null;
  dependency_layer: ContentArtifact | null;
  sbom: ContentArtifact | null;
  license_report: ContentArtifact | null;
  vulnerability_report: ContentArtifact | null;
  error: string | null;
  failure_code: string | null;
}

export interface ResourceServicePlanV1 {
  resource_id: string;
  kind: "postgresql" | "redis" | "s3" | "nats" | "smtp" | "oidc";
  version: string;
  private_alias: string;
  image_key: string;
  consumers: Record<
    string,
    ("read" | "write" | "publish" | "consume" | "admin")[]
  >;
}

export interface IntegrationEmulatorPlanV1 {
  integration_id: string;
  kind: "http" | "webhook" | "stripe" | "openai";
  private_alias: string;
  operations: string[];
  consumers: string[];
}

export interface MigrationPlanV1 {
  resource_id: string;
  owner_node: string;
  migration_path: string;
  require_repeatable: boolean;
}

export interface IntegrationExpectationPlanV1 {
  node: string;
  integration_id: string;
  operation: string;
  request: unknown;
  response: unknown;
}

export interface EnvironmentPlanV1 {
  environment_plan_version: 1;
  ir_digest: string;
  plan_digest: string;
  network_egress: "none";
  resources: ResourceServicePlanV1[];
  integrations: IntegrationEmulatorPlanV1[];
  migrations: MigrationPlanV1[];
  integration_expectations: IntegrationExpectationPlanV1[];
}

export interface StartEnvironmentRequestV2 {
  protocol_version: 2;
  job_id: string;
  run_id: string;
  ir_digest: string;
  base_commit: string;
  plan: EnvironmentPlanV1;
  resource_images: Record<string, string>;
  emulator_image: string;
  resource_policy: ResourcePolicy;
}

export interface EnvironmentActionRequestV2 {
  protocol_version: 2;
  job_id: string;
  run_id: string;
  environment_id: string;
  plan_digest: string;
}

export interface ApplyMigrationsRequestV2 extends EnvironmentActionRequestV2 {
  workspace: string;
  migrations: MigrationPlanV1[];
}

export interface CollectEnvironmentEvidenceRequestV2 extends EnvironmentActionRequestV2 {
  expectations: IntegrationExpectationPlanV1[];
  resources: string[];
}

export interface MigrationOutcomeV2 {
  resource_id: string;
  owner_node: string;
  migration_digest: string;
  applied: boolean;
  repeatable_verified: boolean;
  duration_ms: number;
  diagnostic: string | null;
}

export interface MigrationResultV2 {
  environment_id: string;
  plan_digest: string;
  green: boolean;
  outcomes: MigrationOutcomeV2[];
  artifact: ContentArtifact;
}

export interface EnvironmentHandleV2 {
  environment_id: string;
  run_id: string;
  plan_digest: string;
  network_id: string;
  state: "starting" | "ready" | "degraded" | "stopped";
  aliases: Record<string, string>;
  secret_handles: string[];
}

export interface EnvironmentHealthV2 {
  environment_id: string;
  plan_digest: string;
  healthy: boolean;
  services: Array<{
    id: string;
    healthy: boolean;
    detail: string | null;
  }>;
}

export interface EnvironmentSnapshotV2 {
  environment_id: string;
  plan_digest: string;
  snapshot_digest: string;
  artifact: ContentArtifact;
}

export interface ContractExpectationResultV2 {
  node: string;
  integration_id: string;
  operation: string;
  request_sha256: string;
  response_sha256: string;
  observed_count: number;
  matched: boolean;
  diagnostic: string | null;
}

export interface ResourceUsageV2 {
  resource_id: string;
  cpu_percent: number;
  memory_bytes: number;
  pids: number;
}

export interface EnvironmentTestEvidenceV2 {
  environment_id: string;
  run_id: string;
  plan_digest: string;
  green: boolean;
  contracts: ContractExpectationResultV2[];
  unexpected_requests: number;
  resource_usage: ResourceUsageV2[];
  artifact: ContentArtifact;
}

export interface EnvironmentTeardownV2 {
  environment_id: string;
  plan_digest: string;
  stopped: boolean;
  cleanup_complete: boolean;
  diagnostic_artifact: ContentArtifact | null;
}

export interface PistonExecuteResponse {
  language: string;
  version: string;
  run: PistonStage;
  compile?: PistonStage;
}

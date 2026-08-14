// Authoritative wire types for the GR-host ↔ pi-pool HTTP contract.
// The Rust host (Foundry/gr-host) mirrors these shapes. Prose spec: Foundry/docs/contract.md.
// These reference the IR shapes in Foundry/ir/schema.json.

export type NodeKind = "leaf" | "integrator";

export interface Operation {
  name: string;
  signature: string;
  description?: string;
  properties?: string[]; // behavioral contract clauses (leaky-interface guard)
  parameters?: Array<{ name: string; type: string }>;
  returns?: string;
}

export type TypedValue = null | boolean | number | string | TypedValue[] | { [key: string]: TypedValue } | { $ref: string } | { $type: "datetime" | "decimal" | "bytes"; value: string };
export type TypedExpectation = { kind: "equals" | "subset"; value: TypedValue } | { kind: "error"; errorType: string; messageIncludes?: string };
export interface TypedAcceptanceStep { id: string; operation: string; receiver?: string; arguments: TypedValue[]; bind?: string; expect?: TypedExpectation }
export interface TypedAcceptanceScenario { id: string; name: string; covers: string[]; steps: TypedAcceptanceStep[] }

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
  covers?: string[];
}

export interface TestBundle {
  mandate_owner: string; // parent id (or "spec"); never the node's own id
  language: string;
  cases: TestCase[];
  scenarios?: TypedAcceptanceScenario[];
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

export interface BuildRequest {
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
  usage: { input_tokens: number; output_tokens: number } | null;
}

// ---------- POST /test ----------

export interface TestRequest {
  node_id: string;
  language: string;
  workspace: string;
  write_target: string; // the module under test
  provides: Interface;
  acceptance: TestBundle;
  deps: { import_name: string; read_path: string }[]; // modules the runner must also load
  repository_layout?: boolean;
  module_import_name?: string;
  runtime_version_range?: string;
  repository_files?: string[];
  architecture_version?: number;
}

export interface Failure {
  case: string;
  expected: unknown;
  actual: unknown | null;
  error: string | null;
}

export interface TestResult {
  node_id: string;
  verdict: "green" | "red";
  passed: number;
  failed: number;
  failures: Failure[];
  piston: { code: number; signal: string | null; stdout: string; stderr: string };
}

// ---------- POST /apply-and-test (MCP-native, provider-free) ----------

export interface ApplyAndTestRequest {
  workspace: string; // internal only; public MCP exposes an opaque workspace id
  node: {
    id: string;
    kind: NodeKind;
    provides: Interface;
    requires?: { node: string; interface: string }[];
    implementation: { language?: string; write_target?: string; targets?: Array<{ targetId: string; path: string }>; primaryTargetId?: string };
    acceptance: TestBundle;
  };
  architecture: {
    version?: number;
    delivery?: any;
    spec: { language?: string };
    nodes: Array<{ id: string; kind?: string; implementation: { write_target?: string; targets?: Array<{ targetId: string; path: string }>; primaryTargetId?: string } }>;
  };
  plan: {
    import_names: Record<string, string>;
    write_targets: Record<string, string>;
    read_sets: Record<string, string[]>;
  };
  files?: Array<{ targetId: string; path: string; content: string }>;
  content?: string; // v2 compatibility singleton
}

export interface ApplyAndTestResult {
  verdict: "green" | "red";
  outcome: "accepted_green" | "authored_red";
  diagnostics: (TestResult & { evidenceKind?: string }) | { error: string };
  digest: string;
}

export interface AssemblyRequest {
  workspace: string;
  buildId: string;
  revisionId: string;
  architecture: import("../../src/core/types.ts").FoundryArchitecture;
  conformance: string;
}

export interface MutationRequest { workspace: string; sourcePath: string; repositoryFiles: string[]; conformance: string; maxMutants?: number }

// ---------- POST /product/* (IR v5, provider-free and Piston-only) ----------

export interface ProductApplyRequest {
  workspace: string;
  workId: string;
  nodePath: string;
  node: import("../../src/core/types.ts").FoundryProductNodeV5;
  architecture: import("../../src/core/types.ts").FoundryProductArchitectureV5;
  plan: unknown;
  files: Array<{ targetId: string; path: string; content: string }>;
}

export interface ProductIntegrationRequest {
  workspace: string;
  buildId: string;
  revisionId: string;
  nodePath: string;
  node: import("../../src/core/types.ts").FoundryProductNodeV5;
  architecture: import("../../src/core/types.ts").FoundryProductArchitectureV5;
  childEvidenceDigests: Record<string, string>;
}

export interface ProductAssemblyRequest {
  workspace: string;
  buildId: string;
  revisionId: string;
  architecture: import("../../src/core/types.ts").FoundryProductArchitectureV5;
  deliverables: Array<{ deliverableId: string; ownerPath: string; kind: string; output?: { artifactId?: string; mediaType?: string; maxBytes?: number } }>;
}

export interface ProductVerificationResult {
  verdict: "green" | "red";
  outcome: "accepted_green" | "authored_red" | "contract_weak";
  diagnostics: unknown;
  digest: string;
  evidence: unknown;
}

export interface ProductAssemblyResult {
  verdict: "green" | "red";
  deliverables: Array<{ deliverableId: string; artifactBase64?: string; mediaType?: string; diagnostics?: unknown }>;
  evidence: unknown;
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

export interface PistonExecuteResponse {
  language: string;
  version: string;
  run: PistonStage;
  compile?: PistonStage;
}

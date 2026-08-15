// Authoritative wire types for the GR-host ↔ pi-pool HTTP contract.
// The Rust host (Foundry/gr-host) mirrors these shapes. Prose spec: Foundry/docs/contract.md.
// These reference the IR shapes in Foundry/ir/schema.json.

export type NodeKind = "leaf" | "integrator";
export const WORKER_PROTOCOL_VERSION = 1;

export interface ResourcePolicy {
  timeout_ms: number;
  memory_mb: number;
  cpu_count: number;
  pids: number;
  network: "none" | "model-egress";
}

export interface JobContext {
  protocol_version: 1;
  job_id: string;
  run_id: string;
  ir_digest: string;
  base_commit: string;
  resource_policy: ResourcePolicy;
}

export interface ContentArtifact {
  sha256: string;
  size: number;
  media_type: string;
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

export interface TestResult {
  node_id: string;
  verdict: "green" | "red";
  passed: number;
  failed: number;
  failures: Failure[];
  failure_code: string | null;
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

export interface PistonExecuteResponse {
  language: string;
  version: string;
  run: PistonStage;
  compile?: PistonStage;
}

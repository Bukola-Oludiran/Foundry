import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BuildRequest,
  ArchitectureJobRequest,
  JobContext,
  ResourcePolicy,
  TestRequest,
} from "./contract.ts";
import { WORKER_PROTOCOL_VERSION } from "./contract.ts";
import { languageBackend } from "./language-backend.ts";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value))
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be an object`,
    );
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function array(value: unknown, label: string, max = 1024): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be an array with at most ${max} items`,
    );
  }
  return value;
}

function number(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isFinite(value) ||
    typeof value !== "number" ||
    value < min ||
    value > max
  ) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be between ${min} and ${max}`,
    );
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} has unknown fields: ${unexpected.join(", ")}`,
    );
  }
}

const CONTEXT_KEYS = [
  "protocol_version",
  "job_id",
  "run_id",
  "ir_digest",
  "base_commit",
  "resource_policy",
] as const;

function validatePolicy(raw: unknown): ResourcePolicy {
  const policy = object(raw, "resource_policy");
  exactKeys(
    policy,
    ["timeout_ms", "memory_mb", "cpu_count", "pids", "network"],
    "resource_policy",
  );
  const network = string(policy.network, "resource_policy.network");
  if (network !== "none" && network !== "model-egress") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "resource_policy.network is invalid",
    );
  }
  return {
    timeout_ms: number(
      policy.timeout_ms,
      "resource_policy.timeout_ms",
      100,
      300_000,
    ),
    memory_mb: number(
      policy.memory_mb,
      "resource_policy.memory_mb",
      16,
      16_384,
    ),
    cpu_count: number(policy.cpu_count, "resource_policy.cpu_count", 0.1, 32),
    pids: number(policy.pids, "resource_policy.pids", 1, 4096),
    network,
  };
}

function validateContext(raw: Record<string, unknown>): JobContext {
  if (raw.protocol_version !== WORKER_PROTOCOL_VERSION) {
    throw new RequestError(
      400,
      "UNSUPPORTED_PROTOCOL",
      `protocol_version must be ${WORKER_PROTOCOL_VERSION}`,
    );
  }
  const irDigest = string(raw.ir_digest, "ir_digest");
  if (!/^[a-f0-9]{64}$/.test(irDigest)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "ir_digest must be a lowercase SHA-256 digest",
    );
  }
  const jobId = string(raw.job_id, "job_id");
  const runId = string(raw.run_id, "run_id");
  if (
    jobId.length > 200 ||
    runId.length > 200 ||
    !/^[a-zA-Z0-9._:-]+$/.test(jobId) ||
    !/^[a-zA-Z0-9._:-]+$/.test(runId)
  ) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "job_id and run_id must be bounded safe identifiers",
    );
  }
  return {
    protocol_version: WORKER_PROTOCOL_VERSION,
    job_id: jobId,
    run_id: runId,
    ir_digest: irDigest,
    base_commit: string(raw.base_commit, "base_commit"),
    resource_policy: validatePolicy(raw.resource_policy),
  };
}

function validateInterface(rawValue: unknown, label: string): void {
  const value = object(rawValue, label);
  exactKeys(value, ["name", "operations", "types"], label);
  string(value.name, `${label}.name`);
  const operations = array(value.operations, `${label}.operations`, 256);
  if (operations.length === 0) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label}.operations cannot be empty`,
    );
  }
  for (const [index, rawOperation] of operations.entries()) {
    const operation = object(rawOperation, `${label}.operations[${index}]`);
    exactKeys(
      operation,
      ["name", "signature", "description", "properties"],
      `${label}.operations[${index}]`,
    );
    string(operation.name, `${label}.operations[${index}].name`);
    string(operation.signature, `${label}.operations[${index}].signature`);
    if (operation.properties !== undefined) {
      array(
        operation.properties,
        `${label}.operations[${index}].properties`,
        256,
      );
    }
  }
  if (value.types !== undefined) array(value.types, `${label}.types`, 256);
}

function validateAcceptance(rawValue: unknown, requestLanguage: string): void {
  const value = object(rawValue, "acceptance");
  exactKeys(
    value,
    ["mandate_owner", "language", "cases", "properties", "perf"],
    "acceptance",
  );
  string(value.mandate_owner, "acceptance.mandate_owner");
  if (value.language !== requestLanguage) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "acceptance.language must match request language",
    );
  }
  const cases = array(value.cases, "acceptance.cases", 1024);
  if (cases.length === 0) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "acceptance.cases cannot be empty",
    );
  }
  for (const [index, rawCase] of cases.entries()) {
    const testCase = object(rawCase, `acceptance.cases[${index}]`);
    exactKeys(
      testCase,
      ["name", "call", "expect", "harness"],
      `acceptance.cases[${index}]`,
    );
    string(testCase.name, `acceptance.cases[${index}].name`);
    if (
      (typeof testCase.call === "string") ===
      (typeof testCase.harness === "string")
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `acceptance.cases[${index}] needs exactly one of call or harness`,
      );
    }
  }
  if (value.properties !== undefined)
    array(value.properties, "acceptance.properties", 256);
  if (value.perf !== undefined) {
    const perf = object(value.perf, "acceptance.perf");
    exactKeys(perf, ["time_ms", "mem_mb"], "acceptance.perf");
  }
}

const BUILD_KEYS = [
  ...CONTEXT_KEYS,
  "node_id",
  "kind",
  "language",
  "workspace",
  "write_target",
  "provides",
  "requires",
  "composition",
  "children",
  "attempt",
  "feedback",
] as const;
const TEST_KEYS = [
  ...CONTEXT_KEYS,
  "node_id",
  "language",
  "workspace",
  "write_target",
  "provides",
  "acceptance",
  "deps",
] as const;

function validateCommon(raw: Record<string, unknown>): void {
  validateContext(raw);
  string(raw.node_id, "node_id");
  const language = string(raw.language, "language");
  const backend = languageBackend(language);
  string(raw.workspace, "workspace");
  const writeTarget = string(raw.write_target, "write_target");
  if (!writeTarget.endsWith(backend.extension)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `write_target for ${language} must end in ${backend.extension}`,
    );
  }
  validateInterface(raw.provides, "provides");
}

export function validateBuildRequest(
  value: unknown,
  workspaceRoot?: string,
): BuildRequest {
  const raw = object(value, "request");
  exactKeys(raw, BUILD_KEYS, "request");
  validateCommon(raw);
  if (raw.kind !== "leaf" && raw.kind !== "integrator") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "kind must be leaf or integrator",
    );
  }
  const requires = array(raw.requires, "requires");
  const children = array(raw.children, "children");
  for (const [index, rawDependency] of requires.entries()) {
    const dependency = object(rawDependency, `requires[${index}]`);
    exactKeys(
      dependency,
      ["node", "interface", "import_name", "read_path"],
      `requires[${index}]`,
    );
    string(dependency.node, `requires[${index}].node`);
    string(dependency.import_name, `requires[${index}].import_name`);
    string(dependency.read_path, `requires[${index}].read_path`);
    validateInterface(dependency.interface, `requires[${index}].interface`);
  }
  for (const [index, rawChild] of children.entries()) {
    const child = object(rawChild, `children[${index}]`);
    exactKeys(
      child,
      ["node", "import_name", "read_path"],
      `children[${index}]`,
    );
    string(child.node, `children[${index}].node`);
    string(child.import_name, `children[${index}].import_name`);
    string(child.read_path, `children[${index}].read_path`);
  }
  number(raw.attempt, "attempt", 1, 100);
  const context = validateContext(raw);
  if (context.resource_policy.network !== "model-egress") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "build jobs require model-egress policy",
    );
  }
  validateScopedPaths(raw as unknown as BuildRequest, workspaceRoot);
  return raw as unknown as BuildRequest;
}

export function validateTestRequest(
  value: unknown,
  workspaceRoot?: string,
): TestRequest {
  const raw = object(value, "request");
  exactKeys(raw, TEST_KEYS, "request");
  validateCommon(raw);
  const deps = array(raw.deps, "deps");
  for (const [index, rawDependency] of deps.entries()) {
    const dependency = object(rawDependency, `deps[${index}]`);
    exactKeys(dependency, ["import_name", "read_path"], `deps[${index}]`);
    string(dependency.import_name, `deps[${index}].import_name`);
    string(dependency.read_path, `deps[${index}].read_path`);
  }
  validateAcceptance(raw.acceptance, raw.language as string);
  const context = validateContext(raw);
  if (context.resource_policy.network !== "none") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "test jobs require network=none",
    );
  }
  validateScopedPaths(raw as unknown as TestRequest, workspaceRoot);
  return raw as unknown as TestRequest;
}

export function validateArchitectureRequest(
  value: unknown,
): ArchitectureJobRequest {
  const raw = object(value, "request");
  exactKeys(
    raw,
    ["protocol_version", "job_id", "attempt", "diagnostics", "request"],
    "request",
  );
  if (raw.protocol_version !== WORKER_PROTOCOL_VERSION) {
    throw new RequestError(
      400,
      "UNSUPPORTED_PROTOCOL",
      `protocol_version must be ${WORKER_PROTOCOL_VERSION}`,
    );
  }
  string(raw.job_id, "job_id");
  number(raw.attempt, "attempt", 1, 3);
  const diagnostics = array(raw.diagnostics, "diagnostics", 256);
  diagnostics.forEach((item, index) => string(item, `diagnostics[${index}]`));
  const request = object(raw.request, "request.request");
  exactKeys(
    request,
    [
      "architecture_version",
      "product_spec",
      "repository",
      "base_revision",
      "allowed_languages",
      "policy_constraints",
      "existing_ir",
    ],
    "request.request",
  );
  if (request.architecture_version !== 1) {
    throw new RequestError(
      400,
      "UNSUPPORTED_ARCHITECTURE_VERSION",
      "architecture_version must be 1",
    );
  }
  string(request.product_spec, "request.product_spec");
  string(request.repository, "request.repository");
  string(request.base_revision, "request.base_revision");
  const languages = array(request.allowed_languages, "allowed_languages", 3);
  if (languages.length === 0) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "allowed_languages is empty",
    );
  }
  for (const language of languages) {
    if (
      !["python", "typescript", "go"].includes(string(language, "language"))
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `unsupported language ${String(language)}`,
      );
    }
  }
  const constraints = array(
    request.policy_constraints,
    "policy_constraints",
    256,
  );
  constraints.forEach((item, index) =>
    string(item, `policy_constraints[${index}]`),
  );
  return raw as unknown as ArchitectureJobRequest;
}

function ensureNoSymlink(workspace: string, relativePath: string): void {
  let cursor = workspace;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new RequestError(
          400,
          "PATH_ESCAPE",
          `symlinks are forbidden in scoped path '${relativePath}'`,
        );
      }
    } catch (error) {
      if (error instanceof RequestError) throw error;
      break;
    }
  }
}

function scoped(workspace: string, candidate: string): void {
  if (isAbsolute(candidate))
    throw new RequestError(400, "PATH_ESCAPE", "scoped paths must be relative");
  const resolved = resolve(workspace, candidate);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${sep}`)) {
    throw new RequestError(
      400,
      "PATH_ESCAPE",
      `path escapes workspace: ${candidate}`,
    );
  }
  ensureNoSymlink(workspace, relative(workspace, resolved));
}

function validateScopedPaths(
  req: BuildRequest | TestRequest,
  workspaceRoot?: string,
): void {
  if (!isAbsolute(req.workspace))
    throw new RequestError(400, "PATH_ESCAPE", "workspace must be absolute");
  let workspace: string;
  try {
    workspace = realpathSync(req.workspace);
  } catch {
    throw new RequestError(400, "PATH_ESCAPE", "workspace must already exist");
  }
  if (workspaceRoot) {
    const root = realpathSync(workspaceRoot);
    if (workspace !== root && !workspace.startsWith(`${root}${sep}`)) {
      throw new RequestError(
        403,
        "PATH_ESCAPE",
        "workspace is outside the configured root",
      );
    }
  }
  scoped(workspace, req.write_target);
  const paths =
    "requires" in req
      ? req.requires.map((dep) => dep.read_path)
      : req.deps.map((dep) => dep.read_path);
  for (const path of paths) scoped(workspace, path);
}

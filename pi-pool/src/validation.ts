import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BuildRequest,
  BuildRequestV2,
  ArchitectureJobRequest,
  ApplyMigrationsRequestV2,
  EnvironmentActionRequestV2,
  JobContext,
  ResolveDependenciesRequestV2,
  ResourcePolicy,
  TestRequest,
  TestRequestV2,
  StartEnvironmentRequestV2,
} from "./contract.ts";
import { WORKER_PROTOCOL_VERSION, WORKER_PROTOCOL_V2 } from "./contract.ts";
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
  "semantic_digest",
  "base_commit",
  "proposal_id",
  "revision_id",
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
  if (
    network !== "none" &&
    network !== "model-egress" &&
    network !== "registry-egress" &&
    network !== "private-integration"
  ) {
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

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return result;
}

function safeIdentifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(result)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be a bounded safe identifier`,
    );
  }
  return result;
}

function enumValue(
  value: unknown,
  allowed: readonly string[],
  label: string,
): string {
  const result = string(value, label);
  if (!allowed.includes(result)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be one of ${allowed.join(", ")}`,
    );
  }
  return result;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = string(value, label);
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new RequestError(
      400,
      "PATH_ESCAPE",
      `${label} must be a safe relative path`,
    );
  }
  return path;
}

function validateContext(
  raw: Record<string, unknown>,
  acceptedVersions: readonly number[] = [WORKER_PROTOCOL_VERSION],
): JobContext {
  if (!acceptedVersions.includes(raw.protocol_version as number)) {
    throw new RequestError(
      400,
      "UNSUPPORTED_PROTOCOL",
      `protocol_version must be ${acceptedVersions.join(" or ")}`,
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
  const semanticDigest =
    raw.semantic_digest === undefined
      ? undefined
      : string(raw.semantic_digest, "semantic_digest");
  if (semanticDigest && !/^[a-f0-9]{64}$/.test(semanticDigest)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "semantic_digest must be a lowercase SHA-256 digest",
    );
  }
  const proposalId =
    raw.proposal_id === undefined
      ? undefined
      : string(raw.proposal_id, "proposal_id");
  const revisionId =
    raw.revision_id === undefined
      ? undefined
      : string(raw.revision_id, "revision_id");
  return {
    protocol_version: WORKER_PROTOCOL_VERSION,
    job_id: jobId,
    run_id: runId,
    ir_digest: irDigest,
    semantic_digest: semanticDigest,
    base_commit: string(raw.base_commit, "base_commit"),
    proposal_id: proposalId,
    revision_id: revisionId,
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
  "attempt",
] as const;
const BUILD_V2_KEYS = [
  ...BUILD_KEYS,
  "dependency_layer",
  "resource_bindings",
  "integration_bindings",
  "secret_handles",
] as const;
const TEST_V2_KEYS = [
  ...TEST_KEYS,
  "dependency_layer",
  "test_environment",
  "migration_phase",
] as const;

function validateCommon(
  raw: Record<string, unknown>,
  protocolVersion: 1 | 2,
): void {
  validateContext(raw, [protocolVersion]);
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

function validateDependencyLayer(value: unknown, label: string): void {
  if (value === null) return;
  const layer = object(value, label);
  exactKeys(
    layer,
    [
      "artifact_id",
      "sha256",
      "package_root",
      "manifest_path",
      "lockfile_path",
      "resolver_image",
      "platform",
    ],
    label,
  );
  safeIdentifier(layer.artifact_id, `${label}.artifact_id`);
  digest(layer.sha256, `${label}.sha256`);
  safeIdentifier(layer.package_root, `${label}.package_root`);
  safeRelativePath(layer.manifest_path, `${label}.manifest_path`);
  safeRelativePath(layer.lockfile_path, `${label}.lockfile_path`);
  pinnedImage(layer.resolver_image, `${label}.resolver_image`);
  const platform = string(layer.platform, `${label}.platform`);
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(platform)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label}.platform must be a bounded OCI operating-system/architecture pair`,
    );
  }
}

const RESOURCE_KINDS = ["postgresql", "redis", "s3", "nats", "smtp", "oidc"];
const INTEGRATION_KINDS = ["http", "webhook", "stripe", "openai"];
const RESOURCE_PERMISSIONS = ["read", "write", "publish", "consume", "admin"];

function validateSecretHandles(value: unknown, label: string): void {
  array(value, label, 64).forEach((handle, index) =>
    safeIdentifier(handle, `${label}[${index}]`),
  );
}

function validateResourceBindings(value: unknown, label: string): void {
  array(value, label, 64).forEach((candidate, index) => {
    const itemLabel = `${label}[${index}]`;
    const binding = object(candidate, itemLabel);
    exactKeys(
      binding,
      [
        "resource_id",
        "kind",
        "alias",
        "permissions",
        "environment",
        "secret_handles",
      ],
      itemLabel,
    );
    safeIdentifier(binding.resource_id, `${itemLabel}.resource_id`);
    enumValue(binding.kind, RESOURCE_KINDS, `${itemLabel}.kind`);
    safeIdentifier(binding.alias, `${itemLabel}.alias`);
    array(binding.permissions, `${itemLabel}.permissions`, 8).forEach(
      (permission, permissionIndex) =>
        enumValue(
          permission,
          RESOURCE_PERMISSIONS,
          `${itemLabel}.permissions[${permissionIndex}]`,
        ),
    );
    const environment = object(binding.environment, `${itemLabel}.environment`);
    if (Object.keys(environment).length > 64) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${itemLabel}.environment is too large`,
      );
    }
    Object.entries(environment).forEach(([name, target]) => {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `${itemLabel}.environment contains an invalid variable name`,
        );
      }
      safeIdentifier(target, `${itemLabel}.environment.${name}`);
    });
    validateSecretHandles(
      binding.secret_handles,
      `${itemLabel}.secret_handles`,
    );
  });
}

function validateIntegrationBindings(value: unknown, label: string): void {
  array(value, label, 64).forEach((candidate, index) => {
    const itemLabel = `${label}[${index}]`;
    const binding = object(candidate, itemLabel);
    exactKeys(
      binding,
      [
        "integration_id",
        "kind",
        "alias",
        "operations",
        "timeout_ms",
        "idempotency",
        "secret_handles",
      ],
      itemLabel,
    );
    safeIdentifier(binding.integration_id, `${itemLabel}.integration_id`);
    enumValue(binding.kind, INTEGRATION_KINDS, `${itemLabel}.kind`);
    safeIdentifier(binding.alias, `${itemLabel}.alias`);
    array(binding.operations, `${itemLabel}.operations`, 128).forEach(
      (operation, operationIndex) =>
        safeIdentifier(operation, `${itemLabel}.operations[${operationIndex}]`),
    );
    number(binding.timeout_ms, `${itemLabel}.timeout_ms`, 1, 300_000);
    if (typeof binding.idempotency !== "boolean") {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${itemLabel}.idempotency must be boolean`,
      );
    }
    validateSecretHandles(
      binding.secret_handles,
      `${itemLabel}.secret_handles`,
    );
  });
}

function validateTestEnvironment(value: unknown, label: string): void {
  if (value === null) return;
  const environment = object(value, label);
  exactKeys(
    environment,
    [
      "environment_id",
      "network_id",
      "snapshot_digest",
      "resources",
      "integrations",
    ],
    label,
  );
  safeIdentifier(environment.environment_id, `${label}.environment_id`);
  safeIdentifier(environment.network_id, `${label}.network_id`);
  digest(environment.snapshot_digest, `${label}.snapshot_digest`);
  validateResourceBindings(environment.resources, `${label}.resources`);
  validateIntegrationBindings(
    environment.integrations,
    `${label}.integrations`,
  );
}

export function validateBuildRequest(
  value: unknown,
  workspaceRoot?: string,
): BuildRequest | BuildRequestV2 {
  const raw = object(value, "request");
  const protocolVersion = raw.protocol_version === WORKER_PROTOCOL_V2 ? 2 : 1;
  exactKeys(raw, protocolVersion === 2 ? BUILD_V2_KEYS : BUILD_KEYS, "request");
  validateCommon(raw, protocolVersion);
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
  const context = validateContext(raw, [protocolVersion]);
  if (context.resource_policy.network !== "model-egress") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "build jobs require model-egress policy",
    );
  }
  validateScopedPaths(raw as unknown as BuildRequest, workspaceRoot);
  if (protocolVersion === 2) {
    validateDependencyLayer(raw.dependency_layer, "dependency_layer");
    validateResourceBindings(raw.resource_bindings, "resource_bindings");
    validateIntegrationBindings(
      raw.integration_bindings,
      "integration_bindings",
    );
    validateSecretHandles(raw.secret_handles, "secret_handles");
  }
  return raw as unknown as BuildRequest | BuildRequestV2;
}

export function validateTestRequest(
  value: unknown,
  workspaceRoot?: string,
): TestRequest | TestRequestV2 {
  const raw = object(value, "request");
  const protocolVersion = raw.protocol_version === WORKER_PROTOCOL_V2 ? 2 : 1;
  exactKeys(raw, protocolVersion === 2 ? TEST_V2_KEYS : TEST_KEYS, "request");
  validateCommon(raw, protocolVersion);
  const deps = array(raw.deps, "deps");
  for (const [index, rawDependency] of deps.entries()) {
    const dependency = object(rawDependency, `deps[${index}]`);
    exactKeys(dependency, ["import_name", "read_path"], `deps[${index}]`);
    string(dependency.import_name, `deps[${index}].import_name`);
    string(dependency.read_path, `deps[${index}].read_path`);
  }
  validateAcceptance(raw.acceptance, raw.language as string);
  if (raw.attempt !== undefined) number(raw.attempt, "attempt", 1, 100);
  const context = validateContext(raw, [protocolVersion]);
  if (
    context.resource_policy.network !== "none" &&
    !(
      protocolVersion === 2 &&
      context.resource_policy.network === "private-integration"
    )
  ) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "test jobs require network=none or protocol v2 private-integration",
    );
  }
  validateScopedPaths(raw as unknown as TestRequest, workspaceRoot);
  if (protocolVersion === 2) {
    validateDependencyLayer(raw.dependency_layer, "dependency_layer");
    validateTestEnvironment(raw.test_environment, "test_environment");
    enumValue(
      raw.migration_phase,
      ["not_required", "pending", "applied", "verified"],
      "migration_phase",
    );
    if (
      raw.test_environment !== null &&
      context.resource_policy.network !== "private-integration"
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        "integration test environment requires private-integration network policy",
      );
    }
    if (
      raw.test_environment === null &&
      context.resource_policy.network !== "none"
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        "network-free tests cannot request private integration networking",
      );
    }
  }
  return raw as unknown as TestRequest | TestRequestV2;
}

const RESOLUTION_KEYS = [
  "protocol_version",
  "job_id",
  "run_id",
  "ir_digest",
  "base_commit",
  "workspace",
  "resolver_image",
  "platform",
  "existing_repository",
  "resource_policy",
  "plan",
  "policy",
] as const;

export function validateResolveDependenciesRequest(
  value: unknown,
  workspaceRoot?: string,
): ResolveDependenciesRequestV2 {
  const raw = object(value, "request");
  exactKeys(raw, RESOLUTION_KEYS, "request");
  if (raw.protocol_version !== WORKER_PROTOCOL_V2) {
    throw new RequestError(
      400,
      "UNSUPPORTED_PROTOCOL",
      `protocol_version must be ${WORKER_PROTOCOL_V2}`,
    );
  }
  safeIdentifier(raw.job_id, "job_id");
  safeIdentifier(raw.run_id, "run_id");
  const irDigest = digest(raw.ir_digest, "ir_digest");
  string(raw.base_commit, "base_commit");
  string(raw.platform, "platform");
  if (typeof raw.existing_repository !== "boolean") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "existing_repository must be a boolean",
    );
  }
  const resolverImage = string(raw.resolver_image, "resolver_image");
  if (!/@sha256:[a-f0-9]{64}$/.test(resolverImage)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "resolver_image must be pinned by sha256 digest",
    );
  }
  const policy = validatePolicy(raw.resource_policy);
  if (policy.network !== "registry-egress") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "dependency resolution requires network=registry-egress",
    );
  }

  const plan = object(raw.plan, "plan");
  exactKeys(
    plan,
    ["resolution_version", "ir_digest", "plan_digest", "roots"],
    "plan",
  );
  if (plan.resolution_version !== 1) {
    throw new RequestError(
      400,
      "UNSUPPORTED_PROTOCOL",
      "plan.resolution_version must be 1",
    );
  }
  if (digest(plan.ir_digest, "plan.ir_digest") !== irDigest) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "plan.ir_digest must match ir_digest",
    );
  }
  digest(plan.plan_digest, "plan.plan_digest");
  const roots = array(plan.roots, "plan.roots", 128);
  const rootIds = new Set<string>();
  const packageIds = new Set<string>();
  for (const [rootIndex, rawRoot] of roots.entries()) {
    const label = `plan.roots[${rootIndex}]`;
    const root = object(rawRoot, label);
    exactKeys(
      root,
      [
        "package_root",
        "ecosystem",
        "language",
        "manifest_path",
        "lockfile_path",
        "resolver",
        "registry_allowlist",
        "packages",
      ],
      label,
    );
    const rootId = safeIdentifier(root.package_root, `${label}.package_root`);
    if (rootIds.has(rootId)) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `duplicate package root ${rootId}`,
      );
    }
    rootIds.add(rootId);
    const ecosystem = string(root.ecosystem, `${label}.ecosystem`);
    const language = string(root.language, `${label}.language`);
    const expected =
      language === "python" ? "pypi" : language === "go" ? "go" : "npm";
    if (
      !["python", "typescript", "go"].includes(language) ||
      ecosystem !== expected
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label} has incompatible language and ecosystem`,
      );
    }
    const manifestPath = string(root.manifest_path, `${label}.manifest_path`);
    const lockfilePath = string(root.lockfile_path, `${label}.lockfile_path`);
    const resolver = object(root.resolver, `${label}.resolver`);
    exactKeys(resolver, ["mode", "allow_prereleases"], `${label}.resolver`);
    if (
      resolver.mode !== "locked" ||
      typeof resolver.allow_prereleases !== "boolean"
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.resolver must use locked mode and an explicit prerelease policy`,
      );
    }
    const registries = array(
      root.registry_allowlist,
      `${label}.registry_allowlist`,
      32,
    );
    for (const [index, registryValue] of registries.entries()) {
      const registry = string(
        registryValue,
        `${label}.registry_allowlist[${index}]`,
      );
      let url: URL;
      try {
        url = new URL(registry);
      } catch {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `invalid registry URL ${registry}`,
        );
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          "registry URLs must use HTTPS and contain no credentials",
        );
      }
    }
    const packages = array(root.packages, `${label}.packages`, 4096);
    for (const [packageIndex, rawPackage] of packages.entries()) {
      const packageLabel = `${label}.packages[${packageIndex}]`;
      const pkg = object(rawPackage, packageLabel);
      exactKeys(
        pkg,
        [
          "id",
          "name",
          "version",
          "integrity",
          "features",
          "scope",
          "owner_node",
          "package_root",
        ],
        packageLabel,
      );
      const packageId = safeIdentifier(pkg.id, `${packageLabel}.id`);
      if (packageIds.has(packageId)) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `duplicate package ${packageId}`,
        );
      }
      packageIds.add(packageId);
      string(pkg.name, `${packageLabel}.name`);
      const version = string(pkg.version, `${packageLabel}.version`);
      if (
        /[*xX><=~^|\s]/.test(version) ||
        ["latest", "next", "stable", "head", "main", "master"].includes(
          version.toLowerCase(),
        )
      ) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `${packageLabel}.version must be exact`,
        );
      }
      const integrity = string(pkg.integrity, `${packageLabel}.integrity`);
      if (!/^(sha256-|sha512-|h1:)/.test(integrity)) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `${packageLabel}.integrity is unsupported`,
        );
      }
      array(pkg.features, `${packageLabel}.features`, 128).forEach(
        (feature, index) =>
          string(feature, `${packageLabel}.features[${index}]`),
      );
      if (!["runtime", "development", "build"].includes(String(pkg.scope))) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `${packageLabel}.scope is invalid`,
        );
      }
      safeIdentifier(pkg.owner_node, `${packageLabel}.owner_node`);
      if (pkg.package_root !== rootId) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `${packageLabel}.package_root is inconsistent`,
        );
      }
    }
    validateWorkspacePath(raw.workspace, manifestPath, workspaceRoot);
    validateWorkspacePath(raw.workspace, lockfilePath, workspaceRoot);
  }

  const supplyChain = object(raw.policy, "policy");
  exactKeys(supplyChain, ["allowed_licenses", "deny_at_or_above"], "policy");
  const licenses = array(
    supplyChain.allowed_licenses,
    "policy.allowed_licenses",
    256,
  );
  if (licenses.length === 0) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "policy.allowed_licenses cannot be empty",
    );
  }
  licenses.forEach((license, index) =>
    string(license, `policy.allowed_licenses[${index}]`),
  );
  if (
    !["unknown", "low", "medium", "high", "critical"].includes(
      String(supplyChain.deny_at_or_above),
    )
  ) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "policy.deny_at_or_above is invalid",
    );
  }
  return raw as unknown as ResolveDependenciesRequestV2;
}

const ENVIRONMENT_START_KEYS = [
  "protocol_version",
  "job_id",
  "run_id",
  "ir_digest",
  "base_commit",
  "plan",
  "resource_images",
  "emulator_image",
  "resource_policy",
] as const;

function pinnedImage(value: unknown, label: string): string {
  const image = string(value, label);
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `${label} must be pinned by sha256 digest`,
    );
  }
  return image;
}

export function validateStartEnvironmentRequest(
  value: unknown,
): StartEnvironmentRequestV2 {
  const raw = object(value, "request");
  exactKeys(raw, ENVIRONMENT_START_KEYS, "request");
  if (raw.protocol_version !== WORKER_PROTOCOL_V2) {
    throw new RequestError(
      400,
      "UNSUPPORTED_PROTOCOL",
      "protocol_version must be 2",
    );
  }
  safeIdentifier(raw.job_id, "job_id");
  safeIdentifier(raw.run_id, "run_id");
  const irDigest = digest(raw.ir_digest, "ir_digest");
  string(raw.base_commit, "base_commit");
  const resourcePolicy = validatePolicy(raw.resource_policy);
  if (resourcePolicy.network !== "private-integration") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "environment jobs require network=private-integration",
    );
  }
  const plan = object(raw.plan, "plan");
  exactKeys(
    plan,
    [
      "environment_plan_version",
      "ir_digest",
      "plan_digest",
      "network_egress",
      "resources",
      "integrations",
      "migrations",
    ],
    "plan",
  );
  if (plan.environment_plan_version !== 1 || plan.network_egress !== "none") {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "environment plan must be version 1 with network_egress=none",
    );
  }
  if (digest(plan.ir_digest, "plan.ir_digest") !== irDigest) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "plan.ir_digest must match ir_digest",
    );
  }
  digest(plan.plan_digest, "plan.plan_digest");
  const declaredResources = new Set<string>();
  const imageKeys = new Set<string>();
  for (const [index, rawService] of array(
    plan.resources,
    "plan.resources",
    64,
  ).entries()) {
    const label = `plan.resources[${index}]`;
    const service = object(rawService, label);
    exactKeys(
      service,
      [
        "resource_id",
        "kind",
        "version",
        "private_alias",
        "image_key",
        "consumers",
      ],
      label,
    );
    const id = safeIdentifier(service.resource_id, `${label}.resource_id`);
    if (declaredResources.has(id)) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `duplicate resource ${id}`,
      );
    }
    declaredResources.add(id);
    if (
      !["postgresql", "redis", "s3", "nats", "smtp", "oidc"].includes(
        String(service.kind),
      )
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.kind is invalid`,
      );
    }
    string(service.version, `${label}.version`);
    if (service.private_alias !== id) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.private_alias must equal resource_id`,
      );
    }
    imageKeys.add(safeIdentifier(service.image_key, `${label}.image_key`));
    const consumers = object(service.consumers, `${label}.consumers`);
    for (const [node, rawPermissions] of Object.entries(consumers)) {
      safeIdentifier(node, `${label}.consumers node`);
      const permissions = array(
        rawPermissions,
        `${label}.consumers.${node}`,
        5,
      );
      if (
        permissions.length === 0 ||
        permissions.some(
          (permission) =>
            !["read", "write", "publish", "consume", "admin"].includes(
              String(permission),
            ),
        )
      ) {
        throw new RequestError(
          400,
          "INVALID_REQUEST",
          `${label}.consumers permissions are invalid`,
        );
      }
    }
  }
  const declaredIntegrations = new Set<string>();
  for (const [index, rawIntegration] of array(
    plan.integrations,
    "plan.integrations",
    64,
  ).entries()) {
    const label = `plan.integrations[${index}]`;
    const integration = object(rawIntegration, label);
    exactKeys(
      integration,
      ["integration_id", "kind", "private_alias", "operations", "consumers"],
      label,
    );
    const id = safeIdentifier(
      integration.integration_id,
      `${label}.integration_id`,
    );
    if (declaredIntegrations.has(id)) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `duplicate integration ${id}`,
      );
    }
    declaredIntegrations.add(id);
    if (
      !["http", "webhook", "stripe", "openai"].includes(
        String(integration.kind),
      )
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.kind is invalid`,
      );
    }
    if (integration.private_alias !== id) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.private_alias must equal integration_id`,
      );
    }
    const operations = array(
      integration.operations,
      `${label}.operations`,
      256,
    );
    if (operations.length === 0) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.operations cannot be empty`,
      );
    }
    operations.forEach((operation, item) =>
      string(operation, `${label}.operations[${item}]`),
    );
    array(integration.consumers, `${label}.consumers`, 256).forEach(
      (consumer, item) =>
        safeIdentifier(consumer, `${label}.consumers[${item}]`),
    );
  }
  for (const [index, rawMigration] of array(
    plan.migrations,
    "plan.migrations",
    64,
  ).entries()) {
    const label = `plan.migrations[${index}]`;
    const migration = object(rawMigration, label);
    exactKeys(
      migration,
      ["resource_id", "owner_node", "migration_path", "require_repeatable"],
      label,
    );
    if (
      !declaredResources.has(
        string(migration.resource_id, `${label}.resource_id`),
      )
    ) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label} targets an undeclared resource`,
      );
    }
    safeIdentifier(migration.owner_node, `${label}.owner_node`);
    const migrationPath = string(
      migration.migration_path,
      `${label}.migration_path`,
    );
    if (
      isAbsolute(migrationPath) ||
      migrationPath.split(/[\\/]/).includes("..")
    ) {
      throw new RequestError(
        400,
        "PATH_ESCAPE",
        `${label}.migration_path is unsafe`,
      );
    }
    if (typeof migration.require_repeatable !== "boolean") {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.require_repeatable must be boolean`,
      );
    }
  }
  const images = object(raw.resource_images, "resource_images");
  if (
    Object.keys(images).length !== imageKeys.size ||
    Object.keys(images).some((key) => !imageKeys.has(key))
  ) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "resource_images must exactly cover the environment plan image keys",
    );
  }
  for (const [key, image] of Object.entries(images))
    pinnedImage(image, `resource_images.${key}`);
  pinnedImage(raw.emulator_image, "emulator_image");
  return raw as unknown as StartEnvironmentRequestV2;
}

export function validateEnvironmentActionRequest(
  value: unknown,
): EnvironmentActionRequestV2 {
  const raw = object(value, "request");
  exactKeys(
    raw,
    ["protocol_version", "job_id", "run_id", "environment_id", "plan_digest"],
    "request",
  );
  if (raw.protocol_version !== WORKER_PROTOCOL_V2) {
    throw new RequestError(
      400,
      "UNSUPPORTED_PROTOCOL",
      "protocol_version must be 2",
    );
  }
  safeIdentifier(raw.job_id, "job_id");
  safeIdentifier(raw.run_id, "run_id");
  safeIdentifier(raw.environment_id, "environment_id");
  digest(raw.plan_digest, "plan_digest");
  return raw as unknown as EnvironmentActionRequestV2;
}

export function validateApplyMigrationsRequest(
  value: unknown,
  workspaceRoot?: string,
): ApplyMigrationsRequestV2 {
  const raw = object(value, "request");
  exactKeys(
    raw,
    [
      "protocol_version",
      "job_id",
      "run_id",
      "environment_id",
      "plan_digest",
      "workspace",
      "migrations",
    ],
    "request",
  );
  validateEnvironmentActionRequest({
    protocol_version: raw.protocol_version,
    job_id: raw.job_id,
    run_id: raw.run_id,
    environment_id: raw.environment_id,
    plan_digest: raw.plan_digest,
  });
  const migrations = array(raw.migrations, "migrations", 64);
  const resources = new Set<string>();
  for (const [index, rawMigration] of migrations.entries()) {
    const label = `migrations[${index}]`;
    const migration = object(rawMigration, label);
    exactKeys(
      migration,
      ["resource_id", "owner_node", "migration_path", "require_repeatable"],
      label,
    );
    const resource = safeIdentifier(
      migration.resource_id,
      `${label}.resource_id`,
    );
    if (resources.has(resource)) {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `duplicate migration resource ${resource}`,
      );
    }
    resources.add(resource);
    safeIdentifier(migration.owner_node, `${label}.owner_node`);
    const path = string(migration.migration_path, `${label}.migration_path`);
    validateWorkspacePath(raw.workspace, path, workspaceRoot);
    if (typeof migration.require_repeatable !== "boolean") {
      throw new RequestError(
        400,
        "INVALID_REQUEST",
        `${label}.require_repeatable must be boolean`,
      );
    }
  }
  return raw as unknown as ApplyMigrationsRequestV2;
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

function validateWorkspacePath(
  workspaceValue: unknown,
  candidate: string,
  workspaceRoot?: string,
): void {
  const requestedWorkspace = string(workspaceValue, "workspace");
  if (!isAbsolute(requestedWorkspace)) {
    throw new RequestError(400, "PATH_ESCAPE", "workspace must be absolute");
  }
  let workspace: string;
  try {
    workspace = realpathSync(requestedWorkspace);
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
  scoped(workspace, candidate);
}

function validateScopedPaths(
  req: BuildRequest | TestRequest,
  workspaceRoot?: string,
): void {
  validateWorkspacePath(req.workspace, req.write_target, workspaceRoot);
  const workspace = realpathSync(req.workspace);
  scoped(workspace, req.write_target);
  const paths =
    "requires" in req
      ? req.requires.map((dep) => dep.read_path)
      : req.deps.map((dep) => dep.read_path);
  for (const path of paths) scoped(workspace, path);
}

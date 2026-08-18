import { createHash } from "node:crypto";
import type {
  ApplyMigrationsRequestV2,
  CollectEnvironmentEvidenceRequestV2,
  EnvironmentActionRequestV2,
  EnvironmentHandleV2,
  EnvironmentHealthV2,
  EnvironmentSnapshotV2,
  EnvironmentTestEvidenceV2,
  EnvironmentTeardownV2,
  MigrationResultV2,
  StartEnvironmentRequestV2,
} from "./contract.ts";
import { RequestError } from "./validation.ts";

type Fetcher = typeof fetch;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const jsonDigest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      `${label} has an invalid shape`,
    );
  }
}

function safeEvidenceText(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      `${label} is not bounded text`,
    );
  }
  if (
    /(?:bearer\s+|authorization|cookie|password|private[_ -]?key|nsec1|ghp_|github_pat_)/i.test(
      value,
    )
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      `${label} contains secret-shaped material`,
    );
  }
  return value;
}

function verifyArtifact(value: unknown, label: string): void {
  exactKeys(value, ["sha256", "size", "media_type"], label);
  if (
    typeof value.sha256 !== "string" ||
    !DIGEST.test(value.sha256) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > 1024 * 1024 * 1024 ||
    typeof value.media_type !== "string" ||
    !value.media_type ||
    value.media_type.length > 200
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      `${label} has invalid artifact metadata`,
    );
  }
}

export interface HttpEnvironmentManagerOptions {
  baseUrl: string;
  token: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

/** Operator-supplied lifecycle boundary for one private build environment. */
export interface EnvironmentManager {
  readiness?(): Promise<{ ready: boolean; reason: string | null }>;
  start(
    request: StartEnvironmentRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentHandleV2>;
  health(
    request: EnvironmentActionRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentHealthV2>;
  migrate(
    request: ApplyMigrationsRequestV2,
    signal: AbortSignal,
  ): Promise<MigrationResultV2>;
  snapshot(
    request: EnvironmentActionRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentSnapshotV2>;
  evidence(
    request: CollectEnvironmentEvidenceRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentTestEvidenceV2>;
  teardown(
    request: EnvironmentActionRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentTeardownV2>;
}

function managerUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    url.hostname,
  );
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "environment manager URL must be HTTPS or loopback HTTP and contain no credentials, query, or fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

/** Authenticated adapter for an operator-owned Docker environment controller. */
export class HttpEnvironmentManager implements EnvironmentManager {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: HttpEnvironmentManagerOptions) {
    this.baseUrl = managerUrl(options.baseUrl);
    if (options.token.length < 32 || /[\r\n]/.test(options.token)) {
      throw new Error(
        "environment manager token must contain at least 32 safe characters",
      );
    }
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async readiness(): Promise<{ ready: boolean; reason: string | null }> {
    try {
      const response = await this.request("GET", "/ready");
      return response && (response as { ready?: unknown }).ready === true
        ? { ready: true, reason: null }
        : { ready: false, reason: "environment controller is not ready" };
    } catch {
      return { ready: false, reason: "environment controller is unavailable" };
    }
  }

  async start(
    request: StartEnvironmentRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentHandleV2> {
    return (await this.request(
      "POST",
      "/v1/environments/start",
      request,
      signal,
    )) as EnvironmentHandleV2;
  }

  async health(
    request: EnvironmentActionRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentHealthV2> {
    return (await this.request(
      "POST",
      "/v1/environments/health",
      request,
      signal,
    )) as EnvironmentHealthV2;
  }

  async migrate(
    request: ApplyMigrationsRequestV2,
    signal: AbortSignal,
  ): Promise<MigrationResultV2> {
    return (await this.request(
      "POST",
      "/v1/environments/migrations",
      request,
      signal,
    )) as MigrationResultV2;
  }

  async snapshot(
    request: EnvironmentActionRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentSnapshotV2> {
    return (await this.request(
      "POST",
      "/v1/environments/snapshot",
      request,
      signal,
    )) as EnvironmentSnapshotV2;
  }

  async evidence(
    request: CollectEnvironmentEvidenceRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentTestEvidenceV2> {
    return (await this.request(
      "POST",
      "/v1/environments/evidence",
      request,
      signal,
    )) as EnvironmentTestEvidenceV2;
  }

  async teardown(
    request: EnvironmentActionRequestV2,
    signal: AbortSignal,
  ): Promise<EnvironmentTeardownV2> {
    return (await this.request(
      "POST",
      "/v1/environments/teardown",
      request,
      signal,
    )) as EnvironmentTeardownV2;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const declaredLength = Number(
        response.headers.get("content-length") ?? 0,
      );
      if (declaredLength > 1024 * 1024) {
        throw new RequestError(
          502,
          "ENVIRONMENT_RESPONSE_TOO_LARGE",
          "environment controller response exceeded its bound",
        );
      }
      const text = await response.text();
      if (text.length > 1024 * 1024) {
        throw new RequestError(
          502,
          "ENVIRONMENT_RESPONSE_TOO_LARGE",
          "environment controller response exceeded its bound",
        );
      }
      if (!response.ok) {
        throw new RequestError(
          response.status >= 500 ? 503 : 422,
          "ENVIRONMENT_CONTROLLER_FAILED",
          "environment controller rejected the lifecycle operation",
          response.status >= 500,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new RequestError(
          502,
          "ENVIRONMENT_RESPONSE_INVALID",
          "environment controller returned invalid JSON",
        );
      }
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}

function assertBound(
  request: EnvironmentActionRequestV2,
  response: { environment_id: string; plan_digest: string },
): void {
  if (
    response.environment_id !== request.environment_id ||
    response.plan_digest !== request.plan_digest
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_IDENTITY_MISMATCH",
      "environment manager response is not bound to the requested environment and plan",
    );
  }
}

export function verifyEnvironmentHandle(
  request: StartEnvironmentRequestV2,
  handle: EnvironmentHandleV2,
): EnvironmentHandleV2 {
  if (
    handle.run_id !== request.run_id ||
    handle.plan_digest !== request.plan.plan_digest ||
    !handle.environment_id ||
    !handle.network_id
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_IDENTITY_MISMATCH",
      "environment manager returned an unbound handle",
    );
  }
  const expectedAliases = new Set([
    ...request.plan.resources.map((resource) => resource.private_alias),
    ...request.plan.integrations.map(
      (integration) => integration.private_alias,
    ),
  ]);
  if (
    Object.keys(handle.aliases).some(
      (alias) => !expectedAliases.has(alias) || handle.aliases[alias] !== alias,
    )
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_SCOPE_VIOLATION",
      "environment manager exposed an undeclared or externally routed alias",
    );
  }
  return handle;
}

export function verifyEnvironmentHealth(
  request: EnvironmentActionRequestV2,
  health: EnvironmentHealthV2,
): EnvironmentHealthV2 {
  exactKeys(
    health,
    ["environment_id", "plan_digest", "healthy", "services"],
    "environment health",
  );
  assertBound(request, health);
  if (
    typeof health.healthy !== "boolean" ||
    !Array.isArray(health.services) ||
    health.services.length > 256
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      "environment health is malformed or oversized",
    );
  }
  const seen = new Set<string>();
  for (const service of health.services) {
    exactKeys(service, ["id", "healthy", "detail"], "service health");
    if (
      typeof service.id !== "string" ||
      !SAFE_ID.test(service.id) ||
      seen.has(service.id) ||
      typeof service.healthy !== "boolean"
    ) {
      throw new RequestError(
        502,
        "ENVIRONMENT_EVIDENCE_INVALID",
        "service health identity or state is invalid",
      );
    }
    seen.add(service.id);
    safeEvidenceText(service.detail, "service health detail", 512);
  }
  if (health.healthy && health.services.some((service) => !service.healthy)) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      "green environment health contains an unhealthy service",
    );
  }
  return health;
}

export function verifyMigrationResult(
  request: ApplyMigrationsRequestV2,
  result: MigrationResultV2,
): MigrationResultV2 {
  exactKeys(
    result,
    ["environment_id", "plan_digest", "green", "outcomes", "artifact"],
    "migration result",
  );
  assertBound(request, result);
  if (typeof result.green !== "boolean" || !Array.isArray(result.outcomes)) {
    throw new RequestError(
      502,
      "MIGRATION_EVIDENCE_INVALID",
      "migration result is malformed",
    );
  }
  const expected = new Map(
    request.migrations.map((migration) => [migration.resource_id, migration]),
  );
  const seen = new Set<string>();
  if (
    result.outcomes.length !== expected.size ||
    result.outcomes.some((outcome) => {
      exactKeys(
        outcome,
        [
          "resource_id",
          "owner_node",
          "migration_digest",
          "applied",
          "repeatable_verified",
          "duration_ms",
          "diagnostic",
        ],
        "migration outcome",
      );
      const migration = expected.get(outcome.resource_id);
      return (
        !migration ||
        seen.has(outcome.resource_id) ||
        !seen.add(outcome.resource_id) ||
        outcome.owner_node !== migration.owner_node ||
        !/^[a-f0-9]{64}$/.test(outcome.migration_digest) ||
        typeof outcome.applied !== "boolean" ||
        typeof outcome.repeatable_verified !== "boolean" ||
        !Number.isSafeInteger(outcome.duration_ms) ||
        outcome.duration_ms < 0 ||
        outcome.duration_ms > 86_400_000 ||
        (migration.require_repeatable && !outcome.repeatable_verified)
      );
    })
  ) {
    throw new RequestError(
      502,
      "MIGRATION_EVIDENCE_INVALID",
      "migration evidence does not exactly cover the accepted migration plan",
    );
  }
  if (!result.green || result.outcomes.some((outcome) => !outcome.applied)) {
    throw new RequestError(
      422,
      "MIGRATION_FAILED",
      "one or more declared migrations did not reach green",
    );
  }
  for (const outcome of result.outcomes) {
    safeEvidenceText(outcome.diagnostic, "migration diagnostic", 1024);
  }
  verifyArtifact(result.artifact, "migration artifact");
  return result;
}

export function verifyEnvironmentSnapshot(
  request: EnvironmentActionRequestV2,
  snapshot: EnvironmentSnapshotV2,
): EnvironmentSnapshotV2 {
  exactKeys(
    snapshot,
    ["environment_id", "plan_digest", "snapshot_digest", "artifact"],
    "environment snapshot",
  );
  assertBound(request, snapshot);
  if (!DIGEST.test(snapshot.snapshot_digest)) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      "environment snapshot digest is invalid",
    );
  }
  verifyArtifact(snapshot.artifact, "environment snapshot artifact");
  return snapshot;
}

export function verifyEnvironmentTestEvidence(
  request: CollectEnvironmentEvidenceRequestV2,
  result: EnvironmentTestEvidenceV2,
): EnvironmentTestEvidenceV2 {
  exactKeys(
    result,
    [
      "environment_id",
      "run_id",
      "plan_digest",
      "green",
      "contracts",
      "unexpected_requests",
      "resource_usage",
      "artifact",
    ],
    "environment test evidence",
  );
  assertBound(request, result);
  if (
    result.run_id !== request.run_id ||
    !Number.isSafeInteger(result.unexpected_requests) ||
    result.unexpected_requests < 0
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      "environment test evidence identity or counters are invalid",
    );
  }
  const expected = new Map(
    request.expectations.map((item) => [
      `${item.node}\0${item.integration_id}\0${item.operation}`,
      item,
    ]),
  );
  const seen = new Set<string>();
  if (
    !Array.isArray(result.contracts) ||
    result.contracts.length !== expected.size ||
    result.contracts.some((contract) => {
      exactKeys(
        contract,
        [
          "node",
          "integration_id",
          "operation",
          "request_sha256",
          "response_sha256",
          "observed_count",
          "matched",
          "diagnostic",
        ],
        "contract evidence",
      );
      const key = `${contract.node}\0${contract.integration_id}\0${contract.operation}`;
      const declared = expected.get(key);
      safeEvidenceText(contract.diagnostic, "contract diagnostic", 512);
      return (
        !declared ||
        seen.has(key) ||
        !seen.add(key) ||
        contract.request_sha256 !== jsonDigest(declared.request) ||
        contract.response_sha256 !== jsonDigest(declared.response) ||
        !Number.isSafeInteger(contract.observed_count) ||
        contract.observed_count < 0 ||
        typeof contract.matched !== "boolean"
      );
    })
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      "contract evidence does not exactly cover the accepted plan",
    );
  }
  const resources = new Set(request.resources);
  const measured = new Set<string>();
  if (
    !Array.isArray(result.resource_usage) ||
    result.resource_usage.length !== resources.size ||
    result.resource_usage.some((usage) => {
      exactKeys(
        usage,
        ["resource_id", "cpu_percent", "memory_bytes", "pids"],
        "resource usage",
      );
      return (
        !resources.has(usage.resource_id) ||
        measured.has(usage.resource_id) ||
        !measured.add(usage.resource_id) ||
        !Number.isFinite(usage.cpu_percent) ||
        usage.cpu_percent < 0 ||
        usage.cpu_percent > 100_000 ||
        !Number.isSafeInteger(usage.memory_bytes) ||
        usage.memory_bytes < 0 ||
        !Number.isSafeInteger(usage.pids) ||
        usage.pids < 0
      );
    })
  ) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      "resource usage does not exactly cover the accepted plan",
    );
  }
  if (
    !result.green ||
    result.unexpected_requests !== 0 ||
    result.contracts.some((contract) => !contract.matched)
  ) {
    throw new RequestError(
      422,
      "CONTRACT_TEST_FAILED",
      "declared integration contracts did not reach green",
    );
  }
  verifyArtifact(result.artifact, "environment test artifact");
  return result;
}

export function verifyEnvironmentTeardown(
  request: EnvironmentActionRequestV2,
  teardown: EnvironmentTeardownV2,
): EnvironmentTeardownV2 {
  exactKeys(
    teardown,
    [
      "environment_id",
      "plan_digest",
      "stopped",
      "cleanup_complete",
      "diagnostic_artifact",
    ],
    "environment teardown",
  );
  assertBound(request, teardown);
  if (!teardown.stopped || !teardown.cleanup_complete) {
    throw new RequestError(
      422,
      "ENVIRONMENT_CLEANUP_INCOMPLETE",
      "environment cleanup did not complete",
    );
  }
  if (teardown.diagnostic_artifact !== null) {
    verifyArtifact(
      teardown.diagnostic_artifact,
      "teardown diagnostic artifact",
    );
  }
  return teardown;
}

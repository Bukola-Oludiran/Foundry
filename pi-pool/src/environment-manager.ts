import type {
  ApplyMigrationsRequestV2,
  EnvironmentActionRequestV2,
  EnvironmentHandleV2,
  EnvironmentHealthV2,
  EnvironmentSnapshotV2,
  EnvironmentTeardownV2,
  MigrationResultV2,
  StartEnvironmentRequestV2,
} from "./contract.ts";
import { RequestError } from "./validation.ts";

type Fetcher = typeof fetch;

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
  assertBound(request, health);
  return health;
}

export function verifyMigrationResult(
  request: ApplyMigrationsRequestV2,
  result: MigrationResultV2,
): MigrationResultV2 {
  assertBound(request, result);
  const expected = new Map(
    request.migrations.map((migration) => [migration.resource_id, migration]),
  );
  if (
    result.outcomes.length !== expected.size ||
    result.outcomes.some((outcome) => {
      const migration = expected.get(outcome.resource_id);
      return (
        !migration ||
        outcome.owner_node !== migration.owner_node ||
        !/^[a-f0-9]{64}$/.test(outcome.migration_digest) ||
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
  return result;
}

export function verifyEnvironmentSnapshot(
  request: EnvironmentActionRequestV2,
  snapshot: EnvironmentSnapshotV2,
): EnvironmentSnapshotV2 {
  assertBound(request, snapshot);
  if (!/^[a-f0-9]{64}$/.test(snapshot.snapshot_digest)) {
    throw new RequestError(
      502,
      "ENVIRONMENT_EVIDENCE_INVALID",
      "environment snapshot digest is invalid",
    );
  }
  return snapshot;
}

export function verifyEnvironmentTeardown(
  request: EnvironmentActionRequestV2,
  teardown: EnvironmentTeardownV2,
): EnvironmentTeardownV2 {
  assertBound(request, teardown);
  if (!teardown.stopped || !teardown.cleanup_complete) {
    throw new RequestError(
      422,
      "ENVIRONMENT_CLEANUP_INCOMPLETE",
      "environment cleanup did not complete",
    );
  }
  return teardown;
}

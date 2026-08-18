import type {
  ApplyMigrationsRequestV2,
  CollectEnvironmentEvidenceRequestV2,
  EnvironmentActionRequestV2,
  EnvironmentHandleV2,
  StartEnvironmentRequestV2,
} from "../src/contract.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpEnvironmentManager,
  verifyEnvironmentHandle,
  verifyEnvironmentHealth,
  verifyEnvironmentSnapshot,
  verifyEnvironmentTestEvidence,
  verifyEnvironmentTeardown,
  verifyMigrationResult,
} from "../src/environment-manager.ts";
import {
  RequestError,
  validateApplyMigrationsRequest,
  validateCollectEnvironmentEvidenceRequest,
  validateEnvironmentActionRequest,
  validateStartEnvironmentRequest,
} from "../src/validation.ts";

const digest = (character: string): string => character.repeat(64);
const workspace = mkdtempSync(join(tmpdir(), "foundry-migrations-"));
mkdirSync(join(workspace, "migrations"));
const start: StartEnvironmentRequestV2 = {
  protocol_version: 2,
  job_id: "run-1:environment:start",
  run_id: "run-1",
  ir_digest: digest("a"),
  base_commit: digest("b"),
  resource_policy: {
    timeout_ms: 120_000,
    memory_mb: 2048,
    cpu_count: 2,
    pids: 256,
    network: "private-integration",
  },
  plan: {
    environment_plan_version: 1,
    ir_digest: digest("a"),
    plan_digest: digest("c"),
    network_egress: "none",
    resources: [
      {
        resource_id: "primary-db",
        kind: "postgresql",
        version: "17.2",
        private_alias: "primary-db",
        image_key: "postgresql",
        consumers: { api: ["read", "write", "admin"] },
      },
    ],
    integrations: [
      {
        integration_id: "payments",
        kind: "stripe",
        private_alias: "payments",
        operations: ["create-payment"],
        consumers: ["api"],
      },
    ],
    migrations: [
      {
        resource_id: "primary-db",
        owner_node: "api",
        migration_path: "migrations",
        require_repeatable: true,
      },
    ],
    integration_expectations: [
      {
        node: "api",
        integration_id: "payments",
        operation: "create-payment",
        request: { amount: 1000 },
        response: { status: "accepted" },
      },
    ],
  },
  resource_images: {
    postgresql: `docker.io/library/postgres@sha256:${digest("d")}`,
  },
  emulator_image: `registry.example/foundry-emulator@sha256:${digest("e")}`,
};
const action: EnvironmentActionRequestV2 = {
  protocol_version: 2,
  job_id: "run-1:environment:health",
  run_id: "run-1",
  environment_id: "environment-run-1",
  plan_digest: digest("c"),
};
const handle: EnvironmentHandleV2 = {
  environment_id: "environment-run-1",
  run_id: "run-1",
  plan_digest: digest("c"),
  network_id: "network-run-1",
  state: "ready",
  aliases: { "primary-db": "primary-db", payments: "payments" },
  secret_handles: ["secret-handle-db"],
};
const migrationRequest: ApplyMigrationsRequestV2 = {
  ...action,
  job_id: "run-1:environment:migrations",
  workspace,
  migrations: start.plan.migrations,
};
const evidenceRequest: CollectEnvironmentEvidenceRequestV2 = {
  ...action,
  job_id: "run-1:environment:evidence",
  expectations: start.plan.integration_expectations,
  resources: ["primary-db"],
};
const jsonDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

let failures = 0;
function accept(label: string, operation: () => unknown): void {
  try {
    operation();
    console.log(`OK  ${label}`);
  } catch (error) {
    failures++;
    console.error(`BAD ${label}: ${String(error)}`);
  }
}
function reject(label: string, code: string, operation: () => unknown): void {
  try {
    operation();
    failures++;
    console.error(`BAD ${label}: accepted`);
  } catch (error) {
    const passed = error instanceof RequestError && error.code === code;
    if (!passed) failures++;
    console.log(`${passed ? "OK " : "BAD"} ${label}`);
  }
}

function rejectError(label: string, operation: () => unknown): void {
  try {
    operation();
    failures++;
    console.error(`BAD ${label}: accepted`);
  } catch {
    console.log(`OK  ${label}`);
  }
}

async function acceptAsync(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
    console.log(`OK  ${label}`);
  } catch (error) {
    failures++;
    console.error(`BAD ${label}: ${String(error)}`);
  }
}

accept("validates a private environment plan", () =>
  validateStartEnvironmentRequest(start),
);
accept("accepts a plan-bound handle", () =>
  verifyEnvironmentHandle(start, handle),
);
accept("validates a lifecycle action", () =>
  validateEnvironmentActionRequest(action),
);
accept("accepts plan-bound health", () =>
  verifyEnvironmentHealth(action, {
    environment_id: action.environment_id,
    plan_digest: action.plan_digest,
    healthy: true,
    services: [{ id: "primary-db", healthy: true, detail: null }],
  }),
);
accept("validates scoped migration ownership", () =>
  validateApplyMigrationsRequest(migrationRequest, workspace),
);
accept("accepts complete repeatability evidence", () =>
  verifyMigrationResult(migrationRequest, {
    environment_id: action.environment_id,
    plan_digest: action.plan_digest,
    green: true,
    outcomes: [
      {
        resource_id: "primary-db",
        owner_node: "api",
        migration_digest: digest("f"),
        applied: true,
        repeatable_verified: true,
        duration_ms: 12,
        diagnostic: null,
      },
    ],
    artifact: {
      sha256: digest("1"),
      size: 1,
      media_type: "application/json",
    },
  }),
);
accept("accepts exact contract and resource-usage evidence", () => {
  validateCollectEnvironmentEvidenceRequest(evidenceRequest);
  verifyEnvironmentTestEvidence(evidenceRequest, {
    environment_id: action.environment_id,
    run_id: action.run_id,
    plan_digest: action.plan_digest,
    green: true,
    contracts: [
      {
        node: "api",
        integration_id: "payments",
        operation: "create-payment",
        request_sha256: jsonDigest({ amount: 1000 }),
        response_sha256: jsonDigest({ status: "accepted" }),
        observed_count: 1,
        matched: true,
        diagnostic: null,
      },
    ],
    unexpected_requests: 0,
    resource_usage: [
      {
        resource_id: "primary-db",
        cpu_percent: 0.2,
        memory_bytes: 1024,
        pids: 2,
      },
    ],
    artifact: { sha256: digest("9"), size: 12, media_type: "application/json" },
  });
});
reject(
  "rejects mismatched contract response evidence",
  "ENVIRONMENT_EVIDENCE_INVALID",
  () =>
    verifyEnvironmentTestEvidence(evidenceRequest, {
      environment_id: action.environment_id,
      run_id: action.run_id,
      plan_digest: action.plan_digest,
      green: true,
      contracts: [
        {
          node: "api",
          integration_id: "payments",
          operation: "create-payment",
          request_sha256: jsonDigest({ amount: 1000 }),
          response_sha256: digest("8"),
          observed_count: 1,
          matched: true,
          diagnostic: null,
        },
      ],
      unexpected_requests: 0,
      resource_usage: [
        {
          resource_id: "primary-db",
          cpu_percent: 0.2,
          memory_bytes: 1024,
          pids: 2,
        },
      ],
      artifact: {
        sha256: digest("9"),
        size: 12,
        media_type: "application/json",
      },
    }),
);
reject(
  "rejects secret-shaped health details",
  "ENVIRONMENT_EVIDENCE_INVALID",
  () =>
    verifyEnvironmentHealth(action, {
      environment_id: action.environment_id,
      plan_digest: action.plan_digest,
      healthy: true,
      services: [
        {
          id: "primary-db",
          healthy: true,
          detail: "Authorization: Bearer hidden",
        },
      ],
    }),
);
reject(
  "rejects malformed migration artifacts",
  "ENVIRONMENT_EVIDENCE_INVALID",
  () =>
    verifyMigrationResult(migrationRequest, {
      environment_id: action.environment_id,
      plan_digest: action.plan_digest,
      green: true,
      outcomes: [
        {
          resource_id: "primary-db",
          owner_node: "api",
          migration_digest: digest("f"),
          applied: true,
          repeatable_verified: true,
          duration_ms: 12,
          diagnostic: null,
        },
      ],
      artifact: {
        sha256: "not-a-digest",
        size: 1,
        media_type: "application/json",
      },
    }),
);
reject(
  "rejects malformed snapshot artifacts",
  "ENVIRONMENT_EVIDENCE_INVALID",
  () =>
    verifyEnvironmentSnapshot(action, {
      environment_id: action.environment_id,
      plan_digest: action.plan_digest,
      snapshot_digest: digest("2"),
      artifact: {
        sha256: digest("3"),
        size: -1,
        media_type: "application/json",
      },
    }),
);
reject("rejects unpinned service images", "INVALID_REQUEST", () =>
  validateStartEnvironmentRequest({
    ...start,
    resource_images: { postgresql: "postgres:latest" },
  }),
);
reject(
  "rejects undeclared external aliases",
  "ENVIRONMENT_SCOPE_VIOLATION",
  () =>
    verifyEnvironmentHandle(start, {
      ...handle,
      aliases: { ...handle.aliases, internet: "gateway.example" },
    }),
);

rejectError("rejects a non-loopback plaintext controller", () => {
  new HttpEnvironmentManager({
    baseUrl: "http://environment.example",
    token: "x".repeat(32),
  });
});
rejectError("rejects credentials embedded in the controller URL", () => {
  new HttpEnvironmentManager({
    baseUrl: "https://operator:secret@environment.example",
    token: "x".repeat(32),
  });
});
reject(
  "fails closed on incomplete cleanup",
  "ENVIRONMENT_CLEANUP_INCOMPLETE",
  () =>
    verifyEnvironmentTeardown(action, {
      environment_id: action.environment_id,
      plan_digest: action.plan_digest,
      stopped: true,
      cleanup_complete: false,
      diagnostic_artifact: null,
    }),
);

const controllerCalls: Array<{
  url: string;
  authorization: string | null;
  method: string;
}> = [];
const controllerFetcher = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  controllerCalls.push({
    url,
    authorization: headers.get("authorization"),
    method: init?.method ?? "GET",
  });
  const payload = url.endsWith("/ready") ? { ready: true } : handle;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;
const httpManager = new HttpEnvironmentManager({
  baseUrl: "http://127.0.0.1:9090/",
  token: "controller-token-that-is-at-least-32-characters",
  fetcher: controllerFetcher,
});
await acceptAsync("checks authenticated controller readiness", async () => {
  const readiness = await httpManager.readiness();
  if (!readiness.ready) throw new Error("controller was reported unavailable");
});
await acceptAsync(
  "dispatches lifecycle calls through the controller",
  async () => {
    const returned = await httpManager.start(
      start,
      new AbortController().signal,
    );
    verifyEnvironmentHandle(start, returned);
    if (
      controllerCalls.length !== 2 ||
      controllerCalls.some(
        (call) =>
          call.authorization !==
          "Bearer controller-token-that-is-at-least-32-characters",
      ) ||
      controllerCalls[1]?.method !== "POST"
    ) {
      throw new Error("controller authentication or method was not preserved");
    }
  },
);

rmSync(workspace, { recursive: true, force: true });

process.exitCode = failures === 0 ? 0 : 1;

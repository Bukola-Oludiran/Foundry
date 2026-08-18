import type { TestRequestV2, TestResultV2 } from "./contract.ts";
import { RequestError } from "./validation.ts";

type Fetcher = typeof fetch;

export interface ProjectRunner {
  readiness?(): Promise<{ ready: boolean; reason: string | null }>;
  test(request: TestRequestV2, signal: AbortSignal): Promise<TestResultV2>;
}

export interface HttpProjectRunnerOptions {
  baseUrl: string;
  token: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

function runnerUrl(value: string): string {
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
      "project runner URL must be HTTPS or loopback HTTP and contain no credentials, query, or fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

/** Authenticated boundary for the operator's rootless OCI project-test service. */
export class HttpProjectRunner implements ProjectRunner {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: HttpProjectRunnerOptions) {
    this.baseUrl = runnerUrl(options.baseUrl);
    if (options.token.length < 32 || /[\r\n]/.test(options.token)) {
      throw new Error(
        "project runner token must contain at least 32 safe characters",
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
        : { ready: false, reason: "OCI project runner is not ready" };
    } catch {
      return { ready: false, reason: "OCI project runner is unavailable" };
    }
  }

  async test(
    request: TestRequestV2,
    signal: AbortSignal,
  ): Promise<TestResultV2> {
    return (await this.request(
      "POST",
      "/v2/tests/run",
      request,
      signal,
    )) as TestResultV2;
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
          "PROJECT_RESULT_TOO_LARGE",
          "project runner response exceeded its bound",
        );
      }
      const text = await response.text();
      if (text.length > 1024 * 1024) {
        throw new RequestError(
          502,
          "PROJECT_RESULT_TOO_LARGE",
          "project runner response exceeded its bound",
        );
      }
      if (!response.ok) {
        throw new RequestError(
          response.status >= 500 ? 503 : 422,
          "PROJECT_RUNNER_FAILED",
          "OCI project runner rejected the test operation",
          response.status >= 500,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new RequestError(
          502,
          "PROJECT_RESULT_INVALID",
          "project runner returned invalid JSON",
        );
      }
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}

const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const safeRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes(":") &&
  value
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(
      502,
      "PROJECT_RESULT_INVALID",
      `${label} must be an object`,
    );
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) {
    throw new RequestError(
      502,
      "PROJECT_RESULT_INVALID",
      `${label} contains unknown fields`,
    );
  }
  return object;
}

function containsSensitiveText(value: unknown): boolean {
  if (typeof value === "string") {
    return /bearer\s+\S+|begin (?:rsa |ec |openssh )?private key|nsec1[a-z0-9]+|(?:postgres|redis|nats|https?):\/\/[^\s/:]+:[^\s/@]+@/i.test(
      value,
    );
  }
  if (Array.isArray(value)) return value.some(containsSensitiveText);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        /password|passwd|credential|authorization|cookie|private_key/i.test(
          key,
        ) || containsSensitiveText(child),
    );
  }
  return false;
}

export function verifyProjectTestResult(
  request: TestRequestV2,
  candidate: TestResultV2,
): TestResultV2 {
  const result = exactObject(
    candidate,
    [
      "protocol_version",
      "job_id",
      "run_id",
      "dependency_layer_sha256",
      "environment_snapshot_digest",
      "node_id",
      "verdict",
      "passed",
      "failed",
      "failures",
      "case_results",
      "failure_code",
      "implementation_evidence",
      "measurements",
      "artifact",
      "piston",
    ],
    "project result",
  ) as unknown as TestResultV2;
  const expectedLayer = request.dependency_layer?.sha256 ?? null;
  const expectedSnapshot = request.test_environment?.snapshot_digest ?? null;
  if (
    result.protocol_version !== 2 ||
    result.job_id !== request.job_id ||
    result.run_id !== request.run_id ||
    result.node_id !== request.node_id ||
    result.dependency_layer_sha256 !== expectedLayer ||
    result.environment_snapshot_digest !== expectedSnapshot
  ) {
    throw new RequestError(
      502,
      "PROJECT_IDENTITY_MISMATCH",
      "project result is not bound to the requested run, node, dependencies, and environment",
    );
  }
  if (
    !Number.isSafeInteger(result.passed) ||
    !Number.isSafeInteger(result.failed) ||
    result.passed < 0 ||
    result.failed < 0 ||
    !["green", "red"].includes(result.verdict) ||
    !Array.isArray(result.failures) ||
    result.failures.length > 256
  ) {
    throw new RequestError(
      502,
      "PROJECT_EVIDENCE_INVALID",
      "project verdict counters or failures are invalid",
    );
  }
  if (
    !digest(result.artifact?.sha256) ||
    !Number.isSafeInteger(result.artifact?.size) ||
    result.artifact.size < 0 ||
    result.artifact.size > 16 * 1024 * 1024
  ) {
    throw new RequestError(
      502,
      "PROJECT_EVIDENCE_INVALID",
      "project result artifact metadata is invalid",
    );
  }
  const evidence = exactObject(
    result.implementation_evidence,
    [
      "evidence_version",
      "node_id",
      "build_run_id",
      "proposal_id",
      "revision_id",
      "semantic_digest",
      "base_commit",
      "attempt",
      "language",
      "source_snapshot_digest",
      "source_files",
      "symbols",
      "contract_mappings",
      "case_results",
      "measurements",
      "completeness",
      "diagnostics",
      "created_at_ms",
    ],
    "implementation evidence",
  );
  if (
    evidence.evidence_version !== 1 ||
    evidence.node_id !== request.node_id ||
    evidence.build_run_id !== request.run_id ||
    evidence.base_commit !== request.base_commit ||
    evidence.semantic_digest !==
      (request.semantic_digest ?? request.ir_digest) ||
    evidence.language !== request.language ||
    !digest(evidence.source_snapshot_digest)
  ) {
    throw new RequestError(
      502,
      "PROJECT_EVIDENCE_INVALID",
      "implementation evidence is not bound to the accepted request",
    );
  }
  if (
    !Array.isArray(evidence.source_files) ||
    evidence.source_files.length === 0 ||
    evidence.source_files.length > 256 ||
    evidence.source_files.some((candidate) => {
      const file = exactObject(candidate, ["path", "sha256"], "source file");
      return !safeRelativePath(file.path) || !digest(file.sha256);
    }) ||
    !Array.isArray(evidence.symbols) ||
    evidence.symbols.length > 500 ||
    !Array.isArray(evidence.contract_mappings) ||
    evidence.contract_mappings.length > 500 ||
    !Array.isArray(evidence.diagnostics) ||
    evidence.diagnostics.length > 50 ||
    evidence.diagnostics.some(
      (diagnostic) => typeof diagnostic !== "string" || diagnostic.length > 512,
    )
  ) {
    throw new RequestError(
      502,
      "PROJECT_EVIDENCE_INVALID",
      "source evidence is unsafe or exceeds its bounds",
    );
  }
  const piston = exactObject(
    result.piston,
    ["code", "signal", "stdout", "stderr"],
    "legacy runner summary",
  );
  if (piston.stdout !== "" || piston.stderr !== "") {
    throw new RequestError(
      502,
      "PROJECT_EVIDENCE_UNSAFE",
      "protocol v2 project results must not contain raw process output",
    );
  }
  const expectedCases = new Set(
    request.acceptance.cases.map((item) => item.name),
  );
  if (
    !Array.isArray(result.case_results) ||
    result.case_results.length !== expectedCases.size ||
    result.case_results.some((item) => !expectedCases.delete(item.name))
  ) {
    throw new RequestError(
      502,
      "PROJECT_EVIDENCE_INVALID",
      "named case evidence does not exactly cover the acceptance mandate",
    );
  }
  if (
    JSON.stringify(result).length > 1024 * 1024 ||
    containsSensitiveText(result)
  ) {
    throw new RequestError(
      502,
      "PROJECT_EVIDENCE_UNSAFE",
      "project result contains oversized or sensitive evidence",
    );
  }
  return result;
}

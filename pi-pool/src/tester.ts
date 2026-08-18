// The tester (`POST /test`): run a node's parent-owned acceptance suite against the
// built code and return a deterministic verdict. The SAME generated runner runs either
// locally (python3, dev while Piston is down) or inside Piston's isolated container
// (prod) — Piston lays all files flat in one dir, matching the local temp-dir layout, so
// the verdict is identical. Black-box: reads only the built module + its declared deps.

import type {
  AcceptanceCaseResultV1,
  TestRequest,
  TestRequestV2,
  TestResult,
  Failure,
} from "./contract.ts";
import { parseVerdict } from "./runner-gen.ts";
import { languageBackend, type LanguageBackend } from "./language-backend.ts";
import { extractImplementationEvidence } from "./evidence.ts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const abs = (ws: string, p: string): string =>
  isAbsolute(p) ? p : join(ws, p);
const sanitize = (id: string): string => id.replace(/-/g, "_");

export interface TesterConfig {
  mode: "local" | "piston";
  pistonUrl?: string;
}

export interface PFile {
  name: string;
  content: string;
}

type TestResultCore = Omit<
  TestResult,
  "artifact" | "implementation_evidence" | "case_results"
>;

function withArtifact(
  req: TestRequest | TestRequestV2,
  result: TestResultCore,
): TestResult {
  const failures = new Map(
    result.failures.map((failure) => [failure.case, failure]),
  );
  const caseResults: AcceptanceCaseResultV1[] = req.acceptance.cases.map(
    (testCase) => ({
      name: testCase.name,
      status:
        result.failure_code === "EXECUTION_FAILED" ||
        result.failure_code === "PISTON_FAILED"
          ? "not_run"
          : failures.has(testCase.name)
            ? "failed"
            : "passed",
      failure: failures.get(testCase.name) ?? null,
    }),
  );
  const complete = {
    ...result,
    case_results: caseResults,
    implementation_evidence: extractImplementationEvidence(
      req,
      caseResults,
      languageBackend(req.language),
      result.measurements,
    ),
  };
  const encoded = Buffer.from(JSON.stringify(complete));
  return {
    ...complete,
    artifact: {
      sha256: createHash("sha256").update(encoded).digest("hex"),
      size: encoded.byteLength,
      media_type: "application/vnd.foundry.test-result+json",
    },
  };
}

/** Flatten module-under-test + deps + generated runner (runner is files[0] = the main file). */
export function assembleTestFiles(
  req: TestRequest | TestRequestV2,
  backend: LanguageBackend,
): PFile[] {
  const moduleName = sanitize(req.node_id);
  backend.validateCases(req.acceptance.cases);
  const runner = backend.generateRunner({
    moduleImportName: moduleName,
    opNames: req.provides.operations.map((o) => o.name),
    cases: req.acceptance.cases,
  });
  const files: PFile[] = [{ name: backend.runnerFile, content: runner }];
  files.push({
    name: backend.moduleFile(moduleName),
    content: readFileSync(abs(req.workspace, req.write_target), "utf-8"),
  });
  for (const d of req.deps) {
    files.push({
      name: backend.moduleFile(d.import_name),
      content: readFileSync(abs(req.workspace, d.read_path), "utf-8"),
    });
  }
  return files;
}

/** Map a run's stdout (+ raw stage) to a verdict — shared by both executors. */
export function testResultFromExecution(
  req: TestRequest | TestRequestV2,
  stdout: string,
  piston: TestResult["piston"],
  durationMs: number,
): TestResult {
  const v = parseVerdict(stdout);
  if (!v) {
    const err: Failure = {
      case: "<execution>",
      expected: null,
      actual: null,
      error:
        (piston.stderr || "").trim().slice(0, 400) ||
        `no verdict (exit ${piston.code})`,
    };
    return withArtifact(req, {
      node_id: req.node_id,
      verdict: "red",
      passed: 0,
      failed: 1,
      failures: [err],
      failure_code: "EXECUTION_FAILED",
      measurements: { duration_ms: durationMs, memory_mb: null },
      piston,
    });
  }
  return withArtifact(req, {
    node_id: req.node_id,
    verdict: v.failed === 0 ? "green" : "red",
    passed: v.passed,
    failed: v.failed,
    failures: v.failures.map((f) => ({
      case: f.case,
      expected: f.expected,
      actual: f.actual,
      error: f.error,
    })),
    failure_code: v.failed === 0 ? null : "ACCEPTANCE_FAILED",
    measurements: { duration_ms: durationMs, memory_mb: null },
    piston,
  });
}

function runLocal(
  req: TestRequest | TestRequestV2,
  files: PFile[],
  backend: LanguageBackend,
): TestResult {
  const dir = mkdtempSync(join(tmpdir(), "foundry-test-"));
  try {
    for (const f of files) writeFileSync(join(dir, f.name), f.content);
    const invocation = backend.localCommand(files.map((file) => file.name));
    const startedAt = performance.now();
    const proc = spawnSync(invocation.command, invocation.args, {
      cwd: dir,
      encoding: "utf-8",
      timeout: Math.min(
        req.resource_policy.timeout_ms,
        (req.acceptance.perf?.time_ms ?? 3000) + 2000,
      ),
    });
    return testResultFromExecution(
      req,
      proc.stdout ?? "",
      {
        code: proc.status ?? -1,
        signal: proc.signal ?? null,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
      },
      Math.max(0, Math.round(performance.now() - startedAt)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pistonVersionCache: Record<string, string> = {};
async function resolvePistonVersion(
  url: string,
  language: string,
): Promise<string> {
  if (pistonVersionCache[language]) return pistonVersionCache[language];
  const r = await fetch(`${url}/api/v2/runtimes`);
  const runtimes = (await r.json()) as {
    language: string;
    version: string;
    aliases?: string[];
  }[];
  const rt = runtimes.find(
    (x) => x.language === language || (x.aliases ?? []).includes(language),
  );
  if (!rt)
    throw new Error(
      `Piston has no runtime for '${language}' — install via POST ${url}/api/v2/packages`,
    );
  pistonVersionCache[language] = rt.version;
  return rt.version;
}

async function runOnPiston(
  req: TestRequest | TestRequestV2,
  files: PFile[],
  url: string,
): Promise<TestResult> {
  const backend = languageBackend(req.language);
  const version = await resolvePistonVersion(url, backend.pistonLanguage);
  const body = {
    language: backend.pistonLanguage,
    version,
    files,
    run_timeout: Math.min(
      req.resource_policy.timeout_ms,
      req.acceptance.perf?.time_ms ?? req.resource_policy.timeout_ms,
    ),
    run_memory_limit:
      Math.min(
        req.resource_policy.memory_mb,
        req.acceptance.perf?.mem_mb ?? req.resource_policy.memory_mb,
      ) * 1_000_000,
  };
  const startedAt = performance.now();
  const resp = await fetch(`${url}/api/v2/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as {
    run?: {
      stdout: string;
      stderr: string;
      code: number;
      signal: string | null;
    };
    message?: string;
  };
  if (!data.run) {
    const err: Failure = {
      case: "<piston>",
      expected: null,
      actual: null,
      error: data.message ?? "piston: no run stage",
    };
    return withArtifact(req, {
      node_id: req.node_id,
      verdict: "red",
      passed: 0,
      failed: 1,
      failures: [err],
      failure_code: "PISTON_FAILED",
      measurements: {
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        memory_mb: null,
      },
      piston: {
        code: -1,
        signal: null,
        stdout: "",
        stderr: data.message ?? "",
      },
    });
  }
  const run = data.run;
  return testResultFromExecution(
    req,
    run.stdout ?? "",
    {
      code: run.code,
      signal: run.signal,
      stdout: run.stdout ?? "",
      stderr: run.stderr ?? "",
    },
    Math.max(0, Math.round(performance.now() - startedAt)),
  );
}

export async function executeTest(
  req: TestRequest | TestRequestV2,
  cfg: TesterConfig = { mode: "local" },
): Promise<TestResult> {
  const backend = languageBackend(req.language);
  const files = assembleTestFiles(req, backend);
  if (cfg.mode === "piston")
    return runOnPiston(req, files, cfg.pistonUrl ?? "http://127.0.0.1:2000");
  return runLocal(req, files, backend);
}

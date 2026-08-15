// The tester (`POST /test`): run a node's parent-owned acceptance suite against the
// built code and return a deterministic verdict. The SAME generated runner runs either
// locally (python3, dev while Piston is down) or inside Piston's isolated container
// (prod) — Piston lays all files flat in one dir, matching the local temp-dir layout, so
// the verdict is identical. Black-box: reads only the built module + its declared deps.

import type { TestRequest, TestResult, Failure } from "./contract.ts";
import { generatePythonRunner, parseVerdict } from "./runner-gen.ts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

const abs = (ws: string, p: string): string =>
  isAbsolute(p) ? p : join(ws, p);
const sanitize = (id: string): string => id.replace(/-/g, "_");

export interface TesterConfig {
  mode: "local" | "piston";
  pistonUrl?: string;
}

interface PFile {
  name: string;
  content: string;
}

/** Flatten module-under-test + deps + generated runner (runner is files[0] = the main file). */
function assembleFiles(req: TestRequest): PFile[] {
  const moduleName = sanitize(req.node_id);
  const runner = generatePythonRunner({
    moduleImportName: moduleName,
    opNames: req.provides.operations.map((o) => o.name),
    cases: req.acceptance.cases,
  });
  const files: PFile[] = [{ name: "__runner.py", content: runner }];
  files.push({
    name: `${moduleName}.py`,
    content: readFileSync(abs(req.workspace, req.write_target), "utf-8"),
  });
  for (const d of req.deps) {
    files.push({
      name: `${d.import_name}.py`,
      content: readFileSync(abs(req.workspace, d.read_path), "utf-8"),
    });
  }
  return files;
}

/** Map a run's stdout (+ raw stage) to a verdict — shared by both executors. */
function toResult(
  nodeId: string,
  stdout: string,
  piston: TestResult["piston"],
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
    return {
      node_id: nodeId,
      verdict: "red",
      passed: 0,
      failed: 1,
      failures: [err],
      piston,
    };
  }
  return {
    node_id: nodeId,
    verdict: v.failed === 0 ? "green" : "red",
    passed: v.passed,
    failed: v.failed,
    failures: v.failures.map((f) => ({
      case: f.case,
      expected: f.expected,
      actual: f.actual,
      error: f.error,
    })),
    piston,
  };
}

function runLocal(req: TestRequest, files: PFile[]): TestResult {
  const dir = mkdtempSync(join(tmpdir(), "foundry-test-"));
  try {
    for (const f of files) writeFileSync(join(dir, f.name), f.content);
    const proc = spawnSync("python3", ["__runner.py"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: (req.acceptance.perf?.time_ms ?? 3000) + 2000,
    });
    return toResult(req.node_id, proc.stdout ?? "", {
      code: proc.status ?? -1,
      signal: proc.signal ?? null,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    });
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
  req: TestRequest,
  files: PFile[],
  url: string,
): Promise<TestResult> {
  const version = await resolvePistonVersion(url, req.language);
  const body = {
    language: req.language,
    version,
    files,
    run_timeout: req.acceptance.perf?.time_ms ?? 3000,
    run_memory_limit: req.acceptance.perf?.mem_mb
      ? req.acceptance.perf.mem_mb * 1_000_000
      : -1,
  };
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
    return {
      node_id: req.node_id,
      verdict: "red",
      passed: 0,
      failed: 1,
      failures: [err],
      piston: {
        code: -1,
        signal: null,
        stdout: "",
        stderr: data.message ?? "",
      },
    };
  }
  const run = data.run;
  return toResult(req.node_id, run.stdout ?? "", {
    code: run.code,
    signal: run.signal,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  });
}

export async function executeTest(
  req: TestRequest,
  cfg: TesterConfig = { mode: "local" },
): Promise<TestResult> {
  const files = assembleFiles(req);
  if (cfg.mode === "piston")
    return runOnPiston(req, files, cfg.pistonUrl ?? "http://127.0.0.1:2000");
  return runLocal(req, files);
}

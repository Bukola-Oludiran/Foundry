// The tester (`POST /test`): run a node's parent-owned acceptance suite against the
// built code and return a deterministic verdict. The SAME generated runner runs either
// locally (python3, dev while Piston is down) or inside Piston's isolated container
// (prod) — Piston lays all files flat in one dir, matching the local temp-dir layout, so
// the verdict is identical. Black-box: reads only the built module + its declared deps.

import type { TestRequest, TestResult, Failure } from "./contract.ts";
import { generatePythonRunner, generatePythonTypedRunner, parseVerdict } from "./runner-gen.ts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";

const abs = (ws: string, p: string): string => (isAbsolute(p) ? p : join(ws, p));
const sanitize = (id: string): string => id.replace(/-/g, "_");
const boundedTime = (req: TestRequest): number => Math.min(Math.max(req.acceptance.perf?.time_ms ?? 3000, 100), 10_000);
const boundedMemory = (req: TestRequest): number => Math.min(Math.max(req.acceptance.perf?.mem_mb ?? 256, 16), 256) * 1_000_000;

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
  const moduleName = req.module_import_name ?? sanitize(req.node_id);
  const runnerInput = {
    moduleImportName: moduleName,
    opNames: req.provides.operations.map((o) => o.name),
    cases: req.acceptance.cases,
    scenarios: req.acceptance.scenarios,
  };
  const runner = req.architecture_version === 4 ? generatePythonTypedRunner(runnerInput) : generatePythonRunner(runnerInput);
  const files: PFile[] = [{ name: "__runner.py", content: runner }];
  if (req.repository_layout) for (const path of [...new Set(req.repository_files ?? [req.write_target, ...req.deps.map((dep) => dep.read_path)])]) { const full = abs(req.workspace, path); if (existsSync(full)) files.push({ name: path, content: readFileSync(full, "utf-8") }); }
  else { files.push({ name: `${moduleName}.py`, content: readFileSync(abs(req.workspace, req.write_target), "utf-8") }); for (const d of req.deps) files.push({ name: `${d.import_name}.py`, content: readFileSync(abs(req.workspace, d.read_path), "utf-8") }); }
  return files;
}

/** Map a run's stdout (+ raw stage) to a verdict — shared by both executors. */
function toResult(nodeId: string, stdout: string, piston: TestResult["piston"]): TestResult {
  const v = parseVerdict(stdout);
  if (!v) {
    const err: Failure = {
      case: "<execution>",
      expected: null,
      actual: null,
      error: (piston.stderr || "").trim().slice(0, 400) || `no verdict (exit ${piston.code})`,
    };
    return { node_id: nodeId, verdict: "red", passed: 0, failed: 1, failures: [err], piston };
  }
  return {
    node_id: nodeId,
    verdict: v.failed === 0 ? "green" : "red",
    passed: v.passed,
    failed: v.failed,
    failures: v.failures.map((f) => ({ case: f.case, expected: f.expected, actual: f.actual, error: f.error })),
    piston,
  };
}

function runLocal(req: TestRequest, files: PFile[]): TestResult {
  const dir = mkdtempSync(join(tmpdir(), "foundry-test-"));
  try {
    for (const f of files) { const path = join(dir, f.name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, f.content); }
    if (req.runtime_version_range) { const version = spawnSync("python3", ["--version"], { encoding: "utf8" }).stdout.trim() || spawnSync("python3", ["--version"], { encoding: "utf8" }).stderr.trim(); if (!satisfies(version, req.runtime_version_range)) return toResult(req.node_id, "", { code: -1, signal: null, stdout: "", stderr: `RUNTIME_UNAVAILABLE: ${version} does not satisfy ${req.runtime_version_range}` }); }
    const proc = spawnSync("python3", ["__runner.py"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: boundedTime(req) + 2000,
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
function versionTuple(value: string): number[] { return (value.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map(Number); }
function compareVersion(a: string, b: string): number { const aa = versionTuple(a), bb = versionTuple(b); for (let i = 0; i < Math.max(aa.length, bb.length); i++) { const d = (aa[i] ?? 0) - (bb[i] ?? 0); if (d) return d; } return 0; }
export function satisfies(version: string, range?: string): boolean { if (!range) return true; const minimum = range.match(/>=\s*([\d.]+)/)?.[1]; return minimum ? compareVersion(version, minimum) >= 0 : compareVersion(version, range.replace(/^[=~^\s]+/, "")) === 0; }
export async function resolvePistonVersion(url: string, language: string, range?: string): Promise<string> {
  const cacheKey = `${language}:${range ?? "*"}`; if (pistonVersionCache[cacheKey]) return pistonVersionCache[cacheKey];
  const r = await fetch(`${url}/api/v2/runtimes`);
  const runtimes = (await r.json()) as { language: string; version: string; aliases?: string[] }[];
  const candidates = runtimes.filter((x) => (x.language === language || (x.aliases ?? []).includes(language)) && satisfies(x.version, range)).sort((a, b) => compareVersion(b.version, a.version)); const rt = candidates[0];
  if (!rt) throw new Error(`RUNTIME_UNAVAILABLE: Piston has no '${language}' runtime satisfying '${range ?? "*"}'`);
  pistonVersionCache[cacheKey] = rt.version;
  return rt.version;
}

async function runOnPiston(req: TestRequest, files: PFile[], url: string): Promise<TestResult> {
  const version = await resolvePistonVersion(url, req.language, req.runtime_version_range);
  const body = {
    language: req.language,
    version,
    files,
    run_timeout: boundedTime(req),
    run_memory_limit: boundedMemory(req),
  };
  const resp = await fetch(`${url}/api/v2/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as {
    run?: { stdout: string; stderr: string; code: number; signal: string | null };
    message?: string;
  };
  if (!data.run) {
    const err: Failure = { case: "<piston>", expected: null, actual: null, error: data.message ?? "piston: no run stage" };
    return { node_id: req.node_id, verdict: "red", passed: 0, failed: 1, failures: [err], piston: { code: -1, signal: null, stdout: "", stderr: data.message ?? "" } };
  }
  const run = data.run;
  return toResult(req.node_id, run.stdout ?? "", { code: run.code, signal: run.signal, stdout: run.stdout ?? "", stderr: run.stderr ?? "" });
}

export async function executeTest(req: TestRequest, cfg: TesterConfig = { mode: "local" }): Promise<TestResult> {
  const files = assembleFiles(req);
  if (cfg.mode === "piston") return runOnPiston(req, files, cfg.pistonUrl ?? "http://127.0.0.1:2000");
  return runLocal(req, files);
}

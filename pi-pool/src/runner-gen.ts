// Deterministic Python test-runner generator for the pi-pool /test path (v1).
//
// Given the provided operations + acceptance cases, emit a self-contained Python
// program that imports the module under test (by its flat Piston name), runs each
// case, and prints a single machine-readable verdict line. There is NO LLM in this
// oracle path — the verdict is a pure function of (built code, parent-owned cases),
// which is what gives the bottom-up build its integrity.
//
// The same generated program runs identically under local `python3` (dev) and inside
// a Piston `execute` container (prod) — Piston lays all `files[]` flat in one dir, so
// the flat imports resolve the same way. See Foundry/docs/contract.md.
//
// SECURITY — the runner uses Python `eval` on each case's `call` expression. This is
// deliberate: the acceptance `call` strings ARE the executable contract, and evaluating
// them against the built module is precisely the tester's job. The mitigation is NOT
// input-sanitization (you cannot sanitize a general call expression) — it is the
// architecture's sandbox pillar: /test ALWAYS runs inside Piston's isolated, resource-
// capped, network-off container (dev uses local python3 only as a stand-in while Piston
// is down). In v1 the cases are authored by our own trusted architecture role. If the IR
// ever carries untrusted cases, the containment boundary — not this generator — is the
// control, which is exactly why the executable oracle is sandboxed by design.

export interface GenInput {
  /** Flat module name of the unit under test, e.g. "string_utils". */
  moduleImportName: string;
  /** Provided operation names to bring into scope for the case expressions. */
  opNames: string[];
  /** Parent-owned acceptance cases (call/expect). */
  cases: { name: string; call?: string; expect?: unknown; harness?: string }[];
}

/** Prefix on the single stdout line carrying the JSON verdict. */
export const VERDICT_SENTINEL = "__FOUNDRY_VERDICT__";

export interface RunnerVerdict {
  passed: number;
  failed: number;
  failures: {
    case: string;
    expected: unknown;
    actual: unknown;
    error: string | null;
    passed: boolean;
  }[];
}

export function generatePythonRunner(input: GenInput): string {
  const { moduleImportName, opNames, cases } = input;
  // base64 the cases so arbitrary case content can never break out of the source string.
  const casesB64 = Buffer.from(JSON.stringify(cases), "utf-8").toString(
    "base64",
  );
  const importLine =
    opNames.length > 0
      ? `from ${moduleImportName} import ${opNames.join(", ")}`
      : `import ${moduleImportName}`;

  return `import json, base64
${importLine}
_CASES = json.loads(base64.b64decode("${casesB64}").decode("utf-8"))
_results = []
for _c in _CASES:
    _e = {"case": _c["name"], "expected": _c.get("expect"), "actual": None, "error": None, "passed": False}
    try:
        # eval of the acceptance call expression — contained by the Piston sandbox (see runner-gen.ts header).
        _actual = eval(_c["call"])
        _e["actual"] = _actual
        _e["passed"] = (_actual == _c.get("expect"))
    except Exception as _ex:
        _e["error"] = repr(_ex)
    _results.append(_e)
_failed = [r for r in _results if not r["passed"]]
print("${VERDICT_SENTINEL}" + json.dumps({
    "passed": len([r for r in _results if r["passed"]]),
    "failed": len(_failed),
    "failures": _failed,
}, default=repr))
raise SystemExit(0 if not _failed else 1)
`;
}

/** Extract the verdict from a runner's stdout (the sentinel line). */
export function parseVerdict(stdout: string): RunnerVerdict | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(VERDICT_SENTINEL)) {
      return JSON.parse(line.slice(VERDICT_SENTINEL.length)) as RunnerVerdict;
    }
  }
  return null;
}

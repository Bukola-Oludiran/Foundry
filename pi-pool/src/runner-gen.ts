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
  scenarios?: import("./contract.ts").TypedAcceptanceScenario[];
}

/** Prefix on the single stdout line carrying the JSON verdict. */
export const VERDICT_SENTINEL = "__FOUNDRY_VERDICT__";

export interface RunnerVerdict {
  passed: number;
  failed: number;
  failures: { case: string; expected: unknown; actual: unknown; error: string | null; passed: boolean }[];
}

export function generatePythonRunner(input: GenInput): string {
  const { moduleImportName, opNames, cases } = input;
  // base64 the cases so arbitrary case content can never break out of the source string.
  const casesB64 = Buffer.from(JSON.stringify(cases), "utf-8").toString("base64");
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

export function generatePythonTypedRunner(input: GenInput): string {
  const spec = Buffer.from(JSON.stringify({ operations: input.opNames, scenarios: input.scenarios ?? [] }), "utf8").toString("base64");
  return `import base64, json
from datetime import datetime
from decimal import Decimal
from ${input.moduleImportName} import ${input.opNames.join(", ")}
_SPEC = json.loads(base64.b64decode("${spec}"))
_OPS = {name: globals()[name] for name in _SPEC["operations"]}
def _value(value, handles):
    if isinstance(value, list): return [_value(item, handles) for item in value]
    if not isinstance(value, dict): return value
    if set(value) == {"$ref"}: return handles[value["$ref"]]
    if set(value) == {"$type", "value"}:
        if value["$type"] == "datetime": return datetime.fromisoformat(value["value"].replace("Z", "+00:00"))
        if value["$type"] == "decimal": return Decimal(value["value"])
        if value["$type"] == "bytes": return base64.b64decode(value["value"])
        raise ValueError("unsupported typed value")
    return {key: _value(item, handles) for key, item in value.items()}
def _subset(expected, actual):
    if isinstance(expected, dict): return isinstance(actual, dict) and all(key in actual and _subset(value, actual[key]) for key, value in expected.items())
    if isinstance(expected, list): return isinstance(actual, list) and len(expected) == len(actual) and all(_subset(a, b) for a, b in zip(expected, actual))
    return expected == actual
_results = []
for scenario in _SPEC["scenarios"]:
    handles = {}; error = None
    try:
        for step in scenario["steps"]:
            arguments = [_value(value, handles) for value in step["arguments"]]
            if step.get("receiver"): arguments.insert(0, handles[step["receiver"]])
            expectation = step.get("expect")
            if expectation and expectation["kind"] == "error":
                try: _OPS[step["operation"]](*arguments)
                except Exception as caught:
                    if type(caught).__name__ != expectation["errorType"] or expectation.get("messageIncludes", "") not in str(caught): raise AssertionError("unexpected error: " + repr(caught))
                else: raise AssertionError("expected " + expectation["errorType"])
                continue
            actual = _OPS[step["operation"]](*arguments)
            if step.get("bind"): handles[step["bind"]] = actual
            if expectation:
                expected = _value(expectation["value"], handles)
                if expectation["kind"] == "equals" and actual != expected: raise AssertionError(f"expected {expected!r}, got {actual!r}")
                if expectation["kind"] == "subset" and not _subset(expected, actual): raise AssertionError(f"{expected!r} is not a subset of {actual!r}")
    except Exception as caught: error = repr(caught)
    _results.append({"case": scenario["id"], "expected": "typed scenario", "actual": None, "error": error, "passed": error is None})
_failed = [result for result in _results if not result["passed"]]
print("${VERDICT_SENTINEL}" + json.dumps({"passed": len(_results) - len(_failed), "failed": len(_failed), "failures": _failed}, default=repr))
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

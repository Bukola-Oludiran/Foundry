# Mutation testing — grading the acceptance cases

> Status: **design, not implemented.** Proposed as a second phase inside `POST /test`.

## The gap this closes

Foundry's oracle has total integrity about one question and says nothing about another.

`executeTest` runs the parent-owned acceptance cases against the built module and returns a verdict
that is a pure function of `(built code, cases)` — no LLM anywhere in the path
([runner-gen.ts](../pi-pool/src/runner-gen.ts) header). That answers:

> **Does this code satisfy these cases?** — answered, deterministically, in a sandbox.

The compiler separately enforces `acceptance.mandate_owner` = parent (or `spec`), never self. That is
an *anti-capture* rule: it fixes **who** may author a node's cases, so a doer can never grade itself.

Neither mechanism answers:

> **Do these cases characterize the contract?** — currently unanswered by anything.

An architect that emits three shallow cases per node produces a build where every dyad goes green,
the host reports **ALL GREEN**, and the software is wrong. The oracle is only ever as strong as the
cases it runs, and today nothing measures that strength. Test *ownership* is enforced; test *quality*
is assumed.

Mutation testing turns "are these cases any good?" from a judgment into an executable question —
which is the same move the rest of the system already makes.

## The mechanism

Damage the implementation on purpose; a case set that does not notice is weak.

1. Parse the module under test into an AST.
2. Enumerate mutation sites deterministically and apply one operator per mutant
   (`<` → `<=`, `+` → `-`, `and` → `or`, `return x` → `return None`, constant twists, …).
3. Re-run the *same* acceptance cases against each mutant.
4. A mutant is **killed** if any case fails, errors, or times out; it **survived** if every case still
   passes.
5. `score = killed / (total − declared_equivalent)`.

A surviving mutant is a concrete, quotable indictment: *"I inverted the comparison on line 12 and
your entire suite still passed."*

Cost is zero model calls. It is pure computation in a sandbox we already run.

## Where it runs — one Piston execution, not K

The naive shape is K mutants × one `/api/v2/execute` round-trip each. Don't do that. Generate a
**mutation harness** as `files[0]` that does the whole loop in-process, exactly the way
`generatePythonRunner` already generates the acceptance runner:

- Piston lays `files[]` flat in one directory, so the module under test and its deps are importable
  by their flat names — same layout assumption `assembleFiles` already relies on.
- The harness mutates the AST and `compile()`s it directly into a fresh `types.ModuleType`. No
  `ast.unparse` round-trip (avoids a 3.9+ dependency and formatting drift); mutations are reported by
  operator + `lineno:col_offset` off the AST node.
- One execution per node, one verdict line, same sentinel-parse pattern as `parseVerdict`.

New file `pi-pool/src/mutation-gen.ts`, mirroring `runner-gen.ts`:

```ts
export const MUTATION_SENTINEL = "__FOUNDRY_MUTATION__";

export interface MutationGenInput {
  moduleImportName: string;
  opNames: string[];
  cases: { name: string; call?: string; expect?: unknown; harness?: string }[];
  maxMutants: number;
  equivalent: string[];       // declared-equivalent mutant ids, excluded from the denominator
  perMutantMs: number;
}

export function generatePythonMutationHarness(input: MutationGenInput): string;
export function parseMutationVerdict(stdout: string): MutationVerdict | null;
```

### Harness shape

```python
import json, base64, ast, copy, types, signal

_SPEC  = json.loads(base64.b64decode("<b64>").decode("utf-8"))
_SRC   = open(_SPEC["module"] + ".py").read()
_BASE  = ast.parse(_SRC)

_CMP  = {ast.Lt: ast.LtE, ast.LtE: ast.Lt, ast.Gt: ast.GtE, ast.GtE: ast.Gt,
         ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.In: ast.NotIn, ast.NotIn: ast.In,
         ast.Is: ast.IsNot, ast.IsNot: ast.Is}
_BIN  = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.Div, ast.Div: ast.Mult}
_BOOL = {ast.And: ast.Or, ast.Or: ast.And}

# Sites are identified by index into ast.walk() — a deterministic BFS, so the index is a
# stable identity between _BASE and any deepcopy of it. No RNG anywhere: the mutant set is
# a pure function of the source, which keeps runs replayable.
def _sites(tree):
    out = []
    for i, n in enumerate(ast.walk(tree)):
        if   isinstance(n, ast.Compare):
            out += [("CMP", i, j) for j, op in enumerate(n.ops) if type(op) in _CMP]
        elif isinstance(n, ast.BinOp)   and type(n.op) in _BIN:  out.append(("BIN",   i, 0))
        elif isinstance(n, ast.BoolOp)  and type(n.op) in _BOOL: out.append(("BOOL",  i, 0))
        elif isinstance(n, ast.Return)  and n.value is not None: out.append(("RET",   i, 0))
        elif isinstance(n, ast.Constant):                        out.append(("CONST", i, 0))
    return out

def _apply(kind, idx, opidx):
    t = copy.deepcopy(_BASE)
    n = list(ast.walk(t))[idx]
    if   kind == "CMP":   n.ops[opidx] = _CMP[type(n.ops[opidx])]()
    elif kind == "BIN":   n.op = _BIN[type(n.op)]()
    elif kind == "BOOL":  n.op = _BOOL[type(n.op)]()
    elif kind == "RET":   n.value = ast.Constant(value=None)
    elif kind == "CONST": n.value = _twist(n.value)
    return ast.fix_missing_locations(t)

class _Timeout(Exception): pass
signal.signal(signal.SIGALRM, lambda s, f: (_ for _ in ()).throw(_Timeout()))

def _killed_by_cases(tree):
    """True = mutant killed. Import error, case failure, exception, or hang all count."""
    mod = types.ModuleType(_SPEC["module"])
    try:
        signal.setitimer(signal.ITIMER_REAL, _SPEC["per_mutant_s"])
        exec(compile(tree, _SPEC["module"] + ".py", "exec"), mod.__dict__)
        scope = {k: mod.__dict__[k] for k in _SPEC["ops"] if k in mod.__dict__}
        for c in _SPEC["cases"]:
            if eval(c["call"], dict(scope)) != c.get("expect"):
                return True
        return False                      # every case still passed → SURVIVED
    except Exception:
        return True                       # includes _Timeout: an infinite loop IS detection
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
```

`SIGALRM` per mutant matters: without it one non-terminating mutant burns Piston's global
`run_timeout` and the whole node reports an execution error instead of a mutation score.

### Security posture

The harness `exec`s mutated source. This is the *same* trust boundary the acceptance runner already
accepts for `eval` of case expressions, and strictly narrower — the code being executed was already
inside the sandbox, and the mutation is a mechanical AST edit, not new authored input. The control is
containment (Piston: isolated, resource-capped, network-off), not sanitization. See the
[runner-gen.ts](../pi-pool/src/runner-gen.ts) header for the full argument.

## Verdict and attribution — the part that matters

Foundry's stated principle is that **the failure signal always names its owner.** Mutation results
have a *different owner* than acceptance results, so they must not collapse into the same verdict.

| Outcome | Meaning | Owner | Route |
|---|---|---|---|
| `red` | code fails the cases | **doer** | existing retry-with-feedback |
| `weak` | code passes, cases don't pin it down | **`acceptance.mandate_owner`** (the parent) | `invalidation_set` → subtree re-architecture |
| `green` | passes, and the cases have teeth | — | unlock consumers |

This is the first signal in the system that holds the **contract author** accountable. Everything
today points at the doer. Routing `weak` to the mandate owner reuses machinery that already exists —
it is the same escalation path a genuinely-unbuildable node takes.

Do **not** report a weak node as `red`. Red means "retry the doer," and retrying the doer against
weak cases is a guaranteed no-op that will burn attempts until exhaustion and then blame the wrong
role.

## Ordering and cost

Mutation runs **only after acceptance is green**. There is nothing to learn from mutating code that
already fails its cases, and red is the common state during retries — so the cost lands only on nodes
that were about to be accepted.

Per green node: one extra Piston execution, `K` mutants × acceptance-suite runtime, in-process. For
`string-utils`-sized leaves that is milliseconds. `max_mutants` bounds it; when the site count exceeds
the cap, truncate **deterministically** (sites in `ast.walk` order, take the first K) — never sample.
Replayability is a property this project sells, and an RNG in the oracle path would forfeit it.

## Wire changes

`pi-pool/src/contract.ts` — and the Rust mirror in `gr-host`, which is a breaking change to the
`TestResult` shape:

```ts
export interface TestBundle {
  mandate_owner: string;
  language: string;
  cases: TestCase[];
  properties?: string[];
  perf?: { time_ms?: number; mem_mb?: number };
  mutation?: {                      // NEW — absent = phase disabled for this node
    min_score?: number;             // default 0.8
    max_mutants?: number;           // default 64
    equivalent?: string[];          // mutant ids excused from the denominator
    per_mutant_ms?: number;         // default 500
  };
}

export interface Mutant {
  id: string;                       // "CMP@12:8" — operator + source position
  operator: "CMP" | "BIN" | "BOOL" | "RET" | "CONST";
  line: number;
  col: number;
  survived: boolean;
}

export interface MutationReport {
  score: number;
  killed: number;
  survived: number;
  equivalent: number;               // declared, excluded from the denominator
  truncated: boolean;               // site count exceeded max_mutants
  survivors: Mutant[];              // the feedback payload for the mandate owner
}

export interface TestResult {
  node_id: string;
  verdict: "green" | "red" | "weak";   // "weak" is NEW
  passed: number;
  failed: number;
  failures: Failure[];
  mutation?: MutationReport;           // NEW — present when the phase ran
  piston: { code: number; signal: string | null; stdout: string; stderr: string };
}
```

## Build sequence

1. `pi-pool/src/mutation-gen.ts` — harness generator + `parseMutationVerdict`. Unit-testable with no
   Piston: generate, run under local `python3`, assert survivor sets against hand-built weak/strong
   case pairs.
2. `pi-pool/src/contract.ts` — the types above.
3. `pi-pool/src/tester.ts` — second phase in `executeTest`, guarded on `verdict === "green"` and a
   present `acceptance.mutation`. Reuses `assembleFiles`; swaps `files[0]` for the harness.
4. `ir/schema.json` + `crates/foundry-ir` — accept and validate the `mutation` block.
5. `crates/foundry-host` — mirror the wire types; route `weak` to `mandate_owner` instead of the doer
   retry path; carry `survivors` into the re-architecture feedback.
6. Fixture: a deliberately-weak variant of `ir/examples/string-utils.ir.json` (one case per op) that
   must score below threshold, alongside the current one that must clear it. This is the regression
   test for the whole feature.

## Limits — stated honestly

**Equivalent mutants.** Some mutations produce semantically identical code and can never be killed;
detecting them is undecidable in general. Mitigation is threshold-not-perfection (`min_score` default
`0.8`, never `1.0`) plus the `equivalent` declare-list for known cases. Do not chase 100%.

**The blind spot — mutation cannot see absent code.** This measures whether the cases pin down *the
implementation that exists*. If the contract says "handle empty input" and neither the implementation
nor the cases mention it, there is no mutation site, no survivor, and a perfect score on missing
behavior. Mutation grades case *strength*, not contract *coverage*.

The complementary check has a natural home already in the contract: `Operation.properties` and
`TestBundle.properties` exist as declared behavioral clauses. Requiring every declared property to be
exercised by at least one case is a cheap, deterministic coverage floor that catches exactly what
mutation misses. Worth building alongside; the two together are considerably stronger than either.

**Gaming.** An architect optimizing for mutation score can write assertion-dense cases that kill
mutants without characterizing the contract. Lower risk than the failure it prevents, but the score is
a health metric, not a target to maximize.

**Python only in v1.** Operators are language-specific. `TestRequest.language` already exists, so
dispatch to a per-language harness generator when a second language lands.

## Why this is worth building

It gives the architecture role the objective grade it currently lacks. Hephastus (or any spec→IR
agent) is graded today on critical-issue trajectory — council consensus, a model grading a model.
Mutation score per node is executable ground truth about the *contracts* an architect wrote, in the
same class of evidence as Piston's green/red about the code. That closes the loop: the oracle stops
being something the architect can accidentally defeat by writing an easy exam.

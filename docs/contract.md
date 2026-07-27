# Contract: GR-host ↔ pi-pool ↔ Piston

The control plane (GR host, Rust) drives the data plane (pi workers, Node/TS) over HTTP. The pi-pool
in turn drives **Piston** as the executable oracle.
Authoritative TypeScript types: [`../pi-pool/src/contract.ts`](../pi-pool/src/contract.ts). This
doc is the prose spec; the Rust host mirrors these shapes.

All request bodies are keyed off a single **IR node** (see `../ir/schema.json`).

```
GR host (Rust)                pi-pool (Node/TS)                 Piston (Docker :2000)
  doer node  ──POST /build──▶  pi-agent-core loop  ──writes──▶  workspace (sandboxed)
  tester node ─POST /test───▶  runner-gen (v1: deterministic) ─POST /api/v2/execute─▶ verdict
             ◀── result ────                        ◀── run{stdout,code} ──
```

## POST /build  (doer — LLM agent via pi)

The doer implements `provides` into `write_target`, reading only its dependencies' interfaces. Runs
under an OS sandbox scoped to **read** = `requires[].read_path` (read-only) + **write** =
`write_target`. Never trust "the loop stopped" = done — the tester's verdict is truth.

Request `BuildRequest`:
```json
{
  "node_id": "hyphenate",
  "kind": "leaf",
  "language": "python",
  "workspace": "/abs/path/to/worktree",
  "write_target": "src/string_utils/hyphenate.py",
  "provides": { "name": "Hyphenate", "operations": [ { "name": "hyphenate", "signature": "hyphenate(s: string) -> string", "properties": ["..."] } ] },
  "requires": [
    { "node": "lowercase", "interface": { "name": "Lowercase", "operations": [ ... ] }, "import_name": "lowercase", "read_path": "src/string_utils/lowercase.py" }
  ],
  "composition": null,
  "children": [],
  "attempt": 1,
  "feedback": null
}
```
- `import_name` — the flat module name the doer must import a dependency as (bridges workspace paths
  ↔ Piston's flat file layout). Both the doer's code and the tester's runner use it.
- `children` (integrator only) — same `{node, import_name, read_path}` shape; the doer writes glue.
- `feedback` — on a retry (`attempt > 1`), the prior tester failure detail, fed into the loop.

Response `BuildResult`:
```json
{ "node_id": "hyphenate", "ok": true, "wrote": ["src/string_utils/hyphenate.py"],
  "summary": "…", "error": null, "usage": { "input_tokens": 0, "output_tokens": 0 } }
```

## POST /test  (tester — deterministic in v1)

Black-box: the tester sees the contract + the built module's outputs, never authors the doer's code.
v1 generates the runner **deterministically** from `acceptance.cases` (no LLM in the oracle path →
maximal integrity). LLM-authored property/edge-case expansion is a later enhancement.

Request `TestRequest`:
```json
{
  "node_id": "hyphenate",
  "language": "python",
  "workspace": "/abs/path/to/worktree",
  "write_target": "src/string_utils/hyphenate.py",
  "provides": { "name": "Hyphenate", "operations": [ ... ] },
  "acceptance": { "mandate_owner": "string-utils", "language": "python", "cases": [ { "name": "spaces", "call": "hyphenate('hello world')", "expect": "hello-world" } ], "perf": { "time_ms": 3000 } },
  "deps": [ { "import_name": "lowercase", "read_path": "src/string_utils/lowercase.py" } ]
}
```
- `deps` — modules the runner must also load (a leaf's own module is `write_target`; an integrator
  additionally loads its transitive children so their symbols resolve).

Response `TestResult`:
```json
{
  "node_id": "hyphenate",
  "verdict": "green",
  "passed": 4, "failed": 0,
  "failures": [],
  "piston": { "code": 0, "signal": null, "stdout": "…", "stderr": "" }
}
```
A failure entry: `{ "case": "collapse", "expected": "a-b", "actual": "a--b", "error": null }`.

## pi-pool → Piston mapping (`/test`)

1. Read `write_target` + every `deps[].read_path` from `workspace`.
2. Flatten to Piston `files[]`: each module → `{ name: "<import_name>.py", content }`.
3. Generate `__runner.py` as **files[0]** (Piston runs the first file as main): imports each provided
   op by its `import_name`, evaluates each case's `call`, compares `== expect`, collects failures,
   prints a single JSON line, exits `0` iff all pass.
4. `POST http://127.0.0.1:2000/api/v2/execute`
   `{ language, version, files:[runner, ...modules], run_timeout: perf.time_ms ?? 3000, run_memory_limit: perf.mem_mb*1e6 ?? -1 }`.
   `version` resolved from `GET /api/v2/runtimes` (pick the installed one for `language`).
5. Parse `run.stdout` JSON → `TestResult`. Nonzero `run.code` with no parseable summary ⇒ `red` with
   the stderr as the error (covers crashes/timeouts/compile errors).

## Piston bring-up (one-time, local)

```bash
export PISTON_DIR=/path/to/your/piston-checkout
docker compose -f "$PISTON_DIR/docker-compose.yml" up -d # api on :2000
curl -s http://127.0.0.1:2000/api/v2/runtimes          # list installed
# install the python runtime via ppman:
curl -s -XPOST http://127.0.0.1:2000/api/v2/packages \
  -H 'content-type: application/json' -d '{"language":"python","version":"3.*"}'
```
Runs are ephemeral, isolated containers (`tmpfs /tmp:exec`, privileged). Down with `docker compose down`.
```

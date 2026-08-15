# Contract: GR-host ↔ pi-pool ↔ Piston

The control plane (GR host, Rust) drives the data plane (pi workers, Node/TS) over HTTP. The pi-pool
in turn drives **Piston** as the executable oracle.
Authoritative TypeScript types: [`../pi-pool/src/contract.ts`](../pi-pool/src/contract.ts). This
doc is the prose spec; the Rust host mirrors these shapes.

## Transport and job context

`POST /build` and `POST /test` require `Authorization: Bearer <worker token>`. The token comes from
`FOUNDRY_WORKER_TOKEN`, never a command-line argument. Bodies default to 1 MiB, reject unknown
fields, and are validated before model or executor work.

`POST /architect` accepts a strict versioned architecture job. It returns a candidate IR and a
separate rationale; the Rust control plane remains authoritative and feeds all serde/compiler
diagnostics into a bounded three-attempt repair loop. Invalid proposals are never written as an
accepted IR. `POST /cancel` cooperatively aborts a worker job by its durable effect ID.

Both request types include this context in addition to their route-specific fields:

```json
{
  "protocol_version": 1,
  "job_id": "run-abc:node:build:1",
  "run_id": "run-abc",
  "ir_digest": "<lowercase SHA-256>",
  "base_commit": "<immutable revision>",
  "resource_policy": {
    "timeout_ms": 300000,
    "memory_mb": 1024,
    "cpu_count": 2,
    "pids": 256,
    "network": "model-egress"
  }
}
```

Build policies use `model-egress`; test policies require `none`. Replaying a route and `job_id`
with identical content returns the original result. Reuse with different content returns `409
IDEMPOTENCY_CONFLICT`.

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
  "summary": "…", "error": null, "failure_code": null,
  "artifact": { "sha256": "…", "size": 100, "media_type": "text/plain; charset=utf-8" },
  "usage": { "input_tokens": 0, "output_tokens": 0 } }
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
  "failure_code": null,
  "artifact": { "sha256": "…", "size": 100, "media_type": "application/vnd.foundry.test-result+json" },
  "piston": { "code": 0, "signal": null, "stdout": "…", "stderr": "" }
}
```
A failure entry: `{ "case": "collapse", "expected": "a-b", "actual": "a--b", "error": null }`.

## pi-pool → Piston mapping (`/test`)

1. Canonicalize `workspace`, reject symlinks/escapes, then read `write_target` and declared deps.
2. Select the Python, TypeScript, or Go backend and flatten modules with its file convention.
3. Generate the backend's runner as **files[0]**: evaluate parent-owned cases, collect failures,
   print one sentinel-prefixed JSON verdict, and exit nonzero on failure.
4. `POST http://127.0.0.1:2000/api/v2/execute`
   `{ language, version, files:[runner, ...modules], run_timeout: perf.time_ms ?? 3000, run_memory_limit: perf.mem_mb*1e6 ?? -1 }`.
   `version` resolved from `GET /api/v2/runtimes` (pick the installed one for `language`).
5. Parse `run.stdout` JSON → `TestResult`. Nonzero `run.code` with no parseable summary ⇒ `red` with
   the stderr as the error (covers crashes/timeouts/compile errors).

The backend registry also records immutable Python, Node, and Go OCI image digests. Production Linux
materialization requires a rootless OCI daemon and runs with a read-only root, dropped capabilities,
bounded resources, no network, an isolated attempt mount, and exact-target promotion. macOS
Seatbelt remains a development backend.

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

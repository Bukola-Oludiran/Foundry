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
  "case_results": [ { "name": "spaces", "status": "passed", "failure": null } ],
  "failure_code": null,
  "implementation_evidence": {
    "evidence_version": 1,
    "node_id": "hyphenate",
    "build_run_id": "<run-id>",
    "revision_id": "<studio-revision>",
    "source_snapshot_digest": "…",
    "source_files": [ { "path": "src/string_utils/hyphenate.py", "sha256": "…" } ],
    "symbols": [], "contract_mappings": [], "case_results": [],
    "completeness": "complete", "diagnostics": []
  },
  "artifact": { "sha256": "…", "size": 100, "media_type": "application/vnd.foundry.test-result+json" },
  "piston": { "code": 0, "signal": null, "stdout": "…", "stderr": "" }
}
```
A failure entry: `{ "case": "collapse", "expected": "a-b", "actual": "a--b", "error": null }`.
Implementation evidence is bounded metadata extracted without importing or executing the node source.
It contains public API and module/class/struct state, never source text, values, local variables,
credentials, host paths, or raw command output. Contract mappings are advisory; deterministic
acceptance remains the build gate.

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

## Worker protocol v2 — dependency resolution

IR v1 continues to use `/build` and `/test` unchanged. An IR v2 build first submits
`POST /v2/dependencies/resolve` with a deterministic plan produced by
`foundry-host deps resolve --ir <file> --dry-run`. Without `--dry-run`, the command executes the
configured authenticated resolver. The request binds the job and run identities, IR and plan
digests, immutable base commit, exact platform, and a resolver image pinned by SHA-256. It also
contains only credential-free HTTPS registry origins and a fail-closed license/vulnerability policy.

The worker has no host-package-manager fallback. If an operator has not installed a resolver that
enforces the registry network boundary, it returns `RESOLVER_NOT_CONFIGURED`. A configured resolver
must return native manifest and lockfile, dependency layer, CycloneDX SBOM, license report, and
vulnerability report artifacts. The worker independently verifies every returned package coordinate
and integrity against the accepted plan, rejects undeclared packages or drift, and applies the
license and vulnerability policy before acknowledging the durable effect.

The bundled OCI adapter is enabled only when both `FOUNDRY_RESOLVER_NETWORK` and
`FOUNDRY_REGISTRY_PROXY_URL` are set. The network must already exist with Docker's `Internal` flag;
the proxy URL must contain no credentials. The adapter uses a read-only root, drops all capabilities,
sets no-new-privileges, applies PID/CPU/memory/time/output bounds, mounts the isolated worktree
read-only, and invokes the digest-pinned image without a shell. Set
`FOUNDRY_REQUIRE_PROTOCOL_V2=1` to make worker readiness depend on the resolver, environment
manager, and OCI project runner.

`foundry-host resources plan --ir <file>` emits a digest-bound, deployment-neutral private test
environment plan. It contains logical aliases, exact service versions, consumer permissions,
integration emulator contracts, and migration ownership—never ports, connection strings, or
credentials. Runtime credentials belong only to the `EnvironmentManager` secret boundary.

An operator-supplied `EnvironmentManager` is available through idempotent worker protocol v2
routes for `start`, `health`, `migrations`, `snapshot`, and `teardown`. Start requests must exactly cover each
logical service with digest-pinned images and declare `private-integration` networking; the accepted
plan itself always says `network_egress: none`. Manager responses are checked against the durable
run, environment, and plan identities, and undeclared aliases or incomplete cleanup fail closed.
`foundry-host resources test --ir <file>` exercises this lifecycle when
`FOUNDRY_RESOURCE_IMAGES_JSON`, `FOUNDRY_EMULATOR_IMAGE`, and an authenticated worker are configured.
Declared migrations run between health and snapshot. Their request is workspace-contained and bound
to the exclusive schema owner; green evidence must cover every migration digest and prove repeat
application whenever the IR mandates it. Teardown is attempted after every verification outcome.

Set `FOUNDRY_ENVIRONMENT_MANAGER_URL` and `FOUNDRY_ENVIRONMENT_MANAGER_TOKEN` together to enable the
built-in controller adapter. Non-loopback controllers require HTTPS; URLs containing credentials,
queries, or fragments are rejected. The bearer token must contain at least 32 characters and stays
inside the worker process. Controller responses are bounded to 1 MiB and upstream error bodies are
never copied into worker errors. The controller is an operator deployment boundary: Foundry does
not mount a Docker socket into ordinary worker jobs.

Protocol v2 `/build` and `/test` requests extend the unchanged v1 contracts with a verified
dependency-layer reference, or `null` for a node that declares no packages. Builds additionally carry node-scoped resource and integration
bindings plus opaque secret handles. Tests carry either no environment with `network=none`, or an
exact environment/snapshot reference with `network=private-integration` and an explicit migration
phase. All nested fields are strict and bounded; dependency digests, pinned resolver images, safe
paths, logical aliases, permissions, environment-variable names, and opaque handles are validated
before execution.

Set `FOUNDRY_PROJECT_RUNNER_URL` and `FOUNDRY_PROJECT_RUNNER_TOKEN` together to enable the
authenticated project-test boundary. Non-loopback runners require HTTPS and the token must contain
at least 32 characters. Protocol v2 tests never fall back to Piston or host-local execution when
this boundary is absent. The operator runner retrieves the exact content-addressed dependency
layer, mounts it read-only, joins only the requested internal environment network (or no network),
applies the requested resource limits, and returns bounded structured evidence. Foundry verifies
run, job, node, dependency, environment snapshot, base commit, semantic digest, source hashes, and
named-case coverage. Unknown fields, absolute paths, secrets, and raw process output fail closed
before persistence.

For IR v2, `foundry build` requires local durability. Its preflight node commits dependency
resolution, environment start/health, migration, and snapshot operations as stable idempotent
effects before admitting implementation nodes. Node requests receive only their package root,
resource/integration bindings, logical secret handles, and the exact environment snapshot.
Successful and failed builds tear down an environment through the same durable effect boundary;
host cancellation reconciliation remains pending.

An IR v2 repository build also materializes `.foundry/resources/manifest.json` and
`.foundry/resources/docker-compose.yml` in its isolated attempt worktree. The JSON manifest carries
only deployment-neutral resource policy and logical secret-provider references. Compose publishes
no host ports, marks its shared network internal, applies read-only/capability restrictions, and
requires image values through operator environment variables; it never embeds credentials or
deployment endpoints.

Architecture Studio stores IR v1 and IR v2 as explicit versioned documents. Existing v1 semantic
edits remain at `POST /v1/studios/:run_id/commands`. IR v2 package, resource, integration,
secret-reference, binding, migration, and test-environment edits use
`POST /v2/studios/:run_id/commands`. Both routes require an idempotency key and expected proposal
head. The v2 route requires human edit authority, compiles the complete candidate before writing an
immutable revision artifact, and never converts the document through an IR v1 core.

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

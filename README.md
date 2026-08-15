# Foundry

An **agentic software-engineering organization** built on GraphReact.
An *architecture role* (an LLM agent) emits a formal recursive **IR** describing a software
architecture; that IR **deterministically compiles** to a dependency graph; each node is owned by a
**dyad** — a *doer* that implements it and an independent *tester* that verifies it against a
parent-owned contract — and the software is built **bottom-up**, each node gated by an executable
oracle (Piston). When a node cannot satisfy its contract, its **manager re-architects that subtree**
(OTP-style supervision). The failure signal always names its owner.

## Two planes

- **Control plane — GraphReact (Rust).** Who runs when, the ownership tree, supervision,
  telemetry, message-permissions, contracts. The org.
- **Data plane — sandboxed pi workers.** The actual source files, written by external
  pi (Node/TS) agents, each scoped by an OS sandbox to a read-set +
  write-target. One agent's turn.

> pi = substrate for one agent's turn; GraphReact = substrate for the org.

Foundry's value is the organization around the models: contract-driven decomposition, independent
verification, scoped work, durable recovery, controlled repair, reproducible evidence, and
human-reviewed delivery. See [Why Foundry](docs/why-foundry.md) for the product rationale and the
boundary between a coding agent and a recoverable software-building organization.

## Org concept → GraphReact primitive (v1)

| Org concept | GraphReact primitive |
|---|---|
| Ownership tree | composition/spawn tree (`GraphDirectory::find_in_subtree`, `ctx_spawn_child`) |
| Manager → re-architecture | OTP supervision (`supervise(ChildSpec)`, `SuperviseDecisionHook`) |
| Accountability signal | monitors/links (`__DOWN__`/`__EXIT__`) |
| Interface-visibility scope | `PermissionManifest{accepts,emits,...}` (enforced in `Scheduler::deliver`) |
| FS read/write scope | **OSS OS-sandbox** around the pi worker (rootless OCI / Seatbelt) — *not* GraphReact |
| Bottom-up order | explicit **deps-ready** message gating (not `register_node` height — dynamic children default to height 0) |
| Dependency DAG | app-level directed adjacency (+ reverse); `graphreact-algorithms::dag` for order/cycle-check |
| Executable oracle | **Piston** (configured through `PISTON_URL`) |
| Audit trail | `TelemetrySink` → `/v1/observer/events.sse` |

## Layout

```
Foundry/
  ir/          the recursive dyad IR: schema, examples, docs   ← keystone (start here)
  gr-host/     Rust compiler and GraphReact control-plane host
  pi-pool/     Node/TS worker plane: build, test, LLM, and isolation
  src/mcp/     workspace-scoped MCP façade over the durable Rust host
  plugins/     repo-local Codex plugin and Foundry workflow skills
  docs/        contracts (GR-host ↔ pi-pool HTTP), notes
```

## External dependencies

- **pi-ai** — the locked LLM provider adapter used by the worker pool.
- **Piston** — the executable oracle, reachable through `PISTON_URL`.
- **GraphReact** — the Rust runtime used by the control-plane host, pinned to an exact Git revision
  in `gr-host/Cargo.toml`.

## Development

Install and run the reproducible checks from the repository root:

```bash
make install
make check
```

The first control-plane commands are available directly from the host binary:

```bash
cargo run --manifest-path gr-host/Cargo.toml -- validate --ir ir/examples/string-utils.ir.json
cargo run --manifest-path gr-host/Cargo.toml -- architect \
  --spec product.md --output proposed.ir.json --repo . --base HEAD
cargo run --manifest-path gr-host/Cargo.toml -- build \
  --ir ir/examples/string-utils.ir.json --dry-run
cargo run --manifest-path gr-host/Cargo.toml -- rearchitect \
  --ir accepted.ir.json --proposal proposed.ir.json --node failing-node \
  --reason "acceptance failures exhausted repair" --output structural-diff.json
# Add --execute together with --repo, --base, --workspace, --durability-dir, and --promote
# to run only the calculated affected closure and promote the IR after a green durable run.
cargo run --manifest-path gr-host/Cargo.toml -- publish \
  --run <durable-run-id> --durability-dir <run-store> \
  --repo <worktree> --base main --ir accepted.ir.json --draft-pr --summary review.md
```

`architect` calls the authenticated worker, retries invalid proposals with exact Rust compiler
diagnostics, and writes the rationale beside the IR as `proposed.ir.json.rationale.md`.

`make test-local` additionally exercises the available host sandbox and live worker server. See
[`docs/M5-activation.md`](docs/M5-activation.md) for a provider-backed run.

The current implementation status and remaining acceptance gates live in one place:
[`docs/roadmap.md`](docs/roadmap.md).

## MCP access

Build the Rust host, install the locked root dependencies, and configure one or more opaque
workspace IDs:

```bash
cargo build --manifest-path gr-host/Cargo.toml --locked
npm ci
export FOUNDRY_WORKSPACE_ROOTS="foundry=$(pwd)"
npm run mcp:stdio
```

The stdio server exposes `foundry_validate`, `foundry_architect`, `foundry_build`,
`foundry_status`, `foundry_cancel`, `foundry_rearchitect`, and `foundry_publish`. Tool calls accept
only a configured workspace ID and relative paths. The server never exposes the absolute root as
an MCP resource, and build/status/cancellation/publication all use the existing GraphReact local
durability directory.

The architect-critic extension adds `foundry_begin_architecture_review`,
`foundry_revise_architecture_draft`, `foundry_submit_architecture_review`, and
`foundry_architecture_status`. Candidate revisions and reviews are immutable GraphReact artifacts;
revision updates use compare-and-swap, retries use operation keys, and the author context cannot
approve its own draft. Status returns the verified candidate IR so the critic reviews the artifact
bound to that revision instead of a mutable working-tree copy.

The repo-local Codex plugin is in `plugins/foundry`. Its skills read their canonical workflow from
the MCP server so tool and prompt guidance remain aligned. `FOUNDRY_HOST_BIN` may override the
default `gr-host/target/debug/foundry-host` binary path. Provider and publishing credentials remain
environment-only; they are never accepted as tool arguments.

Claude Code discovers the checked-in project-scoped `.mcp.json`. Build the host and run
`claude mcp get foundry`; the result should report a connected project server. First-use approval,
workspace overrides, verification, and troubleshooting are documented in
[`docs/claude-code.md`](docs/claude-code.md).

MCP uses the host's versioned JSON-lines sidecar by default. The sidecar accepts only the eleven
declared operations, returns structured run/status/publication fields, and restarts on the next
request after an unexpected exit. MCP request aborts are correlated to the active sidecar command
and terminate that command; they do not replace the durable `foundry_cancel` operation for stopping
a run. `FOUNDRY_HOST_TRANSPORT=direct` is available only as a development diagnostic fallback.

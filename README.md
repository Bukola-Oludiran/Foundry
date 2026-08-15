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

## Org concept → GraphReact primitive (v1)

| Org concept | GraphReact primitive |
|---|---|
| Ownership tree | composition/spawn tree (`GraphDirectory::find_in_subtree`, `ctx_spawn_child`) |
| Manager → re-architecture | OTP supervision (`supervise(ChildSpec)`, `SuperviseDecisionHook`) |
| Accountability signal | monitors/links (`__DOWN__`/`__EXIT__`) |
| Interface-visibility scope | `PermissionManifest{accepts,emits,...}` (enforced in `Scheduler::deliver`) |
| FS read/write scope | **OSS OS-sandbox** around the pi worker (Seatbelt / Landlock+seccomp) — *not* GraphReact |
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

`make test-local` additionally exercises the available host sandbox and live worker server. See
[`docs/M5-activation.md`](docs/M5-activation.md) for a provider-backed run.

The current implementation status and remaining acceptance gates live in one place:
[`docs/roadmap.md`](docs/roadmap.md).

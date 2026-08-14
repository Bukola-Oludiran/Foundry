# Foundry

Foundry is an MCP-native, server-authoritative software-engineering engine. Connected clients
(Codex, Claude Code, Gemini CLI, and custom MCP hosts) supply model intelligence; Foundry owns the
architecture IR, authorization, deterministic compilation, GraphReact scheduling, sandboxed
execution, immutable history, diagrams, activation, and repository publication.

```text
MCP client → Hephaestus Core → Architecture IR v4 → UML/Excalidraw
           → GraphReact build → private attempt → Piston verdict + mutation
           → repository assembly → reproducibility replay
           → immutable activation → confirmed Git publication
```

## MCP quick start

```bash
npm install
cargo build --manifest-path gr-host/Cargo.toml --bin foundry-engine-sidecar

FOUNDRY_DATA_DIR=/tmp/foundry-data \
FOUNDRY_WORKSPACE_ROOTS=workspace=/path/to/allowed/root \
npm run mcp:stdio
```

Configure the MCP host to launch `npm run mcp:stdio` with its working directory set to this
directory. The server negotiates both MCP `2026-07-28` and the `2025-11-25` compatibility era.
For hosted use, run `npm run mcp:http` with OIDC configuration; the local static bearer mode is
intended only for development. See [the MCP product reference](docs/mcp.md).

Canonical workflows are exposed as both MCP prompts and `foundry://workflows/{workflowId}`
resources. The repo-local Codex plugin at `plugins/foundry` supplies workflow skills that read those
resources when the client does not expose MCP prompt invocation to the agent.

> Working name — a top-level directory, trivially renameable.

The underlying build model remains an **agentic software-engineering organization** built on GraphReact.
An *architecture role* (an LLM agent) emits a formal recursive **IR** describing a software
architecture; that IR **deterministically compiles** to a dependency graph; each node is owned by a
**dyad** — a *doer* that implements it and an independent *tester* that verifies it against a
parent-owned contract — and the software is built **bottom-up**, each node gated by an executable
oracle (Piston). When a node cannot satisfy its contract, its **manager re-architects that subtree**
(OTP-style supervision). The failure signal always names its owner.

## Product and execution planes

- **Product boundary — MCP façade (TypeScript).** Tools, resources, prompts, authorization,
  SQLite history, content-addressed artifacts, Hephaestus Core, diagram projections, leases, and
  confirmed publication.
- **Engine authority — Rust sidecar.** IR compilation, dependency/ownership invariants, build state,
  invalidation, retries, and cancellation. The legacy CLI uses the same engine.
- **Execution worker — `pi-pool`.** Provider-free scoped change application plus deterministic
  local/Piston tests. The old provider builder is available only when
  `FOUNDRY_ENABLE_LEGACY_PROVIDER=1`.

- **Control plane — GraphReact (Rust).** Who runs when, the ownership tree, supervision,
  telemetry, message-permissions, contracts.
- **Data plane — sandboxed workers.** Actual source files, written only through compiler-issued
  target IDs and digest-bound leases.

> pi = substrate for one agent's turn; GraphReact = substrate for the org.

## Org concept → GraphReact primitive (v1)

| Org concept | GraphReact primitive |
|---|---|
| Ownership tree | one installed `Supervisor` per manager; every dyad mounted with `supervise(ChildSpec)` |
| Manager → re-architecture | `SuperviseDecisionHook` parks exhausted failures for M4 subtree replacement |
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
  src/         MCP façade, commands, persistence, projections, transports
  plugins/     Codex plugin and promptless-client workflow skills
  ir/          the recursive dyad IR: schema, examples, docs   ← keystone (start here)
  gr-host/     Rust engine, JSON-RPC sidecar, and legacy GraphReact CLI
  pi-pool/     provider-free apply/test worker + legacy control builder
  deploy/      local Piston and deterministic Keycloak test deployments
  docs/        contracts (GR-host ↔ pi-pool HTTP), notes
```

## External dependencies

- **MCP client** — owns model intelligence in the normal product path.
- **pi-ai** — retained only for the explicitly enabled legacy/control builder.
- **Piston** — the executable oracle, reachable through `PISTON_URL`.
- **GraphReact** — the private Rust runtime used by the control-plane host. The current Cargo
  workspace expects it as a sibling checkout; its source is intentionally not included here.

## Status

Foundry's adopted architectural direction is the
[recursive product-composition model](docs/product-composition-model.md): architect a product
top-down as an ownership tree with scoped dependency DAGs, then implement and verify it bottom-up
through an integration gate at every composite boundary.

The MCP-native vertical slice is implemented: compatible IR v2/v3 readers, typed IR v4,
deterministic UML/Excalidraw projections,
adaptive Hephaestus Core review, SQLite revision history, Rust sidecar build state, provider-free
node leases with durable build overlays, immutable subtree proposals, two-step activation, and
confirmed Git publication of complete architecture packages and optional all-green build output.
The legacy M3 GraphReact CLI remains available as a compatibility control. Piston must be running
to execute the separate external-oracle suite (`npm run test:piston`).
New code publication requires IR v4, typed acceptance, evidence v2, live Piston verification, and
two matching clean assembly executions. Node submissions verify in private overlays; authored red,
contract weakness, infrastructure failure, and cancellation are separate outcomes. Python-library
and locked Python-service profiles build/install wheels outside the source tree. The service profile
also validates typed HTTP behavior, tenant isolation, concurrency, SQLite schema persistence,
restart recovery, and clean shutdown. Mutation testing defaults to `FOUNDRY_MUTATION_MODE=shadow`;
`enforce` applies the 0.80 non-waivable publication threshold.

Recursive product IR v5 is available for certification with
`FOUNDRY_PRODUCT_IR_V5=enabled`. Its nested composition tree is canonical; scoped execution DAGs,
client implementation work, system-owned composite integration, hierarchical evidence, and
deliverables are derived. V5 production verification requires the pinned `foundry-product` Piston
runtime and never falls back to local execution. Legacy v2–v4 revisions stay on their frozen paths.

`foundry_get_system_health` reports worker/Piston readiness, queue and lease state, failure classes,
artifact integrity, and toolchain identity. Hosted HTTP uses discovery-backed OIDC/JWKS validation;
the pinned Keycloak realm under `deploy/keycloak` is the deterministic integration fixture.
Confirmed repository publication is journaled through a durable outbox. If the façade stops after
the exact prepared Git commit but before consuming its confirmation token, a retry verifies the
commit marker and every prepared file digest before completing the SQLite transaction.

The remaining work required before claiming reliable complex-software delivery is tracked in
[Outstanding trustworthy-delivery certification](docs/outstanding-certification.md). The original
[Foundry hardening gaps](docs/hardening-gaps.md) remain as the historical LedgerForge gap record.

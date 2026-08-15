# Foundry implementation tracker

This is the canonical status document. A milestone is complete only when its acceptance gates are
automated and green on a clean checkout.

## M1 — reproducible foundation

Status: implemented; CI confirmation pending on the first pushed revision.

- GraphReact dependencies are pinned to a compatible Git revision.
- IR v1 parsing is strict and compilation rejects unsafe paths, unsupported languages, ambiguous
  operations, malformed tests, invalid ownership, and invalid dependency graphs.
- Node and Rust dependencies are locked. `make check` is the unified local gate.
- CI covers formatting, strict Clippy, Rust tests, TypeScript checks, schema validation, and the
  deterministic runner fixture.

## M2 — secure polyglot worker plane

Status: implemented; CI confirmation pending on the first pushed revision.

- Language backend registry for Python, TypeScript, and Go.
- Bounded multi-turn doer loop.
- Authenticated, validated worker protocol with stable job identities.
- Rootless OCI isolation on Linux and Seatbelt development isolation on macOS.
- Attempt worktrees and content-addressed result artifacts.

## M3 — durable supervised builds

Status: in progress; the crash-recovery execution slice is implemented.

- Implemented: one GraphReact local durable run per build, durable keyed state, scheduler-message
  dependency gating, persisted worker effects, GraphReact artifacts, exact ownership supervision,
  bounded repair decisions, snapshots, terminal recovery, and disk-backed worker job idempotency.
- Verified: an authenticated OCI-isolated four-node workflow reaches green, writes a verified
  snapshot, and a second host process recovers the succeeded run without rebuilding it.
- Implemented cancellation slice: an idempotent filesystem request is accepted while the daemon is
  live or stopped, GraphReact records cancellation before closing run admission, and the worker has
  an authenticated cooperative cancellation endpoint. Existing artifacts are retained.
- Implemented crash acceptance: subprocess kills after activation, before/after effect dispatch,
  after result application, and after the terminal commit all recover the same one-node run green.
  This matrix runs in OCI isolation in CI.
- Remaining: process-level interruption of synchronous local/OCI runners and binding repository/
  worktree operations themselves as GraphReact durable effects.

## M4 — spec-to-IR architecture

Status: in progress; strict request and bounded proposal repair are implemented.

- Implemented: versioned strict `ArchitectureRequest`, authenticated architecture-worker surface,
  separate rationale output, three-attempt schema/compiler diagnostic repair, and fail-closed output.
- Implemented: `validate` and `architect` control-plane commands plus shared-provider lowest-common-
  owner placement validation.
- Implemented compiler closure: shared interfaces must equal the explicit union of operations their
  consumers require, preventing unused/internal operations from leaking through shared contracts.
- Remaining: repository-aware context, status command consolidation, durable architecture
  artifacts, and an end-to-end provider-backed representative-spec suite.

## M5 — genuine scoped rearchitecture

Status: in progress; the versioned boundary and structural-diff validator are implemented.

- Implemented: accepted-revision digest binding, explicit target/reason/failure/boundary request,
  full proposed-IR compilation, stable target interface and parent mandate checks, out-of-scope
  byte-structural equality, affected consumer closure, and a persisted JSON structural diff.
- Implemented execution: `rearchitect --execute` starts the proposal at an immutable Git base,
  durably rebuilds only the replacement and transitive consumers, restricts the final diff to that
  closure, and atomically promotes the IR only after the scoped run reaches green. Failed proposals
  leave the accepted IR untouched and keep their diagnostics/artifacts in the run store.
- Implemented generation: `rearchitect --generate` sends the accepted IR, exact boundary, reason,
  and persisted failure history to the architecture worker; out-of-scope proposals receive exact
  revision diagnostics in the bounded repair loop and are never staged.
- Remaining: add the full sibling-byte-identity end-to-end fixture across generation, rebuild, and
  promotion.

## M6 — Git review delivery

Status: in progress; isolated worktrees, guarded commits, and draft-only publication are implemented.

- Implemented: replaceable repository/publisher traits, immutable-base per-run worktrees and
  `foundry/<run-id>` branches, repository-configured commit identity, IR write-scope checks, and
  fail-closed secret/symlink/binary/size checks.
- Implemented: durable status verification before publication and idempotent GitHub draft lookup,
  push, and creation. There is deliberately no approve, merge, force-push, or base mutation path.
- Remaining: generate the complete evidence-rich review summary from durable artifacts, bind Git
  prepare/commit/publish themselves as durable effects, and add a GitHub fixture acceptance test.

## Deferred

- Hosted multi-tenancy, quotas, billing, and fleet scheduling.
- Postgres/S3 active-passive failover.
- Autonomous approval or merge.
- Languages beyond Python, TypeScript, and Go.

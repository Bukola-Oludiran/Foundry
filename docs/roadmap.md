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

Status: next.

- Language backend registry for Python, TypeScript, and Go.
- Bounded multi-turn doer loop.
- Authenticated, validated worker protocol with stable job identities.
- Rootless OCI isolation on Linux and Seatbelt development isolation on macOS.
- Attempt worktrees and content-addressed result artifacts.

## M3 — durable supervised builds

Status: planned.

- One GraphReact local durable run per build.
- Durable worker/Git effects, build artifacts, cancellation, and restart recovery.
- Real GraphReact ownership supervision and manager decisions.
- Scheduler messages replace the synchronous generation loop.

## M4 — spec-to-IR architecture

Status: planned.

- Versioned architecture request and bounded validation-repair loop.
- Shared-node LCA placement and interface-union validation.
- Architecture, validation, dry-run, and build control-plane commands.

## M5 — genuine scoped rearchitecture

Status: planned.

- Versioned subtree replacement with a stable boundary interface.
- Structural scope checks and affected-closure rebuild.
- Promote only a fully green proposed IR revision.

## M6 — Git review delivery

Status: planned.

- Isolated run worktrees and repository-provider boundary.
- Scope/secret/binary checks, intentional commits, and review summaries.
- Idempotent draft GitHub pull requests; Foundry never approves or merges.

## Deferred

- Hosted multi-tenancy, quotas, billing, and fleet scheduling.
- Postgres/S3 active-passive failover.
- Autonomous approval or merge.
- Languages beyond Python, TypeScript, and Go.

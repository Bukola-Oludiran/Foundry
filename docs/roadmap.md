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
- Implemented cancellation-time environment reconciliation: `cancelling` is durably recorded
  before action, pending worker effects receive idempotent cooperative cancellation, an ambiguously
  dispatched environment start is resolved with its original effect ID, and terminal `cancelled`
  is withheld until teardown completion and bounded evidence are committed. Cleanup resumes from a
  crash-safe journal without changing the authoritative GraphReact run/artifact history.
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
- Implemented review evidence: publication binds the specification, accepted IR digest, exact
  base/head commits, terminal result, attempts, artifact names/media/sizes/hashes, operator notes,
  and residual human-review risk in the draft body.
- Remaining: bind Git prepare/commit/publish themselves as durable effects and add a GitHub fixture
  acceptance test.

## MCP integration

Status: first durable-host façade implemented; richer project authoring remains pending.

- Implemented: stdio MCP tools for validate, architect, durable build, status, cancellation,
  scoped rearchitecture, and draft-only publication.
- Implemented: opaque configured workspace IDs, relative-path containment, symlink-escape refusal,
  shell-free Rust host invocation, workflow resources/prompts, and a validated repo-local Codex
  plugin.
- Preserved: GraphReact persistence remains authoritative for build state, effects, artifacts,
  cancellation, and publication eligibility. The alternate branch's SQLite build authority and
  in-memory scheduler sidecar were intentionally not imported.
- Implemented: a versioned, allowlisted JSON-lines Rust sidecar with structured run, status, and
  publication results; the MCP client supervises and restarts it without introducing another
  persistence authority.
- Implemented: MCP abort signals use correlated sidecar cancellation messages to terminate the
  matching active host command. This transport cleanup is intentionally separate from durable run
  cancellation, which remains an explicit, monotonic GraphReact operation.
- Implemented: checked-in Claude Code project discovery with a credential-free `.mcp.json`, a
  protocol-clean launcher, configuration tests, and a native Claude Code connection health check.
- Implemented: the first durable collaborative architecture mode (`architect-critic`), including
  immutable candidate/review artifacts, independent MCP context enforcement, revision CAS,
  replay-safe operation keys, changes-requested repair, and approval immutability.
- Remaining: richer architecture project resources and the separately versioned recursive product
  IR.

## Architecture Studio and Buzz embedding

Status: editable preview implementation.

- Implemented: versioned bindings, revisions, proposal branches, presentation-only layouts,
  boundary locks, deterministic commands, full-IR compilation, semantic CAS, idempotent mutation,
  generated subtree repair, independent exact-digest critique, signed human approval, promotion,
  durable build handoff, canonical worktree materialization, and recovery of proposal heads.
- Implemented: single-community HTTP service, NIP-98 session exchange and replay rejection,
  memory-only scoped capabilities, relay-verified kind `46011` approvals, lifecycle kinds
  `43001–43006`, artifact projections, run status/cancellation/artifacts/SSE, and stable error codes.
- Implemented in Buzz: preview-gated Architecture project tab, deep links, C4/UML projections,
  ELK layout, typed semantic edits, proposal review, locks, approval/build gates, offline verified
  projections, and a credential-isolating Tauri bridge.
- Implemented inception: an empty repository Studio accepts a product specification, runs the
  bounded architecture agent, compiles the complete IR, persists the initial proposal, and obtains
  an independent critic verdict before returning the first editable projection.
- Implemented delivery: terminal green builds invoke the idempotent draft-only publisher, attach
  proposal/review/approval/diff evidence, and durably advance the revision to `delivered` only after
  publication succeeds.
- Implemented acceptance foundation: the desktop E2E harness persists exact proposal state across
  reload and exercises initial architecture, deep links, dependency drawing, conflict recovery,
  semantic editing, branching, generative repair with independent critique, human approval, build
  submission, and cancellation. Foundry also injects the artifact-written/head-uncommitted crash
  boundary and proves recovery plus idempotent retry.
- Implemented multi-human approval acceptance: promotion counts distinct eligible signers for the
  exact semantic digest, duplicate approvals from one signer cannot satisfy a protected-branch
  threshold, approval progress survives restart, and Build remains gated until the threshold is met.
- Implemented Foundry side of Buzz-managed intelligence: a provider-neutral `AgentRuntime` routes
  both initial and generative architect/critic jobs to the existing pi-pool adapter or a versioned
  Buzz ACP submit/status/cancel protocol. Stable IDs survive polling/retry, responses fail closed on
  identity mismatch, and architect/critic runtime identities must remain independent.
- Buzz now supplies a runnable authenticated gateway, transport-neutral durable job ledger, and
  bounded ACP executor. It enforces role-scoped identities, request-digest idempotency, exclusive
  durability ownership, restart recovery, immutable terminal results, rejected tool permissions,
  explicit child environments, and strict JSON output.
- Implemented durable Architecture Room foundation: asynchronous initial operations, hash-chained
  proposal transcripts, authenticated cursor/SSE recovery, curated ACP lifecycle/plan/tool events,
  compiler diagnostics, three-round architect–critic repair, monotonic cancellation, acknowledged
  immediate steering with checkpoint fallback, structured question/answer resumption, and Buzz
  timeline/filter/reconnect/offline projections.
- Implemented proposal-scoped asynchronous generative edits and explicit architect-assisted rebase
  rooms. Rebase creates a linked branch from the current approved proposal, preserves the stale
  proposal as evidence, and uses compare-and-swap head digests. Room histories are additionally
  paged into immutable GraphReact artifacts with a transcript index committed in Studio state.
- Remaining for the ACP path: issue short-lived workload capabilities from Buzz's NIP-98 community
  session, resolve current repository authority, and add OCI isolation.
- Remaining before public release: exhaustive desktop Playwright/crash-matrix acceptance.

## Deferred

- Hosted multi-tenancy, quotas, billing, and fleet scheduling.
- Postgres/S3 active-passive failover.
- Autonomous approval or merge.
- Languages beyond Python, TypeScript, and Go.

## External dependencies, resources, and integrations

Status: foundation and worker execution boundaries implemented; durable build orchestration remains in progress.

- Implemented: strict IR v2 alongside unchanged IR v1, covering exact package roots/dependencies,
  PostgreSQL, Redis, S3, NATS, SMTP, OIDC, HTTP/webhook/payment/model integrations, logical secret
  references, bindings, fixtures, seeds, expectations, and migration checks.
- Implemented compiler policy: safe paths, exact versions and integrity, ecosystem ownership,
  credential-free registries, kind-specific resource configuration, migration exclusivity,
  least-privilege permission compatibility, secret-literal rejection, declared integration use,
  bounded retry/rate limits, and mandatory payment idempotency.
- Implemented deterministic dependency and private-environment plans, semantic digests, strict JSON
  Schema validation, CLI `deps resolve`, `deps audit`, and `resources plan`, plus a representative
  TypeScript/PostgreSQL/payment fixture.
- Implemented worker protocol v2 resolution contracts, strict request containment, pinned resolver
  image enforcement, durable job idempotency through the existing worker ledger, and fail-closed
  verification of lock, layer, SBOM, license, and vulnerability evidence. No unsafe host resolver
  fallback exists.
- Implemented environment lifecycle boundaries and authenticated worker routes for start, health,
  migration, snapshot, and teardown. Responses are plan/run bound; migration ownership,
  repeatability evidence, private aliases, pinned images, and complete cleanup fail closed.
- Implemented the concrete OCI resolver adapter: it requires an internal Docker network and a
  credential-free registry proxy, invokes a digest-pinned image without a shell, and applies a
  read-only root, non-root identity, dropped capabilities, no-new-privileges, resource/time/output
  bounds, and a read-only worktree mount.
- Implemented an authenticated HTTPS/loopback adapter for an operator-owned Docker environment
  controller, including bounded responses, abort/timeout propagation, readiness gating, and
  credential-free error surfaces. Worker protocol v2 `/build` and `/test` now strictly accept and
  validate dependency layers, resource/integration bindings, secret handles, environment snapshots,
  and migration phase while preserving strict v1 behavior.
- Implemented durable IR v2 build orchestration: `build` compiles either explicit IR version,
  resolves packages, starts and health-checks the declared private environment, applies migrations,
  snapshots it, gates node admission on the verified preflight, binds exact dependency/environment
  identities into worker v2 requests, persists phase evidence, and tears the environment down on
  green, node failure, or preflight failure. Every lifecycle call is an idempotent GraphReact effect.
- Implemented the fail-closed OCI project-runner boundary. V2 tests cannot use the local/Piston
  fallback; an authenticated HTTPS/loopback runner must acknowledge readiness. Results bind to the
  exact job, run, node, dependency layer, environment snapshot, semantic/base revision, source
  hashes, and acceptance cases, with strict bounds and redaction before durable replay.
- Implemented deterministic generated resource output in the isolated run worktree:
  `.foundry/resources/manifest.json` preserves the deployment-neutral plan and logical secret
  bindings, while `docker-compose.yml` uses digest-image environment references, an internal-only
  network, read-only services, dropped capabilities, and no published host ports or credentials.
- Implemented recovered dependency-evidence materialization in the isolated run worktree. A green
  durable build writes `.foundry/dependencies/resolution.json` containing only the strict verified
  resolution result and content-addressed artifact metadata; incomplete results, unknown fields,
  and resolver errors fail closed before Git validation.
- Implemented native dependency-file retrieval and promotion. The pinned resolver writes
  content-addressed artifacts through a dedicated writable mount; the authenticated worker route
  serves only bounded regular files whose bytes match their requested digest. The host verifies
  transport and per-file hashes, accepts exact multi-root manifest/lockfile bundles, rejects unsafe
  paths and secret-shaped content, preserves matching repository files, and refuses conflicts.
- Implemented recovered resource-lifecycle evidence materialization. Health, required migration,
  snapshot, and teardown records are committed as durable scheduler state, verified to share one
  exact environment/plan identity, bounded and redacted, then recovery-safely written to
  `.foundry/resources/evidence.json`. Non-green, incomplete, unknown-field, secret-shaped, or
  conflicting replay output fails closed before Git validation.
- Implemented the IR v2 Studio semantic-edit boundary: complete typed package, resource,
  integration, secret-reference, binding, migration, and test-environment declaration batches are
  compiler-checked atomically, respect node boundary locks, change the semantic digest, and produce
  a deterministic rebuild closure. Buzz has matching version-discriminated models, node badges,
  and read projections for these contracts without reinterpreting IR v1.
- Implemented durable Studio persistence and authenticated HTTP wiring for IR v2. Revision
  artifacts retain the exact explicit document version, proposal CAS and idempotency receipts cover
  external-contract edits, compiler rejection leaves the head unchanged, and only a human edit
  capability may call `POST /v2/studios/:run_id/commands`. Existing v1 commands remain on their
  original route and reject v2 proposals explicitly rather than discarding declarations.
- Remaining: deployable resolver, runner, and controller images,
  the concrete Docker controller/emulator service itself, contract-test/resource-usage evidence
  linkage, and the broad
  polyglot restart acceptance fixture. Buzz now has
  typed package-root, declaration, binding, secret-reference, fixture, seed, and contract-
  expectation mutation forms plus dedicated managed-resource and third-party integration graph
  projections. IR v1 never projects ordinary dependencies into those views.

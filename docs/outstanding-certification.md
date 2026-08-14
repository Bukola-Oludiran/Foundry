# Outstanding trustworthy-delivery certification

Status: open work as of 2026-08-13.

This document lists the work that remains before Foundry may claim reliable complex-software
delivery. It is intentionally separate from the historical gap inventory: implemented foundations
are not counted as certified until the corresponding failure and interoperability gates pass.
The execution model for future work is defined by the
[recursive product-composition model](product-composition-model.md).

## Exit condition

Foundry may claim `complex-software certified` only when every item in this document is complete
and at least two independent MCP clients complete the held-out portfolio without a false-green
build, lost infrastructure failure, incomplete evidence, sandbox escape, tenancy violation, or
publication-integrity failure.

## 1. Persistence and crash consistency

Current foundation: checksummed SQLite migrations, verification journal, transactional node
overlays, atomic artifact writes, backup/restore, quarantine GC, and a recoverable Git publication
outbox.

Outstanding work:

- add model-based tests for the complete TypeScript, SQLite, Rust, worker, and Piston state machine;
- inject failures after every multi-file write, artifact link, verdict transition, activation,
  evidence write, outbox transition, Git staging, and Git commit boundary;
- prove cancellation is terminal and late or duplicate lease results cannot advance a build;
- prove restart recovery is equivalent to uninterrupted execution;
- schedule and observe periodic artifact scrubbing and reachability-based garbage collection;
- run operator-grade backup, restore, missing-artifact, and corrupt-database recovery drills.

Acceptance gate: no injected crash may produce partial accepted targets, mixed revisions, orphaned
green state, missing evidence, or an ambiguous publication result.

## 2. Hosted identity and hostile-input certification

Current foundation: discovery-backed OIDC/JWKS verification, OAuth protected-resource metadata,
scope and tenant validation, context-bound leases, and a deterministic Keycloak fixture.

Outstanding work:

- run the live Keycloak suite on a host with enough container memory;
- test signing-key rotation, JWKS cache expiry, provider outage, revoked users, reduced scopes,
  unknown tenants, `nbf`, audience/resource mismatches, and authorized-party mismatches;
- certify symlink, hard-link, traversal, malicious archive, package-metadata, and renderer inputs;
- test environment, credential, Git metadata, and host-file exfiltration attempts;
- test process/fork leaks and CPU, memory, disk, file-count, and output exhaustion;
- test cross-tenant and cross-build access for tools, resources, artifacts, leases, reviews,
  events, and confirmations.

Acceptance gate: zero authentication, tenancy, sandbox, or publication-integrity failures across
stdio and hosted Streamable HTTP.

Operational blocker: the current Docker VM has approximately 2 GB available and could not keep
the Keycloak fixture alive alongside the existing local services. The fixture itself is checked in;
the live gate must run on a larger Docker host or after an explicitly approved resource change.

## 3. MCP client resilience matrix

Run identical fixtures through Codex CLI, Claude Code, and Gemini CLI. Record `pass`, `fail`, or
`unsupported_by_client` with transcript and artifact digests. `unsupported_by_client` is allowed
only for optional prompt or sampling capabilities when the complete manual/resource fallback is
proven. It is not allowed for security, state integrity, cancellation, or publication.

| Capability | Codex CLI | Claude Code | Gemini CLI |
| --- | --- | --- | --- |
| stdio discovery and tool execution | pending certification | pending | pending |
| Streamable HTTP and protocol negotiation | pending | pending | pending |
| resources and large artifact links | pending | pending | pending |
| prompt invocation or workflow-resource fallback | pending certification | pending | pending |
| malformed calls and structured errors | pending | pending | pending |
| progress and end-to-end cancellation | pending | pending | pending |
| disconnect and durable resume | pending | pending | pending |
| stale lease/revision/token rejection | pending | pending | pending |
| concurrent-client isolation | pending | pending | pending |
| worker/Piston outage classification and recovery | pending | pending | pending |
| hosted OIDC and tenant isolation | pending | pending | pending |
| prepare/apply publication integrity | pending | pending | pending |
| proof of no embedded-provider fallback | pending | pending | pending |

Acceptance gate: at least two clients pass the complete local matrix, and at least one passes the
hosted OIDC, isolation, cancellation, and disconnect/resume matrix.

## 4. Python service completion

Current foundation: locked offline installation, clean wheel execution, typed HTTP acceptance,
health readiness, concurrency, SQLite schema persistence, restart recovery, clean shutdown, and
live Piston mutation verification.

Outstanding work:

- kill the service at deterministic points during an active database transaction and prove
  rollback/recovery;
- test concurrent writers, lock contention, idempotency races, and process leak detection under
  repeated failure;
- upgrade from a frozen prior release and verify schema/data compatibility;
- certify a non-empty hash-locked dependency set against the offline wheelhouse;
- have two independent MCP clients deliver the held-out subscription-billing service and compare
  normalized assembly evidence.

Acceptance gate: both clients produce green, reproducible Piston evidence with no hidden-case
failure and identical normalized deliverables.

## 5. Rearchitecture confidence

Outstanding work:

- introduce controlled defects requiring ownership, dependency, persistence-boundary, and
  interface-preserving subtree changes;
- prove authority enforcement, isolated proposal builds, stale compare-and-swap rejection, failed
  proposal rollback, and minimal compiler-derived invalidation;
- prove unrelated subtrees and their evidence remain byte-identical after activation;
- expand projection tests for large architectures, renderer failure, font substitution, routed
  edges, semantic IDs, layout import, and revision comparison;
- certify independent critic identity and scoped waiver provenance without allowing waivers to
  bypass assembly, conformance, mutation, reproducibility, or security.

Acceptance gate: every affected consumer is rebuilt, every unrelated artifact remains unchanged,
and no authority boundary is broadened.

## 6. Additional delivery profiles

Current local foundation: the pinned `foundry-product/1.0.0` runtime contains Rust 1.80.1, Cargo, Node 22.18.0, npm, and TypeScript 5.9.2. HashRelay has exercised Rust library/binary, TypeScript package, Node service, artifact-bundle, process-contract, HTTP-contract, and mixed-product capabilities through live Piston.

Outstanding profile certification:

1. certify the Rust and TypeScript capabilities independently with profile-owned hidden tests, hostile-input fixtures, mutation-strength baselines, and offline dependency cases;
2. add and certify the multi-package repository profile;
3. retain two-client normalized evidence for each promoted profile.

## 7. Held-out benchmark portfolio

The final portfolio must include:

- concurrent financial ledger;
- durable job scheduler;
- authenticated versioned service with migrations;
- parser/compiler with golden, malformed-input, fuzz, and property tests;
- multi-package dependency graph;
- deliberately flawed system requiring subtree rearchitecture.

Every benchmark must include worker/Piston failure injection, restart, disconnect/resume,
cancellation, mutation testing, deterministic replay, and confirmed Git publication. Controls,
inputs, client/model identity, transcripts, raw evidence, normalized evidence, and artifact digests
must be immutable and retained.

## Non-waivable boundaries

The following can never be waived for code publication:

- typed conformance and complete evidence;
- production Piston verification;
- mutation-strength enforcement after shadow-mode promotion;
- reproducibility;
- sandbox and tenant isolation;
- assembly success;
- publication digest and optimistic-concurrency checks.

Architecture-only publication remains available when code-delivery certification is incomplete.

## 8. Recursive product IR v5 certification

Current foundation: a feature-gated nested v5 schema; deterministic TypeScript and Rust recursive
compilers; hierarchical identities and lineage; immediate-child DAGs and reviewed deep exceptions;
CAS subtree commands and path-bound authoring leases; recursive GraphReact work; system-owned
composite integration; digest-aggregated evidence v3; versioned capability records; recursive UML,
SVG, PNG, and Excalidraw projections; product-aware rearchitecture; and evidence-bound v5
publication preparation. Local-control execution is rejected for v5.

Completed local live certification (2026-08-13):

- built and pinned `foundry-product/1.0.0` with Rust 1.80.1, Cargo, Node 22.18.0, npm, and TypeScript 5.9.2;
- verified the behavioral HashRelay fixture through real Piston, including Rust and TypeScript leaves, the checksum process contract, Node HTTP boundary, malformed input, restart behavior, recursive integration, installed execution, all six declared deliverables, and a clean replay;
- passed the legacy live Python library and Python service Piston suites;
- passed all 68 Node tests, TypeScript checks, and all Rust workspace tests after correcting the canonical HashRelay state model.

Outstanding certification:

- run HashRelay independently through two certified MCP clients and compare normalized evidence;
- run Piston outage, worker restart, cancellation, malicious source, resource exhaustion, artifact substitution, and undeclared-egress fixtures;
- retain p95 performance evidence on certification hardware for 512-node compilation and the 2,048-node ceiling, including peak-memory measurement;
- complete the architecture-only PCBPnR decomposition and record Bun, Electrobun, webview, Windows packaging, GUI automation, native-sidecar, and update-system gaps without substituting Node capabilities.

The isolated runtime currently advertises `foundry-product/1.0.0` and Python 3.11.2. The previous storage-corrupted profile was deleted and recreated; no host-execution or embedded-provider fallback was used.

Acceptance gate: v5 remains behind `FOUNDRY_PRODUCT_IR_V5=enabled` until HashRelay, migration,
performance, security, and two-client gates all pass. The absence or failure of the product runtime
must produce `infrastructure_blocked`; it may never produce a red authored verdict or fall back to
host execution.

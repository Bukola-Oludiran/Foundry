# Foundry hardening gaps

Status: historical gap inventory, derived from the LedgerForge certification run on 2026-08-09.
The current implementation state is summarized below; numbered findings are retained as the
original control evidence and must not be read as the present product contract.

## Trustworthy-delivery implementation status

Implemented and regression-tested:

- shared asynchronous MCP result normalization and schema validation;
- IR v4 typed, eval-free scenarios and evidence v2 with requirement/scenario/result mappings;
- private transactional verification overlays, replay-safe submissions, and distinct authored,
  contract-weak, infrastructure, and cancellation outcomes;
- repository-shaped v4 integrator verification, Piston-only publication evidence, two clean
  reproducibility executions, and deterministic Python mutation testing;
- atomic digest-verified artifact writes, migration checksums, backup/restore, quarantine GC,
  tenant quotas, verification journaling, and recoverable repository-publication outbox state;
- discovery-backed OIDC/JWKS validation, protected-resource metadata, context-bound leases,
  administrative system health, and static bearer authentication restricted to explicit local
  development;
- Python library and locked Python service profiles, including clean wheel installation, typed
  HTTP scenarios, SQLite reopen/restart checks, concurrency, shutdown, and live Piston mutation
  verification.

Certification work still open:

- live Keycloak rotation/outage/revocation certification on a host with enough container memory;
- exhaustive transaction-boundary fault injection, model-based state-machine coverage, periodic
  scrub/GC orchestration, and operator-grade backup recovery drills;
- complete Codex/Claude/Gemini resilience matrices and hosted disconnect/resume certification;
- prior-release service upgrades and precisely injected mid-transaction process termination;
- the controlled-defect rearchitecture benchmark and large-architecture projection suite;
- Rust, TypeScript, and multi-package delivery profiles plus the held-out portfolio rollout.

The actionable checklist and acceptance gates are maintained in
[Outstanding trustworthy-delivery certification](outstanding-certification.md).

Foundry can now produce a repository-shaped Python library, install its wheel outside the source
tree, execute root conformance cases, retain immutable assembly evidence, and publish architecture
and build artifacts together. That is meaningful integration evidence. It is not yet sufficient
evidence that every green Foundry build is trustworthy under complex production conditions.

The next hardening program must prioritize the integrity of the green verdict, then operational
resilience, security, and breadth of delivery profiles.

## Evidence from the LedgerForge run

The LedgerForge run demonstrated:

- 16 GraphReact nodes reached green;
- the mandatory Python-library assembly gate reached green;
- all 21 published target digests matched the immutable evidence;
- a wheel was built, installed without dependencies into a clean environment, and imported from
  outside the checkout;
- 33 public exports loaded;
- end-to-end billing and transaction-rollback scenarios passed;
- canonical IR, PlantUML, SVG, PNG, Excalidraw, implementation, and conformance evidence were
  published in one repository revision.

The same run exposed these concrete gaps:

1. `foundry_get_assembly_evidence` does not await the asynchronous command result. The MCP SDK
   rejects its `structuredContent` because it receives a `Promise`. The underlying evidence remains
   readable through `foundry_get_build`, but the dedicated public tool is not conformant.
2. The IR contains 31 node acceptance cases, while the durable generated conformance test projects
   only two root scenarios into one test method.
3. The conformance manifest does not contain per-requirement acceptance mappings and individual
   case results.
4. The generated test relies on authored scenario helpers. Such a helper can become a self-oracle
   that reports the expected summary without independently exercising every promised behavior.
5. The nested generated test is directly executable after package installation, but ordinary
   `python -m unittest discover` from the repository root discovers no tests.
6. Concurrent stdio sessions previously borrowed one shared local worker. When its owning MCP
   process exited, the surviving sessions returned `WORKER_UNAVAILABLE`. Session-private workers
   now eliminate that specific race, but infrastructure-failure semantics still require broader
   hardening.

## P0 — Trustworthy green verdicts

### Independent conformance testing

Foundry must compile conformance independently from submitted implementation source.

- Project every accepted node case into durable repository tests, not only root cases.
- Generate typed operation invocations instead of evaluating authored expression strings with
  `eval`.
- Add boundary, negative, property, and metamorphic cases derived from typed contracts.
- Keep the deterministic tester independent from the authoring client.
- Prevent implementation code from detecting, rewriting, or bypassing the harness.
- Ensure generated tests run through standard language discovery mechanisms without Foundry state.
- Treat authored scenario helpers as supplementary integration fixtures, not the sole oracle.

Foundry already has a detailed [mutation-testing design](mutation-testing.md). Implementing it is
part of this work, but mutation score cannot replace independent contract projection.

### Complete evidence contracts

Every registered MCP tool must have a successful end-to-end contract test. Certification must fail
for unresolved promises, malformed structured content, invalid resource links, inconsistent data,
or transport-specific behavior.

The conformance manifest must include:

- architecture revision and build identifiers;
- every node, requirement, acceptance case, and property;
- requirement-to-case and case-to-result mappings;
- individual verdicts, failures, durations, and runtime identities;
- test-source, target, assembly-evidence, and output-artifact digests;
- worker, sandbox, Piston, runtime, packaging-tool, renderer, and font versions;
- retry, cancellation, waiver, and infrastructure-failure provenance.

The manifest, generated tests, assembly evidence, and public MCP resources must agree on the same
digests and verdicts.

### Infrastructure failures are not authored failures

`WORKER_UNAVAILABLE`, Piston transport failures, worker crashes, and infrastructure timeouts must
remain distinct from code and acceptance failures.

- Do not mark a node red or consume its authored retry budget.
- Do not discard a valid work lease merely because the verifier is temporarily unavailable.
- Retry automatically within a separate bounded infrastructure budget.
- Return a stable failure code, component identity, readiness details, and `retryAfter` guidance.
- Make submissions idempotent when execution succeeds but the response is lost.
- Pause lease issuance when required verification infrastructure is unhealthy.
- Persist enough state to resume safely after MCP, sidecar, worker, or Piston restart.

### Reproducible assembly

Run identical immutable inputs in two clean workers and compare:

- generated conformance source;
- architecture projections and manifests;
- package contents and digest;
- normalized logs and verdicts;
- runtime-visible behavior.

Normalize explicitly permitted timestamps or environment metadata. Any unexplained difference must
fail determinism certification. Reproducibility tests must include wheel/archive timestamps,
filesystem ordering, locale, timezone, hash seed, and renderer/font selection.

## P1 — Build and transaction integrity

### GraphReact state-machine invariants

Use property and model-based tests to enforce at least these invariants:

- a build cannot become green before assembly is green;
- cancelled work cannot later become green;
- a late, stale, or duplicate lease submission cannot mutate state;
- infrastructure failures cannot become authored failures;
- only ready nodes can acquire leases;
- concurrent leases have disjoint compiler-issued write scopes;
- only compiler-derived invalidation sets reopen green nodes;
- exhausted authored retries route to the responsible owner;
- restart recovery produces the same durable state as uninterrupted execution.

Exercise these rules across the TypeScript command layer, SQLite transactions, Rust sidecar, and
MCP transports rather than testing each layer only in isolation.

### Real-boundary integrator verification

Repository-shaped integration must extend beyond import success. Depending on the delivery
profile, it should cover:

- public API and serialized-data compatibility;
- persistence schema creation, migration, downgrade policy, and rollback;
- concurrent writers and locking behavior;
- process termination during transactional work;
- read-only installation and restricted filesystem permissions;
- locale, timezone, clock, and numeric boundary behavior;
- upgrade from the previously active release;
- declared CLI, service, database, and network boundaries.

### Mutation testing

Deliberately damage accepted implementations and prove the parent-owned cases notice. Initial
mutations should include removed tenant predicates, changed rounding modes, inverted comparisons,
skipped rollback, unbalanced ledger postings, missing idempotency checks, and altered public
exports.

A surviving mutant is an acceptance-quality failure owned by the contract author. It must not be
reported as an implementation retry. See [mutation-testing.md](mutation-testing.md) for the proposed
`weak` verdict and attribution model.

### Multi-file and cross-store atomicity

Inject failure after every externally visible step of submission, activation, and publication:

- an artifact is stored but metadata is not committed;
- only part of a multi-target change is staged;
- a worker completes but its response is lost;
- SQLite commits immediately before a sidecar crash;
- assembly evidence is written before build state advances;
- repository files are written but Git commit fails;
- confirmation is replayed after a relevant file or revision changes.

Recovery must expose either the complete prior state or the complete accepted state. Partial target
sets, mixed revisions, and evidence without corresponding durable state are forbidden.

## P1 — Security and isolation

### Treat source and tests as hostile

Harden every compiler, renderer, package builder, and test runner against:

- sandbox, namespace, and test-harness escape;
- symlink, hard-link, archive traversal, and path-normalization attacks;
- environment-variable, credential, repository-metadata, and host-file access;
- fork bombs, process leaks, excessive memory/CPU/disk use, and oversized output;
- renderer and diagram-source injection;
- malicious package metadata and build backends;
- cross-project, cross-tenant, and cross-build artifact access.

Resource and output limits must fail with typed diagnostics and must not be misattributed to the
implementation unless the implementation exceeded a declared contract limit.

### Hosted authentication and tenancy

Complete live OIDC integration and certify:

- issuer, signature, audience, nonce, and expiry validation;
- key rotation and temporary discovery/JWKS failure;
- user revocation and scope reduction;
- tenant and project authorization on every tool and resource;
- Origin, Host, session-fixation, token-replay, and confused-deputy defenses;
- audit attribution across user, client, transport, and sampling contexts.

Static bearer authentication remains a local-development control only.

## P2 — Product and operational resilience

### Worker supervision and observability

Expose an administrative health resource or tool containing:

- MCP façade, Rust sidecar, worker, sandbox, and Piston readiness;
- component and protocol versions;
- installed and selectable runtimes;
- queue depth, active leases, and oldest queued work;
- infrastructure versus authored failure rates;
- sidecar and worker restart counts;
- last successful node test and assembly;
- storage pressure and artifact-integrity status.

Use readiness gating and circuit breakers. Foundry must stop leasing work when it cannot verify the
result and must explain which dependency is unavailable.

### Artifact lifecycle management

Add:

- atomic artifact writes and digest verification on every read;
- periodic integrity scrubbing;
- reference-counted or reachability-based garbage collection;
- per-tenant quotas and pressure diagnostics;
- backup, restore, and disaster-recovery tests;
- interrupted-write recovery;
- retention protection for active revisions, proposals, builds, reviews, waivers, and live
  confirmation tokens.

Garbage collection must never delete evidence required to reproduce a published revision.

### Additional delivery profiles

The dependency-free Python library is the first control, not the final definition of complex
software. Add profiles through the same delivery-contract interface for:

- Python libraries and applications with hash-locked dependencies;
- Rust libraries and binaries;
- TypeScript packages and services;
- command-line applications;
- multi-package repositories;
- database-backed and multi-process services;
- schema migrations and backward-compatible upgrades.

Each profile requires pinned tooling, a clean install/deploy boundary, profile-specific security
rules, deterministic evidence, and an independently maintained standard assembly suite.

### Adversarial client certification

Certify every supported MCP client with identical fixtures and deliberate failures. Include:

- malformed or oversized tool calls;
- cancellation at every long-running phase;
- disconnect and resume during leases and assembly;
- stale revisions, leases, digests, and confirmation tokens;
- missing sampling, image, prompt, progress, or usage capabilities;
- concurrent clients working on overlapping and disjoint nodes;
- attempts to bypass typed targets, review independence, or publication confirmation.

Unsupported optional client capabilities must degrade to documented manual workflows, never to an
embedded Foundry model provider.

## P2 — Architecture and rearchitecture confidence

### Subtree rearchitecture

Exercise real rearchitecture rather than only schema-level proposals:

- introduce a defect requiring an ownership or dependency change;
- compute and verify the minimal invalidation set;
- build the proposal in an isolated overlay;
- reject parent-contract, mandate-owner, permission, and unrelated-subtree changes;
- fail a proposal build and prove the active revision and repository remain unchanged;
- activate a valid proposal under compare-and-swap;
- rebuild only invalidated consumers and retain unrelated evidence.

### Review independence

Strengthen reviewer identity beyond display names. Bind author and critic contexts to server-issued
identities, MCP sessions, authenticated principals, and source revisions. Test reconnects,
delegation, sampled fresh contexts, colluding contexts from one principal, and explicit scoped
waivers. Every waiver must identify exactly which independence requirement was bypassed and why.

### Architecture projection fidelity

Continue testing that every diagram element maps to canonical semantic IDs. Add readability and
change-impact checks for large architectures, renderer failures, font substitution, edge routing,
layout import, and diagram evolution across revisions. Layout imports must never create semantic
nodes or relationships.

## Complex-software benchmark suite

No single project proves general capability. Maintain a held-out benchmark portfolio:

1. A concurrent financial ledger with idempotency, migrations, audit retention, and failure
   injection.
2. A durable job scheduler with leases, retries, cancellation, crash recovery, and clock control.
3. A versioned HTTP service with authentication, database migrations, pagination, and compatibility
   tests.
4. A parser or compiler with golden files, malformed-input tests, fuzzing, and semantic properties.
5. A multi-package dependency graph with parallel builds and cross-package API compatibility.
6. A deliberately flawed architecture that can succeed only through bounded subtree
   rearchitecture.

Every benchmark must include hidden independent tests, injected infrastructure failures, mutation
testing, deterministic rebuild comparison, restart/resume, and confirmed publication. Passing the
authored cases alone is not a certification result.

## Recommended implementation order

1. Fix complete MCP response certification, beginning with
   `foundry_get_assembly_evidence`.
2. Project every node acceptance case into discoverable durable tests and complete the evidence
   manifest.
3. Replace expression `eval` and self-oracle dependence with typed independent invocation.
4. Separate and automatically retry infrastructure failures without consuming authored attempts.
5. Add double-build reproducibility and mutation-quality gates.
6. Add GraphReact model-based state tests and multi-store failure injection.
7. Complete live OIDC, hostile-input isolation, and operational readiness reporting.
8. Certify a concurrent, migration-bearing service before claiming complex-software capability.
9. Expand delivery profiles and run the full held-out benchmark portfolio.

## Promotion criterion

Foundry should claim reliable complex-software delivery only when at least two independent MCP
clients complete the benchmark portfolio with:

- no false-green build;
- no lost or misattributed infrastructure failure;
- complete immutable requirement-to-result evidence;
- deterministic rebuilds or fully explained normalized differences;
- successful crash/restart recovery;
- zero sandbox, tenancy, authentication, or publication-integrity failures.

# Why Foundry

Foundry is not valuable merely because an AI model can generate code. Codex, Claude, and other
coding agents can already implement a small, well-scoped feature directly. Foundry becomes useful
when a software project is too large, long-running, or risky to entrust to one model session.

Its purpose is to turn model calls into a constrained, recoverable software-building organization:

- **Contract-driven decomposition.** Architecture becomes a machine-validated ownership tree with
  explicit interfaces, dependencies, write scopes, and acceptance mandates.
- **Independent verification.** An implementer cannot silently weaken or rewrite its own tests.
  Parent-owned deterministic tests decide whether a node is accepted.
- **Scoped parallel work.** Multiple agents can implement separate nodes without gaining permission
  to modify the entire repository.
- **Durable execution.** Builds, retries, reviews, artifacts, and decisions survive host crashes and
  model-session loss.
- **Controlled repair.** A failing node receives bounded feedback and retry. It cannot quietly
  broaden its scope.
- **Genuine rearchitecture.** Persistent failures can replace a constrained subtree while preserving
  external interfaces and unaffected sibling branches.
- **Reproducible evidence.** Patches, test reports, architecture revisions, reviewer decisions, and
  model attempts are retained as artifacts.
- **Safe delivery.** Output is validated against declared scopes and published only as a
  human-reviewed draft pull request.
- **Replaceable intelligence.** Codex and Claude are participants behind interfaces rather than the
  project's source of truth. The compiler, tests, persistence layer, and Git history remain
  authoritative.

In short: a coding agent produces code; Foundry manages a recoverable software-building
organization.

## Where the value appears

A three-function demonstration validates plumbing, but it does not exercise Foundry's strongest
properties. A representative workload contains multiple independently owned components, shared
contracts, mixed languages, integration boundaries, and enough execution time for retries or
recovery to matter. In that setting, Foundry can coordinate independent architects, bounded doers,
and testers while retaining the evidence behind every accepted change.

The intended lifecycle is:

1. Architects turn a product specification into compiler-valid IR.
2. Independent reviewers challenge the contracts and acceptance mandates.
3. Scoped workers build nodes in dependency order, potentially in parallel.
4. Parent-owned tests accept or reject each implementation.
5. Bounded repair handles local failures; scoped rearchitecture handles persistent structural ones.
6. Durable state and artifacts allow the same run to recover after interruption.
7. A validated result is published as a draft pull request for human review and merge.

Some of these capabilities are complete while others remain active roadmap work. The authoritative
implementation status and acceptance gates are maintained in [the roadmap](roadmap.md); this
document describes the product value and intended operating model, not a claim that every milestone
is finished.

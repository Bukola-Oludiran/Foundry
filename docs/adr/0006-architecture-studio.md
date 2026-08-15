# ADR 0006: Architecture Studio revisions and Buzz authority

Status: accepted

## Decision

Foundry exposes architecture as an immutable, versioned proposal graph. `Ir` remains the semantic
source of truth; rationale and boundary locks participate in its Studio semantic digest, while
layout does not. Every semantic mutation is a typed command against an expected proposal head and
an idempotency key. Foundry compiles the complete candidate before atomically advancing the head.
Conflicts return the current head and structural diff. Proposal branches are never auto-merged.

The revision path is:

`draft → awaiting_critic → awaiting_human_approval → approved → building → delivered`

Any semantic change invalidates reviews and approvals. An independent critic must approve the exact
digest before eligible humans can sign kind `46011` approvals. Layout edits retain approval. An
approved proposal makes other open proposals stale. Build admission additionally checks that the
repository still has the immutable bound base commit.

GraphReact local persistence is the recovery authority. Proposal heads, commands, revisions,
reviews, approvals, layouts, diffs, and canonical architecture documents are content-addressed
artifacts. The canonical files are materialized only in the build run's isolated worktree:

- `.foundry/architecture/ir.json`
- `.foundry/architecture/rationale.json`
- `.foundry/architecture/layout.json`

Buzz owns identity, discussion, repository policy, and the human go-ahead. Foundry owns validation,
durability, agent execution, scoped builds, and delivery evidence. Agent-derived authority may edit
but can never count toward the human gate.

## Consequences

The diagram is a reversible projection instead of a second architecture language. Moving a card is
presentation-only; ownership, dependencies, interfaces, mandates, or scopes are semantic commands.
Offline Buzz clients may display a timestamped verified projection but cannot mutate or approve it.
The deployment remains one persistent, single-tenant Foundry service per Buzz community.


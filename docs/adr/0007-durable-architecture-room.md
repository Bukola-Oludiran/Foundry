# ADR 0007: Durable Architecture Room

## Status

Accepted.

## Decision

Architecture generation is a durable `ArchitectureOperationV1`, not the lifetime of an HTTP
request. Each proposal owns an append-only room whose `ArchitectureRoomEventV1` records use
monotonic sequences and a SHA-256 hash chain. Foundry commits an event before SSE delivery. Restart
recovery resumes nonterminal operations with stable ACP identities; a structured architect question
remains paused until the exact question is answered.

The room is a curated operational record. It includes lifecycle stages, bounded architect and critic
messages, safe tool categories, compiler diagnostics, guidance delivery outcomes, questions,
reviews, and revision results. It excludes private thought chunks, partial structured output, shell
commands, raw tool output, credentials, environment values, and host paths. Final strict JSON remains
the job result and must compile before it becomes a revision.

Human guidance is committed before delivery. `immediate` guidance attempts Buzz ACP's non-cancelling
steer transport. A positive acknowledgement records `delivered`; unsupported, late, interrupted, or
ambiguous steering records `checkpointed` and retains the message for the next architect invocation.
The critic remains read-only and cannot be steered.

The synchronous route remains a compatibility wrapper. Buzz uses asynchronous status, paged history,
and authenticated SSE. Tauri retains Foundry and ACP capabilities; the webview receives only scoped
room projections.

## Consequences

- Closing Buzz or losing SSE does not cancel architecture work.
- Readers can audit a revision without receiving model chain-of-thought.
- Cursor reconnect and event-ID deduplication make redelivery harmless.
- A question and answer become durable inputs to a new stable architect job.

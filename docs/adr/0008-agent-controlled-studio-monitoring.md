# ADR 0008: Managed agents may start and monitor, never govern Studio

## Status

Accepted.

## Decision

Foundry exposes a separate NIP-98 plus NIP-OA session exchange for Buzz-managed agents. It resolves
the attested human owner against the current signed repository policy and issues only `read` and the
narrow `architect` operation. The capability is short-lived, workload-bound, and marked
`human: false`.

`architect` admits an initial durable architecture operation. It does not alias `edit`: an agent
cannot guide or answer the architect, cancel work, mutate a revision, review, approve, build, or
satisfy a human threshold. The existing human and critic boundaries remain unchanged.

Buzz may disclose Foundry's curated Architecture Room record by projecting deterministic,
agent-signed messages into the human-selected project thread. Foundry remains the scheduler and
canonical room ledger. Buzz persists only a NIP-44 self-encrypted monitor intent and its last
committed sequence; replay uses the room event identity and does not duplicate authoritative
messages.

## Consequences

Humans can delegate “use Architecture Studio and monitor it here” to Bumble or any other managed
agent without granting governance authority. Offline harnesses pause disclosure but lose no room
state. The originating channel intentionally receives the curated transcript, while capabilities,
attestations, hidden reasoning, raw tool traffic, and credentials remain outside that transcript.

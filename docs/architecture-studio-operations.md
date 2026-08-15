# Operating Architecture Studio

Architecture Studio runs as the supervised Foundry service for one Buzz community:

## Durable Architecture Room

Buzz submits creation through `POST /v1/studio-operations/architect`. Foundry returns the operation
immediately and exposes status at `GET /v1/studio-operations/{operation_id}`. Readers page the
committed transcript through `/room?after=<sequence>` or follow authenticated SSE at
`/events?after=<sequence>`.

Editors send bounded guidance to `/messages`. `immediate` is reported as `delivered` only after ACP
acknowledges steering; otherwise it is visibly retained as `checkpointed`. A structured architect
question moves the operation to `waiting_input`; an idempotent `/answers` request resumes it without
reusing the completed question turn.

Room events are curated. Thought chunks, partial JSON, commands, paths, raw output, environment
values, and credentials are excluded before persistence.

Generative edits use `POST /v1/studio-operations/generate` and return a room operation immediately.
Only one semantic operation may be active for a proposal, while independent proposal branches may
run concurrently. A stale proposal is never rewritten in place: editors submit
`POST /v1/studio-operations/rebase` with the stale and current approved head digests, and Foundry
creates a linked proposal room branch before asking the architect to preserve the stale intent.

Once a room is bound to a proposal, Foundry mirrors its hash-chained events into immutable,
200-record GraphReact artifact pages. The Studio state references a transcript-index artifact only
after every page is stored. Cursor and SSE reads perform this durable mirror before returning new
events, so the visible conversation can be recovered alongside the architecture revision.

```sh
export FOUNDRY_STUDIO_SERVICE_NSEC='<workload secret>'
export FOUNDRY_WORKER_TOKEN='<workload secret>'
export FOUNDRY_CRITIC_TOKEN='<different workload secret>'
cargo run -p foundry-host -- studio-serve \
  --listen 127.0.0.1:3900 \
  --public-url https://foundry.example \
  --community-id 00000000-0000-4000-8000-000000000001 \
  --durability-dir /var/lib/foundry/community-1 \
  --relay-api-url https://relay.example/api \
  --repositories /etc/foundry/community-1-repositories.json \
  --pi-pool http://127.0.0.1:8787 \
  --critic-pool http://127.0.0.1:8788
```

Secrets are accepted only from environment/workload secret injection. Worker and critic identities
must be distinct. Repository coordinates are mapped to explicit local paths; clients cannot supply
host paths. The repositories file is a JSON object such as
`{"owner/repository":"/srv/repositories/repository"}`.

The Buzz relay advertises the service in its host-derived NIP-11 document when all of these are set:

```sh
BUZZ_FOUNDRY_SERVICE_URL=https://foundry.example
BUZZ_FOUNDRY_SERVICE_PUBKEY=<64-character service public key>
BUZZ_FOUNDRY_PROTOCOL_VERSION=1
```

Configure `FOUNDRY_STUDIO_READERS`, `FOUNDRY_STUDIO_EDITORS`,
`FOUNDRY_STUDIO_REVIEWERS`, `FOUNDRY_STUDIO_APPROVERS`, and
`FOUNDRY_STUDIO_BUILDERS` as comma-separated public keys. `FOUNDRY_STUDIO_AGENTS` identifies
agent-derived authorities and prevents them from satisfying human approval. The repository owner is
eligible by default. `FOUNDRY_STUDIO_APPROVAL_THRESHOLD` defaults to one.

At every session exchange and approval ingestion, Foundry fetches and cryptographically verifies the
current kind `30617` repository announcement. The owner and explicitly tagged `maintainer` or
`push-allowed` humans may edit/approve/build. A protected branch can raise its human gate with
`["foundry-approval", "<branch>", "<distinct-signers>"]`; the operator threshold remains a floor.
Policy lookup fails closed, so a stale capability cannot approve after repository governance changes.

Readiness is `GET /v1/studio/readiness`. The desktop discovers through NIP-11, performs a signed
NIP-98 session exchange, and retains the five-minute capability only in Tauri memory. Never put the
capability, an nsec, or a worker token in a URL, browser store, or command line.

For a repository without a Studio, Buzz posts the product specification to
`POST /v1/studio-operations/architect`. Foundry first commits and returns the durable operation, then
runs its bounded architect repair loop, compiles the complete IR, creates the initial proposal, and
invokes the separately configured critic. The legacy `POST /v1/studios/architect` endpoint remains
a bounded-wait compatibility wrapper. Retrying with the same idempotency key resolves to the same
operation and Studio.

## Buzz-managed ACP agents

Architecture Studio can dispatch either role through the provider-neutral `AgentRuntime` boundary.
The existing pi-pool behavior remains the default. To select Buzz ACP agents:

```sh
export FOUNDRY_BUZZ_ARCHITECT_AGENT_ID='<architect agent npub or stable runtime id>'
export FOUNDRY_BUZZ_ARCHITECT_CAPABILITY='<role-scoped workload capability>'
export FOUNDRY_BUZZ_CRITIC_AGENT_ID='<different critic agent id>'
export FOUNDRY_BUZZ_CRITIC_CAPABILITY='<different role-scoped capability>'

cargo run -p foundry-host -- studio-serve \
  --listen 127.0.0.1:3900 \
  --public-url http://127.0.0.1:3900 \
  --community-id 00000000-0000-4000-8000-000000000001 \
  --durability-dir .foundry/studio-state \
  --relay-api-url http://127.0.0.1:3000 \
  --repositories /absolute/path/to/repositories.json \
  --pi-pool http://127.0.0.1:7878 \
  --architect-runtime buzz-acp \
  --critic-runtime buzz-acp \
  --buzz-acp-gateway http://127.0.0.1:7790
```

The architect and critic agent IDs must differ. Foundry rejects startup when both roles resolve to
the same runtime identity.

The gateway contract is versioned and job-oriented:

- `POST /v1/acp/jobs` submits `AgentJobRequestV1`. Reusing the same `job_id` and request returns the
  existing job; different content for that ID must return a conflict.
- `GET /v1/acp/jobs/:job_id` returns `queued`, `running`, `succeeded`, `failed`, `cancelled`, or
  `indeterminate` plus structured output for success.
- `POST /v1/acp/jobs/:job_id/cancel` requests monotonic cooperative cancellation.
- `Authorization: Bearer ...` carries a role-scoped capability and `X-Buzz-Agent-Id` selects the
  allowlisted Buzz-managed ACP identity. Credentials never enter the request body or artifacts.

Foundry submits once and polls with the same stable job identity. A GraphReact effect retry therefore
recovers the existing ACP job rather than opening a duplicate Codex, Claude, Goose, or Buzz Agent
turn. Start Buzz's gateway with `buzz-acp foundry-gateway`; its JSON configuration binds distinct
agent identities to the same capability environment variables shown above. If it is unavailable,
Foundry fails dispatch rather than silently falling back to pi-pool.

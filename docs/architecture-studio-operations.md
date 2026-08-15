# Operating Architecture Studio

Architecture Studio runs as the supervised Foundry service for one Buzz community:

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
  --repositories '{"owner/repository":"/srv/repositories/repository"}' \
  --pi-pool http://127.0.0.1:8787 \
  --critic-pool http://127.0.0.1:8788
```

Secrets are accepted only from environment/workload secret injection. Worker and critic identities
must be distinct. Repository coordinates are mapped to explicit local paths; clients cannot supply
host paths.

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
`POST /v1/studios/architect`. Foundry runs its bounded architect repair loop, compiles the complete
IR, creates the durable initial proposal, and invokes the separately configured critic before
returning the projection. Retrying with the same idempotency key resolves to the same Studio.

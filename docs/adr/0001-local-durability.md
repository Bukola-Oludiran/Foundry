# ADR 0001: GraphReact local durability

Status: accepted.

Foundry models one build as one GraphReact durable run and uses the local persistence backend for
v1. Worker and repository calls are durable effects keyed by stable job identities. Clustered
Postgres/S3 recovery is deliberately deferred; persistence-facing Foundry interfaces must remain
backend-neutral.

# ADR 0003: OCI isolation on Linux

Status: accepted.

Production Linux workers use rootless OCI containers with read-only dependencies, one writable
output scope, resource limits, reduced privileges, and network disabled for tests. macOS Seatbelt
remains a development backend. Unisolated local execution is never a production fallback.

---
name: foundry-rearchitecture
description: Validate an interface-preserving Foundry subtree revision and its affected rebuild closure. Use when a durable build exhausts repair or a failure requires a scoped architectural change.
---

# Foundry Rearchitecture

Read `foundry://workflows/propose-subtree-rearchitecture` before acting.

Use `foundry_rearchitect` against immutable accepted and proposed IR files. Preserve the parent-facing interface, parent-owned acceptance, and unrelated siblings. Review the structural diff before executing or promoting the proposal.

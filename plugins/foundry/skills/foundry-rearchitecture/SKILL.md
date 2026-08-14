---
name: foundry-rearchitecture
description: Design, validate, build, review, and activate immutable Foundry subtree replacement proposals. Use when a build exhausts retries, a node cannot satisfy its fixed contract, or a user requests a scoped architecture change that must preserve M4 authority boundaries and minimal invalidation.
---

# Foundry Rearchitecture

Read `foundry://workflows/propose-subtree-rearchitecture` through the Foundry MCP resource reader before opening a proposal. Read `foundry://workflows/diagnose-red-node` first when rearchitecture follows a failed build.

Use the proposal, validation, isolated-build, activation-preparation, and activation tools. Preserve the target semantic ID, owner, parent-facing interface, parent-owned acceptance, permissions, and unrelated subtrees. Never broaden write targets or activate a proposal that is stale or not all green. Treat the compiler-derived invalidation set as authoritative.

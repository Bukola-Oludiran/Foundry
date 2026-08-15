---
name: foundry-architect
description: Create or validate a Foundry architecture from a product specification through the workspace-scoped Foundry MCP server. Use when asked to architect a product, generate Foundry IR, or validate an IR before building.
---

# Foundry Architect

Read `foundry://workflows/architect-from-spec` before acting.

Use configured workspace IDs and relative paths. Generate the IR through `foundry_architect`, inspect its rationale, then run `foundry_validate`. Treat schema and Rust compiler diagnostics as authoritative. Do not publish or modify a protected base branch.

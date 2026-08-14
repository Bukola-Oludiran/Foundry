---
name: foundry-build
description: Implement, test, retry, and inspect provider-free Foundry build nodes through bounded leases and compiler-issued targets. Use when a user asks Codex to start or resume a Foundry build, implement ready work, inspect a node, diagnose a red attempt, or verify implementation with the Foundry sandbox and Piston.
---

# Foundry Build

Read `foundry://workflows/implement-ready-node` through the Foundry MCP resource reader before leasing or submitting work. When a node is red, also read `foundry://workflows/diagnose-red-node` before retrying.

Use the build, node-context, ready-work, attempt, submission, retry, and cancellation tools. Submit only complete source for the compiler-issued target and current base digest. Never use shell commands or direct repository edits as a substitute for the Foundry change set. Treat lease conflicts and independent tester verdicts as authoritative. Escalate architectural causes to governed rearchitecture instead of weakening acceptance.

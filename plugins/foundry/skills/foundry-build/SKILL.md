---
name: foundry-build
description: Start, resume, inspect, or cancel a crash-recoverable Foundry build through GraphReact local durability. Use when asked to build an accepted Foundry IR or manage an existing durable run.
---

# Foundry Build

Read `foundry://workflows/run-durable-build` before acting.

Validate the IR, then call `foundry_build` with a workspace-scoped durability directory. Preserve the returned run ID. Use `foundry_status` and `foundry_cancel` for run control. Never edit persistence logs, snapshots, artifacts, or attempt worktrees directly.

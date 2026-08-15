---
name: foundry-publish
description: Publish a successful Foundry durable run as a human-reviewed draft pull request. Use when asked to deliver, publish, or open a draft PR for a completed Foundry run.
---

# Foundry Publish

Read `foundry://workflows/publish-draft-review` before acting.

Confirm the run is succeeded with `foundry_status`, review its durable evidence and accepted IR, then call `foundry_publish` with `draftPr=true`. Never approve, merge, force-push, or modify the protected base branch.

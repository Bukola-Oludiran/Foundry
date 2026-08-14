---
name: foundry-publish
description: Review, prepare, confirm, and apply controlled Foundry repository publications. Use when a user asks to publish or commit an activated architecture package, generated UML or Excalidraw artifacts, or an all-green Foundry build while preserving unrelated repository changes.
---

# Foundry Publish

Read `foundry://workflows/review-activation-diff` through the Foundry MCP resource reader before preparing publication.

Use `foundry_prepare_repository_update` to obtain the immutable revision, build evidence, base Git HEAD, complete controlled path list and diff, artifact digests, blockers, prepared digest, expiry, and single-use token. Present the consequential changes and obtain explicit user confirmation unless the current request already authorizes the exact publication. Then call `foundry_apply_repository_update` with the unchanged prepared values. Never reconstruct tokens, bypass stale checks, include unrelated paths, or apply a changed diff.

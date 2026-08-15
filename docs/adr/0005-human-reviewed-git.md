# ADR 0005: human-reviewed Git delivery

Status: accepted.

Foundry works from an immutable base commit in a dedicated branch/worktree and may publish or update
one idempotent draft pull request per durable run. It cannot approve, merge, force-push, or write to
the protected base branch. Git identity and signing come from repository configuration.

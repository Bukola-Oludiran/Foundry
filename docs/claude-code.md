# Claude Code MCP activation

Foundry includes a project-scoped `.mcp.json` for Claude Code. It starts the same durable,
workspace-scoped MCP server used by the Codex plugin; there is no second scheduler or persistence
authority.

## Prepare and connect

From the Foundry checkout:

```bash
npm ci
cargo build --manifest-path gr-host/Cargo.toml --locked
claude mcp get foundry
```

The health check should report `Scope: Project config` and `Status: Connected`. On first use,
Claude Code asks you to approve the checked-in project server. Open `/mcp` inside Claude Code to
inspect or approve it.

By default, Claude exposes this checkout as workspace ID `foundry`. To expose other operator-approved
roots, set `FOUNDRY_WORKSPACE_ROOTS` before starting Claude Code:

```bash
export FOUNDRY_WORKSPACE_ROOTS="foundry=/absolute/path/to/Foundry,application=/absolute/path/to/application"
claude
```

All Foundry tool paths remain relative to one of those opaque workspace IDs. Keep provider, worker,
and GitHub credentials in the environment or workload secret store. Never add them to `.mcp.json`
or pass them as Foundry tool arguments.

## Verify in a session

Open `/mcp`, confirm `foundry` is connected, then ask Claude to list the Foundry tools or read
`foundry://workflows/run-durable-build`. A normal connection exposes seven tools. Use
`foundry_validate` for a read-only end-to-end check against `ir/examples/string-utils.ir.json`.

The launcher uses silent npm output because stdout is reserved exclusively for MCP frames. Server
diagnostics go to stderr. An aborted Claude tool request cancels its correlated host process tree;
stopping a durable run still requires `foundry_cancel`.

## Troubleshooting

- Run `claude mcp get foundry` for a non-interactive health check.
- Run `/mcp` to review the one-time project approval or reconnect the server.
- Run `claude --debug mcp` when startup succeeds but tools do not appear.
- Rebuild `gr-host/target/debug/foundry-host` if the Rust host is missing or stale.
- Use `FOUNDRY_HOST_BIN` only when intentionally selecting another compatible host binary.

The configuration follows Anthropic's project-scoped MCP format:
<https://code.claude.com/docs/en/mcp>.

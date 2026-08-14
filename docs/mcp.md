# Foundry MCP product reference

## Authority model

MCP is the public product boundary. A client supplies reasoning and source content; Foundry decides
what the client may see or change. Public calls use project/workspace IDs, compiler-issued target
IDs, CAS versions, content digests, and bounded leases. Raw absolute paths, shell commands, URLs,
permission expansions, and new executable acceptance harnesses are rejected.

The TypeScript server persists application state in SQLite and artifacts by SHA-256. The private
Rust sidecar owns compilation, build readiness, invalidation, verdict transitions, and cancellation.
Sidecar loss does not lose committed state: builds are reconstructed from their immutable revision
and recorded attempts.

## Workflow delivery and client compatibility

Foundry defines reusable architecture, review, build, rearchitecture, and publication workflows in
one typed registry. Each definition is projected through both an MCP prompt and a readable
`foundry://workflows/{workflowId}` resource. The server initialization instructions direct clients
to the relevant workflow resource and state the cross-tool safety rules.

Prompt-capable clients may use `prompts/list` and `prompts/get`. Clients such as current Codex CLI
that expose tools, resources, and server instructions but not MCP prompt invocation use the same
workflow through the bundled Foundry skills and workflow resources. Prompt support is therefore a
client capability, not a prerequisite for governed authoring.

The repo-local Codex plugin lives at `plugins/foundry`. It bundles the Foundry MCP registration and
four thin skills: `foundry-architect`, `foundry-build`, `foundry-rearchitecture`, and
`foundry-publish`. Skills contain only activation and safety guidance; they read canonical workflow
bodies from the server. This prevents prompt, resource, and skill behavior from drifting.

## Transports and authorization

- `npm run mcp:stdio` serves local clients and negotiates MCP `2026-07-28` or the 2025 compatibility
  era. Configure roots as `FOUNDRY_WORKSPACE_ROOTS=id=/absolute/root,id2=/another/root`; tools accept
  only the configured ID plus a relative child.
- `npm run mcp:http` serves stateless Streamable HTTP at `/mcp`. It validates Host and Origin before
  bearer authentication. Production uses `FOUNDRY_OIDC_ISSUER` and `FOUNDRY_OIDC_AUDIENCE` with an
  optional `FOUNDRY_OIDC_JWKS_URL`. `FOUNDRY_HTTP_BEARER_TOKEN` is a local-development fallback.

Scopes are `foundry:read`, `foundry:architect`, `foundry:build`, `foundry:activate`,
`foundry:publish`, and `foundry:admin`. Every project and artifact read is tenant checked.

## Architecture workflow

1. Create a project and submit its specification.
2. Begin a `solo`, `adaptive`, `architect-critic`, or `council` draft (`adaptive` is default).
   Council mode requires two to four explicit specialist roles and evidence from each role; it is
   never selected automatically.
3. Author canonical IR v2 with typed requirements, ownership, dependencies, interfaces, scenarios,
   deployment topology, states, and layout hints.
4. Validate through semantic checks and the Rust compiler.
5. Render the architecture package: PlantUML, SVG, PNG, and one frame-based Excalidraw document.
6. Supply a manual critic or use `foundry_request_architecture_review` with MCP sampling.
7. Activate with compare-and-swap. Adaptive risk signals require an approving review or an
   authorized, recorded waiver.

Excalidraw edits round-trip layout only. Elements carry semantic IDs, and imported phantom elements
are rejected. Ownership and dependency projections always remain separate.

## Build and rearchitecture

`foundry_start_build` creates durable state against an immutable revision. Source changes live in
a durable per-build overlay rather than the bound Git checkout. Ready nodes are leased;
the lease binds the client, target ID, expiration, and current file digest. A submitted complete
target is written by the network-disabled OS sandbox and tested independently. Green dependencies
unlock consumers. Red nodes have three attempts before the owning manager must rearchitect.

A subtree proposal preserves its root ID, parent owner, parent-facing interface, and parent-owned
acceptance. Unrelated nodes and write targets cannot be captured. The proposal compiles and builds
in isolation; activation requires all green, a fresh digest-bound confirmation, and an unchanged
base revision.

## Publication

Publication is separate from activation. `foundry_prepare_repository_update` records Git HEAD,
per-file before/after digests, the complete controlled diff, and a ten-minute single-use token.
It always includes canonical IR and the complete UML/Excalidraw package; when supplied an
all-green `buildId`, it also includes that build's compiler-authorized targets.
`foundry_apply_repository_update` rechecks all inputs, writes only prepared paths, preserves
unrelated dirty files, and commits the exact prepared architecture package.

## Delivery and assembly

IR v3 code publication requires a `python-library` delivery profile owned by the root integrator.
After all GraphReact nodes pass, Foundry enters `assembling`, reconstructs compiler-owned paths,
builds and installs a wheel in a clean network-disabled runtime, imports the public module outside
the source tree, and runs generated conformance tests. A build becomes green only after that gate.
Use `foundry_get_assembly_evidence` or `foundry://builds/{buildId}/assembly` for the immutable result;
red assemblies may be retried with `foundry_retry_assembly` while their authored nodes remain green.

## Verification

```bash
npm run typecheck
npm test
npm run test:mcp
npm run test:rust

# Requires local Piston at PISTON_URL
npm run test:piston
```

The MCP suite covers in-memory calls, resources, prompts, server instructions, promptless workflow
parity, structured authorization errors, stdio for both protocol eras, Streamable HTTP parity,
bearer rejection, and Origin protection. Foundry protocol conformance always tests MCP prompts
directly. Client certification records unsupported prompt invocation as `unsupported_by_client`
when the client successfully uses the equivalent instructions, workflow resource, and skill path.

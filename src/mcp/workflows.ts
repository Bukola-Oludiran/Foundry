export interface FoundryWorkflow {
  id: string;
  description: string;
  body: string;
}

export const FOUNDRY_WORKFLOWS = [
  {
    id: "architect-from-spec",
    description: "Create and validate a Foundry architecture from a product specification.",
    body: `# Architect from specification

1. Work only within a configured Foundry workspace.
2. Read the specification and current IR contract before architecting.
3. Invoke foundry_architect with the specification and a new relative output path.
4. Treat Rust schema and compiler diagnostics as authoritative.
5. Review the generated rationale and validate the resulting IR before building.

Do not publish or modify a protected base branch as part of architecture.`,
  },
  {
    id: "run-durable-build",
    description: "Start or resume a crash-recoverable GraphReact build.",
    body: `# Run a durable build

1. Validate the accepted IR.
2. Start the build with a workspace-scoped durability directory.
3. Preserve the returned run ID for status, cancellation, and publication.
4. On restart, call the same build with the same IR, base revision, and durability directory.
5. Treat durable worker effects and independent tester verdicts as authoritative.

Never edit GraphReact persistence files or accepted attempt artifacts directly.`,
  },
  {
    id: "propose-subtree-rearchitecture",
    description: "Validate a scoped architecture replacement without widening authority.",
    body: `# Propose subtree rearchitecture

1. Keep the accepted IR immutable.
2. Produce a proposal that preserves the target's parent-facing interface and parent-owned acceptance.
3. Invoke foundry_rearchitect for the failed node and inspect the structural diff.
4. Rebuild only the compiler-calculated affected closure before promotion.

Do not weaken acceptance or modify unrelated sibling subtrees.`,
  },
  {
    id: "publish-draft-review",
    description: "Publish one successful durable run as a human-reviewed draft pull request.",
    body: `# Publish a draft review

1. Confirm the durable run status is succeeded.
2. Review the accepted IR, durable evidence, exact base revision, and resulting branch.
3. Invoke foundry_publish only with draftPr=true.
4. Report the draft pull-request URL and residual risks.

Foundry must never approve, merge, force-push, or modify the protected base branch.`,
  },
] as const satisfies readonly FoundryWorkflow[];

export function findFoundryWorkflow(id: string): FoundryWorkflow | undefined {
  return FOUNDRY_WORKFLOWS.find((workflow) => workflow.id === id);
}

export function workflowResourceUri(id: string): string {
  return `foundry://workflows/${id}`;
}

export function renderFoundryWorkflow(workflow: FoundryWorkflow, resourceUri?: string): string {
  return `${workflow.body}\n\nUse Foundry MCP tools for every control-plane mutation.${resourceUri ? `\nPrimary resource: ${resourceUri}` : ""}`;
}

export const FOUNDRY_SERVER_INSTRUCTIONS = `Foundry exposes the existing durable GraphReact control plane through workspace-scoped MCP tools. Use configured workspace IDs and relative paths only. Read foundry://workflows/architect-from-spec before architecture, foundry://workflows/run-durable-build before builds, foundry://workflows/propose-subtree-rearchitecture before structural repair, and foundry://workflows/publish-draft-review before publication. Never edit durability logs or artifacts directly. Publication is draft-only and always requires human review and merge.`;

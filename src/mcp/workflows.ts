export interface FoundryWorkflow {
  id: string;
  description: string;
  body: string;
}

export const FOUNDRY_WORKFLOWS = [
  {
    id: "architect-from-spec",
    description: "Create a canonical Foundry architecture from the project specification.",
    body: `# Architect from specification

1. Read the project and immutable specification resources.
2. Begin an architecture draft. Use adaptive mode unless the caller explicitly selects another mode.
3. For a new product, begin recursive IR v5 and decompose the product mandate into nested composites until bounded implementable leaves are reached. Use subtree commands and optimistic draft versions rather than replacing the whole document.
4. Give every node typed public contracts and acceptance. Give every composite an immediate-child dependency DAG and executable integration acceptance; allocate must requirements down the tree and prove them again at the relevant composite boundaries.
5. Select only curated capability references. Declare deliverables at the composite that owns their integration. Treat deep cross-tree dependencies as reviewed exceptions attributed to their lowest common owner.
6. Treat external scenario participants as canonical deployment elements. Never add semantics through diagram layout.
7. Validate the complete recursive draft and resolve every error before rendering.
8. Render and inspect the composition tree, each composite DAG, contracts, sequences, deployment, states, and lifecycle package.
9. Satisfy any required critique with an independent review or an authorized scoped waiver.
10. Activate with the draft's base revision as the compare-and-swap expectation.

Do not publish repository changes unless the caller separately requests and confirms publication.`,
  },
  {
    id: "review-architecture",
    description: "Independently critique a Foundry architecture without rewriting it.",
    body: `# Review architecture

Read the immutable architecture revision or open draft. Evaluate requirements coverage, interface precision, ownership authority, dependency direction, acceptance ownership, scenarios, deployment and security boundaries, failure recovery, and invalidation risk. Keep ownership and dependency findings separate. Submit an evidence-backed approve or changes_requested verdict; do not rewrite the architecture while acting as the critic.`,
  },
  {
    id: "review-ownership-and-dependencies",
    description: "Review ownership and dependency graphs as distinct concerns.",
    body: `# Review ownership and dependencies

Inspect the ownership tree for a single root, explicit supervisory authority, and parent-owned acceptance. Inspect the dependency DAG separately for contract direction, cycles, unnecessary coupling, and invalid fan-in or fan-out. Report semantic IDs and concrete evidence. Never infer ownership from dependency edges or dependency direction from ownership.`,
  },
  {
    id: "review-critical-scenarios",
    description: "Review scenario completeness and interaction ordering.",
    body: `# Review critical scenarios

Read the canonical architecture and sequence projections. Confirm that each release-critical behavior has an ordered scenario, every participant is a canonical node or deployment element, messages map to typed interfaces, failure and recovery paths are represented where material, and the deployment view supports the interaction. Return specific missing or contradictory steps by semantic ID.`,
  },
  {
    id: "compare-architecture-revisions",
    description: "Compare two immutable architecture revisions.",
    body: `# Compare architecture revisions

Use the typed revision comparison and read both immutable revisions. Summarize requirement, ownership, dependency, interface, acceptance, scenario, deployment, state, and invalidation changes. Distinguish semantic changes from layout-only changes. Identify authority-sensitive changes and whether review or a waiver is required.`,
  },
  {
    id: "implement-ready-node",
    description: "Implement one leased node against fixed interfaces and acceptance.",
    body: `# Implement ready node

1. Read the build and lease only ready work.
2. Read the leased work context, canonical node path, work kind, dependency contracts, allowed read set, compiler-issued target set, base digests, and prior diagnostics.
3. Implement a ready leaf or composite glue atomically inside every issued target. Never author system-owned composite integration work. Do not introduce paths, commands, URLs, executable harnesses, or permission changes.
4. Submit a complete typed change set before the lease expires.
5. Treat the independent sandbox and Piston verdict as authoritative. On red, read the recorded attempt before deciding whether to retry or rearchitect.

Composite integration runs automatically after required child evidence and optional glue are green. Child evidence never makes a parent green by itself. Never edit the bound repository directly; publication is a separate confirmed operation.`,
  },
  {
    id: "diagnose-red-node",
    description: "Diagnose a failed node attempt from deterministic tester evidence.",
    body: `# Diagnose red node

Read the node context and all recorded attempts. Attribute each failure to the fixed contract, submitted implementation, dependency assumption, runtime, or architecture. Retry only when the implementation can satisfy the unchanged interface and acceptance within the remaining budget. When the contract or ownership boundary is the cause, begin governed subtree rearchitecture instead of weakening acceptance.`,
  },
  {
    id: "propose-subtree-rearchitecture",
    description: "Propose a replacement subtree inside M4 authority boundaries.",
    body: `# Propose subtree rearchitecture

Begin from the active immutable revision and failed target node. Preserve the target ID, parent owner, parent-facing interface, parent-owned acceptance, permissions, and unrelated subtrees. Submit a typed replacement subtree, validate its authority boundaries and invalidation set, then build it in isolation. Prepare and activate only an all-green proposal against an unchanged active revision.`,
  },
  {
    id: "review-activation-diff",
    description: "Review an activation or repository publication diff.",
    body: `# Review activation or publication diff

Read the immutable revision, manifest, build evidence, controlled path list, complete prepared diff, base Git HEAD, and blockers. Confirm semantic and artifact digests, all-green build status when implementation is included, exact compiler-authorized targets, and preservation of unrelated dirty files. Apply only the unexpired single-use confirmation produced for the exact reviewed digest.`,
  },
] as const satisfies readonly FoundryWorkflow[];

export type FoundryWorkflowId = (typeof FOUNDRY_WORKFLOWS)[number]["id"];

export function findFoundryWorkflow(id: string): FoundryWorkflow | undefined {
  return FOUNDRY_WORKFLOWS.find((workflow) => workflow.id === id);
}

export function workflowResourceUri(id: string): string {
  return `foundry://workflows/${id}`;
}

export function renderFoundryWorkflow(workflow: FoundryWorkflow, resourceUri?: string): string {
  return `${workflow.body}\n\nUse Foundry typed tools for every semantic or repository change. Diagrams are projections and cannot introduce nodes or relationships.${resourceUri ? `\nPrimary resource: ${resourceUri}` : ""}`;
}

export const FOUNDRY_SERVER_INSTRUCTIONS = `Foundry is the authoritative architecture and build engine. Use only Foundry tools for canonical state changes; never edit its SQLite data, overlays, or generated diagrams directly. Read foundry://workflows/architect-from-spec for architecture, foundry://workflows/implement-ready-node for builds, foundry://workflows/propose-subtree-rearchitecture for structural repair, and foundry://workflows/review-activation-diff before publication. Activation and repository publication are separate. Publication always requires prepare, review, and apply with the exact unexpired confirmation. Raw paths, commands, URLs, executable harnesses, and permission expansion are forbidden. Treat validation, lease, CAS, sandbox, Piston, and digest failures as authoritative.`;

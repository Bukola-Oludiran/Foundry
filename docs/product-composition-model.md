# Foundry recursive product-composition model

Status: architectural direction adopted on 2026-08-10.

Foundry is intended to embody the product division of a software company. A caller gives Foundry a
product mandate; Foundry architects the product top-down, implements its smallest trustworthy units,
integrates them bottom-up, verifies the assembled product, and prepares an evidence-backed release.

```text
product mandate
  → top-down architectural decomposition
  → leaf-level implementation
  → bottom-up integration
  → product-level verification
  → confirmed release
```

The Composite pattern is the governing abstraction. A product, application, service, package,
module, and implementation object are nodes at different levels of one recursive model. Profiles
and language adapters support that model; they are not the product architecture itself.

## Two authoritative relationships

Foundry maintains composition and dependency as separate relations.

### Composition and ownership tree

Composition answers: **what larger responsibility does this component belong to, and who may
change it?**

```text
PCBPnR Desktop Product
├── Desktop Application
│   ├── Electrobun Main Process
│   │   ├── Daemon Supervisor
│   │   ├── Workspace Manager
│   │   └── RPC Gateway
│   └── Frontend
│       ├── Board Editor
│       │   ├── KiCanvas Renderer
│       │   ├── Selection Controller
│       │   └── Placement Overlay
│       ├── DRC Panel
│       └── History Panel
├── PCBPnR Service
│   ├── M-Ingress
│   ├── Board Store
│   ├── Placement Engine
│   ├── Router
│   └── Validation Engine
└── Release System
    ├── Windows Packaging
    └── Update Manifest
```

Every non-leaf node is both a composite and an integrator. It owns the outcome produced by its
children, not merely their file locations.

### Dependency DAG

Dependency answers: **what must exist before this component can work?** A dependency does not imply
ownership.

```text
Board model ──────┐
                  ├──→ KiCanvas renderer ──→ Board editor
Selection model ──┘

RPC client ───────────→ Placement controller
Board editor ─────────→ Placement controller
Placement controller ─→ History panel
```

Each composite owns an internal dependency DAG for its children. Cross-boundary dependencies use
the public contract of the target composite; they may not reach into a sibling's implementation.
The composition tree governs authority and integration responsibility. Dependency DAGs govern
readiness, ordering, and safe parallelism.

## Top-down architecture

Foundry starts at the product mandate and recursively decomposes each composite. Every composite
must answer:

- what outcome it owns;
- which public contracts it exposes;
- which constraints it inherits from its parent;
- which children are required;
- how those children depend on one another;
- which integration evidence proves the children work together;
- whether the node is small and stable enough to implement directly.

```text
architect(product)
  architect(desktop application)
    architect(frontend)
      architect(board editor)
        define renderer leaf
        define selection leaf
        define overlay leaf
      define frontend integration contract
    architect(main process)
    define desktop integration contract
  architect(service)
  define product integration contract
```

There is no fixed decomposition depth. A node becomes a leaf when it has one coherent
responsibility, one bounded implementation scope, one owner, an independently testable contract,
and no unresolved internal architectural decision requiring separate governance.

## Bottom-up implementation and verification

Implementation reverses the architecture traversal:

```text
build leaves
  → integrate package
  → integrate frontend
  → integrate desktop application
  → integrate desktop with service
  → assemble and verify product
```

Operationally, this is a post-order fold over the composition tree:

```text
implement(child₁ … childₙ)
  → verify each child
  → integrate children
  → verify composite contract
  → emit composite evidence
```

The dependency DAG determines which siblings are ready and may execute concurrently. The
composition tree determines who integrates them, who receives a failure, and which authority may
change their shared design.

## Every composite is an integration node

The product root is not the only integrator. Integration and evidence exist at every composite
boundary:

```text
leaf tests
  → Board Editor integration
  → Frontend integration
  → Desktop integration
  → whole-product integration
```

Examples:

- if rendering and selection are independently green but disagree on coordinate systems, the
  Board Editor composite is red;
- if frontend and daemon are green but disagree on revision or RPC semantics, the Desktop
  Application composite is red;
- if all deliverables work independently but the Windows package omits `pcb-cli`, the product root
  is red.

Every composite therefore requires its own acceptance contract, integration operation, verdict,
and immutable evidence.

## Requirements descend; evidence ascends

A product requirement is progressively allocated down the ownership tree:

```text
“User can safely move a component”
  → Desktop Application owns the workflow
  → Frontend owns interaction and preview
  → PCBPnR Service owns authoritative mutation
  → Board Store owns atomic revision
```

Evidence returns through the inverse path:

```text
document transaction evidence
  → service mutation evidence
  → frontend/service integration evidence
  → desktop workflow evidence
  → product requirement satisfied
```

Foundry rejects must-level requirements that are unallocated, reach a leaf without executable
acceptance, terminate at a composite without integration evidence, or cannot be traced from the
product claim to a final observed result.

## Recursive node contract

The canonical architecture should converge on a recursive node similar to:

```text
FoundryProductNode
├── mandate
├── kind: composite | leaf
├── public contracts
├── inherited constraints
├── children
├── internal dependency DAG
├── acceptance contract
├── implementation capabilities
├── deliverables
└── evidence
```

Leaves and composites expose the same boundary shape. Their realization differs:

```text
leaf       = source targets + leaf verification
composite  = child nodes + integration definition + composite verification
```

The root is simply the highest composite: it owns the complete product mandate and release.

## Product deliverables

A product may emit several coupled artifacts. Delivery is therefore a collection owned by a
composite, not one language profile attached to the entire architecture.

```text
PCBPnR Product
├── pcb-cli.exe
├── frontend bundle
├── Electrobun desktop package
├── architecture package
└── conformance package
```

A composite is green only when all required child artifacts exist, their declared integration
relationships pass, and the composite deliverable satisfies its own assembly contract.

## Role of capabilities and profiles

Profiles remain curated verification recipes, but they attach at the level where they are useful:

```text
Leaf capabilities:
  rust-library
  rust-binary
  typescript-package
  react-component

Composite capabilities:
  bun-service
  electrobun-application
  HTTP-service
  multi-package-workspace

Root delivery capabilities:
  Windows desktop release
  hosted SaaS product
  CLI distribution
```

Reusable language adapters supply compilation, linting, unit execution, and mutation operators.
Reusable runtime and artifact capabilities supply process, browser, packaging, installation, and
platform verification. Curated profiles compose these capabilities into a stable release contract;
they must not introduce a parallel architecture hierarchy.

For example:

```text
Electrobun desktop
  = TypeScript
  + Bun main process
  + browser/webview
  + native desktop package
  + optional Rust sidecar
  + GUI verification
  + child-process lifecycle
```

## Agent organization and authority

Agent organization may mirror the product tree:

```text
Product architect
├── Desktop architect
│   ├── Frontend implementer/architect
│   └── Main-process implementer/architect
├── Service architect
└── Release architect
```

This does not require multiple agents. One connected client may traverse the entire hierarchy
sequentially. Multi-agent execution is an optional accelerator for independent siblings.

Authority follows composition:

- a leaf implementer may change only its assigned implementation;
- a composite owner may change internal composition while preserving its parent-facing contract;
- a child may not change a parent-owned contract or acceptance criterion;
- cross-composite changes escalate to the lowest common owning composite;
- changing the product mandate requires root authority;
- waivers may not bypass conformance, assembly, reproducibility, mutation, security, or
  publication-integrity gates.

## Compiler and scheduler implications

The current Foundry implementation already distinguishes ownership and dependency, but parts of
its build and delivery path flatten the hierarchy into leaf nodes plus one root integrator. The
authoritative engine must evolve to:

1. compile the recursive composition tree without losing intermediate composites;
2. validate one scoped dependency DAG per composite;
3. allocate requirements and constraints down the tree;
4. schedule ready leaf and composite-integration work in post-order;
5. attribute integration failure to the owning composite;
6. invalidate the minimal affected subtree and external consumers;
7. aggregate immutable evidence upward;
8. allow multiple deliverables within one product revision;
9. mark the root green only after every required composite and product assembly gate is green.

## Architectural invariants

- Composition forms an acyclic, single-parent ownership tree rooted at the product mandate.
- Dependency edges are acyclic within their declared scope.
- Dependency never implies ownership.
- Cross-boundary access uses public contracts rather than child internals.
- Every node has one responsible owner and a bounded mutation scope.
- Every composite has executable integration acceptance.
- Every must-level requirement is allocated to executable evidence.
- Child evidence cannot by itself satisfy a parent integration claim.
- Green propagates upward only after the current composite verifies successfully.
- Failure and invalidation propagate through compiler-derived ownership and dependency relations.
- Publication includes only evidence-backed deliverables from an accepted immutable root revision.

## Guiding statement

> Foundry architects top-down and implements bottom-up.

It recursively designs a product as an ownership/composition tree, derives dependency DAGs inside
those scopes, implements the smallest trustworthy units, and integrates evidence upward until the
complete product—not merely its files or individual services—is green.

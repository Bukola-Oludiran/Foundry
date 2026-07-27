# Dyad IR

The formal artifact an **architecture role** emits and everything downstream compiles from.
Language-neutral source of truth: [`schema.json`](schema.json) (JSON Schema 2020-12).
Worked example: [`examples/string-utils.ir.json`](examples/string-utils.ir.json).

## The atom is a dyad

Every node is `{ doer, tester }`. The doer implements `provides`; the tester verifies it against
`acceptance` via Piston. They are never the same agent, and the tester is **black-box** (it sees the
contract + outputs, not the code).

## Two graphs overlaid on one node list

The IR is a **flat list of nodes** carrying two graphs — do not conflate them:

- **Ownership TREE** — `owner` (each node names its manager; `null` only for `root`). Single parent
  per node. This is the org chart; it decides accountability and the unit of re-architecture.
- **Dependency DAG** — `requires` (each entry = a `this-node → provider-node` edge). Many consumers
  per node allowed. This decides build order and invalidation blast-radius.

A node can be a dependency for multiple upstreams (DAG fan-in) while still having exactly one owner
(tree). The compiler builds both from this one file.

## Node kinds

- **leaf** — the doer writes real code into `implementation.write_target`. Its read-set is derived
  by the compiler = every required node's `write_target`, mounted read-only (the sandbox scope).
- **integrator** — the doer writes *glue* composing `implementation.children`. Its tester verifies
  the **composed/emergent** behavior of `provides` — the altitude where interface leaks surface.

## Integrity rules the compiler enforces

1. **Oracle integrity** — `acceptance.mandate_owner` MUST be the node's `owner` (or `'spec'` for
   root), never the node's own id. The doer cannot author its own exam.
2. **Ownership is a tree** — every non-root `owner` references an existing node; an integrator's
   `implementation.children` are exactly the nodes whose `owner` is that integrator; no cycles.
3. **Dependency graph is acyclic** — every `requires` entry references a real provided interface;
   the induced `depends_on` graph passes `topological_sort` (else `DagError::CycleDetected`).
4. **Behavioral contracts** — `operations[].properties` and `acceptance` carry behavior, not just
   type signatures — the leaky-interface guard.

## Derived by the compiler (not authored)

- `depends_on` reverse-adjacency (for invalidation blast-radius).
- Each leaf's **read-set** (from `requires` → providers' `write_target`, read-only).
- Topological generations (build order; leaves first).

## Deferred to slice 2 (representation is ready now)

- **Shared-node placement** — when a node is required by multiple owners, place its ownership at the
  **LCA** of its consumers and make its `provides` the **union** of their requirements. The DAG
  representation already supports the fan-in; only the placement/union algorithm is deferred.

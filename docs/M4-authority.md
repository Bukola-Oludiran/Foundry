# M4 re-architecture authority

The manager may replace a failed node's internal ownership subtree only after the node has
exhausted its ordinary repair budget.

## Immutable boundary

- The failing subtree root's parent-facing `provides` interface remains unchanged.
- The parent-owned acceptance bundle remains unchanged.
- `mandate_owner` remains the parent (or `spec` for the root).
- Unrelated ownership subtrees are outside the mutation scope.
- Filesystem, network, and secret permissions cannot be broadened by generated IR.

## Mutable interior

Within the failed ownership subtree, the manager may:

- add, remove, or replace internal nodes;
- change internal ownership relationships;
- change internal interfaces and dependency edges;
- change implementation targets and composition;
- retain a node and revise only its implementation contract.

## Activation gate

A proposed replacement is activated only if:

1. it validates against `ir/schema.json`;
2. the compiler accepts ownership, oracle-integrity, and dependency-DAG invariants;
3. every write target resolves beneath the assigned workspace;
4. dependency changes do not reach unrelated ownership subtrees;
5. the rebuilt subtree and its dependency consumers pass their unchanged executable oracles.

Until M4 supplies a validated replacement IR, the M3 `SuperviseDecisionHook` parks the failed
child. It does not restart the identical definition and call that re-architecture.

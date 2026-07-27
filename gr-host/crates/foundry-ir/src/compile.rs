//! Deterministic IR → build-plan compiler.
//!
//! Two graphs are overlaid on one node list: an ownership TREE (`owner`) and a dependency
//! DAG (`requires`). We validate both, then lower to a [`BuildPlan`]:
//!   - `order` / `generations` — bottom-up build order (leaves first) via Kahn's algorithm.
//!   - `dependents` — the dependency-DAG adjacency (provider → consumers). One direction
//!     serves BOTH build order (topo-sort) AND invalidation (reach consumers of a change).
//!   - `read_sets` — each node's sandbox read scope (its dependencies' write-targets).
//!
//! Errors are collected (not fail-fast) so an architecture role sees every violation at once.

use crate::types::{Ir, Kind, Node};
use graphreact_algorithms::dag::{topological_generations, topological_sort, DagError, DirectedAdj};
use indexmap::IndexMap;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CompileError {
    #[error("duplicate node id `{0}`")]
    DuplicateNode(String),
    #[error("root `{0}` is not among the nodes")]
    RootNotANode(String),
    #[error("root `{root}` must have owner=null")]
    RootOwnerNotNull { root: String },
    #[error("non-root node `{0}` must declare an owner")]
    NonRootMissingOwner(String),
    #[error("node `{node}` owner `{owner}` is not a node")]
    OwnerNotANode { node: String, owner: String },
    #[error("integrator `{0}` must list children")]
    IntegratorNoChildren(String),
    #[error("leaf `{0}` must not list children")]
    LeafHasChildren(String),
    #[error("integrator `{integrator}` child `{child}` is missing or not owned by it")]
    ChildOwnerMismatch { integrator: String, child: String },
    #[error("node `{node}` requires unknown node `{dep}`")]
    RequiresUnknownNode { node: String, dep: String },
    #[error("node `{node}` requires `{interface}` from `{dep}`, which provides `{provides}`")]
    RequiresMismatch { node: String, dep: String, interface: String, provides: String },
    #[error("node `{0}` authors its own acceptance (mandate_owner == self)")]
    MandateOwnerIsSelf(String),
    #[error("node `{node}` acceptance mandate_owner `{got}` must be `{expected}`")]
    MandateOwnerMismatch { node: String, expected: String, got: String },
    #[error("node `{0}` is unreachable from root via ownership (orphan or ownership cycle)")]
    OwnershipUnreachable(String),
    #[error("dependency graph has a cycle (sorted {sorted}/{total})")]
    Cycle { sorted: usize, total: usize },
}

/// The compiled, validated plan the GraphReact host orchestrates.
#[derive(Debug, Clone)]
pub struct BuildPlan {
    /// Bottom-up build order (every node after its dependencies).
    pub order: Vec<String>,
    /// Layered build order — generation N depends only on earlier generations.
    pub generations: Vec<Vec<String>>,
    /// Dependency-DAG adjacency: provider → [consumers]. Drives invalidation.
    pub dependents: BTreeMap<String, Vec<String>>,
    /// node → [providers it depends on].
    pub dependencies: BTreeMap<String, Vec<String>>,
    /// node → [read paths] = its dependencies' write-targets (the sandbox read scope).
    pub read_sets: BTreeMap<String, Vec<String>>,
    /// node → flat module import name (hyphens → underscores).
    pub import_names: BTreeMap<String, String>,
    /// node → write-target path.
    pub write_targets: BTreeMap<String, String>,
    /// node → owner (ownership tree; None only for root).
    pub owners: BTreeMap<String, Option<String>>,
}

impl BuildPlan {
    /// Transitive consumers that must rebuild if `changed` changes (excludes `changed`).
    /// This is the re-architecture blast-radius, computed off the same DAG as build order.
    pub fn invalidation_set(&self, changed: &str) -> Vec<String> {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut q: VecDeque<String> = VecDeque::new();
        q.push_back(changed.to_string());
        while let Some(n) = q.pop_front() {
            if let Some(consumers) = self.dependents.get(&n) {
                for c in consumers {
                    if seen.insert(c.clone()) {
                        q.push_back(c.clone());
                    }
                }
            }
        }
        seen.into_iter().collect()
    }
}

fn sanitize(id: &str) -> String {
    id.replace('-', "_")
}

pub fn compile(ir: &Ir) -> Result<BuildPlan, Vec<CompileError>> {
    let mut errors: Vec<CompileError> = Vec::new();

    // Index nodes; detect duplicates.
    let mut by_id: BTreeMap<&str, &Node> = BTreeMap::new();
    for n in &ir.nodes {
        if by_id.insert(n.id.as_str(), n).is_some() {
            errors.push(CompileError::DuplicateNode(n.id.clone()));
        }
    }
    let root_exists = by_id.contains_key(ir.root.as_str());
    if !root_exists {
        errors.push(CompileError::RootNotANode(ir.root.clone()));
    }

    for n in &ir.nodes {
        // Ownership.
        if n.id == ir.root {
            if n.owner.is_some() {
                errors.push(CompileError::RootOwnerNotNull { root: n.id.clone() });
            }
        } else {
            match &n.owner {
                None => errors.push(CompileError::NonRootMissingOwner(n.id.clone())),
                Some(o) if !by_id.contains_key(o.as_str()) => {
                    errors.push(CompileError::OwnerNotANode { node: n.id.clone(), owner: o.clone() });
                }
                _ => {}
            }
        }

        // Kind ↔ children consistency.
        let children = n.implementation.children.as_ref();
        match n.kind {
            Kind::Integrator => {
                if children.map_or(true, |c| c.is_empty()) {
                    errors.push(CompileError::IntegratorNoChildren(n.id.clone()));
                } else if let Some(children) = children {
                    for c in children {
                        let owned = by_id.get(c.as_str()).is_some_and(|cn| cn.owner.as_deref() == Some(n.id.as_str()));
                        if !owned {
                            errors.push(CompileError::ChildOwnerMismatch { integrator: n.id.clone(), child: c.clone() });
                        }
                    }
                }
            }
            Kind::Leaf => {
                if children.is_some_and(|c| !c.is_empty()) {
                    errors.push(CompileError::LeafHasChildren(n.id.clone()));
                }
            }
        }

        // Oracle integrity: acceptance owned by the parent, never self.
        let mo = &n.acceptance.mandate_owner;
        if mo == &n.id {
            errors.push(CompileError::MandateOwnerIsSelf(n.id.clone()));
        } else {
            let expected = if n.id == ir.root {
                Some("spec".to_string())
            } else {
                n.owner.clone()
            };
            if let Some(expected) = expected {
                if mo != &expected {
                    errors.push(CompileError::MandateOwnerMismatch { node: n.id.clone(), expected, got: mo.clone() });
                }
            }
        }
    }

    // Dependency edges (provider → consumer) + per-node dependency list.
    let mut adj: DirectedAdj = IndexMap::new();
    for n in &ir.nodes {
        adj.insert(n.id.clone(), Vec::new());
    }
    let mut dependencies: BTreeMap<String, Vec<String>> =
        ir.nodes.iter().map(|n| (n.id.clone(), Vec::new())).collect();
    for n in &ir.nodes {
        for r in &n.requires {
            match by_id.get(r.node.as_str()) {
                None => errors.push(CompileError::RequiresUnknownNode { node: n.id.clone(), dep: r.node.clone() }),
                Some(dep) if dep.provides.name != r.interface => {
                    errors.push(CompileError::RequiresMismatch {
                        node: n.id.clone(),
                        dep: r.node.clone(),
                        interface: r.interface.clone(),
                        provides: dep.provides.name.clone(),
                    });
                }
                Some(_) => {
                    if let Some(consumers) = adj.get_mut(&r.node) {
                        consumers.push(n.id.clone());
                    }
                    if let Some(deps) = dependencies.get_mut(&n.id) {
                        deps.push(r.node.clone());
                    }
                }
            }
        }
    }

    // Ownership reachability from root (catches orphans / ownership cycles).
    if root_exists {
        let mut reached: BTreeSet<String> = BTreeSet::new();
        let mut q: VecDeque<String> = VecDeque::from([ir.root.clone()]);
        while let Some(id) = q.pop_front() {
            if !reached.insert(id.clone()) {
                continue;
            }
            if let Some(node) = by_id.get(id.as_str()) {
                if let Some(children) = &node.implementation.children {
                    for c in children {
                        if by_id.contains_key(c.as_str()) {
                            q.push_back(c.clone());
                        }
                    }
                }
            }
        }
        for n in &ir.nodes {
            if !reached.contains(&n.id) {
                errors.push(CompileError::OwnershipUnreachable(n.id.clone()));
            }
        }
    }

    // Dependency DAG must be acyclic; order = leaves first.
    let (order, generations) = match topological_sort(&adj) {
        Ok(order) => (order, topological_generations(&adj).unwrap_or_default()),
        Err(DagError::CycleDetected { sorted, total }) => {
            errors.push(CompileError::Cycle { sorted, total });
            (Vec::new(), Vec::new())
        }
    };

    if !errors.is_empty() {
        return Err(errors);
    }

    let import_names: BTreeMap<String, String> =
        ir.nodes.iter().map(|n| (n.id.clone(), sanitize(&n.id))).collect();
    let write_targets: BTreeMap<String, String> = ir
        .nodes
        .iter()
        .map(|n| (n.id.clone(), n.implementation.write_target.clone()))
        .collect();
    let owners: BTreeMap<String, Option<String>> =
        ir.nodes.iter().map(|n| (n.id.clone(), n.owner.clone())).collect();
    let dependents: BTreeMap<String, Vec<String>> =
        adj.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let read_sets: BTreeMap<String, Vec<String>> = dependencies
        .iter()
        .map(|(node, deps)| {
            let paths = deps.iter().filter_map(|d| write_targets.get(d).cloned()).collect();
            (node.clone(), paths)
        })
        .collect();

    Ok(BuildPlan {
        order,
        generations,
        dependents,
        dependencies,
        read_sets,
        import_names,
        write_targets,
        owners,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{InterfaceRef, Ir};

    fn load_example() -> Ir {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../ir/examples/string-utils.ir.json");
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        serde_json::from_str(&raw).expect("example IR parses")
    }

    #[test]
    fn compiles_example_bottom_up() {
        let ir = load_example();
        let plan = compile(&ir).expect("example compiles");
        // integrator builds last; the three leaves build first.
        assert_eq!(plan.order.last().map(String::as_str), Some("string-utils"));
        assert_eq!(plan.generations.len(), 2, "two generations: leaves then integrator");
        assert_eq!(plan.generations[1], vec!["string-utils".to_string()]);
        assert_eq!(plan.generations[0].len(), 3);
        // read-set of the integrator = the three leaves' write-targets.
        let rs = &plan.read_sets["string-utils"];
        assert_eq!(rs.len(), 3);
        assert!(rs.iter().any(|p| p.ends_with("hyphenate.py")));
        // import name sanitized.
        assert_eq!(plan.import_names["string-utils"], "string_utils");
    }

    #[test]
    fn invalidation_blast_radius_is_scoped() {
        let plan = compile(&load_example()).unwrap();
        // changing a leaf reddens only the integrator, not sibling leaves.
        assert_eq!(plan.invalidation_set("hyphenate"), vec!["string-utils".to_string()]);
        assert_eq!(plan.invalidation_set("lowercase"), vec!["string-utils".to_string()]);
        // changing the root invalidates nothing downstream (it has no consumers).
        assert!(plan.invalidation_set("string-utils").is_empty());
    }

    #[test]
    fn rejects_dependency_cycle() {
        let mut ir = load_example();
        // make a leaf depend back on the integrator → cycle.
        let lc = ir.nodes.iter_mut().find(|n| n.id == "lowercase").unwrap();
        lc.requires.push(InterfaceRef { node: "string-utils".into(), interface: "StringUtils".into() });
        let errs = compile(&ir).expect_err("cycle must be rejected");
        assert!(errs.iter().any(|e| matches!(e, CompileError::Cycle { .. })), "got {errs:?}");
    }

    #[test]
    fn rejects_self_authored_acceptance() {
        let mut ir = load_example();
        let hy = ir.nodes.iter_mut().find(|n| n.id == "hyphenate").unwrap();
        hy.acceptance.mandate_owner = "hyphenate".into(); // doer grading its own exam
        let errs = compile(&ir).expect_err("self-mandate must be rejected");
        assert!(errs.iter().any(|e| matches!(e, CompileError::MandateOwnerIsSelf(_))), "got {errs:?}");
    }
}

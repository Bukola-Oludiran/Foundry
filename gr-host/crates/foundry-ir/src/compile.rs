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
use graphreact_algorithms::dag::{
    topological_generations, topological_sort, DagError, DirectedAdj,
};
use indexmap::IndexMap;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Component, Path};

const CURRENT_IR_VERSION: u32 = 1;
const SUPPORTED_LANGUAGES: &[&str] = &["python", "typescript", "go"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CompileError {
    #[error("unsupported IR version `{got}` (expected `1`)")]
    UnsupportedVersion { got: u32 },
    #[error("spec name must not be empty")]
    EmptySpecName,
    #[error("duplicate node id `{0}`")]
    DuplicateNode(String),
    #[error("node id `{0}` is not a safe kebab-case identifier")]
    InvalidNodeId(String),
    #[error("node `{node}` has unsafe write_target `{path}`")]
    UnsafeWriteTarget { node: String, path: String },
    #[error("node `{node}` has unsafe entrypoint `{path}`")]
    UnsafeEntrypoint { node: String, path: String },
    #[error("nodes `{first}` and `{second}` share write_target `{path}`")]
    DuplicateWriteTarget {
        first: String,
        second: String,
        path: String,
    },
    #[error("node `{node}` uses unsupported language `{language}`")]
    UnsupportedLanguage { node: String, language: String },
    #[error("node `{node}` provides an empty interface")]
    EmptyInterface { node: String },
    #[error("node `{node}` has duplicate operation `{operation}`")]
    DuplicateOperation { node: String, operation: String },
    #[error("node `{node}` operation `{operation}` must have a non-empty name and signature")]
    EmptySignature { node: String, operation: String },
    #[error("node `{node}` acceptance must contain at least one case")]
    EmptyAcceptance { node: String },
    #[error("node `{node}` acceptance case `{case}` must declare exactly one of call or harness")]
    InvalidAcceptanceCase { node: String, case: String },
    #[error("node `{node}` has fields incompatible with kind `{kind}`")]
    MalformedImplementation { node: String, kind: &'static str },
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
    RequiresMismatch {
        node: String,
        dep: String,
        interface: String,
        provides: String,
    },
    #[error("node `{node}` requires unknown operation `{operation}` from `{dep}`")]
    RequiresUnknownOperation {
        node: String,
        dep: String,
        operation: String,
    },
    #[error("shared node `{node}` exposes operations not in the consumers' required union: {operations:?}")]
    SharedInterfaceOverexposed {
        node: String,
        operations: Vec<String>,
    },
    #[error("node `{0}` authors its own acceptance (mandate_owner == self)")]
    MandateOwnerIsSelf(String),
    #[error("node `{node}` acceptance mandate_owner `{got}` must be `{expected}`")]
    MandateOwnerMismatch {
        node: String,
        expected: String,
        got: String,
    },
    #[error("node `{0}` is unreachable from root via ownership (orphan or ownership cycle)")]
    OwnershipUnreachable(String),
    #[error("dependency graph has a cycle (sorted {sorted}/{total})")]
    Cycle { sorted: usize, total: usize },
    #[error("shared node `{node}` must be owned by consumers' lowest common ancestor `{expected}`, not `{got}`")]
    SharedNodeOwnerMismatch {
        node: String,
        expected: String,
        got: String,
    },
}

fn valid_node_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_lowercase() || b.is_ascii_digit() || (b == b'-' && i > 0))
        && !id.ends_with('-')
        && !id.contains("--")
}

fn safe_relative_path(raw: &str) -> bool {
    let path = Path::new(raw);
    !raw.is_empty()
        && !raw.contains('\\')
        && !raw.contains(':')
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
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

fn ownership_ancestors<'a>(start: &'a str, by_id: &BTreeMap<&'a str, &'a Node>) -> Vec<&'a str> {
    let mut result = Vec::new();
    let mut current = Some(start);
    let mut seen = BTreeSet::new();
    while let Some(id) = current {
        if !seen.insert(id) {
            break;
        }
        result.push(id);
        current = by_id.get(id).and_then(|node| node.owner.as_deref());
    }
    result.reverse();
    result
}

fn lowest_common_owner<'a>(
    consumers: &[String],
    by_id: &BTreeMap<&'a str, &'a Node>,
) -> Option<String> {
    let paths: Vec<_> = consumers
        .iter()
        .map(|consumer| ownership_ancestors(consumer, by_id))
        .collect();
    let first = paths.first()?;
    first
        .iter()
        .enumerate()
        .take_while(|(index, candidate)| {
            paths
                .iter()
                .all(|path| path.get(*index).is_some_and(|value| value == *candidate))
        })
        .last()
        .map(|(_, value)| (*value).to_owned())
}

pub fn compile(ir: &Ir) -> Result<BuildPlan, Vec<CompileError>> {
    let mut errors: Vec<CompileError> = Vec::new();

    if ir.ir_version != CURRENT_IR_VERSION {
        errors.push(CompileError::UnsupportedVersion { got: ir.ir_version });
    }
    if ir.spec.name.trim().is_empty() {
        errors.push(CompileError::EmptySpecName);
    }

    // Index nodes; detect duplicates.
    let mut by_id: BTreeMap<&str, &Node> = BTreeMap::new();
    let mut write_targets: BTreeMap<&str, &str> = BTreeMap::new();
    for n in &ir.nodes {
        if by_id.insert(n.id.as_str(), n).is_some() {
            errors.push(CompileError::DuplicateNode(n.id.clone()));
        }
        if !valid_node_id(&n.id) {
            errors.push(CompileError::InvalidNodeId(n.id.clone()));
        }
        if !safe_relative_path(&n.implementation.write_target) {
            errors.push(CompileError::UnsafeWriteTarget {
                node: n.id.clone(),
                path: n.implementation.write_target.clone(),
            });
        } else if let Some(first) = write_targets.insert(&n.implementation.write_target, &n.id) {
            errors.push(CompileError::DuplicateWriteTarget {
                first: (*first).to_string(),
                second: n.id.clone(),
                path: n.implementation.write_target.clone(),
            });
        }
        if let Some(entrypoint) = &n.implementation.entrypoint {
            if !safe_relative_path(entrypoint) {
                errors.push(CompileError::UnsafeEntrypoint {
                    node: n.id.clone(),
                    path: entrypoint.clone(),
                });
            }
        }
    }

    let root_exists = by_id.contains_key(ir.root.as_str());
    if !root_exists {
        errors.push(CompileError::RootNotANode(ir.root.clone()));
    }

    for n in &ir.nodes {
        let language = n
            .implementation
            .language
            .as_deref()
            .or(ir.spec.language.as_deref())
            .unwrap_or("python");
        if !SUPPORTED_LANGUAGES.contains(&language) {
            errors.push(CompileError::UnsupportedLanguage {
                node: n.id.clone(),
                language: language.to_string(),
            });
        }
        if !SUPPORTED_LANGUAGES.contains(&n.acceptance.language.as_str()) {
            errors.push(CompileError::UnsupportedLanguage {
                node: n.id.clone(),
                language: n.acceptance.language.clone(),
            });
        }
        if n.provides.name.trim().is_empty() || n.provides.operations.is_empty() {
            errors.push(CompileError::EmptyInterface { node: n.id.clone() });
        }
        let mut operations = BTreeSet::new();
        for operation in &n.provides.operations {
            if !operations.insert(operation.name.as_str()) {
                errors.push(CompileError::DuplicateOperation {
                    node: n.id.clone(),
                    operation: operation.name.clone(),
                });
            }
            if operation.name.trim().is_empty() || operation.signature.trim().is_empty() {
                errors.push(CompileError::EmptySignature {
                    node: n.id.clone(),
                    operation: operation.name.clone(),
                });
            }
        }
        if n.acceptance.cases.is_empty() {
            errors.push(CompileError::EmptyAcceptance { node: n.id.clone() });
        }
        for case in &n.acceptance.cases {
            if case.name.trim().is_empty()
                || case.call.is_some() == case.harness.is_some()
                || (case.call.is_some() && case.expect.is_none())
            {
                errors.push(CompileError::InvalidAcceptanceCase {
                    node: n.id.clone(),
                    case: case.name.clone(),
                });
            }
        }

        // Ownership.
        if n.id == ir.root {
            if n.owner.is_some() {
                errors.push(CompileError::RootOwnerNotNull { root: n.id.clone() });
            }
        } else {
            match &n.owner {
                None => errors.push(CompileError::NonRootMissingOwner(n.id.clone())),
                Some(o) if !by_id.contains_key(o.as_str()) => {
                    errors.push(CompileError::OwnerNotANode {
                        node: n.id.clone(),
                        owner: o.clone(),
                    });
                }
                _ => {}
            }
        }

        // Kind ↔ children consistency.
        let children = n.implementation.children.as_ref();
        match n.kind {
            Kind::Integrator => {
                if n.implementation.language.is_some() || n.implementation.entrypoint.is_some() {
                    errors.push(CompileError::MalformedImplementation {
                        node: n.id.clone(),
                        kind: "integrator",
                    });
                }
                if children.is_none_or(|c| c.is_empty()) {
                    errors.push(CompileError::IntegratorNoChildren(n.id.clone()));
                } else if let Some(children) = children {
                    for c in children {
                        let owned = by_id
                            .get(c.as_str())
                            .is_some_and(|cn| cn.owner.as_deref() == Some(n.id.as_str()));
                        if !owned {
                            errors.push(CompileError::ChildOwnerMismatch {
                                integrator: n.id.clone(),
                                child: c.clone(),
                            });
                        }
                    }
                    for owned in ir
                        .nodes
                        .iter()
                        .filter(|candidate| candidate.owner.as_deref() == Some(n.id.as_str()))
                    {
                        if !children.contains(&owned.id) {
                            errors.push(CompileError::ChildOwnerMismatch {
                                integrator: n.id.clone(),
                                child: owned.id.clone(),
                            });
                        }
                    }
                }
            }
            Kind::Leaf => {
                if n.implementation.language.is_none()
                    || children.is_some()
                    || n.implementation.composition.is_some()
                {
                    errors.push(CompileError::MalformedImplementation {
                        node: n.id.clone(),
                        kind: "leaf",
                    });
                }
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
                    errors.push(CompileError::MandateOwnerMismatch {
                        node: n.id.clone(),
                        expected,
                        got: mo.clone(),
                    });
                }
            }
        }
    }

    // Dependency edges (provider → consumer) + per-node dependency list.
    let mut adj: DirectedAdj = IndexMap::new();
    for n in &ir.nodes {
        adj.insert(n.id.clone(), Vec::new());
    }
    let mut dependencies: BTreeMap<String, Vec<String>> = ir
        .nodes
        .iter()
        .map(|n| (n.id.clone(), Vec::new()))
        .collect();
    let mut required_operations: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for n in &ir.nodes {
        for r in &n.requires {
            match by_id.get(r.node.as_str()) {
                None => errors.push(CompileError::RequiresUnknownNode {
                    node: n.id.clone(),
                    dep: r.node.clone(),
                }),
                Some(dep) if dep.provides.name != r.interface => {
                    errors.push(CompileError::RequiresMismatch {
                        node: n.id.clone(),
                        dep: r.node.clone(),
                        interface: r.interface.clone(),
                        provides: dep.provides.name.clone(),
                    });
                }
                Some(dep) => {
                    let provided: BTreeSet<_> = dep
                        .provides
                        .operations
                        .iter()
                        .map(|operation| operation.name.clone())
                        .collect();
                    let requested = if r.operations.is_empty() {
                        provided.clone()
                    } else {
                        r.operations.iter().cloned().collect()
                    };
                    for operation in requested.difference(&provided) {
                        errors.push(CompileError::RequiresUnknownOperation {
                            node: n.id.clone(),
                            dep: r.node.clone(),
                            operation: operation.clone(),
                        });
                    }
                    required_operations
                        .entry(r.node.clone())
                        .or_default()
                        .extend(requested);
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

    // A provider used across ownership branches is placed directly under the consumers'
    // lowest common owner. This keeps its implementation visible to exactly the managers
    // responsible for every consumer, without leaking it into a sibling subtree.
    for (provider, consumers) in &adj {
        if consumers.len() < 2 || provider == &ir.root {
            continue;
        }
        if let (Some(expected), Some(node)) = (
            lowest_common_owner(consumers, &by_id),
            by_id.get(provider.as_str()),
        ) {
            let got = node.owner.as_deref().unwrap_or("<none>");
            if got != expected {
                errors.push(CompileError::SharedNodeOwnerMismatch {
                    node: provider.clone(),
                    expected,
                    got: got.to_owned(),
                });
            }
            let provided: BTreeSet<_> = node
                .provides
                .operations
                .iter()
                .map(|operation| operation.name.clone())
                .collect();
            let required = required_operations
                .get(provider)
                .cloned()
                .unwrap_or_default();
            let overexposed: Vec<_> = provided.difference(&required).cloned().collect();
            if !overexposed.is_empty() {
                errors.push(CompileError::SharedInterfaceOverexposed {
                    node: provider.clone(),
                    operations: overexposed,
                });
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

    let import_names: BTreeMap<String, String> = ir
        .nodes
        .iter()
        .map(|n| (n.id.clone(), sanitize(&n.id)))
        .collect();
    let write_targets: BTreeMap<String, String> = ir
        .nodes
        .iter()
        .map(|n| (n.id.clone(), n.implementation.write_target.clone()))
        .collect();
    let owners: BTreeMap<String, Option<String>> = ir
        .nodes
        .iter()
        .map(|n| (n.id.clone(), n.owner.clone()))
        .collect();
    let dependents: BTreeMap<String, Vec<String>> =
        adj.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let read_sets: BTreeMap<String, Vec<String>> = dependencies
        .iter()
        .map(|(node, deps)| {
            let paths = deps
                .iter()
                .filter_map(|d| write_targets.get(d).cloned())
                .collect();
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
        assert_eq!(
            plan.generations.len(),
            2,
            "two generations: leaves then integrator"
        );
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
        assert_eq!(
            plan.invalidation_set("hyphenate"),
            vec!["string-utils".to_string()]
        );
        assert_eq!(
            plan.invalidation_set("lowercase"),
            vec!["string-utils".to_string()]
        );
        // changing the root invalidates nothing downstream (it has no consumers).
        assert!(plan.invalidation_set("string-utils").is_empty());
    }

    #[test]
    fn shared_provider_must_live_at_consumers_lowest_common_owner() {
        let mut ir = load_example();
        let lowercase_interface = ir
            .nodes
            .iter()
            .find(|node| node.id == "lowercase")
            .unwrap()
            .provides
            .name
            .clone();
        ir.nodes
            .iter_mut()
            .find(|node| node.id == "trim")
            .unwrap()
            .requires
            .push(InterfaceRef {
                node: "lowercase".into(),
                interface: lowercase_interface,
                operations: Vec::new(),
            });
        compile(&ir).expect("root owns the provider shared by sibling and root consumers");

        ir.nodes
            .iter_mut()
            .find(|node| node.id == "lowercase")
            .unwrap()
            .owner = Some("hyphenate".into());
        let errors = compile(&ir).expect_err("misplaced shared provider must fail");
        assert!(errors.iter().any(|error| matches!(
            error,
            CompileError::SharedNodeOwnerMismatch { node, expected, .. }
                if node == "lowercase" && expected == "string-utils"
        )));
    }

    #[test]
    fn shared_interface_is_exactly_the_required_operation_union() {
        let mut ir = load_example();
        let lowercase = ir
            .nodes
            .iter_mut()
            .find(|node| node.id == "lowercase")
            .unwrap();
        let mut internal = lowercase.provides.operations[0].clone();
        internal.name = "internal-cache-key".into();
        internal.signature = "internal_cache_key() -> string".into();
        lowercase.provides.operations.push(internal);

        for node_id in ["trim", "string-utils"] {
            let consumer = ir.nodes.iter_mut().find(|node| node.id == node_id).unwrap();
            if node_id == "trim" {
                consumer.requires.push(InterfaceRef {
                    node: "lowercase".into(),
                    interface: "Lowercase".into(),
                    operations: vec!["lower".into()],
                });
            } else {
                consumer
                    .requires
                    .iter_mut()
                    .find(|dependency| dependency.node == "lowercase")
                    .unwrap()
                    .operations = vec!["lower".into()];
            }
        }
        let errors = compile(&ir).expect_err("unused shared operations must not leak");
        assert!(errors.iter().any(|error| matches!(
            error,
            CompileError::SharedInterfaceOverexposed { node, operations }
                if node == "lowercase" && operations == &["internal-cache-key"]
        )));
    }

    #[test]
    fn rejects_dependency_cycle() {
        let mut ir = load_example();
        // make a leaf depend back on the integrator → cycle.
        let lc = ir.nodes.iter_mut().find(|n| n.id == "lowercase").unwrap();
        lc.requires.push(InterfaceRef {
            node: "string-utils".into(),
            interface: "StringUtils".into(),
            operations: Vec::new(),
        });
        let errs = compile(&ir).expect_err("cycle must be rejected");
        assert!(
            errs.iter().any(|e| matches!(e, CompileError::Cycle { .. })),
            "got {errs:?}"
        );
    }

    #[test]
    fn rejects_self_authored_acceptance() {
        let mut ir = load_example();
        let hy = ir.nodes.iter_mut().find(|n| n.id == "hyphenate").unwrap();
        hy.acceptance.mandate_owner = "hyphenate".into(); // doer grading its own exam
        let errs = compile(&ir).expect_err("self-mandate must be rejected");
        assert!(
            errs.iter()
                .any(|e| matches!(e, CompileError::MandateOwnerIsSelf(_))),
            "got {errs:?}"
        );
    }

    #[test]
    fn rejects_unsupported_ir_version() {
        let mut ir = load_example();
        ir.ir_version = 2;
        let errs = compile(&ir).expect_err("unknown versions must fail closed");
        assert!(
            errs.iter()
                .any(|e| matches!(e, CompileError::UnsupportedVersion { got: 2 })),
            "got {errs:?}"
        );
    }

    #[test]
    fn rejects_unsafe_and_duplicate_write_targets() {
        let mut ir = load_example();
        ir.nodes[0].implementation.write_target = "../outside.py".into();
        let duplicate = ir.nodes[1].implementation.write_target.clone();
        ir.nodes[2].implementation.write_target = duplicate;
        let errs = compile(&ir).expect_err("unsafe and overlapping targets must fail");
        assert!(
            errs.iter()
                .any(|e| matches!(e, CompileError::UnsafeWriteTarget { .. })),
            "got {errs:?}"
        );
        assert!(
            errs.iter()
                .any(|e| matches!(e, CompileError::DuplicateWriteTarget { .. })),
            "got {errs:?}"
        );
    }

    #[test]
    fn rejects_unsupported_language_and_duplicate_operations() {
        let mut ir = load_example();
        let node = &mut ir.nodes[0];
        node.implementation.language = Some("ruby".into());
        node.provides
            .operations
            .push(node.provides.operations[0].clone());
        let errs =
            compile(&ir).expect_err("unsupported backends and ambiguous interfaces must fail");
        assert!(
            errs.iter()
                .any(|e| matches!(e, CompileError::UnsupportedLanguage { .. })),
            "got {errs:?}"
        );
        assert!(
            errs.iter()
                .any(|e| matches!(e, CompileError::DuplicateOperation { .. })),
            "got {errs:?}"
        );
    }

    #[test]
    fn serde_rejects_unknown_fields() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../ir/examples/string-utils.ir.json");
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        value["unexpected"] = serde_json::json!(true);
        let err =
            serde_json::from_value::<Ir>(value).expect_err("unknown fields must not be ignored");
        assert!(err.to_string().contains("unknown field"), "got {err}");
    }

    #[test]
    fn rejects_fields_from_the_wrong_implementation_variant() {
        let mut ir = load_example();
        let leaf = ir
            .nodes
            .iter_mut()
            .find(|node| node.kind == Kind::Leaf)
            .unwrap();
        leaf.implementation.children = Some(Vec::new());
        let root = ir
            .nodes
            .iter_mut()
            .find(|node| node.kind == Kind::Integrator)
            .unwrap();
        root.implementation.language = Some("python".into());
        let errs = compile(&ir).expect_err("Rust loading must enforce the schema union");
        assert_eq!(
            errs.iter()
                .filter(|error| matches!(error, CompileError::MalformedImplementation { .. }))
                .count(),
            2,
            "got {errs:?}"
        );
    }
}

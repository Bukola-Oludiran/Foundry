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
    RequiresMismatch {
        node: String,
        dep: String,
        interface: String,
        provides: String,
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
    #[error("node `{node}` has invalid repository-relative write target `{target}`")]
    InvalidWriteTarget { node: String, target: String },
    #[error("nodes `{first}` and `{second}` share write target `{target}`")]
    DuplicateWriteTarget { first: String, second: String, target: String },
    #[error("scenario `{scenario}` references unknown endpoint `{endpoint}`")]
    DanglingScenarioEndpoint { scenario: String, endpoint: String },
    #[error("deployment link references unknown deployment node `{0}`")]
    DanglingDeploymentEndpoint(String),
    #[error("state model `{model}` references unknown state `{state}`")]
    DanglingState { model: String, state: String },
    #[error("layout `{view}` references unknown semantic element `{element}`")]
    PhantomLayoutElement { view: String, element: String },
    #[error("IR v3 requires a python-library delivery profile owned by the root integrator")]
    InvalidDeliveryProfile,
    #[error("must requirement `{0}` has no acceptance coverage reference")]
    UncoveredRequirement(String),
    #[error("IR v4 node `{0}` must use typed acceptance scenarios and no executable cases")]
    InvalidTypedAcceptance(String),
    #[error("IR v4 scenario `{scenario}` step `{step}` references unknown operation `{operation}` on node `{node}`")]
    UnknownAcceptanceOperation { node: String, scenario: String, step: String, operation: String },
    #[error("IR v4 scenario `{scenario}` step `{step}` references unknown handle `{handle}`")]
    UnknownAcceptanceHandle { scenario: String, step: String, handle: String },
    #[error("IR v4 scenario `{scenario}` contains a duplicate step or handle `{id}`")]
    DuplicateAcceptanceIdentity { scenario: String, id: String },
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
    /// True when `order` contains recursive implementation/integration work IDs.
    pub product: bool,
    /// work id → canonical v5 node path (legacy maps node id to itself).
    pub node_paths: BTreeMap<String, String>,
    /// work id → implementation|integration.
    pub work_kinds: BTreeMap<String, String>,
    /// work id → client|system.
    pub work_actors: BTreeMap<String, String>,
    /// canonical node path → direct child paths.
    pub children: BTreeMap<String, Vec<String>>,
    /// canonical node path → recursive invalidation set.
    pub node_invalidation: BTreeMap<String, Vec<String>>,
    /// deliverable id → owning canonical node path.
    pub deliverables: BTreeMap<String, String>,
}

impl BuildPlan {
    /// Transitive consumers that must rebuild if `changed` changes (excludes `changed`).
    /// This is the re-architecture blast-radius, computed off the same DAG as build order.
    pub fn invalidation_set(&self, changed: &str) -> Vec<String> {
        if let Some(product) = self.node_invalidation.get(changed) { return product.clone(); }
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

fn collect_refs(value: &serde_json::Value, refs: &mut Vec<String>) {
    match value {
        serde_json::Value::Array(items) => for item in items { collect_refs(item, refs); },
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(reference)) = map.get("$ref") { refs.push(reference.clone()); }
            else if !map.contains_key("$type") { for item in map.values() { collect_refs(item, refs); } }
        }
        _ => {}
    }
}

pub fn compile(ir: &Ir) -> Result<BuildPlan, Vec<CompileError>> {
    let mut errors: Vec<CompileError> = Vec::new();

    // Index nodes; detect duplicates.
    let mut by_id: BTreeMap<&str, &Node> = BTreeMap::new();
    let mut target_owners: BTreeMap<String, String> = BTreeMap::new();
    for n in &ir.nodes {
        for declared in n.implementation.all_targets(&n.id) {
        let target = std::path::Path::new(&declared.path);
        let valid_target = !declared.path.is_empty() && !target.is_absolute() && target.components().all(|part| matches!(part, std::path::Component::Normal(_)));
        if !valid_target { errors.push(CompileError::InvalidWriteTarget { node: n.id.clone(), target: declared.path.clone() }); }
        else if let Some(first) = target_owners.insert(declared.path.clone(), n.id.clone()) { errors.push(CompileError::DuplicateWriteTarget { first, second: n.id.clone(), target: declared.path.clone() }); }
        }
        if by_id.insert(n.id.as_str(), n).is_some() {
            errors.push(CompileError::DuplicateNode(n.id.clone()));
        }
    }
    if matches!(ir.version, Some(3) | Some(4)) {
        let valid = ir.delivery.as_ref().is_some_and(|delivery| ((delivery.profile == "python-library" && delivery.dependency_policy == "none") || (delivery.profile == "python-service" && delivery.dependency_policy == "locked" && delivery.lockfile_target_id.is_some() && delivery.service_entrypoint_target_id.is_some() && delivery.entrypoint.is_some() && delivery.health_route.as_deref().is_some_and(|route| route.starts_with('/')) && delivery.persistence.as_ref().is_some_and(|persistence| persistence.engine == "sqlite" && persistence.schema_version > 0) && delivery.migration_operation_id.is_some() && delivery.readiness_operation_id.is_some())) && delivery.integration_node == ir.root && delivery.runtime.language == "python") && by_id.get(ir.root.as_str()).is_some_and(|root| root.kind == Kind::Integrator);
        if !valid { errors.push(CompileError::InvalidDeliveryProfile); }
        let covered: BTreeSet<&str> = if ir.version == Some(4) {
            ir.nodes.iter().flat_map(|node| node.acceptance.scenarios.iter()).flat_map(|scenario| scenario.covers.iter().map(String::as_str)).collect()
        } else {
            ir.nodes.iter().flat_map(|node| node.acceptance.cases.iter()).flat_map(|case| case.covers.iter().map(String::as_str)).collect()
        };
        for requirement in ir.requirements.iter().filter(|requirement| requirement.priority.as_deref() == Some("must")) { if !covered.contains(requirement.id.as_str()) { errors.push(CompileError::UncoveredRequirement(requirement.id.clone())); } }
    }
    let root_exists = by_id.contains_key(ir.root.as_str());
    if !root_exists {
        errors.push(CompileError::RootNotANode(ir.root.clone()));
    }

    let deployment_ids: BTreeSet<&str> = ir.deployment.as_ref().map(|deployment| deployment.nodes.iter().map(|node| node.id.as_str()).collect()).unwrap_or_default();
    let mut semantic_ids: BTreeSet<String> = by_id.keys().map(|id| (*id).to_string()).chain(deployment_ids.iter().map(|id| (*id).to_string())).collect();
    for scenario in &ir.scenarios { for step in &scenario.steps { for endpoint in [&step.from, &step.to] { if !semantic_ids.contains(endpoint) { errors.push(CompileError::DanglingScenarioEndpoint { scenario: scenario.id.clone(), endpoint: endpoint.clone() }); } } } }
    if let Some(deployment) = &ir.deployment { for link in &deployment.links { for endpoint in [&link.from, &link.to] { if !deployment_ids.contains(endpoint.as_str()) { errors.push(CompileError::DanglingDeploymentEndpoint(endpoint.clone())); } } } }
    for model in &ir.state_models { let states: BTreeSet<&str> = model.states.iter().map(String::as_str).collect(); semantic_ids.extend(model.states.iter().map(|state| format!("{}:{}", model.id, state))); if !states.contains(model.initial.as_str()) { errors.push(CompileError::DanglingState { model: model.id.clone(), state: model.initial.clone() }); } for transition in &model.transitions { for state in [&transition.from, &transition.to] { if !states.contains(state.as_str()) { errors.push(CompileError::DanglingState { model: model.id.clone(), state: state.clone() }); } } } }
    semantic_ids.extend(["pending", "ready", "leased", "verifying", "green", "red", "contract_weak", "infrastructure_blocked", "rearchitecture", "cancelled"].into_iter().map(|state| format!("build:{state}")));
    for view in &ir.layouts { for element in view.positions.keys() { if !semantic_ids.contains(element) { errors.push(CompileError::PhantomLayoutElement { view: view.view_id.clone(), element: element.clone() }); } } }

    for n in &ir.nodes {
        if ir.version == Some(4) {
            if !n.acceptance.cases.is_empty() || n.acceptance.scenarios.is_empty() { errors.push(CompileError::InvalidTypedAcceptance(n.id.clone())); }
            let operation_names: BTreeSet<&str> = n.provides.operations.iter().map(|operation| operation.name.as_str()).collect();
            let mut scenario_ids = BTreeSet::new();
            for scenario in &n.acceptance.scenarios {
                if !scenario_ids.insert(scenario.id.as_str()) { errors.push(CompileError::DuplicateAcceptanceIdentity { scenario: scenario.id.clone(), id: scenario.id.clone() }); }
                let mut step_ids = BTreeSet::new(); let mut handles = BTreeSet::new();
                for step in &scenario.steps {
                    if !step_ids.insert(step.id.as_str()) { errors.push(CompileError::DuplicateAcceptanceIdentity { scenario: scenario.id.clone(), id: step.id.clone() }); }
                    if !operation_names.contains(step.operation.as_str()) { errors.push(CompileError::UnknownAcceptanceOperation { node: n.id.clone(), scenario: scenario.id.clone(), step: step.id.clone(), operation: step.operation.clone() }); }
                    if let Some(receiver) = &step.receiver { if !handles.contains(receiver.as_str()) { errors.push(CompileError::UnknownAcceptanceHandle { scenario: scenario.id.clone(), step: step.id.clone(), handle: receiver.clone() }); } }
                    let mut refs = Vec::new(); for argument in &step.arguments { collect_refs(argument, &mut refs); }
                    for reference in refs { if !handles.contains(reference.as_str()) { errors.push(CompileError::UnknownAcceptanceHandle { scenario: scenario.id.clone(), step: step.id.clone(), handle: reference }); } }
                    if let Some(bind) = &step.bind { if !handles.insert(bind.as_str()) { errors.push(CompileError::DuplicateAcceptanceIdentity { scenario: scenario.id.clone(), id: bind.clone() }); } }
                }
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
                if children.map_or(true, |c| c.is_empty()) {
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

    let import_names: BTreeMap<String, String> = ir
        .nodes
        .iter()
        .map(|n| (n.id.clone(), sanitize(&n.id)))
        .collect();
    let write_targets: BTreeMap<String, String> = ir
        .nodes
        .iter()
        .map(|n| (n.id.clone(), n.implementation.primary_target()))
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
        product: false,
        node_paths: ir.nodes.iter().map(|node| (node.id.clone(), node.id.clone())).collect(),
        work_kinds: ir.nodes.iter().map(|node| (node.id.clone(), "implementation".to_string())).collect(),
        work_actors: ir.nodes.iter().map(|node| (node.id.clone(), "client".to_string())).collect(),
        children: ir.nodes.iter().map(|node| (node.id.clone(), node.implementation.children.clone().unwrap_or_default())).collect(),
        node_invalidation: BTreeMap::new(),
        deliverables: BTreeMap::new(),
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
    fn rejects_dependency_cycle() {
        let mut ir = load_example();
        // make a leaf depend back on the integrator → cycle.
        let lc = ir.nodes.iter_mut().find(|n| n.id == "lowercase").unwrap();
        lc.requires.push(InterfaceRef {
            node: "string-utils".into(),
            interface: "StringUtils".into(),
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
    fn rejects_unsafe_and_overlapping_write_targets() {
        let mut ir = load_example();
        ir.nodes[0].implementation.write_target = "../escape.py".into();
        let errors = compile(&ir).unwrap_err();
        assert!(errors.iter().any(|error| matches!(error, CompileError::InvalidWriteTarget { .. })));

        let mut ir = load_example();
        ir.nodes[1].implementation.write_target = ir.nodes[0].implementation.write_target.clone();
        let errors = compile(&ir).unwrap_err();
        assert!(errors.iter().any(|error| matches!(error, CompileError::DuplicateWriteTarget { .. })));
    }

    #[test]
    fn rejects_phantom_v2_semantics() {
        let mut ir = load_example();
        ir.scenarios.push(crate::types::Scenario { id: "bad".into(), name: "Bad".into(), critical: true, steps: vec![crate::types::ScenarioStep { from: "phantom".into(), to: ir.root.clone(), message: "call".into(), order: 0 }] });
        ir.layouts.push(crate::types::ViewLayout { view_id: "ownership".into(), positions: BTreeMap::from([("phantom".into(), crate::types::LayoutBox { x: 0.0, y: 0.0, width: None, height: None })]) });
        let errors = compile(&ir).unwrap_err(); assert!(errors.iter().any(|error| matches!(error, CompileError::DanglingScenarioEndpoint { .. }))); assert!(errors.iter().any(|error| matches!(error, CompileError::PhantomLayoutElement { .. })));
    }

    #[test]
    fn v3_requires_delivery_and_must_requirement_coverage() {
        let mut ir = load_example(); ir.version = Some(3); ir.requirements.push(crate::types::Requirement { id: "release".into(), kind: "constraint".into(), text: "package is importable".into(), priority: Some("must".into()) });
        let errors = compile(&ir).unwrap_err();
        assert!(errors.iter().any(|error| matches!(error, CompileError::InvalidDeliveryProfile)));
        assert!(errors.iter().any(|error| matches!(error, CompileError::UncoveredRequirement(id) if id == "release")));
    }

    #[test]
    fn v4_rejects_executable_cases_and_unknown_typed_operations() {
        let mut ir = load_example(); ir.version = Some(4);
        for node in &mut ir.nodes {
            node.acceptance.cases.clear();
            node.acceptance.scenarios = vec![crate::types::AcceptanceScenario { id: "typed".into(), name: "typed".into(), covers: vec![], steps: vec![crate::types::AcceptanceStep { id: "call".into(), operation: "missing".into(), receiver: None, arguments: vec![], bind: None, expect: None }] }];
        }
        let errors = compile(&ir).unwrap_err();
        assert!(errors.iter().any(|error| matches!(error, CompileError::UnknownAcceptanceOperation { .. })));
        ir.nodes[0].acceptance.cases.push(crate::types::TestCase { name: "legacy".into(), call: Some("unsafe()".into()), expect: None, harness: None, covers: vec![] });
        let errors = compile(&ir).unwrap_err();
        assert!(errors.iter().any(|error| matches!(error, CompileError::InvalidTypedAcceptance(_))));
    }
}

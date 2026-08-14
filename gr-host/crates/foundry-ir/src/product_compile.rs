//! IR v5 recursive product compiler. The nested tree remains canonical; this module
//! derives a work graph for GraphReact without erasing composite integration boundaries.

use crate::compile::BuildPlan;
use crate::types::{ProductArchitectureV5, ProductNode, ProductNodeKind};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_DEPTH: usize = 16;
const MAX_NODES: usize = 2048;
const MAX_CHILDREN: usize = 128;
const MAX_EXCEPTIONS: usize = 64;
const CAPABILITIES: &[&str] = &["python-library", "python-service", "rust-library", "rust-binary", "typescript-package", "node-service", "process-contract", "http-contract", "artifact-bundle", "mixed-rust-node-product"];

#[derive(Clone)]
struct IndexedNode { node: ProductNode, parent: Option<String> }

fn target_valid(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.contains('\\') && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn node_final(path: &str, node: &ProductNode) -> String { match node.kind { ProductNodeKind::Leaf => format!("{path}:implementation"), ProductNodeKind::Composite => format!("{path}:integration") } }
fn implementation_work(path: &str) -> String { format!("{path}:implementation") }
fn integration_work(path: &str) -> String { format!("{path}:integration") }

fn entry_work(path: &str, nodes: &BTreeMap<String, IndexedNode>, node_dependencies: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let Some(indexed) = nodes.get(path) else { return Vec::new() };
    match indexed.node.kind {
        ProductNodeKind::Leaf => vec![implementation_work(path)],
        ProductNodeKind::Composite => {
            let child_paths: Vec<String> = indexed.node.children.iter().map(|child| format!("{path}/{}", child.id)).collect();
            let ready: Vec<String> = child_paths.iter().filter(|child| node_dependencies.get(*child).is_none_or(Vec::is_empty)).cloned().collect();
            if ready.is_empty() && child_paths.is_empty() && indexed.node.integration.as_ref().and_then(|integration| integration.glue.as_ref()).is_some() { vec![implementation_work(path)] }
            else { ready.into_iter().flat_map(|child| entry_work(&child, nodes, node_dependencies)).collect() }
        }
    }
}

fn topo(dependencies: &BTreeMap<String, Vec<String>>, dependents: &BTreeMap<String, Vec<String>>) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    let mut degree: BTreeMap<String, usize> = dependencies.iter().map(|(id, deps)| (id.clone(), deps.len())).collect();
    let mut ready: Vec<String> = degree.iter().filter_map(|(id, degree)| (*degree == 0).then_some(id.clone())).collect();
    let mut order = Vec::new(); let mut generations = Vec::new();
    while !ready.is_empty() {
        ready.sort(); generations.push(ready.clone()); let mut next = Vec::new();
        for id in ready { order.push(id.clone()); for consumer in dependents.get(&id).cloned().unwrap_or_default() { let value = degree.get_mut(&consumer).expect("consumer indexed"); *value -= 1; if *value == 0 { next.push(consumer); } } }
        ready = next;
    }
    if order.len() != dependencies.len() { Err(format!("combined recursive work graph contains a cycle (sorted {}/{})", order.len(), dependencies.len())) } else { Ok((order, generations)) }
}

pub fn compile_product(ir: &ProductArchitectureV5) -> Result<BuildPlan, Vec<String>> {
    let mut errors = Vec::new();
    if ir.version != 5 { errors.push("recursive product compiler requires IR version 5".into()); }
    let mut nodes: BTreeMap<String, IndexedNode> = BTreeMap::new(); let mut targets: BTreeMap<String, String> = BTreeMap::new(); let mut deliverables = BTreeMap::new(); let mut exception_count = 0usize;
    fn walk(node: &ProductNode, parent: Option<String>, depth: usize, nodes: &mut BTreeMap<String, IndexedNode>, targets: &mut BTreeMap<String, String>, deliverables: &mut BTreeMap<String, String>, exception_count: &mut usize, errors: &mut Vec<String>) {
        let path = parent.as_ref().map_or_else(|| node.id.clone(), |parent| format!("{parent}/{}", node.id));
        if node.id.is_empty() || !node.id.chars().next().is_some_and(|ch| ch.is_ascii_lowercase()) || !node.id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-') { errors.push(format!("invalid canonical node segment `{}`", node.id)); }
        if depth > MAX_DEPTH { errors.push(format!("node `{path}` exceeds maximum depth {MAX_DEPTH}")); }
        if nodes.insert(path.clone(), IndexedNode { node: node.clone(), parent: parent.clone() }).is_some() { errors.push(format!("duplicate canonical node path `{path}`")); }
        let mut contracts = BTreeSet::new(); let mut operations = BTreeSet::new(); for contract in &node.contracts { if !contracts.insert(contract.id.clone()) { errors.push(format!("node `{path}` repeats contract `{}`", contract.id)); } for operation in &contract.operations { if !operations.insert(operation.name.clone()) { errors.push(format!("node `{path}` repeats operation `{}`", operation.name)); } } }
        for scenario in &node.acceptance { for step in &scenario.steps { if !operations.contains(&step.operation) { errors.push(format!("node `{path}` acceptance cannot resolve operation `{}`", step.operation)); } } }
        for capability in &node.capability_refs { if capability.version != "1.0.0" || !CAPABILITIES.contains(&capability.id.as_str()) { errors.push(format!("node `{path}` references unknown capability `{}@{}`", capability.id, capability.version)); } }
        let implementations = node.implementation.iter().chain(node.integration.as_ref().and_then(|integration| integration.glue.as_ref()));
        for implementation in implementations { let mut target_ids = BTreeSet::new(); for target in &implementation.targets { if !target_ids.insert(target.target_id.clone()) { errors.push(format!("node `{path}` repeats target id `{}`", target.target_id)); } if !target_valid(&target.path) { errors.push(format!("node `{path}` has invalid target `{}`", target.path)); } if let Some(first) = targets.insert(target.path.clone(), path.clone()) { errors.push(format!("nodes `{first}` and `{path}` overlap target `{}`", target.path)); } } if implementation.primary_target_id.as_ref().is_some_and(|id| !target_ids.contains(id)) { errors.push(format!("node `{path}` primary target is not declared")); } }
        match node.kind {
            ProductNodeKind::Leaf => { if node.implementation.as_ref().is_none_or(|implementation| implementation.targets.is_empty()) { errors.push(format!("leaf `{path}` requires implementation targets")); } if !node.children.is_empty() || node.integration.is_some() { errors.push(format!("leaf `{path}` declares composition state")); } }
            ProductNodeKind::Composite => { if node.children.is_empty() { errors.push(format!("composite `{path}` requires children")); } if node.children.len() > MAX_CHILDREN { errors.push(format!("composite `{path}` exceeds {MAX_CHILDREN} children")); } if node.integration.as_ref().is_none_or(|integration| integration.scenarios.is_empty()) { errors.push(format!("composite `{path}` requires integration scenarios")); } if node.implementation.is_some() { errors.push(format!("composite `{path}` must put glue under integration.glue")); } let child_operations: BTreeSet<String> = node.children.iter().flat_map(|child| child.contracts.iter().flat_map(|contract| contract.operations.iter().map(|operation| operation.name.clone()))).collect(); for scenario in node.integration.iter().flat_map(|integration| &integration.scenarios) { for step in &scenario.steps { if !operations.contains(&step.operation) && !child_operations.contains(&step.operation) { errors.push(format!("composite `{path}` integration cannot resolve operation `{}`", step.operation)); } } } }
        }
        for deliverable in &node.deliverables { if deliverables.insert(deliverable.deliverable_id.clone(), path.clone()).is_some() { errors.push(format!("duplicate deliverable `{}`", deliverable.deliverable_id)); } if !CAPABILITIES.contains(&deliverable.capability_ref.id.as_str()) { errors.push(format!("deliverable `{}` uses unknown capability", deliverable.deliverable_id)); } }
        *exception_count += node.dependency_exceptions.len();
        for child in &node.children { walk(child, Some(path.clone()), depth + 1, nodes, targets, deliverables, exception_count, errors); }
    }
    walk(&ir.product, None, 0, &mut nodes, &mut targets, &mut deliverables, &mut exception_count, &mut errors);
    if nodes.len() > MAX_NODES { errors.push(format!("product exceeds {MAX_NODES} nodes")); }
    if exception_count > MAX_EXCEPTIONS { errors.push(format!("product exceeds {MAX_EXCEPTIONS} dependency exceptions")); }

    let mut node_dependencies: BTreeMap<String, Vec<String>> = nodes.keys().map(|path| (path.clone(), Vec::new())).collect();
    let mut node_dependents: BTreeMap<String, Vec<String>> = nodes.keys().map(|path| (path.clone(), Vec::new())).collect();
    for (path, indexed) in &nodes {
        if indexed.node.kind != ProductNodeKind::Composite { continue; }
        let child_paths: BTreeSet<String> = indexed.node.children.iter().map(|child| format!("{path}/{}", child.id)).collect();
        for edge in &indexed.node.dependencies {
            let provider = format!("{path}/{}", edge.provider); let consumer = format!("{path}/{}", edge.consumer);
            if !child_paths.contains(&provider) || !child_paths.contains(&consumer) || provider == consumer { errors.push(format!("composite `{path}` dependency must join distinct immediate children")); continue; }
            if !nodes.get(&provider).is_some_and(|node| node.node.contracts.iter().any(|contract| contract.id == edge.contract_id)) { errors.push(format!("provider `{provider}` does not expose `{}`", edge.contract_id)); continue; }
            node_dependencies.get_mut(&consumer).unwrap().push(provider.clone()); node_dependents.get_mut(&provider).unwrap().push(consumer);
        }
        for edge in &indexed.node.dependency_exceptions {
            let common = lowest_common(&edge.provider_path, &edge.consumer_path);
            if !nodes.contains_key(&edge.provider_path) || !nodes.contains_key(&edge.consumer_path) { errors.push(format!("dependency exception under `{path}` references unknown nodes")); continue; }
            if edge.reason.trim().is_empty() || edge.review_id.is_none() || common != *path || edge.responsible_owner_path != *path { errors.push(format!("dependency exception under `{path}` requires reason, independent review, and lowest-common-owner attribution")); }
            if !nodes.get(&edge.provider_path).is_some_and(|node| node.node.contracts.iter().any(|contract| contract.id == edge.contract_id)) { errors.push(format!("exception provider `{}` does not expose `{}`", edge.provider_path, edge.contract_id)); }
            node_dependencies.get_mut(&edge.consumer_path).unwrap().push(edge.provider_path.clone()); node_dependents.get_mut(&edge.provider_path).unwrap().push(edge.consumer_path.clone());
        }
    }
    for values in node_dependencies.values_mut() { values.sort(); values.dedup(); } for values in node_dependents.values_mut() { values.sort(); values.dedup(); }

    let must: BTreeSet<String> = ir.requirements.iter().filter(|requirement| requirement.priority.as_deref() == Some("must")).map(|requirement| requirement.id.clone()).collect();
    let mut executable = BTreeSet::new();
    for (path, indexed) in &nodes {
        let scenario_ids: BTreeSet<String> = indexed.node.acceptance.iter().chain(indexed.node.integration.iter().flat_map(|integration| &integration.scenarios)).map(|scenario| scenario.id.clone()).collect();
        for scenario in indexed.node.acceptance.iter().chain(indexed.node.integration.iter().flat_map(|integration| &integration.scenarios)) { executable.extend(scenario.covers.iter().cloned()); }
        for allocation in &indexed.node.allocations { if allocation.targets.is_empty() { errors.push(format!("allocation `{}` at `{path}` requires targets", allocation.requirement_id)); } if allocation.integration_scenario_ids.iter().any(|id| !scenario_ids.contains(id)) { errors.push(format!("allocation `{}` at `{path}` references unknown integration scenario", allocation.requirement_id)); } if !allocation.integration_scenario_ids.is_empty() { executable.insert(allocation.requirement_id.clone()); } }
    }
    for requirement in must { if !executable.contains(&requirement) { errors.push(format!("must requirement `{requirement}` has no executable recursive allocation")); } }

    let mut dependencies: BTreeMap<String, Vec<String>> = BTreeMap::new(); let mut work_kinds = BTreeMap::new(); let mut work_actors = BTreeMap::new(); let mut node_paths = BTreeMap::new(); let mut write_targets = BTreeMap::new(); let mut owners = BTreeMap::new();
    for (path, indexed) in &nodes {
        let has_glue = indexed.node.integration.as_ref().and_then(|integration| integration.glue.as_ref()).is_some_and(|glue| !glue.targets.is_empty());
        if indexed.node.kind == ProductNodeKind::Leaf || has_glue {
            let work = implementation_work(path); dependencies.insert(work.clone(), Vec::new()); work_kinds.insert(work.clone(), "implementation".into()); work_actors.insert(work.clone(), "client".into()); node_paths.insert(work.clone(), path.clone()); owners.insert(work.clone(), indexed.parent.clone());
            let implementation = indexed.node.implementation.as_ref().or_else(|| indexed.node.integration.as_ref().and_then(|integration| integration.glue.as_ref())).unwrap(); write_targets.insert(work, implementation.primary_target());
        }
        if indexed.node.kind == ProductNodeKind::Composite { let work = integration_work(path); dependencies.insert(work.clone(), Vec::new()); work_kinds.insert(work.clone(), "integration".into()); work_actors.insert(work.clone(), "system".into()); node_paths.insert(work.clone(), path.clone()); owners.insert(work.clone(), indexed.parent.clone()); write_targets.insert(work, String::new()); }
    }
    for (path, indexed) in &nodes {
        if indexed.node.kind != ProductNodeKind::Composite { continue; }
        let child_finals: Vec<String> = indexed.node.children.iter().map(|child| { let child_path = format!("{path}/{}", child.id); node_final(&child_path, &nodes[&child_path].node) }).collect();
        let integration = integration_work(path); dependencies.get_mut(&integration).unwrap().extend(child_finals.iter().cloned());
        if indexed.node.integration.as_ref().and_then(|integration| integration.glue.as_ref()).is_some_and(|glue| !glue.targets.is_empty()) { let glue = implementation_work(path); dependencies.get_mut(&glue).unwrap().extend(child_finals); dependencies.get_mut(&integration).unwrap().push(glue); }
    }
    for (consumer, providers) in &node_dependencies { for provider in providers { let provider_final = node_final(provider, &nodes[provider].node); for entry in entry_work(consumer, &nodes, &node_dependencies) { dependencies.get_mut(&entry).unwrap().push(provider_final.clone()); } } }
    for values in dependencies.values_mut() { values.sort(); values.dedup(); }
    let mut dependents: BTreeMap<String, Vec<String>> = dependencies.keys().map(|id| (id.clone(), Vec::new())).collect(); for (consumer, providers) in &dependencies { for provider in providers { dependents.get_mut(provider).unwrap().push(consumer.clone()); } } for values in dependents.values_mut() { values.sort(); }
    let (order, generations) = match topo(&dependencies, &dependents) { Ok(value) => value, Err(error) => { errors.push(error); (Vec::new(), Vec::new()) } };

    if !errors.is_empty() { return Err(errors); }
    let mut node_invalidation = BTreeMap::new();
    for changed in nodes.keys() {
        let mut affected = BTreeSet::new(); let mut cursor = Some(changed.clone()); while let Some(path) = cursor { affected.insert(path.clone()); cursor = nodes.get(&path).and_then(|node| node.parent.clone()); }
        let mut queue = VecDeque::from([changed.clone()]); while let Some(path) = queue.pop_front() { for consumer in node_dependents.get(&path).cloned().unwrap_or_default() { if affected.insert(consumer.clone()) { queue.push_back(consumer.clone()); } let mut owner = nodes.get(&consumer).and_then(|node| node.parent.clone()); while let Some(path) = owner { affected.insert(path.clone()); owner = nodes.get(&path).and_then(|node| node.parent.clone()); } } }
        affected.remove(changed); node_invalidation.insert(changed.clone(), affected.into_iter().collect());
    }
    let read_sets = dependencies.iter().map(|(work, providers)| (work.clone(), providers.iter().filter_map(|provider| write_targets.get(provider)).filter(|path| !path.is_empty()).cloned().collect())).collect();
    let import_names = node_paths.iter().map(|(work, path)| (work.clone(), path.replace(['-', '/', ':'], "_"))).collect();
    let children = nodes.iter().map(|(path, indexed)| (path.clone(), indexed.node.children.iter().map(|child| format!("{path}/{}", child.id)).collect())).collect();
    Ok(BuildPlan { order, generations, dependents, dependencies, read_sets, import_names, write_targets, owners, product: true, node_paths, work_kinds, work_actors, children, node_invalidation, deliverables })
}

fn lowest_common(a: &str, b: &str) -> String { a.split('/').zip(b.split('/')).take_while(|(left, right)| left == right).map(|(part, _)| part).collect::<Vec<_>>().join("/") }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recursive_work_is_post_order_and_composites_integrate() {
        let raw = include_str!("../../../../fixtures/hash-relay/foundry-v5.ir.json");
        let ir: ProductArchitectureV5 = serde_json::from_str(raw).unwrap(); let plan = compile_product(&ir).unwrap();
        assert!(plan.product); assert!(plan.order.iter().position(|id| id == "hash-relay/engine/checksum-core:implementation") < plan.order.iter().position(|id| id == "hash-relay/engine:integration"));
        assert_eq!(plan.work_actors["hash-relay/engine:integration"], "system"); assert!(plan.invalidation_set("hash-relay/engine/checksum-core").contains(&"hash-relay".into()));
    }
}

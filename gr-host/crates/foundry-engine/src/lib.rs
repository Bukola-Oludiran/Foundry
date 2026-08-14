//! Transport-neutral authority used by both the legacy CLI and the MCP sidecar.

use foundry_ir::{compile, compile_product, types::{Architecture, Ir}, BuildPlan};
use graphreact_core::{use_message, Attrs, ChildSpec, CommunicationGraph, NodeContext, NodeDefinition, PermissionManifest, RestartPolicy, RestartStrategy, RestartTracker, Scheduler, Supervisor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeVerdict {
    Pending,
    WaitingChildren,
    Ready,
    Leased,
    Verifying,
    Green,
    Red,
    ContractWeak,
    InfrastructureBlocked,
    IntegrationReady,
    Integrating,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssemblyVerdict { Pending, Running, Green, Red, Cancelled }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializableBuildPlan {
    pub order: Vec<String>,
    pub generations: Vec<Vec<String>>,
    pub dependents: BTreeMap<String, Vec<String>>,
    pub dependencies: BTreeMap<String, Vec<String>>,
    pub read_sets: BTreeMap<String, Vec<String>>,
    pub import_names: BTreeMap<String, String>,
    pub write_targets: BTreeMap<String, String>,
    pub owners: BTreeMap<String, Option<String>>,
    pub product: bool,
    pub node_paths: BTreeMap<String, String>,
    pub work_kinds: BTreeMap<String, String>,
    pub work_actors: BTreeMap<String, String>,
    pub children: BTreeMap<String, Vec<String>>,
    pub node_invalidation: BTreeMap<String, Vec<String>>,
    pub deliverables: BTreeMap<String, String>,
}

impl From<&BuildPlan> for SerializableBuildPlan {
    fn from(plan: &BuildPlan) -> Self {
        Self {
            order: plan.order.clone(),
            generations: plan.generations.clone(),
            dependents: plan.dependents.clone(),
            dependencies: plan.dependencies.clone(),
            read_sets: plan.read_sets.clone(),
            import_names: plan.import_names.clone(),
            write_targets: plan.write_targets.clone(),
            owners: plan.owners.clone(),
            product: plan.product,
            node_paths: plan.node_paths.clone(),
            work_kinds: plan.work_kinds.clone(),
            work_actors: plan.work_actors.clone(),
            children: plan.children.clone(),
            node_invalidation: plan.node_invalidation.clone(),
            deliverables: plan.deliverables.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildState {
    pub build_id: String,
    pub architecture_revision: String,
    pub plan: SerializableBuildPlan,
    pub nodes: BTreeMap<String, NodeVerdict>,
    pub cancelled: bool,
    pub assembly: AssemblyVerdict,
}

impl BuildState {
    pub fn new(build_id: String, architecture_revision: String, plan: &BuildPlan) -> Self {
        let mut state = Self {
            build_id,
            architecture_revision,
            plan: plan.into(),
            nodes: plan.order.iter().map(|id| (id.clone(), if plan.product { NodeVerdict::WaitingChildren } else { NodeVerdict::Pending })).collect(),
            cancelled: false,
            assembly: AssemblyVerdict::Pending,
        };
        state.refresh_ready();
        state
    }

    pub fn ready_nodes(&self) -> Vec<String> {
        self.plan.order.iter().filter(|id| self.nodes.get(*id) == Some(&NodeVerdict::Ready)).cloned().collect()
    }

    pub fn set_verdict(&mut self, node: &str, verdict: NodeVerdict) -> Result<(), EngineError> {
        if self.cancelled {
            return Err(EngineError::BuildCancelled(self.build_id.clone()));
        }
        if !self.nodes.contains_key(node) {
            return Err(EngineError::UnknownNode(node.to_string()));
        }
        self.nodes.insert(node.to_string(), verdict);
        Ok(())
    }

    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.assembly = AssemblyVerdict::Cancelled;
        for verdict in self.nodes.values_mut() {
            if !matches!(verdict, NodeVerdict::Green | NodeVerdict::Red) {
                *verdict = NodeVerdict::Cancelled;
            }
        }
    }

    fn refresh_ready(&mut self) {
        if self.cancelled { return; }
        let green: BTreeSet<String> = self.nodes.iter().filter_map(|(id, state)| (*state == NodeVerdict::Green).then_some(id.clone())).collect();
        for id in &self.plan.order {
            if !matches!(self.nodes.get(id), Some(NodeVerdict::Pending | NodeVerdict::WaitingChildren)) { continue; }
            let deps = self.plan.dependencies.get(id).map(Vec::as_slice).unwrap_or(&[]);
            if deps.iter().all(|dep| green.contains(dep.as_str())) {
                let next = if self.plan.work_actors.get(id).is_some_and(|actor| actor == "system") { NodeVerdict::IntegrationReady } else { NodeVerdict::Ready };
                self.nodes.insert(id.clone(), next);
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("IR did not compile: {0}")]
    InvalidIr(String),
    #[error("unknown build `{0}`")]
    UnknownBuild(String),
    #[error("unknown node `{0}`")]
    UnknownNode(String),
    #[error("build `{0}` is cancelled")]
    BuildCancelled(String),
    #[error("GraphReact scheduler failed: {0}")]
    Scheduler(String),
}

struct BuildRuntime {
    state: BuildState,
    scheduler: Scheduler,
    newly_ready: Rc<RefCell<BTreeSet<String>>>,
}

fn graph_runtime(state: BuildState) -> BuildRuntime {
    let mut scheduler = Scheduler::new(CommunicationGraph::new());
    let newly_ready = Rc::new(RefCell::new(BTreeSet::new()));
    let mut supervisors = BTreeMap::new();
    for manager in state.plan.owners.values().map(|owner| owner.clone().unwrap_or_else(|| "spec".into())).collect::<BTreeSet<_>>() {
        supervisors.insert(manager, scheduler.install_supervisor(Supervisor::new(RestartStrategy::OneForOne, RestartTracker::new(3, Duration::from_secs(60)))));
    }
    for node_id in state.plan.order.iter().rev() {
        let dependencies = state.plan.dependencies.get(node_id).cloned().unwrap_or_default();
        let seen: Rc<RefCell<BTreeSet<String>>> = Rc::new(RefCell::new(BTreeSet::new()));
        let ready = Rc::clone(&newly_ready);
        let id = node_id.clone();
        let definition = NodeDefinition::new(format!("mcp-dyad:{id}"), move |_ctx: &NodeContext| {
            let deps = dependencies.clone(); let seen = Rc::clone(&seen); let ready = Rc::clone(&ready); let id = id.clone();
            use_message("dependency-green", move |message| {
                let Some(provider) = message.payload.get("provider").and_then(Value::as_str) else { return; };
                if !deps.iter().any(|dependency| dependency == provider) { return; }
                seen.borrow_mut().insert(provider.to_string());
                if deps.iter().all(|dependency| seen.borrow().contains(dependency)) { ready.borrow_mut().insert(id.clone()); }
            });
            PermissionManifest::new(["dependency-green"], std::iter::empty::<&str>())
        });
        let manager = state.plan.owners.get(node_id).and_then(Clone::clone).unwrap_or_else(|| "spec".into());
        scheduler.supervise(supervisors[&manager], ChildSpec { id: node_id.clone(), policy: RestartPolicy::Permanent, definition, props: Attrs::new(), connect_to: state.plan.dependents.get(node_id).cloned().unwrap_or_default(), height: 0 }).expect("compiled GraphReact dyad mounts");
    }
    BuildRuntime { state, scheduler, newly_ready }
}

#[derive(Default)]
pub struct Engine {
    builds: BTreeMap<String, BuildRuntime>,
}

impl Engine {
    pub fn compile_ir(&self, ir: &Ir) -> Result<BuildPlan, EngineError> {
        compile(ir).map_err(|errors| EngineError::InvalidIr(errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ")))
    }

    pub fn compile_architecture(&self, architecture: &Architecture) -> Result<BuildPlan, EngineError> {
        match architecture {
            Architecture::Legacy(ir) => self.compile_ir(ir),
            Architecture::Product(ir) => compile_product(ir).map_err(|errors| EngineError::InvalidIr(errors.join("; "))),
        }
    }

    pub fn start_build(&mut self, build_id: String, revision: String, ir: &Ir) -> Result<BuildState, EngineError> {
        let plan = self.compile_ir(ir)?;
        let state = BuildState::new(build_id.clone(), revision, &plan);
        self.builds.insert(build_id, graph_runtime(state.clone()));
        Ok(state)
    }

    pub fn start_architecture(&mut self, build_id: String, revision: String, architecture: &Architecture) -> Result<BuildState, EngineError> {
        let plan = self.compile_architecture(architecture)?;
        let state = BuildState::new(build_id.clone(), revision, &plan);
        self.builds.insert(build_id, graph_runtime(state.clone()));
        Ok(state)
    }

    pub fn build(&self, build_id: &str) -> Result<&BuildState, EngineError> {
        self.builds.get(build_id).map(|runtime| &runtime.state).ok_or_else(|| EngineError::UnknownBuild(build_id.to_string()))
    }

    pub fn record_node(&mut self, build_id: &str, node: &str, verdict: NodeVerdict) -> Result<BuildState, EngineError> {
        let runtime = self.builds.get_mut(build_id).ok_or_else(|| EngineError::UnknownBuild(build_id.to_string()))?;
        runtime.state.set_verdict(node, verdict.clone())?;
        if verdict == NodeVerdict::Green {
            for consumer in runtime.state.plan.dependents.get(node).cloned().unwrap_or_default() { runtime.scheduler.send(&consumer, "dependency-green", serde_json::json!({"provider": node})); }
            runtime.scheduler.process_batch().map_err(|error| EngineError::Scheduler(error.to_string()))?;
            let ready: Vec<String> = runtime.newly_ready.borrow_mut().iter().cloned().collect(); runtime.newly_ready.borrow_mut().clear();
            for id in ready { if runtime.state.nodes.get(&id) == Some(&NodeVerdict::Pending) { runtime.state.nodes.insert(id, NodeVerdict::Ready); } }
        }
        runtime.state.refresh_ready();
        Ok(runtime.state.clone())
    }

    pub fn record_assembly(&mut self, build_id: &str, verdict: AssemblyVerdict) -> Result<BuildState, EngineError> {
        let runtime = self.builds.get_mut(build_id).ok_or_else(|| EngineError::UnknownBuild(build_id.to_string()))?;
        if runtime.state.cancelled { return Err(EngineError::BuildCancelled(build_id.to_string())); }
        if !runtime.state.nodes.values().all(|node| *node == NodeVerdict::Green) { return Err(EngineError::InvalidIr("assembly requires every authored node green".into())); }
        runtime.state.assembly = verdict; Ok(runtime.state.clone())
    }

    pub fn cancel(&mut self, build_id: &str) -> Result<BuildState, EngineError> {
        let runtime = self.builds.get_mut(build_id).ok_or_else(|| EngineError::UnknownBuild(build_id.to_string()))?;
        runtime.state.cancel();
        Ok(runtime.state.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> Ir {
        serde_json::from_str(include_str!("../../../../ir/examples/string-utils.ir.json")).unwrap()
    }

    #[test]
    fn advances_only_after_dependencies_are_green() {
        let mut engine = Engine::default();
        let mut state = engine.start_build("b1".into(), "r1".into(), &example()).unwrap();
        assert_eq!(state.ready_nodes().len(), 3);
        for leaf in state.ready_nodes() {
            state = engine.record_node("b1", &leaf, NodeVerdict::Green).unwrap();
        }
        assert_eq!(state.ready_nodes(), vec!["string-utils"]);
    }

    #[test]
    fn cancellation_is_terminal() {
        let mut engine = Engine::default();
        engine.start_build("b1".into(), "r1".into(), &example()).unwrap();
        let state = engine.cancel("b1").unwrap();
        assert!(state.cancelled);
        assert!(engine.record_node("b1", "trim", NodeVerdict::Green).is_err());
    }
}

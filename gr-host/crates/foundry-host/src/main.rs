//! Foundry control-plane host.
//!
//! Compiles a dyad IR into a `BuildPlan`, materializes it as a real `graphreact-core`
//! graph (one supervised node per dyad, dependency edges), and runs a bottom-up build:
//! each dyad is a scheduler node whose `build` handler drives the pi-pool (`/build` +
//! `/test`) over HTTP with **node-level retry-with-feedback** (a red verdict is fed back
//! to the doer, which repairs). Green providers emit targeted `dependency-green` messages;
//! consumers build only after every declared provider is green. Exhausted failures become
//! abnormal supervised exits and are parked by the M4 decision hook for re-architecture.
//!
//! With `--rearchitect <node>`, after the initial build it performs a **scoped
//! re-architecture**: rebuild only `{node} ∪ invalidation_set(node)` in topological order,
//! proving the blast radius is scoped by construction — sibling branches are never touched.
//!
//! Usage: foundry-host --ir <path> [--pi-pool URL] [--workspace DIR] [--rearchitect NODE]

mod http;
use http::http_post_json;

use foundry_ir::types::{Ir, Kind, Node};
use foundry_ir::BuildPlan;
use foundry_engine::Engine;
use graphreact_core::{
    use_emit, use_message, Attrs, ChildSpec, CommunicationGraph, EmitOptions, ExitReason,
    MessageDelivered, NodeContext, NodeDefinition, NodeMounted, PermissionManifest, RestartPolicy,
    RestartStrategy, RestartTracker, Scheduler, SuperviseDecision, Supervisor, SupervisorKey,
    TelemetrySink,
};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX_RETRIES: u32 = 3;
const BUILD_MESSAGE: &str = "build";
const DEPENDENCY_GREEN_MESSAGE: &str = "dependency-green";

#[derive(Clone, PartialEq, Eq, Debug)]
enum Verdict {
    Pending,
    Green,
    Red(String),
    Error(String),
}

struct Job {
    build_req: Value,
    test_req: Value,
}

struct AuditSink {
    events: AtomicU64,
    supervisor_decisions: AtomicU64,
}
impl TelemetrySink for AuditSink {
    fn on_message_delivered(&self, ev: &MessageDelivered<'_>) {
        self.events.fetch_add(1, Ordering::Relaxed);
        if matches!(ev.message_type, BUILD_MESSAGE | DEPENDENCY_GREEN_MESSAGE) {
            println!(
                "   [telemetry] {} → {:<14} ({})",
                ev.message_type,
                ev.to,
                if ev.accepted { "accepted" } else { "REJECTED" }
            );
        }
    }
    fn on_node_mounted(&self, ev: &NodeMounted<'_>) {
        println!("   [telemetry] mounted dyad {}", ev.node_id);
    }
    fn on_supervisor_decision(&self, ev: &graphreact_core::SupervisorDecisionMade<'_>) {
        self.supervisor_decisions.fetch_add(1, Ordering::Relaxed);
        println!(
            "   [telemetry] supervisor {:?}: {} ({})",
            ev.action, ev.failed_id, ev.reason
        );
    }
}

/// One dyad build attempt: POST /build (with attempt+feedback) then POST /test.
fn build_once(job: &Job, base: &str, attempt: u32, feedback: &Value) -> Verdict {
    let mut br = job.build_req.clone();
    br["attempt"] = json!(attempt);
    br["feedback"] = feedback.clone();
    match http_post_json(base, "/build", &br) {
        Err(e) => return Verdict::Error(format!("build: {e}")),
        Ok(v) => {
            if !v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Verdict::Red(format!(
                    "build failed: {}",
                    v.get("error").and_then(Value::as_str).unwrap_or("?")
                ));
            }
        }
    }
    match http_post_json(base, "/test", &job.test_req) {
        Err(e) => Verdict::Error(format!("test: {e}")),
        Ok(v) => {
            if v.get("verdict").and_then(Value::as_str) == Some("green") {
                Verdict::Green
            } else {
                Verdict::Red(
                    v.get("failures")
                        .map(std::string::ToString::to_string)
                        .unwrap_or_default(),
                )
            }
        }
    }
}

/// Node-level repair: retry with the tester's feedback until green or the budget is spent.
/// Returns the final verdict and the number of attempts made.
fn build_with_retry(
    nid: &str,
    jobs: &HashMap<String, Job>,
    base: &str,
    counts: &RefCell<HashMap<String, u32>>,
) -> (Verdict, u32) {
    let Some(job) = jobs.get(nid) else {
        return (Verdict::Error("no job".into()), 0);
    };
    let mut feedback = Value::Null;
    let mut last = Verdict::Pending;
    for attempt in 1..=MAX_RETRIES {
        *counts.borrow_mut().entry(nid.to_string()).or_insert(0) += 1;
        last = build_once(job, base, attempt, &feedback);
        match &last {
            Verdict::Green => return (Verdict::Green, attempt),
            Verdict::Red(detail) => feedback = json!(detail),
            Verdict::Error(_) => return (last, attempt),
            Verdict::Pending => {}
        }
    }
    (last, MAX_RETRIES)
}

#[allow(clippy::too_many_arguments)]
fn dyad_definition(
    nid: String,
    dependencies: Vec<String>,
    consumers: Vec<String>,
    jobs: Rc<HashMap<String, Job>>,
    base: Rc<String>,
    verdicts: Rc<RefCell<HashMap<String, Verdict>>>,
    counts: Rc<RefCell<HashMap<String, u32>>>,
    ready: Rc<RefCell<HashMap<String, BTreeSet<String>>>>,
    triggered: Rc<RefCell<HashSet<String>>>,
    completion_order: Rc<RefCell<Vec<String>>>,
) -> NodeDefinition {
    NodeDefinition::new(format!("dyad:{nid}"), move |_ctx: &NodeContext| {
        let emit = use_emit();
        let run_build = {
            let nid = nid.clone();
            let consumers = consumers.clone();
            let jobs = Rc::clone(&jobs);
            let base = Rc::clone(&base);
            let verdicts = Rc::clone(&verdicts);
            let counts = Rc::clone(&counts);
            let triggered = Rc::clone(&triggered);
            let completion_order = Rc::clone(&completion_order);
            Rc::new(move || {
                triggered.borrow_mut().insert(nid.clone());
                let (verdict, attempts) = build_with_retry(&nid, &jobs, &base, &counts);
                if attempts > 1 && verdict == Verdict::Green {
                    println!(
                        "   ↻ {nid} repaired after {attempts} attempts (tester feedback supplied to doer)"
                    );
                }
                if verdict == Verdict::Green {
                    completion_order.borrow_mut().push(nid.clone());
                    if !consumers.is_empty() {
                        emit(
                            DEPENDENCY_GREEN_MESSAGE,
                            json!({ "provider": nid }),
                            EmitOptions {
                                to: Some(consumers.clone()),
                                ..EmitOptions::default()
                            },
                        );
                    }
                }
                verdicts.borrow_mut().insert(nid.clone(), verdict);
            })
        };

        {
            let run_build = Rc::clone(&run_build);
            use_message(BUILD_MESSAGE, move |_msg| run_build());
        }

        {
            let nid = nid.clone();
            let dependencies = dependencies.clone();
            let ready = Rc::clone(&ready);
            let triggered = Rc::clone(&triggered);
            let run_build = Rc::clone(&run_build);
            use_message(DEPENDENCY_GREEN_MESSAGE, move |msg| {
                let Some(provider) = msg.payload.get("provider").and_then(Value::as_str) else {
                    return;
                };
                if !dependencies.iter().any(|dep| dep == provider) {
                    return;
                }
                ready
                    .borrow_mut()
                    .entry(nid.clone())
                    .or_default()
                    .insert(provider.to_string());
                let all_ready = {
                    let state = ready.borrow();
                    let seen = state.get(&nid);
                    dependencies
                        .iter()
                        .all(|dep| seen.is_some_and(|providers| providers.contains(dep)))
                };
                if all_ready && !triggered.borrow().contains(&nid) {
                    run_build();
                }
            });
        }

        PermissionManifest::new(
            [BUILD_MESSAGE, DEPENDENCY_GREEN_MESSAGE],
            [DEPENDENCY_GREEN_MESSAGE],
        )
    })
}

fn build_jobs(ir: &Ir, plan: &BuildPlan, ws: &str) -> HashMap<String, Job> {
    let by_id: HashMap<&str, &Node> = ir.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let default_lang = ir
        .spec
        .language
        .clone()
        .unwrap_or_else(|| "python".to_string());
    let mut jobs = HashMap::new();
    for n in &ir.nodes {
        let lang = n
            .implementation
            .language
            .clone()
            .unwrap_or_else(|| default_lang.clone());
        let provides = serde_json::to_value(&n.provides).unwrap_or(Value::Null);
        let requires: Vec<Value> = n
            .requires
            .iter()
            .map(|r| {
                json!({
                    "node": r.node,
                    "interface": by_id.get(r.node.as_str()).map(|d| serde_json::to_value(&d.provides).unwrap_or(Value::Null)),
                    "import_name": plan.import_names.get(&r.node),
                    "read_path": plan.write_targets.get(&r.node),
                })
            })
            .collect();
        let children: Vec<Value> = n
            .implementation
            .children
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|c| json!({ "node": c, "import_name": plan.import_names.get(c), "read_path": plan.write_targets.get(c) }))
            .collect();
        let deps: Vec<Value> = n
            .requires
            .iter()
            .map(|r| json!({ "import_name": plan.import_names.get(&r.node), "read_path": plan.write_targets.get(&r.node) }))
            .collect();
        let kind = match n.kind {
            Kind::Leaf => "leaf",
            Kind::Integrator => "integrator",
        };
        let build_req = json!({
            "node_id": n.id, "kind": kind, "language": lang, "workspace": ws,
            "write_target": n.implementation.write_target, "provides": provides.clone(),
            "requires": requires, "composition": n.implementation.composition,
            "children": children, "attempt": 1, "feedback": Value::Null,
        });
        let test_req = json!({
            "node_id": n.id, "language": lang, "workspace": ws,
            "write_target": n.implementation.write_target, "provides": provides,
            "acceptance": serde_json::to_value(&n.acceptance).unwrap_or(Value::Null), "deps": deps,
        });
        jobs.insert(
            n.id.clone(),
            Job {
                build_req,
                test_req,
            },
        );
    }
    jobs
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn report(node: &str, verdict: &Verdict) -> bool {
    match verdict {
        Verdict::Green => {
            println!("   GREEN {node}");
            true
        }
        Verdict::Pending => {
            println!("   BLOCKED {node}  ← waiting for green dependencies");
            false
        }
        other => {
            println!("   RED   {node}  ← {other:?}");
            false
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(ir_path) = arg(&args, "--ir") else {
        eprintln!("usage: foundry-host --ir <path> [--pi-pool URL] [--workspace DIR] [--rearchitect NODE]");
        std::process::exit(2);
    };
    let base = arg(&args, "--pi-pool").unwrap_or_else(|| "http://127.0.0.1:8787".to_string());
    let ws = arg(&args, "--workspace").unwrap_or_else(|| {
        std::env::temp_dir()
            .join("foundry-ws")
            .to_string_lossy()
            .into_owned()
    });
    let rearchitect = arg(&args, "--rearchitect");

    let raw = std::fs::read_to_string(&ir_path).unwrap_or_else(|e| {
        eprintln!("read {ir_path}: {e}");
        std::process::exit(1);
    });
    let ir: Ir = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("parse IR: {e}");
        std::process::exit(1);
    });
    let plan = Engine::default().compile_ir(&ir).unwrap_or_else(|error| {
        eprintln!("IR did not compile: {error}");
        std::process::exit(1);
    });
    std::fs::create_dir_all(format!("{ws}/src")).ok();

    println!("Foundry host: {} ({} nodes)", ir.spec.name, ir.nodes.len());
    println!("  build order:  {}", plan.order.join(" → "));
    println!("  workspace:    {ws}");
    println!("  pi-pool:      {base}");

    let jobs = Rc::new(build_jobs(&ir, &plan, &ws));
    let verdicts: Rc<RefCell<HashMap<String, Verdict>>> = Rc::new(RefCell::new(
        ir.nodes
            .iter()
            .map(|n| (n.id.clone(), Verdict::Pending))
            .collect(),
    ));
    let counts: Rc<RefCell<HashMap<String, u32>>> = Rc::new(RefCell::new(HashMap::new()));
    let ready: Rc<RefCell<HashMap<String, BTreeSet<String>>>> =
        Rc::new(RefCell::new(HashMap::new()));
    let triggered: Rc<RefCell<HashSet<String>>> = Rc::new(RefCell::new(HashSet::new()));
    let completion_order: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let base = Rc::new(base);

    let mut scheduler = Scheduler::new(CommunicationGraph::new());
    let sink = Arc::new(AuditSink {
        events: AtomicU64::new(0),
        supervisor_decisions: AtomicU64::new(0),
    });
    scheduler.install_telemetry_sink(sink.clone());

    // M4 authority boundary: a red dyad is removed as an abnormal exit, but the
    // supervisor parks the restart until a replacement subtree IR has been produced
    // and validated. Restarting the identical definition would only disguise failure.
    let owners_for_hook = Arc::new(plan.owners.clone());
    scheduler.install_supervise_decision_hook(Arc::new(move |_sup, failed_id, reason| {
        let manager = owners_for_hook
            .get(failed_id)
            .and_then(Clone::clone)
            .unwrap_or_else(|| "spec".to_string());
        println!(
            "   [supervision] manager {manager} owns failure {failed_id}: {:?}; parked for conservative M4 re-architecture",
            reason
        );
        SuperviseDecision::Defer {
            reason: format!(
                "awaiting validated subtree IR from manager {manager}; parent interface and acceptance remain fixed"
            ),
            retry_after: None,
        }
    }));

    // One real GraphReact supervisor per manager. The root is governed by the
    // synthetic `spec` manager; every other node is governed by its IR owner.
    let manager_ids: BTreeSet<String> = ir
        .nodes
        .iter()
        .map(|n| n.owner.clone().unwrap_or_else(|| "spec".to_string()))
        .collect();
    let mut supervisors: HashMap<String, SupervisorKey> = HashMap::new();
    for manager in manager_ids {
        let key = scheduler.install_supervisor(Supervisor::new(
            RestartStrategy::OneForOne,
            RestartTracker::new(3, Duration::from_secs(60)),
        ));
        supervisors.insert(manager, key);
    }

    // Mount consumers before providers so each provider can connect to all of its
    // already-live consumers. Build execution still goes in the opposite direction,
    // driven exclusively by dependency-green messages.
    for nid in plan.order.iter().rev() {
        let node = ir
            .nodes
            .iter()
            .find(|n| &n.id == nid)
            .expect("compiled node exists");
        let manager = node.owner.clone().unwrap_or_else(|| "spec".to_string());
        let definition = dyad_definition(
            nid.clone(),
            plan.dependencies.get(nid).cloned().unwrap_or_default(),
            plan.dependents.get(nid).cloned().unwrap_or_default(),
            Rc::clone(&jobs),
            Rc::clone(&base),
            Rc::clone(&verdicts),
            Rc::clone(&counts),
            Rc::clone(&ready),
            Rc::clone(&triggered),
            Rc::clone(&completion_order),
        );
        scheduler
            .supervise(
                supervisors[&manager],
                ChildSpec {
                    id: nid.clone(),
                    policy: RestartPolicy::Permanent,
                    definition,
                    props: Attrs::new(),
                    connect_to: plan.dependents.get(nid).cloned().unwrap_or_default(),
                    height: 0,
                },
            )
            .unwrap_or_else(|e| panic!("supervise dyad {nid} under {manager}: {e}"));
    }

    println!(
        "  supervision: {} managers govern {} dyads",
        scheduler.supervisor_count(),
        ir.nodes.len()
    );

    // ---- initial bottom-up build ----
    println!(
        "\n== message-gated bottom-up build ({} dependency generations) ==",
        plan.generations.len()
    );
    for node in plan
        .order
        .iter()
        .filter(|id| plan.dependencies.get(*id).is_none_or(Vec::is_empty))
    {
        scheduler.send(node.as_str(), BUILD_MESSAGE, Value::Null);
    }
    scheduler.process_batch().expect("message-gated build");

    println!(
        "\n  observed completion order: {}",
        completion_order.borrow().join(" → ")
    );
    let mut failed = false;
    for node in &plan.order {
        let verdict = verdicts
            .borrow()
            .get(node)
            .cloned()
            .unwrap_or(Verdict::Pending);
        if !report(node, &verdict) {
            failed = true;
        }
    }
    if failed {
        // Turn exhausted red/error verdicts into real abnormal exits. The installed
        // decision hook deliberately parks their restart pending M4's validated IR.
        let failed_nodes: Vec<(String, Verdict)> = verdicts
            .borrow()
            .iter()
            .filter(|(_, verdict)| matches!(verdict, Verdict::Red(_) | Verdict::Error(_)))
            .map(|(id, verdict)| (id.clone(), verdict.clone()))
            .collect();
        for (node, verdict) in failed_nodes {
            if let Some(key) = scheduler.key_for(&node) {
                scheduler.unmount_with_reason(
                    key,
                    ExitReason::Crashed {
                        detail: format!("dyad exhausted repair budget: {verdict:?}"),
                    },
                );
            }
        }
        scheduler
            .process_batch()
            .expect("record deferred supervision decisions");
        println!("\n❌ build did not reach green");
        std::process::exit(1);
    }
    println!("\n✅ initial build: ALL GREEN");

    // ---- manual scoped rebuild (M4 will replace this with subtree IR mutation) ----
    if let Some(target) = rearchitect {
        if !plan.order.iter().any(|n| n == &target) {
            eprintln!("--rearchitect: unknown node `{target}`");
            std::process::exit(1);
        }
        println!("\n== manual scoped rebuild: {target} ==");
        // Blast radius = the node itself + its transitive consumers, in build order.
        let mut set: Vec<String> = std::iter::once(target.clone())
            .chain(plan.invalidation_set(&target))
            .collect();
        set.sort_by_key(|n| plan.order.iter().position(|x| x == n).unwrap_or(usize::MAX));
        let untouched: Vec<String> = plan
            .order
            .iter()
            .filter(|id| !set.contains(id))
            .cloned()
            .collect();
        println!("   blast radius (invalidation_set):  [{}]", set.join(", "));
        println!(
            "   NOT rebuilt (out of scope):       [{}]",
            untouched.join(", ")
        );

        let counts_before = counts.borrow().clone();
        let mut rearch_failed = false;
        for node in &set {
            verdicts.borrow_mut().insert(node.clone(), Verdict::Pending);
            scheduler.send(node.as_str(), "build", Value::Null);
            scheduler.process_batch().expect("process_batch");
            let verdict = verdicts
                .borrow()
                .get(node)
                .cloned()
                .unwrap_or(Verdict::Pending);
            if !report(node, &verdict) {
                rearch_failed = true;
            }
        }

        // Prove the scope: out-of-set nodes were never rebuilt.
        let counts_after = counts.borrow();
        let mut scope_ok = true;
        for id in &untouched {
            let before = counts_before.get(id).copied().unwrap_or(0);
            let after = counts_after.get(id).copied().unwrap_or(0);
            if before != after {
                scope_ok = false;
            }
            println!(
                "   untouched {id:<14} built {after}× (unchanged: {})",
                before == after
            );
        }

        if rearch_failed || !scope_ok {
            println!("\n❌ scoped rebuild failed or touched out-of-scope nodes");
            std::process::exit(1);
        }
        println!("\n✅ scoped rebuild converged; blast radius limited to invalidation_set");
    }

    println!(
        "\n[telemetry] {} messages delivered through the scheduler",
        sink.events.load(Ordering::Relaxed)
    );
    println!(
        "[telemetry] {} supervisor decisions",
        sink.supervisor_decisions.load(Ordering::Relaxed)
    );
    println!("[build counts] {:?}", counts.borrow());
    println!("\n✅ Foundry M3: supervised dyads + message-gated bottom-up build");
}

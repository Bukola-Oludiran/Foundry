//! Foundry control-plane host.
//!
//! Compiles a dyad IR into a `BuildPlan`, materializes it as a real `graphreact-core`
//! graph (one node per dyad, dependency edges), and runs a supervised bottom-up build:
//! each dyad is a scheduler node whose `build` handler drives the pi-pool (`/build` +
//! `/test`) over HTTP with **node-level retry-with-feedback** (a red verdict is fed back
//! to the doer, which repairs). The host walks the DAG's topological generations (explicit
//! deps-ready gating), and a `TelemetrySink` renders the build as an event stream.
//!
//! With `--rearchitect <node>`, after the initial build it performs a **scoped
//! re-architecture**: rebuild only `{node} ∪ invalidation_set(node)` in topological order,
//! proving the blast radius is scoped by construction — sibling branches are never touched.
//!
//! Usage: foundry-host --ir <path> [--pi-pool URL] [--workspace DIR] [--rearchitect NODE]

mod http;
use http::http_post_json;

use foundry_ir::types::{Ir, Kind, Node};
use foundry_ir::{compile, BuildPlan};
use graphreact_core::{
    use_message, Attrs, CommunicationGraph, MessageDelivered, NodeContext, NodeDefinition,
    NodeMounted, PermissionManifest, Scheduler, TelemetrySink,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const MAX_RETRIES: u32 = 3;

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
}
impl TelemetrySink for AuditSink {
    fn on_message_delivered(&self, ev: &MessageDelivered<'_>) {
        self.events.fetch_add(1, Ordering::Relaxed);
        if ev.message_type == "build" {
            println!(
                "   [telemetry] build → {:<14} ({})",
                ev.to,
                if ev.accepted { "accepted" } else { "REJECTED" }
            );
        }
    }
    fn on_node_mounted(&self, ev: &NodeMounted<'_>) {
        println!("   [telemetry] mounted dyad {}", ev.node_id);
    }
}

/// One dyad build attempt: POST /build (with attempt+feedback) then POST /test.
fn build_once(job: &Job, base: &str, token: &str, attempt: u32, feedback: &Value) -> Verdict {
    let mut br = job.build_req.clone();
    br["attempt"] = json!(attempt);
    br["feedback"] = feedback.clone();
    br["job_id"] = json!(format!(
        "{}:{}:build:{attempt}",
        br["run_id"].as_str().unwrap_or("run"),
        br["node_id"].as_str().unwrap_or("node")
    ));
    match http_post_json(base, "/build", &br, token) {
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
    let mut tr = job.test_req.clone();
    tr["job_id"] = json!(format!(
        "{}:{}:test:{attempt}",
        tr["run_id"].as_str().unwrap_or("run"),
        tr["node_id"].as_str().unwrap_or("node")
    ));
    match http_post_json(base, "/test", &tr, token) {
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
    token: &str,
    counts: &RefCell<HashMap<String, u32>>,
) -> (Verdict, u32) {
    let Some(job) = jobs.get(nid) else {
        return (Verdict::Error("no job".into()), 0);
    };
    let mut feedback = Value::Null;
    let mut last = Verdict::Pending;
    for attempt in 1..=MAX_RETRIES {
        *counts.borrow_mut().entry(nid.to_string()).or_insert(0) += 1;
        last = build_once(job, base, token, attempt, &feedback);
        match &last {
            Verdict::Green => return (Verdict::Green, attempt),
            Verdict::Red(detail) => feedback = json!(detail),
            Verdict::Error(_) => return (last, attempt),
            Verdict::Pending => {}
        }
    }
    (last, MAX_RETRIES)
}

fn build_jobs(
    ir: &Ir,
    plan: &BuildPlan,
    ws: &str,
    ir_digest: &str,
    run_id: &str,
    base_commit: &str,
) -> HashMap<String, Job> {
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
        let context = json!({
            "protocol_version": 1,
            "job_id": format!("{}:pending", n.id),
            "run_id": run_id,
            "ir_digest": ir_digest,
            "base_commit": base_commit,
            "resource_policy": {
                "timeout_ms": 300_000,
                "memory_mb": 1024,
                "cpu_count": 2,
                "pids": 256,
                "network": "model-egress",
            },
        });
        let build_req = json!({
            "protocol_version": context["protocol_version"], "job_id": context["job_id"],
            "run_id": context["run_id"], "ir_digest": context["ir_digest"],
            "base_commit": context["base_commit"], "resource_policy": context["resource_policy"],
            "node_id": n.id, "kind": kind, "language": lang, "workspace": ws,
            "write_target": n.implementation.write_target, "provides": provides.clone(),
            "requires": requires, "composition": n.implementation.composition,
            "children": children, "attempt": 1, "feedback": Value::Null,
        });
        let test_req = json!({
            "protocol_version": context["protocol_version"], "job_id": context["job_id"],
            "run_id": context["run_id"], "ir_digest": context["ir_digest"],
            "base_commit": context["base_commit"], "resource_policy": {
                "timeout_ms": n.acceptance.perf.as_ref().and_then(|p| p.time_ms).unwrap_or(3_000),
                "memory_mb": n.acceptance.perf.as_ref().and_then(|p| p.mem_mb).unwrap_or(256),
                "cpu_count": 1, "pids": 64, "network": "none",
            },
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
    let workspace_root = arg(&args, "--workspace").unwrap_or_else(|| {
        std::env::temp_dir()
            .join("foundry-ws")
            .to_string_lossy()
            .into_owned()
    });
    let rearchitect = arg(&args, "--rearchitect");
    let base_commit = arg(&args, "--base").unwrap_or_else(|| "uncommitted".to_string());
    let worker_token = std::env::var("FOUNDRY_WORKER_TOKEN").unwrap_or_else(|_| {
        eprintln!("FOUNDRY_WORKER_TOKEN is required");
        std::process::exit(2);
    });

    let raw = std::fs::read_to_string(&ir_path).unwrap_or_else(|e| {
        eprintln!("read {ir_path}: {e}");
        std::process::exit(1);
    });
    let ir: Ir = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("parse IR: {e}");
        std::process::exit(1);
    });
    let ir_digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
    let run_digest = format!(
        "{:x}",
        Sha256::digest(format!("{ir_digest}:{base_commit}").as_bytes())
    );
    let run_id = format!("run-{}", &run_digest[..16]);
    let ws = std::path::Path::new(&workspace_root)
        .join(".foundry")
        .join("attempts")
        .join(&run_id)
        .to_string_lossy()
        .into_owned();
    let plan = compile(&ir).unwrap_or_else(|errs| {
        eprintln!("IR did not compile:");
        for e in &errs {
            eprintln!("  - {e}");
        }
        std::process::exit(1);
    });
    std::fs::create_dir_all(format!("{ws}/src")).ok();

    println!("Foundry host: {} ({} nodes)", ir.spec.name, ir.nodes.len());
    println!("  build order:  {}", plan.order.join(" → "));
    println!("  workspace:    {ws}");
    println!("  pi-pool:      {base}");

    let jobs = Rc::new(build_jobs(
        &ir,
        &plan,
        &ws,
        &ir_digest,
        &run_id,
        &base_commit,
    ));
    let verdicts: Rc<RefCell<HashMap<String, Verdict>>> = Rc::new(RefCell::new(
        ir.nodes
            .iter()
            .map(|n| (n.id.clone(), Verdict::Pending))
            .collect(),
    ));
    let counts: Rc<RefCell<HashMap<String, u32>>> = Rc::new(RefCell::new(HashMap::new()));
    let base = Rc::new(base);
    let worker_token = Rc::new(worker_token);

    let mut graph = CommunicationGraph::new();
    for n in &ir.nodes {
        graph.add_node(n.id.as_str(), Attrs::new());
    }
    for (provider, consumers) in &plan.dependents {
        for c in consumers {
            graph.add_edge(provider.as_str(), c.as_str(), None, Attrs::new());
        }
    }

    let mut scheduler = Scheduler::new(graph);
    let sink = Arc::new(AuditSink {
        events: AtomicU64::new(0),
    });
    scheduler.install_telemetry_sink(sink.clone());

    for n in &ir.nodes {
        let nid = n.id.clone();
        let jobs_c = Rc::clone(&jobs);
        let verdicts_c = Rc::clone(&verdicts);
        let counts_c = Rc::clone(&counts);
        let base_c = Rc::clone(&base);
        let token_c = Rc::clone(&worker_token);
        let body = move |_ctx: &NodeContext| {
            let nid = nid.clone();
            let jobs_c = Rc::clone(&jobs_c);
            let verdicts_c = Rc::clone(&verdicts_c);
            let counts_c = Rc::clone(&counts_c);
            let base_c = Rc::clone(&base_c);
            let token_c = Rc::clone(&token_c);
            use_message("build", move |_msg| {
                let (verdict, attempts) =
                    build_with_retry(&nid, &jobs_c, &base_c, &token_c, &counts_c);
                if attempts > 1 && verdict == Verdict::Green {
                    println!(
                        "   ↻ {nid} repaired after {attempts} attempts (doer used tester feedback)"
                    );
                }
                verdicts_c.borrow_mut().insert(nid.clone(), verdict);
            });
            PermissionManifest::new(["build"], Vec::<String>::new())
        };
        scheduler
            .register_node(
                NodeDefinition::new(n.id.clone(), body),
                n.id.as_str(),
                Attrs::new(),
                0,
            )
            .expect("register dyad");
    }
    scheduler.start().expect("scheduler start");

    // ---- initial bottom-up build ----
    println!(
        "\n== bottom-up build ({} generations) ==",
        plan.generations.len()
    );
    let mut failed = false;
    for (gi, gen) in plan.generations.iter().enumerate() {
        println!("\n-- generation {gi}: [{}] --", gen.join(", "));
        for node in gen {
            scheduler.send(node.as_str(), "build", Value::Null);
        }
        scheduler.process_batch().expect("process_batch");
        for node in gen {
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
            break;
        }
    }
    if failed {
        println!("\n❌ build did not reach green");
        std::process::exit(1);
    }
    println!("\n✅ initial build: ALL GREEN");

    // ---- scoped re-architecture ----
    if let Some(target) = rearchitect {
        if !plan.order.iter().any(|n| n == &target) {
            eprintln!("--rearchitect: unknown node `{target}`");
            std::process::exit(1);
        }
        println!("\n== re-architecture event: {target} ==");
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
            println!("\n❌ re-architecture failed or touched out-of-scope nodes");
            std::process::exit(1);
        }
        println!("\n✅ re-architecture converged, blast radius scoped to invalidation_set");
    }

    println!(
        "\n[telemetry] {} messages delivered through the scheduler",
        sink.events.load(Ordering::Relaxed)
    );
    println!("[build counts] {:?}", counts.borrow());
    println!("\n✅ Foundry: BuildPlan → GraphReact nodes → supervised bottom-up build + scoped re-architecture");
}

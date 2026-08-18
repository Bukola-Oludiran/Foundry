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

mod agent_runtime;
mod architect;
mod cancellation_reconciliation;
mod collaboration;
mod dependency_files;
mod durable;
mod environment_evidence;
mod http;
mod repository;
mod sidecar;
mod studio;
mod studio_room;
mod studio_service;
use dependency_files::materialize_native_dependency_files;
use environment_evidence::materialize_environment_evidence;
use http::{http_get_bytes, http_post_json};
use repository::{
    dependency_file_artifacts, git_revision, materialize_architecture_files,
    materialize_dependency_resolution, materialize_generated_resources, ContentArtifactRef,
    DiffPolicy, GitHubRepositoryProvider, LocalGitRepository, PullRequestPublisher,
    RepositoryProvider,
};

use foundry_ir::types::{Ir, Kind, Node};
use foundry_ir::{
    compile, compile_v2, plan_dependency_resolution, plan_test_environment, BuildPlan, IrDocument,
};
use graphreact_core::{
    use_message, Attrs, CommunicationGraph, MessageDelivered, NodeContext, NodeDefinition,
    NodeMounted, PermissionManifest, Scheduler, TelemetrySink,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
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

#[derive(Clone)]
struct Job {
    build_req: Value,
    test_req: Value,
}

#[derive(Clone, Copy)]
struct StudioJobContext<'a> {
    proposal_id: Option<&'a str>,
    revision_id: Option<&'a str>,
    semantic_digest: Option<&'a str>,
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
    studio: StudioJobContext<'_>,
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
        let mut build_req = json!({
            "protocol_version": context["protocol_version"], "job_id": context["job_id"],
            "run_id": context["run_id"], "ir_digest": context["ir_digest"],
            "base_commit": context["base_commit"], "resource_policy": context["resource_policy"],
            "node_id": n.id, "kind": kind, "language": lang, "workspace": ws,
            "write_target": n.implementation.write_target, "provides": provides.clone(),
            "requires": requires, "composition": n.implementation.composition,
            "children": children, "attempt": 1, "feedback": Value::Null,
        });
        let mut test_req = json!({
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
        for request in [&mut build_req, &mut test_req] {
            if let Some(proposal_id) = studio.proposal_id {
                request["proposal_id"] = json!(proposal_id);
            }
            if let Some(revision_id) = studio.revision_id {
                request["revision_id"] = json!(revision_id);
            }
            if let Some(semantic_digest) = studio.semantic_digest {
                request["semantic_digest"] = json!(semantic_digest);
            }
        }
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

fn v2_execution_plan(
    ir: &foundry_ir::v2::IrV2,
    workspace: &str,
    run_id: &str,
    base_commit: &str,
) -> Result<durable::V2ExecutionPlan, String> {
    let dependency_plan = plan_dependency_resolution(ir).map_err(|errors| {
        errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ")
    })?;
    let environment_plan = plan_test_environment(ir).map_err(|errors| {
        errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ")
    })?;
    let dependency_request = if dependency_plan.roots.is_empty() {
        None
    } else {
        let resolver_image = std::env::var("FOUNDRY_RESOLVER_IMAGE").map_err(|_| {
            "FOUNDRY_RESOLVER_IMAGE is required for an IR v2 package build".to_string()
        })?;
        let existing_repository = dependency_plan.roots.iter().any(|root| {
            std::path::Path::new(workspace)
                .join(&root.manifest_path)
                .exists()
                || std::path::Path::new(workspace)
                    .join(&root.lockfile_path)
                    .exists()
        });
        Some(json!({
            "protocol_version": 2,
            "job_id": format!("{run_id}:dependencies"),
            "run_id": run_id,
            "ir_digest": dependency_plan.ir_digest,
            "base_commit": base_commit,
            "workspace": workspace,
            "resolver_image": resolver_image,
            "platform": std::env::var("FOUNDRY_RESOLVER_PLATFORM").unwrap_or_else(|_| "linux/amd64".into()),
            "existing_repository": existing_repository,
            "resource_policy": {
                "timeout_ms": 300_000,
                "memory_mb": 2048,
                "cpu_count": 2,
                "pids": 512,
                "network": "registry-egress"
            },
            "plan": dependency_plan,
            "policy": foundry_ir::SupplyChainPolicyV1::default(),
        }))
    };
    let needs_environment = !environment_plan.resources.is_empty()
        || !environment_plan.integrations.is_empty()
        || !environment_plan.migrations.is_empty();
    let environment_start_request = if needs_environment {
        let resource_images: Value = std::env::var("FOUNDRY_RESOURCE_IMAGES_JSON")
            .map_err(|_| {
                "FOUNDRY_RESOURCE_IMAGES_JSON is required for an IR v2 resource build".to_string()
            })
            .and_then(|raw| {
                serde_json::from_str(&raw)
                    .map_err(|error| format!("invalid FOUNDRY_RESOURCE_IMAGES_JSON: {error}"))
            })?;
        let emulator_image = std::env::var("FOUNDRY_EMULATOR_IMAGE").map_err(|_| {
            "FOUNDRY_EMULATOR_IMAGE is required for an IR v2 integration build".to_string()
        })?;
        Some(json!({
            "protocol_version": 2,
            "job_id": format!("{run_id}:environment:start"),
            "run_id": run_id,
            "ir_digest": environment_plan.ir_digest,
            "base_commit": base_commit,
            "plan": environment_plan,
            "resource_images": resource_images,
            "emulator_image": emulator_image,
            "resource_policy": {
                "timeout_ms": 300_000,
                "memory_mb": 4096,
                "cpu_count": 4,
                "pids": 1024,
                "network": "private-integration"
            }
        }))
    } else {
        None
    };

    let resources_by_id: HashMap<_, _> = ir
        .resources
        .iter()
        .map(|resource| (resource.id.as_str(), resource))
        .collect();
    let integrations_by_id: HashMap<_, _> = ir
        .integrations
        .iter()
        .map(|integration| (integration.id.as_str(), integration))
        .collect();
    let roots_by_id: HashMap<_, _> = ir
        .package_roots
        .iter()
        .map(|root| (root.id.as_str(), root))
        .collect();
    let mut node_bindings = BTreeMap::new();
    for node in &ir.nodes {
        let package_roots = ir
            .packages
            .iter()
            .filter(|package| package.owner_node == node.id)
            .map(|package| package.package_root.as_str())
            .collect::<BTreeSet<_>>();
        if package_roots.len() > 1 {
            return Err(format!(
                "node `{}` spans multiple package roots; worker protocol v2 supports one package root per node",
                node.id
            ));
        }
        let package_root = package_roots
            .first()
            .and_then(|id| roots_by_id.get(id))
            .map(|root| {
                json!({
                    "id": root.id,
                    "manifest_path": root.manifest_path,
                    "lockfile_path": root.lockfile_path,
                })
            })
            .unwrap_or(Value::Null);
        let resource_bindings = ir
            .resource_bindings
            .iter()
            .filter(|binding| binding.node == node.id)
            .filter_map(|binding| {
                let resource = resources_by_id.get(binding.resource.as_str())?;
                let mut environment = serde_json::Map::new();
                let mut secret_handles = Vec::new();
                for (logical_name, environment_name) in &binding.environment {
                    let handle = format!("resource:{}:{logical_name}", binding.resource);
                    environment.insert(environment_name.clone(), json!(handle));
                    secret_handles.push(handle);
                }
                Some(json!({
                    "resource_id": binding.resource,
                    "kind": resource.kind,
                    "alias": binding.resource,
                    "permissions": binding.permissions,
                    "environment": environment,
                    "secret_handles": secret_handles,
                }))
            })
            .collect::<Vec<_>>();
        let integration_bindings = ir
            .integration_bindings
            .iter()
            .filter(|binding| binding.node == node.id)
            .filter_map(|binding| {
                let integration = integrations_by_id.get(binding.integration.as_str())?;
                Some(json!({
                    "integration_id": binding.integration,
                    "kind": integration.kind,
                    "alias": binding.integration,
                    "operations": binding.operations,
                    "timeout_ms": binding.timeout_ms,
                    "idempotency": binding.idempotency,
                    "secret_handles": binding.secret_ref.iter().cloned().collect::<Vec<_>>(),
                }))
            })
            .collect::<Vec<_>>();
        let secret_handles = resource_bindings
            .iter()
            .flat_map(|binding| {
                binding
                    .get("secret_handles")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned()
            })
            .chain(integration_bindings.iter().flat_map(|binding| {
                binding
                    .get("secret_handles")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned()
            }))
            .collect::<Vec<_>>();
        node_bindings.insert(
            node.id.clone(),
            json!({
                "package_root": package_root,
                "resource_bindings": resource_bindings,
                "integration_bindings": integration_bindings,
                "secret_handles": secret_handles,
            }),
        );
    }
    Ok(durable::V2ExecutionPlan {
        dependency_request,
        environment_start_request,
        migrations: serde_json::to_value(&environment_plan.migrations)
            .map_err(|error| error.to_string())?,
        workspace: workspace.to_owned(),
        node_bindings,
    })
}

fn fetch_dependency_artifact(
    base: &str,
    token: &str,
    artifact: &ContentArtifactRef,
) -> Result<Vec<u8>, String> {
    const MAX_BYTES: usize = 16 * 1024 * 1024;
    let expected_size = usize::try_from(artifact.size)
        .map_err(|_| "dependency artifact size cannot be represented".to_string())?;
    if expected_size > MAX_BYTES {
        return Err("dependency artifact exceeds its materialization bound".into());
    }
    let bytes = http_get_bytes(
        base,
        &format!("/v2/dependencies/artifacts/{}", artifact.sha256),
        token,
        MAX_BYTES,
    )?;
    if bytes.len() != expected_size {
        return Err("dependency artifact size does not match its verified metadata".into());
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != artifact.sha256 {
        return Err("dependency artifact checksum does not match its verified metadata".into());
    }
    Ok(bytes)
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|argument| argument == flag)
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

fn read_v2_ir(path: &str) -> foundry_ir::v2::IrV2 {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|error| {
        eprintln!("read {path}: {error}");
        std::process::exit(1);
    });
    match serde_json::from_str::<IrDocument>(&raw).unwrap_or_else(|error| {
        eprintln!("invalid IR JSON: {error}");
        std::process::exit(1);
    }) {
        IrDocument::V2(ir) => ir,
        IrDocument::V1(_) => {
            eprintln!("this command requires IR v2; IR v1 remains supported by validate and build");
            std::process::exit(2);
        }
    }
}

fn print_or_write_json(args: &[String], value: &impl serde::Serialize) {
    let rendered = serde_json::to_string_pretty(value).expect("command output serializes");
    if let Some(output) = arg(args, "--output") {
        std::fs::write(&output, format!("{rendered}\n")).unwrap_or_else(|error| {
            eprintln!("write {output}: {error}");
            std::process::exit(1);
        });
        println!("wrote {output}");
    } else {
        println!("{rendered}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|value| value == "deps") {
        let Some(action) = args.get(2).map(String::as_str) else {
            eprintln!("usage: foundry-host deps <resolve|audit> --ir <file> [--output <file>]");
            std::process::exit(2);
        };
        let Some(ir_path) = arg(&args, "--ir") else {
            eprintln!("usage: foundry-host deps {action} --ir <file> [--output <file>]");
            std::process::exit(2);
        };
        let ir = read_v2_ir(&ir_path);
        let plan = plan_dependency_resolution(&ir).unwrap_or_else(|errors| {
            errors.iter().for_each(|error| eprintln!("- {error}"));
            std::process::exit(1);
        });
        match action {
            "resolve" if has_flag(&args, "--dry-run") => print_or_write_json(&args, &plan),
            "resolve" => {
                let base =
                    arg(&args, "--pi-pool").unwrap_or_else(|| "http://127.0.0.1:8787".into());
                let token = std::env::var("FOUNDRY_WORKER_TOKEN").unwrap_or_else(|_| {
                    eprintln!("FOUNDRY_WORKER_TOKEN is required (use --dry-run to print only the deterministic plan)");
                    std::process::exit(2);
                });
                let resolver_image = std::env::var("FOUNDRY_RESOLVER_IMAGE").unwrap_or_else(|_| {
                    eprintln!("FOUNDRY_RESOLVER_IMAGE must be a digest-pinned OCI image");
                    std::process::exit(2);
                });
                let workspace = arg(&args, "--repo").unwrap_or_else(|| {
                    std::env::current_dir()
                        .unwrap_or_else(|error| {
                            eprintln!("resolve current repository: {error}");
                            std::process::exit(1);
                        })
                        .to_string_lossy()
                        .into_owned()
                });
                let existing_repository = plan.roots.iter().any(|root| {
                    std::path::Path::new(&workspace)
                        .join(&root.manifest_path)
                        .exists()
                        || std::path::Path::new(&workspace)
                            .join(&root.lockfile_path)
                            .exists()
                });
                let job_id = format!("deps-{}", &plan.plan_digest[..16]);
                let result = http_post_json(
                    &base,
                    "/v2/dependencies/resolve",
                    &json!({
                        "protocol_version": 2,
                        "job_id": job_id,
                        "run_id": job_id,
                        "ir_digest": plan.ir_digest,
                        "base_commit": arg(&args, "--base").unwrap_or_else(|| "HEAD".into()),
                        "workspace": workspace,
                        "resolver_image": resolver_image,
                        "platform": std::env::var("FOUNDRY_RESOLVER_PLATFORM")
                            .unwrap_or_else(|_| "linux/amd64".into()),
                        "existing_repository": existing_repository,
                        "resource_policy": {
                            "timeout_ms": 300_000,
                            "memory_mb": 2048,
                            "cpu_count": 2,
                            "pids": 512,
                            "network": "registry-egress"
                        },
                        "plan": plan,
                        "policy": foundry_ir::SupplyChainPolicyV1::default(),
                    }),
                    &token,
                )
                .unwrap_or_else(|error| {
                    eprintln!("dependency resolution failed: {error}");
                    std::process::exit(1);
                });
                print_or_write_json(&args, &result);
            }
            "audit" => {
                let package_count: usize = plan.roots.iter().map(|root| root.packages.len()).sum();
                print_or_write_json(
                    &args,
                    &json!({
                        "audit_version": 1,
                        "ir_digest": plan.ir_digest,
                        "plan_digest": plan.plan_digest,
                        "package_roots": plan.roots.len(),
                        "declared_packages": package_count,
                        "declarations": "valid",
                        "resolution_evidence": "not_executed",
                        "note": "build executes the pinned OCI resolver and fails closed on license or vulnerability policy"
                    }),
                );
            }
            _ => {
                eprintln!("unknown deps command `{action}`; expected resolve or audit");
                std::process::exit(2);
            }
        }
        return;
    }
    if args.get(1).is_some_and(|value| value == "resources") {
        let Some(action) = args.get(2).map(String::as_str) else {
            eprintln!("usage: foundry-host resources plan --ir <file> [--output <file>]");
            std::process::exit(2);
        };
        if !matches!(action, "plan" | "test") {
            eprintln!("unknown resources command `{action}`; expected plan or test");
            std::process::exit(2);
        }
        let Some(ir_path) = arg(&args, "--ir") else {
            eprintln!("usage: foundry-host resources plan --ir <file> [--output <file>]");
            std::process::exit(2);
        };
        let ir = read_v2_ir(&ir_path);
        let plan = plan_test_environment(&ir).unwrap_or_else(|errors| {
            errors.iter().for_each(|error| eprintln!("- {error}"));
            std::process::exit(1);
        });
        if action == "plan" {
            print_or_write_json(&args, &plan);
            return;
        }
        let base = arg(&args, "--pi-pool").unwrap_or_else(|| "http://127.0.0.1:8787".into());
        let token = std::env::var("FOUNDRY_WORKER_TOKEN").unwrap_or_else(|_| {
            eprintln!("FOUNDRY_WORKER_TOKEN is required");
            std::process::exit(2);
        });
        let resource_images: Value = std::env::var("FOUNDRY_RESOURCE_IMAGES_JSON")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| {
                eprintln!("FOUNDRY_RESOURCE_IMAGES_JSON must be a JSON object of image keys to digest-pinned OCI images");
                std::process::exit(2);
            });
        let emulator_image = std::env::var("FOUNDRY_EMULATOR_IMAGE").unwrap_or_else(|_| {
            eprintln!("FOUNDRY_EMULATOR_IMAGE must be a digest-pinned OCI image");
            std::process::exit(2);
        });
        let run_id = format!("resources-{}", &plan.plan_digest[..16]);
        let start = http_post_json(
            &base,
            "/v2/environments/start",
            &json!({
                "protocol_version": 2,
                "job_id": format!("{run_id}:start"),
                "run_id": run_id,
                "ir_digest": plan.ir_digest,
                "base_commit": arg(&args, "--base").unwrap_or_else(|| "HEAD".into()),
                "plan": plan,
                "resource_images": resource_images,
                "emulator_image": emulator_image,
                "resource_policy": {
                    "timeout_ms": 300_000,
                    "memory_mb": 4096,
                    "cpu_count": 4,
                    "pids": 1024,
                    "network": "private-integration"
                }
            }),
            &token,
        )
        .unwrap_or_else(|error| {
            eprintln!("environment start failed: {error}");
            std::process::exit(1);
        });
        let environment_id = start
            .get("environment_id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                eprintln!("environment manager omitted environment_id");
                std::process::exit(1);
            });
        let action_request = |suffix: &str| {
            json!({
                "protocol_version": 2,
                "job_id": format!("{run_id}:{suffix}"),
                "run_id": run_id,
                "environment_id": environment_id,
                "plan_digest": plan.plan_digest,
            })
        };
        let workspace = arg(&args, "--repo").unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|error| {
                    eprintln!("resolve current repository: {error}");
                    std::process::exit(1);
                })
                .to_string_lossy()
                .into_owned()
        });
        let phases: Result<(Value, Value, Value), String> = (|| {
            let health = http_post_json(
                &base,
                "/v2/environments/health",
                &action_request("health"),
                &token,
            )?;
            if health.get("healthy").and_then(Value::as_bool) != Some(true) {
                return Err(format!("environment is not healthy: {health}"));
            }
            let migrations = if plan.migrations.is_empty() {
                json!({"green": true, "outcomes": []})
            } else {
                let mut request = action_request("migrations");
                request["workspace"] = json!(workspace);
                request["migrations"] =
                    serde_json::to_value(&plan.migrations).map_err(|error| error.to_string())?;
                http_post_json(&base, "/v2/environments/migrations", &request, &token)?
            };
            let snapshot = http_post_json(
                &base,
                "/v2/environments/snapshot",
                &action_request("snapshot"),
                &token,
            )?;
            Ok((health, migrations, snapshot))
        })();
        let teardown = http_post_json(
            &base,
            "/v2/environments/teardown",
            &action_request("teardown"),
            &token,
        );
        let (health, migrations, snapshot) = match phases {
            Ok(phases) => phases,
            Err(error) => {
                eprintln!("environment verification failed: {error}");
                if let Err(cleanup_error) = &teardown {
                    eprintln!("environment teardown also failed: {cleanup_error}");
                }
                std::process::exit(1);
            }
        };
        let teardown = teardown.unwrap_or_else(|error| {
            eprintln!("environment teardown failed: {error}");
            std::process::exit(1);
        });
        print_or_write_json(
            &args,
            &json!({
                "start": start,
                "health": health,
                "migrations": migrations,
                "snapshot": snapshot,
                "teardown": teardown
            }),
        );
        return;
    }
    if args.get(1).is_some_and(|value| value == "sidecar") {
        sidecar::serve().unwrap_or_else(|error| {
            eprintln!("sidecar failed: {error}");
            std::process::exit(1);
        });
        return;
    }
    if args.get(1).is_some_and(|value| value == "studio-serve") {
        studio_service::serve(&args).unwrap_or_else(|error| {
            eprintln!("Architecture Studio service failed: {error}");
            std::process::exit(1);
        });
        return;
    }
    if args
        .get(1)
        .is_some_and(|value| value == "architecture-begin")
    {
        let required = |flag: &str| {
            arg(&args, flag).unwrap_or_else(|| {
                eprintln!("usage: foundry-host architecture-begin --ir <file> --durability-dir <dir> --context-id <id> --idempotency-key <key>");
                std::process::exit(2);
            })
        };
        let ir = required("--ir");
        let bytes = std::fs::read(&ir).unwrap_or_else(|error| {
            eprintln!("read {ir}: {error}");
            std::process::exit(1);
        });
        let state = collaboration::begin(
            &bytes,
            std::path::Path::new(&required("--durability-dir")),
            &required("--context-id"),
            &required("--idempotency-key"),
        )
        .unwrap_or_else(|error| {
            eprintln!("architecture collaboration failed: {error}");
            std::process::exit(1);
        });
        println!(
            "collaboration: {}",
            serde_json::to_string(&state).expect("collaboration state serializes")
        );
        return;
    }
    if args
        .get(1)
        .is_some_and(|value| value == "architecture-revise")
    {
        let required = |flag: &str| {
            arg(&args, flag).unwrap_or_else(|| {
                eprintln!("usage: foundry-host architecture-revise --run <id> --ir <file> --durability-dir <dir> --context-id <id> --expected-revision <n> --operation-key <key>");
                std::process::exit(2);
            })
        };
        let ir = required("--ir");
        let bytes = std::fs::read(&ir).unwrap_or_else(|error| {
            eprintln!("read {ir}: {error}");
            std::process::exit(1);
        });
        let expected_revision = required("--expected-revision")
            .parse::<u32>()
            .unwrap_or_else(|_| {
                eprintln!("--expected-revision must be a positive integer");
                std::process::exit(2);
            });
        let state = collaboration::revise(
            &bytes,
            std::path::Path::new(&required("--durability-dir")),
            &required("--run"),
            &required("--context-id"),
            expected_revision,
            &required("--operation-key"),
        )
        .unwrap_or_else(|error| {
            eprintln!("architecture revision failed: {error}");
            std::process::exit(1);
        });
        println!(
            "collaboration: {}",
            serde_json::to_string(&state).expect("collaboration state serializes")
        );
        return;
    }
    if args
        .get(1)
        .is_some_and(|value| value == "architecture-review")
    {
        let required = |flag: &str| {
            arg(&args, flag).unwrap_or_else(|| {
                eprintln!("usage: foundry-host architecture-review --run <id> --durability-dir <dir> --context-id <id> --expected-revision <n> --verdict <approve|changes_requested> --body <text> --operation-key <key>");
                std::process::exit(2);
            })
        };
        let expected_revision = required("--expected-revision")
            .parse::<u32>()
            .unwrap_or_else(|_| {
                eprintln!("--expected-revision must be a positive integer");
                std::process::exit(2);
            });
        let state = collaboration::review(
            std::path::Path::new(&required("--durability-dir")),
            &required("--run"),
            &required("--context-id"),
            expected_revision,
            &required("--verdict"),
            &required("--body"),
            &required("--operation-key"),
        )
        .unwrap_or_else(|error| {
            eprintln!("architecture review failed: {error}");
            std::process::exit(1);
        });
        println!(
            "collaboration: {}",
            serde_json::to_string(&state).expect("collaboration state serializes")
        );
        return;
    }
    if args
        .get(1)
        .is_some_and(|value| value == "architecture-status")
    {
        let required = |flag: &str| {
            arg(&args, flag).unwrap_or_else(|| {
                eprintln!(
                    "usage: foundry-host architecture-status --run <id> --durability-dir <dir>"
                );
                std::process::exit(2);
            })
        };
        let state = collaboration::status(
            std::path::Path::new(&required("--durability-dir")),
            &required("--run"),
        )
        .unwrap_or_else(|error| {
            eprintln!("architecture status failed: {error}");
            std::process::exit(1);
        });
        println!(
            "collaboration: {}",
            serde_json::to_string(&state).expect("collaboration state serializes")
        );
        return;
    }
    if args.get(1).is_some_and(|value| value == "validate") {
        let Some(ir_path) = arg(&args, "--ir") else {
            eprintln!("usage: foundry-host validate --ir <file>");
            std::process::exit(2);
        };
        let raw = std::fs::read_to_string(&ir_path).unwrap_or_else(|error| {
            eprintln!("read {ir_path}: {error}");
            std::process::exit(1);
        });
        let document: IrDocument = serde_json::from_str(&raw).unwrap_or_else(|error| {
            eprintln!("invalid IR JSON: {error}");
            std::process::exit(1);
        });
        match document {
            IrDocument::V1(ir) => {
                let plan = compile(&ir).unwrap_or_else(|errors| {
                    errors.iter().for_each(|error| eprintln!("- {error}"));
                    std::process::exit(1);
                });
                println!("valid IR v{}: {}", ir.ir_version, plan.order.join(" → "));
            }
            IrDocument::V2(ir) => {
                let plan = compile_v2(&ir).unwrap_or_else(|errors| {
                    errors.iter().for_each(|error| eprintln!("- {error}"));
                    std::process::exit(1);
                });
                println!(
                    "valid IR v{}: {} ({} packages, {} resources, {} integrations)",
                    ir.ir_version,
                    plan.core.order.join(" → "),
                    ir.packages.len(),
                    ir.resources.len(),
                    ir.integrations.len()
                );
            }
        }
        return;
    }
    if args.get(1).is_some_and(|value| value == "architect") {
        let Some(spec_path) = arg(&args, "--spec") else {
            eprintln!("usage: foundry-host architect --spec <file> --output <file>");
            std::process::exit(2);
        };
        let Some(output) = arg(&args, "--output") else {
            eprintln!("usage: foundry-host architect --spec <file> --output <file>");
            std::process::exit(2);
        };
        let product_spec = std::fs::read_to_string(&spec_path).unwrap_or_else(|error| {
            eprintln!("read {spec_path}: {error}");
            std::process::exit(1);
        });
        let base = arg(&args, "--pi-pool").unwrap_or_else(|| "http://127.0.0.1:8787".into());
        let token = std::env::var("FOUNDRY_WORKER_TOKEN").unwrap_or_else(|_| {
            eprintln!("FOUNDRY_WORKER_TOKEN is required");
            std::process::exit(2);
        });
        let request = foundry_ir::ArchitectureRequest {
            architecture_version: 1,
            product_spec,
            repository: arg(&args, "--repo").unwrap_or_else(|| ".".into()),
            base_revision: arg(&args, "--base").unwrap_or_else(|| "HEAD".into()),
            allowed_languages: arg(&args, "--languages")
                .unwrap_or_else(|| "python,typescript,go".into())
                .split(',')
                .map(str::to_owned)
                .collect(),
            policy_constraints: Vec::new(),
            existing_ir: None,
        };
        let agent = architect::WorkerArchitectureAgent {
            base: &base,
            token: &token,
        };
        architect::architect(&agent, &request, std::path::Path::new(&output)).unwrap_or_else(
            |error| {
                eprintln!("architecture failed: {error}");
                std::process::exit(1);
            },
        );
        println!("valid architecture written to {output}");
        return;
    }
    if args.get(1).is_some_and(|value| value == "rearchitect") {
        let required = |flag: &str| {
            arg(&args, flag).unwrap_or_else(|| {
                eprintln!(
                    "usage: foundry-host rearchitect --ir <accepted> --proposal <file> --node <id> --reason <text> --output <diff>"
                );
                std::process::exit(2);
            })
        };
        let accepted_path = required("--ir");
        let proposal_path = required("--proposal");
        let target_node = required("--node");
        let reason = required("--reason");
        let output = required("--output");
        let read_ir = |path: &str| -> Ir {
            let raw = std::fs::read_to_string(path).unwrap_or_else(|error| {
                eprintln!("read {path}: {error}");
                std::process::exit(1);
            });
            serde_json::from_str(&raw).unwrap_or_else(|error| {
                eprintln!("parse {path}: {error}");
                std::process::exit(1);
            })
        };
        let accepted = read_ir(&accepted_path);
        let Some(target) = accepted.nodes.iter().find(|node| node.id == target_node) else {
            eprintln!("unknown revision target `{target_node}`");
            std::process::exit(1);
        };
        let request = foundry_ir::ArchitectureRevisionRequest {
            revision_version: 1,
            accepted_ir_revision: foundry_ir::ir_digest(&accepted),
            target_node,
            reason,
            failure_history: arg(&args, "--failure-history")
                .map(|path| {
                    std::fs::read_to_string(path)
                        .unwrap_or_else(|error| {
                            eprintln!("read failure history: {error}");
                            std::process::exit(1);
                        })
                        .lines()
                        .filter(|line| !line.trim().is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            boundary_interface: target.provides.clone(),
        };
        let (proposed, diff) = if has_flag(&args, "--generate") {
            let repository = required("--repo");
            let base_revision = required("--base");
            let worker_base =
                arg(&args, "--pi-pool").unwrap_or_else(|| "http://127.0.0.1:8787".into());
            let token = std::env::var("FOUNDRY_WORKER_TOKEN").unwrap_or_else(|_| {
                eprintln!("FOUNDRY_WORKER_TOKEN is required");
                std::process::exit(2);
            });
            let agent = architect::WorkerArchitectureAgent {
                base: &worker_base,
                token: &token,
            };
            architect::revise(
                &agent,
                &accepted,
                &request,
                &repository,
                &base_revision,
                std::path::Path::new(&proposal_path),
            )
            .unwrap_or_else(|error| {
                eprintln!("revision generation failed: {error}");
                std::process::exit(1);
            })
        } else {
            let proposed = read_ir(&proposal_path);
            let diff = foundry_ir::validate_revision(&accepted, &proposed, &request)
                .unwrap_or_else(|errors| {
                    errors.iter().for_each(|error| eprintln!("- {error}"));
                    std::process::exit(1);
                });
            (proposed, diff)
        };
        std::fs::write(
            &output,
            serde_json::to_vec_pretty(&diff).expect("diff serialization cannot fail"),
        )
        .unwrap_or_else(|error| {
            eprintln!("write {output}: {error}");
            std::process::exit(1);
        });
        println!(
            "valid scoped revision: rebuild {}",
            diff.rebuilt_nodes.join(" → ")
        );
        if has_flag(&args, "--execute") {
            let repository = required("--repo");
            let workspace = required("--workspace");
            let durability_dir = required("--durability-dir");
            let promote = required("--promote");
            let base_revision = required("--base");
            let mut command =
                std::process::Command::new(std::env::current_exe().unwrap_or_else(|error| {
                    eprintln!("resolve Foundry executable: {error}");
                    std::process::exit(1);
                }));
            command
                .args(["build", "--ir", &proposal_path, "--repo", &repository])
                .args([
                    "--workspace",
                    &workspace,
                    "--durability-dir",
                    &durability_dir,
                ])
                .args(["--base", &base_revision])
                .args(["--only", &diff.rebuilt_nodes.join(",")]);
            if let Some(worker) = arg(&args, "--pi-pool") {
                command.args(["--pi-pool", &worker]);
            }
            let status = command.status().unwrap_or_else(|error| {
                eprintln!("execute scoped revision: {error}");
                std::process::exit(1);
            });
            if !status.success() {
                eprintln!("proposed revision did not reach green; accepted IR remains active");
                std::process::exit(1);
            }
            let promote_path = std::path::Path::new(&promote);
            if let Some(parent) = promote_path.parent() {
                std::fs::create_dir_all(parent).unwrap_or_else(|error| {
                    eprintln!("prepare promotion path: {error}");
                    std::process::exit(1);
                });
            }
            let temporary = promote_path.with_extension(format!("tmp-{}", std::process::id()));
            std::fs::write(
                &temporary,
                serde_json::to_vec_pretty(&proposed).expect("IR serialization cannot fail"),
            )
            .and_then(|()| std::fs::rename(&temporary, promote_path))
            .unwrap_or_else(|error| {
                eprintln!("promote green IR revision: {error}");
                std::process::exit(1);
            });
            println!("promoted green IR revision to {promote}");
        }
        return;
    }
    if args.get(1).is_some_and(|value| value == "cancel") {
        let Some(run_id) = arg(&args, "--run") else {
            eprintln!("usage: foundry-host cancel --run <id> --durability-dir <dir>");
            std::process::exit(2);
        };
        let Some(durability_dir) = arg(&args, "--durability-dir") else {
            eprintln!("usage: foundry-host cancel --run <id> --durability-dir <dir>");
            std::process::exit(2);
        };
        durable::request_cancel(std::path::Path::new(&durability_dir), &run_id).unwrap_or_else(
            |error| {
                eprintln!("cannot request cancellation: {error}");
                std::process::exit(1);
            },
        );
        println!("cancellation requested for {run_id}");
        return;
    }
    if args.get(1).is_some_and(|value| value == "publish") {
        let Some(run_id) = arg(&args, "--run") else {
            eprintln!(
                "usage: foundry-host publish --run <id> --repo <path> --base <branch> --draft-pr"
            );
            std::process::exit(2);
        };
        let Some(repository) = arg(&args, "--repo") else {
            eprintln!(
                "usage: foundry-host publish --run <id> --repo <path> --base <branch> --draft-pr"
            );
            std::process::exit(2);
        };
        if !has_flag(&args, "--draft-pr") {
            eprintln!("Foundry only publishes draft pull requests; pass --draft-pr");
            std::process::exit(2);
        }
        let Some(durability_dir) = arg(&args, "--durability-dir") else {
            eprintln!(
                "publish requires --durability-dir so the successful durable run can be verified"
            );
            std::process::exit(2);
        };
        let status = durable::run_status(std::path::Path::new(&durability_dir), &run_id)
            .unwrap_or_else(|error| {
                eprintln!("cannot verify durable run: {error}");
                std::process::exit(1);
            });
        if status != graphreact_persistence::RunStatus::Succeeded {
            eprintln!("only a succeeded durable run can be published (status: {status:?})");
            std::process::exit(1);
        }
        let base_branch = arg(&args, "--base").unwrap_or_else(|| "main".into());
        let ir_path = arg(&args, "--ir").unwrap_or_else(|| {
            eprintln!("publish requires --ir to bind the review to an accepted architecture");
            std::process::exit(2);
        });
        let ir: Ir = serde_json::from_slice(&std::fs::read(&ir_path).unwrap_or_else(|error| {
            eprintln!("read {ir_path}: {error}");
            std::process::exit(1);
        }))
        .unwrap_or_else(|error| {
            eprintln!("parse {ir_path}: {error}");
            std::process::exit(1);
        });
        let repository_path = std::path::Path::new(&repository);
        let base_commit = git_revision(repository_path, &base_branch).unwrap_or_else(|error| {
            eprintln!("resolve base commit: {error}");
            std::process::exit(1);
        });
        let head_commit = git_revision(repository_path, &format!("foundry/{run_id}"))
            .unwrap_or_else(|error| {
                eprintln!("resolve Foundry head commit: {error}");
                std::process::exit(1);
            });
        let operator_summary = arg(&args, "--summary")
            .map(|path| {
                std::fs::read_to_string(path).unwrap_or_else(|error| {
                    eprintln!("read review summary: {error}");
                    std::process::exit(1);
                })
            })
            .unwrap_or_default();
        let evidence = durable::review_evidence(std::path::Path::new(&durability_dir), &run_id)
            .unwrap_or_else(|error| {
                eprintln!("read durable evidence: {error}");
                std::process::exit(1);
            });
        let summary = format!(
            "## Foundry build\n\n- Specification: `{}`\n- Accepted IR revision: `{}`\n- Base commit: `{base_commit}`\n- Head commit: `{head_commit}`\n\n{}\n{}\n## Residual risks\n\nHuman review and merge are required. Review all durable artifacts before approval.\n",
            ir.spec.name,
            foundry_ir::ir_digest(&ir),
            operator_summary,
            evidence,
        );
        let publisher = GitHubRepositoryProvider;
        let url = publisher
            .publish_draft(
                std::path::Path::new(&repository),
                &run_id,
                &base_branch,
                &format!("Foundry build {run_id}"),
                &summary,
            )
            .unwrap_or_else(|error| {
                eprintln!("draft publication failed: {error}");
                std::process::exit(1);
            });
        println!("draft pull request: {url}");
        return;
    }
    if args.get(1).is_some_and(|value| value == "status") {
        let Some(run_id) = arg(&args, "--run") else {
            eprintln!("usage: foundry-host status --run <id> --durability-dir <dir>");
            std::process::exit(2);
        };
        let Some(durability_dir) = arg(&args, "--durability-dir") else {
            eprintln!("usage: foundry-host status --run <id> --durability-dir <dir>");
            std::process::exit(2);
        };
        let status = durable::run_status(std::path::Path::new(&durability_dir), &run_id)
            .unwrap_or_else(|error| {
                eprintln!("status failed: {error}");
                std::process::exit(1);
            });
        println!("{run_id}: {status:?}");
        return;
    }
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
    let durability = arg(&args, "--durability").unwrap_or_else(|| "local".to_string());
    let mut base_commit = arg(&args, "--base").unwrap_or_else(|| "uncommitted".to_string());
    let raw = std::fs::read_to_string(&ir_path).unwrap_or_else(|e| {
        eprintln!("read {ir_path}: {e}");
        std::process::exit(1);
    });
    let document: IrDocument = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("parse IR: {e}");
        std::process::exit(1);
    });
    let architecture_ir: Value = serde_json::from_str(&raw).expect("validated IR is JSON");
    let (ir, plan, ir_v2) = match document {
        IrDocument::V1(ir) => {
            let plan = compile(&ir).unwrap_or_else(|errs| {
                eprintln!("IR did not compile:");
                for error in &errs {
                    eprintln!("  - {error}");
                }
                std::process::exit(1);
            });
            (ir, plan, None)
        }
        IrDocument::V2(ir_v2) => {
            let plan = compile_v2(&ir_v2).unwrap_or_else(|errs| {
                eprintln!("IR v2 did not compile:");
                for error in &errs {
                    eprintln!("  - {error}");
                }
                std::process::exit(1);
            });
            (ir_v2.v1_core(), plan.core, Some(ir_v2))
        }
    };
    let ir_digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
    let only = arg(&args, "--only");
    let scope_key = only.as_deref().unwrap_or("all");
    let run_digest = format!(
        "{:x}",
        Sha256::digest(format!("{ir_digest}:{base_commit}:{scope_key}").as_bytes())
    );
    let run_id =
        arg(&args, "--durable-run-id").unwrap_or_else(|| format!("run-{}", &run_digest[..16]));
    let attempt_path = std::path::Path::new(&workspace_root)
        .join(".foundry")
        .join("attempts")
        .join(&run_id);
    let targets: BTreeMap<String, ()> = if let Some(only) = only {
        only.split(',')
            .map(str::trim)
            .filter(|node| !node.is_empty())
            .map(|node| {
                if !plan.order.iter().any(|candidate| candidate == node) {
                    eprintln!("--only contains unknown node `{node}`");
                    std::process::exit(2);
                }
                (node.to_owned(), ())
            })
            .collect()
    } else {
        plan.order.iter().cloned().map(|node| (node, ())).collect()
    };
    if has_flag(&args, "--dry-run") {
        println!("Foundry dry-run: {}", ir.spec.name);
        for (index, generation) in plan.generations.iter().enumerate() {
            println!("  generation {index}: {}", generation.join(", "));
        }
        return;
    }
    let worker_token = std::env::var("FOUNDRY_WORKER_TOKEN").unwrap_or_else(|_| {
        eprintln!("FOUNDRY_WORKER_TOKEN is required");
        std::process::exit(2);
    });
    let repository = LocalGitRepository;
    let run_worktree = arg(&args, "--repo").map(|repository_path| {
        repository
            .prepare_worktree(
                std::path::Path::new(&repository_path),
                &attempt_path,
                &base_commit,
                &run_id,
            )
            .unwrap_or_else(|error| {
                eprintln!("prepare run worktree: {error}");
                std::process::exit(1);
            })
    });
    if let Some(worktree) = &run_worktree {
        base_commit.clone_from(&worktree.base_commit);
        println!("  branch:       {}", worktree.branch);
    }
    let mut architecture_paths = if let Some(worktree) = &run_worktree {
        match (
            arg(&args, "--studio-rationale"),
            arg(&args, "--studio-layout"),
            arg(&args, "--studio-locks"),
        ) {
            (Some(rationale), Some(layout), Some(locks)) => {
                let read_json = |path: &str| -> Value {
                    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|error| {
                        eprintln!("read Studio architecture metadata `{path}`: {error}");
                        std::process::exit(1);
                    }))
                    .unwrap_or_else(|error| {
                        eprintln!("parse Studio architecture metadata `{path}`: {error}");
                        std::process::exit(1);
                    })
                };
                materialize_architecture_files(
                    worktree,
                    &architecture_ir,
                    &read_json(&rationale),
                    &read_json(&layout),
                    &read_json(&locks),
                )
                .unwrap_or_else(|error| {
                    eprintln!("materialize approved architecture: {error}");
                    std::process::exit(1);
                })
            }
            (None, None, None) => Vec::new(),
            _ => {
                eprintln!("Studio builds require --studio-rationale, --studio-layout, and --studio-locks together");
                std::process::exit(2);
            }
        }
    } else {
        Vec::new()
    };
    if let (Some(worktree), Some(ir_v2)) = (&run_worktree, &ir_v2) {
        let generated = foundry_ir::generate_resource_files(ir_v2).unwrap_or_else(|errors| {
            eprintln!("generate IR v2 resource manifests:");
            errors.iter().for_each(|error| eprintln!("  - {error}"));
            std::process::exit(1);
        });
        architecture_paths.extend(
            materialize_generated_resources(worktree, &generated).unwrap_or_else(|error| {
                eprintln!("materialize IR v2 resource manifests: {error}");
                std::process::exit(1);
            }),
        );
    }
    let ws = attempt_path.to_string_lossy().into_owned();
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
        StudioJobContext {
            proposal_id: arg(&args, "--studio-proposal-id").as_deref(),
            revision_id: arg(&args, "--studio-revision-id").as_deref(),
            semantic_digest: arg(&args, "--studio-semantic-digest").as_deref(),
        },
    ));
    if ir_v2.is_some() && durability != "local" {
        eprintln!("IR v2 builds require --durability local");
        std::process::exit(2);
    }
    let v2_plan = ir_v2.as_ref().map(|ir_v2| {
        v2_execution_plan(ir_v2, &ws, &run_id, &base_commit).unwrap_or_else(|error| {
            eprintln!("prepare IR v2 execution: {error}");
            std::process::exit(1);
        })
    });
    if durability == "local" {
        let durability_dir = arg(&args, "--durability-dir")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(&workspace_root)
                    .join(".foundry")
                    .join("durability")
                    .join(&ir_digest)
            });
        let durable_outcome = durable::run(
            &ir,
            &plan,
            jobs.as_ref(),
            raw.as_bytes(),
            &base,
            &worker_token,
            durability_dir,
            &run_digest,
            &targets,
            arg(&args, "--durable-run-id").as_deref(),
            v2_plan,
        )
        .unwrap_or_else(|error| {
            eprintln!("durable build failed: {error}");
            std::process::exit(1);
        });
        if let Some(worktree) = &run_worktree {
            if let Some(resolution) = durable_outcome.dependency_resolution.as_ref() {
                architecture_paths.extend(
                    materialize_dependency_resolution(worktree, resolution).unwrap_or_else(
                        |error| {
                            eprintln!("materialize dependency resolution evidence: {error}");
                            std::process::exit(1);
                        },
                    ),
                );
                let ir_v2 = ir_v2
                    .as_ref()
                    .ok_or("dependency resolution belongs to a non-v2 build")
                    .unwrap_or_else(|error| {
                        eprintln!("materialize native dependency files: {error}");
                        std::process::exit(1);
                    });
                let (manifest, lockfile) =
                    dependency_file_artifacts(resolution).unwrap_or_else(|error| {
                        eprintln!("read dependency artifact identities: {error}");
                        std::process::exit(1);
                    });
                let manifest_bytes = fetch_dependency_artifact(&base, &worker_token, &manifest)
                    .unwrap_or_else(|error| {
                        eprintln!("fetch dependency manifest bundle: {error}");
                        std::process::exit(1);
                    });
                let lockfile_bytes = fetch_dependency_artifact(&base, &worker_token, &lockfile)
                    .unwrap_or_else(|error| {
                        eprintln!("fetch dependency lockfile bundle: {error}");
                        std::process::exit(1);
                    });
                architecture_paths.extend(
                    materialize_native_dependency_files(
                        worktree,
                        ir_v2,
                        &manifest_bytes,
                        &lockfile_bytes,
                    )
                    .unwrap_or_else(|error| {
                        eprintln!("materialize native dependency files: {error}");
                        std::process::exit(1);
                    }),
                );
            }
            if let Some(evidence) = durable_outcome.environment_evidence.as_ref() {
                architecture_paths.extend(
                    materialize_environment_evidence(worktree, evidence).unwrap_or_else(|error| {
                        eprintln!("materialize environment lifecycle evidence: {error}");
                        std::process::exit(1);
                    }),
                );
            }
            let policy = DiffPolicy {
                allowed_paths: targets
                    .keys()
                    .filter_map(|node| plan.write_targets.get(node).cloned())
                    .chain(architecture_paths.iter().cloned())
                    .collect::<BTreeSet<_>>(),
                max_file_bytes: 4 * 1024 * 1024,
            };
            let paths = repository
                .validate_diff(worktree, &policy)
                .unwrap_or_else(|error| {
                    eprintln!("final diff rejected: {error}");
                    std::process::exit(1);
                });
            if !paths.is_empty() {
                let commit = repository
                    .commit(
                        worktree,
                        &paths,
                        &format!("Build {} with Foundry ({run_id})", ir.spec.name),
                    )
                    .unwrap_or_else(|error| {
                        eprintln!("commit green build: {error}");
                        std::process::exit(1);
                    });
                println!("  committed:    {commit}");
            }
        }
        return;
    }
    if durability != "off" {
        eprintln!("--durability must be `local` or `off`");
        std::process::exit(2);
    }
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

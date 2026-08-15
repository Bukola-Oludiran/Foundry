use std::collections::{BTreeMap, HashMap};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::executor::block_on;
use graphreact_core::{
    use_durable_artifact, use_durable_effect, use_durable_state, use_message, Attrs, ChildSpec,
    CommunicationGraph, DurableArtifactRequest, DurableEffectRequest, DurableReplayPolicy,
    NodeContext, NodeDefinition, PermissionManifest, RestartPolicy, RestartStrategy,
    RestartTracker, Scheduler, SuperviseDecision, Supervisor,
};
use graphreact_durable_runtime::{
    cancel_run, dispatch_pending_effects, enqueue_durable_message, get_run, install_local,
    list_run_artifacts, recover, write_runtime_snapshot, AdapterFuture, DurableEffectAdapter,
    EffectAdapterError, EffectAdapterRegistry,
};
use graphreact_persistence::{
    canonical_json_bytes, AttemptId, CorrelationId, DeploymentDigest, DeploymentId,
    LocalPersistence, PersistenceEngine, ReplayPolicy, RunId, RunStatus, RuntimeRecordV1,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::http::http_post_json;
use crate::{BuildPlan, Ir, Job, MAX_RETRIES};

const FENCING_TOKEN: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagerDecision {
    Retry,
    ProposeRearchitecture,
    Escalate,
    Fail,
}

const MANAGER_DECISIONS: [ManagerDecision; 4] = [
    ManagerDecision::Retry,
    ManagerDecision::ProposeRearchitecture,
    ManagerDecision::Escalate,
    ManagerDecision::Fail,
];

impl ManagerDecision {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Retry => "retry",
            Self::ProposeRearchitecture => "propose_rearchitecture",
            Self::Escalate => "escalate",
            Self::Fail => "fail",
        }
    }
}

#[derive(Debug)]
struct WorkerEffectAdapter {
    base: String,
    token: String,
}

impl DurableEffectAdapter for WorkerEffectAdapter {
    fn replay_policy(&self) -> ReplayPolicy {
        ReplayPolicy::Idempotent
    }

    fn execute<'a>(
        &'a self,
        effect_id: &'a graphreact_persistence::EffectId,
        operation: &'a str,
        input: &'a Value,
    ) -> AdapterFuture<'a, Value> {
        Box::pin(async move {
            let path = match operation {
                "build" => "/build",
                "test" => "/test",
                other => {
                    return Err(EffectAdapterError::Operation {
                        operation: other.to_owned(),
                        message: "unsupported worker operation".into(),
                    });
                }
            };
            let mut request = input.clone();
            request["job_id"] = json!(effect_id.to_string());
            http_post_json(&self.base, path, &request, &self.token).map_err(|message| {
                eprintln!("durable worker effect {effect_id} {operation} failed: {message}");
                EffectAdapterError::Operation {
                    operation: operation.to_owned(),
                    message,
                }
            })
        })
    }

    fn cancel<'a>(
        &'a self,
        effect_id: &'a graphreact_persistence::EffectId,
    ) -> AdapterFuture<'a, ()> {
        Box::pin(async move {
            http_post_json(
                &self.base,
                "/cancel",
                &json!({"effect_id": effect_id.to_string()}),
                &self.token,
            )
            .map(|_| ())
            .map_err(|message| EffectAdapterError::Operation {
                operation: "cancel".into(),
                message,
            })
        })
    }
}

pub fn request_cancel(durability_dir: &Path, run_id: &str) -> Result<(), String> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let requests = durability_dir.join("cancel-requests");
    std::fs::create_dir_all(&requests).map_err(|error| error.to_string())?;
    let path = requests.join(run_id.as_str());
    match OpenOptions::new().create_new(true).write(true).open(path) {
        Ok(file) => file.sync_all().map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn cancellation_requested(durability_dir: &Path, run_id: &RunId) -> bool {
    durability_dir
        .join("cancel-requests")
        .join(run_id.as_str())
        .is_file()
}

fn retry_or_fail(
    phase: graphreact_core::DurableSignal,
    feedback: graphreact_core::DurableSignal,
    decision: graphreact_core::DurableSignal,
    attempt: u64,
    detail: Value,
) {
    feedback.set(detail);
    if attempt < u64::from(MAX_RETRIES) {
        phase.set(json!("retry"));
        decision.set(json!(ManagerDecision::Retry.as_str()));
    } else {
        phase.set(json!("failed"));
        decision.set(json!(ManagerDecision::Fail.as_str()));
    }
}

fn definition(node_id: String, job: Job) -> NodeDefinition {
    NodeDefinition::new(
        format!("FoundryDyad:{node_id}"),
        move |_ctx: &NodeContext| {
            let phase = use_durable_state("phase", json!("pending"));
            let attempt = use_durable_state("attempt", json!(0));
            let feedback = use_durable_state("feedback", Value::Null);
            let verdict = use_durable_state("verdict", Value::Null);
            let manager_decision = use_durable_state("manager_decision", Value::Null);
            let effect = use_durable_effect();
            let artifact = use_durable_artifact();

            let build_request = job.build_req.clone();
            let build_effect = effect.clone();
            use_message("build", move |message| {
                if matches!(phase.get().as_str(), Some("building" | "testing" | "green")) {
                    return;
                }
                let next_attempt = attempt.get().as_u64().unwrap_or_default() + 1;
                let mut request = build_request.clone();
                request["attempt"] = json!(next_attempt);
                request["feedback"] = feedback.get();
                if let Some(run_id) = &message.run_id {
                    request["run_id"] = json!(run_id);
                }
                let result = build_effect(DurableEffectRequest {
                    key: format!("build:{next_attempt}"),
                    adapter: "foundry-worker".into(),
                    operation: "build".into(),
                    input: request,
                    result_type: "build_result".into(),
                    error_type: "build_error".into(),
                    replay_policy: DurableReplayPolicy::Idempotent,
                });
                if let Err(error) = result {
                    retry_or_fail(
                        phase,
                        feedback,
                        manager_decision,
                        next_attempt,
                        json!({"error": error.to_string()}),
                    );
                    return;
                }
                attempt.set(json!(next_attempt));
                phase.set(json!("building"));
            });

            let test_request = job.test_req.clone();
            let test_effect = effect.clone();
            let build_artifact = artifact.clone();
            let build_node_id = node_id.clone();
            use_message("build_result", move |message| {
                let current_attempt = attempt.get().as_u64().unwrap_or_default();
                let bytes = serde_json::to_vec(&message.payload).unwrap_or_default();
                let _ = build_artifact(DurableArtifactRequest {
                    logical_name: format!("{build_node_id}-build-{current_attempt}.json"),
                    media_type: "application/vnd.foundry.build-result+json".into(),
                    bytes,
                });
                if message.payload.get("ok").and_then(Value::as_bool) != Some(true) {
                    retry_or_fail(
                        phase,
                        feedback,
                        manager_decision,
                        current_attempt,
                        message.payload.clone(),
                    );
                    return;
                }
                let mut request = test_request.clone();
                if let Some(run_id) = &message.run_id {
                    request["run_id"] = json!(run_id);
                }
                if let Err(error) = test_effect(DurableEffectRequest {
                    key: format!("test:{current_attempt}"),
                    adapter: "foundry-worker".into(),
                    operation: "test".into(),
                    input: request,
                    result_type: "test_result".into(),
                    error_type: "test_error".into(),
                    replay_policy: DurableReplayPolicy::Idempotent,
                }) {
                    retry_or_fail(
                        phase,
                        feedback,
                        manager_decision,
                        current_attempt,
                        json!({"error": error.to_string()}),
                    );
                    return;
                }
                phase.set(json!("testing"));
            });

            let test_artifact = artifact.clone();
            let test_node_id = node_id.clone();
            use_message("test_result", move |message| {
                let current_attempt = attempt.get().as_u64().unwrap_or_default();
                let bytes = serde_json::to_vec(&message.payload).unwrap_or_default();
                let _ = test_artifact(DurableArtifactRequest {
                    logical_name: format!("{test_node_id}-test-{current_attempt}.json"),
                    media_type: "application/vnd.foundry.test-result+json".into(),
                    bytes,
                });
                if message.payload.get("verdict").and_then(Value::as_str) == Some("green") {
                    verdict.set(message.payload.clone());
                    manager_decision.set(Value::Null);
                    phase.set(json!("green"));
                } else {
                    retry_or_fail(
                        phase,
                        feedback,
                        manager_decision,
                        current_attempt,
                        message.payload.clone(),
                    );
                }
            });

            use_message("build_error", move |message| {
                retry_or_fail(
                    phase,
                    feedback,
                    manager_decision,
                    attempt.get().as_u64().unwrap_or_default(),
                    message.payload.clone(),
                );
            });
            use_message("test_error", move |message| {
                retry_or_fail(
                    phase,
                    feedback,
                    manager_decision,
                    attempt.get().as_u64().unwrap_or_default(),
                    message.payload.clone(),
                );
            });

            PermissionManifest::new(
                [
                    "build",
                    "build_result",
                    "build_error",
                    "test_result",
                    "test_error",
                ],
                Vec::<String>::new(),
            )
        },
    )
}

fn deployment_id(root: &Path) -> Result<DeploymentId, String> {
    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let path = root.join("deployment-id");
    if let Ok(value) = std::fs::read_to_string(&path) {
        return DeploymentId::parse(value.trim().to_owned()).map_err(|error| error.to_string());
    }
    let id = DeploymentId::new();
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(id.as_str().as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(id)
}

fn decode_digest(value: &str) -> Result<DeploymentDigest, String> {
    if value.len() != 64 {
        return Err("deployment digest must contain 64 hexadecimal characters".into());
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|error| error.to_string())?;
    }
    Ok(DeploymentDigest(bytes))
}

fn open_existing(durability_dir: &Path) -> Result<LocalPersistence, String> {
    let deployment_id = DeploymentId::parse(
        std::fs::read_to_string(durability_dir.join("deployment-id"))
            .map_err(|error| error.to_string())?
            .trim()
            .to_owned(),
    )
    .map_err(|error| error.to_string())?;
    let digest = decode_digest(
        std::fs::read_to_string(durability_dir.join("deployment-digest"))
            .map_err(|error| error.to_string())?
            .trim(),
    )?;
    LocalPersistence::open(graphreact_persistence::LocalConfig::new(
        durability_dir,
        deployment_id,
        digest,
    ))
    .map_err(|error| error.to_string())
}

pub fn run_status(durability_dir: &Path, run_id: &str) -> Result<RunStatus, String> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let engine = open_existing(durability_dir)?;
    block_on(get_run(&engine, &run_id))
        .map(|info| info.status)
        .map_err(|error| error.to_string())
}

pub fn review_evidence(durability_dir: &Path, run_id: &str) -> Result<String, String> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let engine = open_existing(durability_dir)?;
    let info = block_on(get_run(&engine, &run_id)).map_err(|error| error.to_string())?;
    let artifacts =
        block_on(list_run_artifacts(&engine, &run_id)).map_err(|error| error.to_string())?;
    let attempts = block_on(engine.replay(0))
        .map_err(|error| error.to_string())?
        .iter()
        .filter(|record| {
            matches!(record, RuntimeRecordV1::AttemptStarted { run_id: id, .. } if id == &run_id)
        })
        .count();
    let mut summary = format!(
        "## Durable run evidence\n\n- Run: `{run_id}`\n- Status: `{:?}`\n- Attempts: {attempts}\n- Durable artifacts: {}\n",
        info.status,
        artifacts.len()
    );
    if let Some(result) = info.result {
        summary.push_str(&format!("- Terminal result: `{result}`\n"));
    }
    if !artifacts.is_empty() {
        summary.push_str("\n### Artifacts\n\n");
        for artifact in artifacts {
            summary.push_str(&format!(
                "- `{}` — `{}` — {} bytes — SHA-256 `{}`\n",
                artifact.logical_name,
                artifact.media_type,
                artifact.size,
                artifact
                    .sha256
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ));
        }
    }
    Ok(summary)
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn crash_injection(point: &str) {
    if std::env::var("FOUNDRY_CRASH_AT").ok().as_deref() != Some(point) {
        return;
    }
    if let Ok(marker) = std::env::var("FOUNDRY_CRASH_MARKER") {
        let marker = Path::new(&marker);
        if let Some(parent) = marker.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match OpenOptions::new().create_new(true).write(true).open(marker) {
            Ok(file) => {
                let _ = file.sync_all();
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return,
            Err(error) => {
                eprintln!("cannot create crash-injection marker: {error}");
                std::process::exit(87);
            }
        }
    }
    eprintln!("intentional Foundry crash injection at `{point}`");
    std::process::exit(86);
}

struct RunContext {
    run_id: RunId,
    attempt_id: AttemptId,
    status: RunStatus,
}

async fn load_or_create_run(
    engine: &dyn PersistenceEngine,
    idempotency_key: &str,
    request_hash: [u8; 32],
) -> Result<RunContext, String> {
    let records = engine.replay(0).await.map_err(|error| error.to_string())?;
    let mut found: Option<RunContext> = None;
    for record in records {
        match record {
            RuntimeRecordV1::RunCreated {
                run_id,
                request_hash: existing_hash,
                idempotency_key: existing_key,
                ..
            } if existing_key == idempotency_key => {
                if existing_hash != request_hash {
                    return Err("durable build idempotency conflict".into());
                }
                found = Some(RunContext {
                    run_id,
                    attempt_id: AttemptId::new(),
                    status: RunStatus::Queued,
                });
            }
            RuntimeRecordV1::AttemptStarted {
                run_id, attempt_id, ..
            } if found.as_ref().is_some_and(|value| value.run_id == run_id) => {
                if let Some(value) = found.as_mut() {
                    value.attempt_id = attempt_id;
                }
            }
            RuntimeRecordV1::ActivationCommitted(commit)
                if found
                    .as_ref()
                    .is_some_and(|value| value.run_id == commit.run_id) =>
            {
                if let Some(value) = found.as_mut() {
                    value.status = commit.resulting_status;
                }
            }
            RuntimeRecordV1::RunStatusChanged { run_id, status, .. }
                if found.as_ref().is_some_and(|value| value.run_id == run_id) =>
            {
                if let Some(value) = found.as_mut() {
                    value.status = status;
                }
            }
            _ => {}
        }
    }
    if let Some(found) = found {
        return Ok(found);
    }

    let run_id = RunId::new();
    let attempt_id = AttemptId::new();
    let now = unix_time_ms();
    engine
        .commit(
            FENCING_TOKEN,
            &[
                RuntimeRecordV1::RunCreated {
                    run_id: run_id.clone(),
                    entrypoint: "foundry-build".into(),
                    request_hash,
                    idempotency_key: idempotency_key.into(),
                    created_at_ms: now,
                },
                RuntimeRecordV1::AttemptStarted {
                    run_id: run_id.clone(),
                    attempt_id: attempt_id.clone(),
                    number: 1,
                    started_at_ms: now,
                },
            ],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(RunContext {
        run_id,
        attempt_id,
        status: RunStatus::Queued,
    })
}

fn phase(snapshot: &graphreact_core::DurableStateSnapshot, node_id: &str) -> String {
    snapshot
        .nodes
        .get(node_id)
        .and_then(|values| values.get("phase"))
        .and_then(Value::as_str)
        .unwrap_or("pending")
        .to_owned()
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    ir: &Ir,
    plan: &BuildPlan,
    jobs: &HashMap<String, Job>,
    raw_ir: &[u8],
    base: &str,
    token: &str,
    durability_dir: PathBuf,
    idempotency_key: &str,
    targets: &BTreeMap<String, ()>,
) -> Result<(), String> {
    debug_assert_eq!(MANAGER_DECISIONS.len(), 4);
    let mut definitions: HashMap<String, NodeDefinition> = jobs
        .iter()
        .map(|(node_id, job)| (node_id.clone(), definition(node_id.clone(), job.clone())))
        .collect();
    let mut graph = CommunicationGraph::new();
    graph.add_node(ir.root.as_str(), Attrs::new());
    let mut scheduler = Scheduler::new(graph);
    let root_definition = definitions
        .remove(&ir.root)
        .ok_or_else(|| "root definition missing".to_string())?;
    scheduler
        .register_node(root_definition, ir.root.as_str(), Attrs::new(), 0)
        .map_err(|error| error.to_string())?;

    let digest = DeploymentDigest::of(raw_ir);
    std::fs::create_dir_all(&durability_dir).map_err(|error| error.to_string())?;
    let digest_path = durability_dir.join("deployment-digest");
    if let Ok(existing) = std::fs::read_to_string(&digest_path) {
        if existing.trim() != digest.hex() {
            return Err("durability directory belongs to a different IR deployment".into());
        }
    } else {
        std::fs::write(&digest_path, digest.hex()).map_err(|error| error.to_string())?;
    }
    let config = graphreact_persistence::LocalConfig::new(
        &durability_dir,
        deployment_id(&durability_dir)?,
        digest,
    );
    let engine = install_local(&mut scheduler, config).map_err(|error| error.to_string())?;
    scheduler.install_supervise_decision_hook(Arc::new(|_supervisor, child, reason| {
        eprintln!(
            "manager supervising `{child}` observed {reason:?}; proceeding with bounded restart"
        );
        SuperviseDecision::Proceed
    }));
    scheduler.start().map_err(|error| error.to_string())?;

    let children_by_owner: BTreeMap<String, Vec<String>> =
        ir.nodes.iter().fold(BTreeMap::new(), |mut owners, node| {
            if let Some(owner) = &node.owner {
                owners
                    .entry(owner.clone())
                    .or_default()
                    .push(node.id.clone());
            }
            owners
        });
    for children in children_by_owner.values() {
        let supervisor = scheduler.install_supervisor(Supervisor::new(
            RestartStrategy::OneForOne,
            RestartTracker::new(MAX_RETRIES, Duration::from_secs(60)),
        ));
        for child in children {
            let child_definition = definitions
                .remove(child)
                .ok_or_else(|| format!("child definition missing: {child}"))?;
            scheduler
                .supervise(
                    supervisor,
                    ChildSpec {
                        id: child.clone(),
                        policy: RestartPolicy::Permanent,
                        definition: child_definition,
                        props: Attrs::new(),
                        connect_to: Vec::new(),
                        height: 0,
                    },
                )
                .map_err(|error| error.to_string())?;
        }
    }
    scheduler
        .process_batch()
        .map_err(|error| error.to_string())?;
    let recovery =
        block_on(recover(&scheduler, engine.as_ref())).map_err(|error| error.to_string())?;
    crash_injection("after_recovery");
    println!(
        "  recovery: {} records, {} pending messages",
        recovery.replayed_records, recovery.pending_messages
    );

    let request_hash: [u8; 32] = Sha256::digest(canonical_json_bytes(&json!({
        "ir": String::from_utf8_lossy(raw_ir),
        "base": idempotency_key,
    })))
    .into();
    let run = block_on(load_or_create_run(
        engine.as_ref(),
        idempotency_key,
        request_hash,
    ))?;
    println!("  durable run: {} ({:?})", run.run_id, run.status);
    if run.status.is_terminal() {
        return match run.status {
            RunStatus::Succeeded => Ok(()),
            _ => Err(format!("durable run is already terminal: {:?}", run.status)),
        };
    }

    let mut registry = EffectAdapterRegistry::default();
    registry.register(
        "foundry-worker",
        Arc::new(WorkerEffectAdapter {
            base: base.to_owned(),
            token: token.to_owned(),
        }),
    );

    loop {
        crash_injection("before_activation");
        if cancellation_requested(&durability_dir, &run.run_id) {
            block_on(cancel_run(
                &scheduler,
                engine.as_ref(),
                FENCING_TOKEN,
                &run.run_id,
            ))
            .map_err(|error| error.to_string())?;
            block_on(engine.commit(
                FENCING_TOKEN,
                &[RuntimeRecordV1::RunStatusChanged {
                    run_id: run.run_id.clone(),
                    status: RunStatus::Cancelled,
                    result: None,
                    error: None,
                    changed_at_ms: unix_time_ms(),
                }],
            ))
            .map_err(|error| error.to_string())?;
            block_on(write_runtime_snapshot(
                &scheduler,
                engine.as_ref(),
                FENCING_TOKEN,
            ))
            .map_err(|error| error.to_string())?;
            return Err(format!("durable run {} was cancelled", run.run_id));
        }
        scheduler
            .process_batch()
            .map_err(|error| error.to_string())?;
        crash_injection("after_activation");
        crash_injection("before_effect_dispatch");
        let dispatched = block_on(dispatch_pending_effects(
            &scheduler,
            engine.as_ref(),
            FENCING_TOKEN,
            &registry,
        ))
        .map_err(|error| error.to_string())?;
        crash_injection("after_effect_dispatch");
        scheduler
            .process_batch()
            .map_err(|error| error.to_string())?;
        crash_injection("after_effect_result_application");

        let state = scheduler.snapshot_durable_state();
        let phases: BTreeMap<_, _> = plan
            .order
            .iter()
            .map(|node_id| (node_id.clone(), phase(&state, node_id)))
            .collect();
        if targets
            .keys()
            .all(|node| phases.get(node).is_some_and(|value| value == "green"))
        {
            block_on(engine.commit(
                FENCING_TOKEN,
                &[RuntimeRecordV1::RunStatusChanged {
                    run_id: run.run_id.clone(),
                    status: RunStatus::Succeeded,
                    result: Some(json!({"nodes": phases})),
                    error: None,
                    changed_at_ms: unix_time_ms(),
                }],
            ))
            .map_err(|error| error.to_string())?;
            crash_injection("before_terminal_snapshot");
            block_on(write_runtime_snapshot(
                &scheduler,
                engine.as_ref(),
                FENCING_TOKEN,
            ))
            .map_err(|error| error.to_string())?;
            println!("✅ durable build: ALL GREEN");
            return Ok(());
        }
        if let Some((node, _)) = phases
            .iter()
            .filter(|(node, _)| targets.contains_key(*node))
            .find(|(_, value)| *value == "failed")
        {
            let detail = state
                .nodes
                .get(node)
                .and_then(|values| values.get("feedback"))
                .cloned()
                .unwrap_or(Value::Null);
            block_on(engine.commit(
                FENCING_TOKEN,
                &[RuntimeRecordV1::RunStatusChanged {
                    run_id: run.run_id.clone(),
                    status: RunStatus::Failed,
                    result: None,
                    error: Some(format!(
                        "node `{node}` exhausted its repair budget: {detail}"
                    )),
                    changed_at_ms: unix_time_ms(),
                }],
            ))
            .map_err(|error| error.to_string())?;
            block_on(write_runtime_snapshot(
                &scheduler,
                engine.as_ref(),
                FENCING_TOKEN,
            ))
            .map_err(|error| error.to_string())?;
            return Err(format!(
                "node `{node}` exhausted its repair budget: {detail}"
            ));
        }

        let queues = scheduler.snapshot_durable_queues();
        let queued = |node_id: &str| {
            queues
                .inbox
                .iter()
                .chain(queues.postponed.iter())
                .any(|message| message.to == node_id && message.r#type == "build")
        };
        let mut scheduled = 0usize;
        for node_id in &plan.order {
            if !targets.contains_key(node_id) {
                continue;
            }
            let current = phases.get(node_id).map(String::as_str).unwrap_or("pending");
            if !matches!(current, "pending" | "retry") || queued(node_id) {
                continue;
            }
            let ready = plan.dependencies[node_id].iter().all(|dependency| {
                !targets.contains_key(dependency)
                    || phases.get(dependency).is_some_and(|value| value == "green")
            });
            if ready {
                enqueue_durable_message(
                    &scheduler,
                    engine.as_ref(),
                    FENCING_TOKEN,
                    node_id,
                    "build",
                    Value::Null,
                    run.run_id.clone(),
                    run.attempt_id.clone(),
                    CorrelationId::new(),
                )
                .map_err(|error| error.to_string())?;
                crash_injection("after_message_enqueue");
                scheduled += 1;
            }
        }
        if scheduled == 0
            && dispatched.dispatched == 0
            && dispatched.result_messages == 0
            && queues.inbox.is_empty()
        {
            return Err(format!("durable scheduler made no progress: {phases:?}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_decision_names_are_stable() {
        assert_eq!(ManagerDecision::Retry.as_str(), "retry");
        assert_eq!(
            ManagerDecision::ProposeRearchitecture.as_str(),
            "propose_rearchitecture"
        );
        assert_eq!(ManagerDecision::Escalate.as_str(), "escalate");
        assert_eq!(ManagerDecision::Fail.as_str(), "fail");
    }
}

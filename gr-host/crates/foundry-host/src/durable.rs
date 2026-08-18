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
const V2_PREFLIGHT_NODE: &str = "__foundry_v2_preflight";

#[derive(Debug, Clone)]
pub struct V2ExecutionPlan {
    pub dependency_request: Option<Value>,
    pub environment_start_request: Option<Value>,
    pub migrations: Value,
    pub workspace: String,
    pub node_bindings: BTreeMap<String, Value>,
}

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
                "resolve_dependencies" => "/v2/dependencies/resolve",
                "environment_start" => "/v2/environments/start",
                "environment_health" => "/v2/environments/health",
                "environment_migrations" => "/v2/environments/migrations",
                "environment_snapshot" => "/v2/environments/snapshot",
                "environment_teardown" => "/v2/environments/teardown",
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

fn v2_preflight_definition(plan: V2ExecutionPlan) -> NodeDefinition {
    NodeDefinition::new("FoundryV2Preflight", move |_ctx: &NodeContext| {
        let phase = use_durable_state("phase", json!("pending"));
        let failure = use_durable_state("failure", Value::Null);
        let dependency_result = use_durable_state("dependency_result", Value::Null);
        let environment_handle = use_durable_state("environment_handle", Value::Null);
        let environment_snapshot = use_durable_state("environment_snapshot", Value::Null);
        let effect = use_durable_effect();
        let artifact = use_durable_artifact();

        let prepare_plan = plan.clone();
        let prepare_effect = effect.clone();
        use_message("prepare", move |_message| {
            if phase.get().as_str() != Some("pending") {
                return;
            }
            let request = prepare_plan
                .dependency_request
                .clone()
                .or_else(|| prepare_plan.environment_start_request.clone());
            let Some(request) = request else {
                phase.set(json!("ready"));
                return;
            };
            let resolving = prepare_plan.dependency_request.is_some();
            let (key, operation, result_type, error_type) = if resolving {
                (
                    "dependency-resolution",
                    "resolve_dependencies",
                    "dependency_result",
                    "dependency_error",
                )
            } else {
                (
                    "environment-start",
                    "environment_start",
                    "environment_start_result",
                    "environment_start_error",
                )
            };
            match prepare_effect(DurableEffectRequest {
                key: key.into(),
                adapter: "foundry-worker".into(),
                operation: operation.into(),
                input: request,
                result_type: result_type.into(),
                error_type: error_type.into(),
                replay_policy: DurableReplayPolicy::Idempotent,
            }) {
                Ok(_) => phase.set(json!(if resolving {
                    "resolving_dependencies"
                } else {
                    "starting_environment"
                })),
                Err(error) => {
                    failure.set(json!({"phase": operation, "error": error.to_string()}));
                    phase.set(json!("failed"));
                }
            }
        });

        let dependency_plan = plan.clone();
        let dependency_effect = effect.clone();
        let dependency_artifact = artifact.clone();
        use_message("dependency_result", move |message| {
            if message.payload.get("ok").and_then(Value::as_bool) != Some(true) {
                failure.set(message.payload.clone());
                phase.set(json!("failed"));
                return;
            }
            let bytes = serde_json::to_vec(&message.payload).unwrap_or_default();
            if let Err(error) = dependency_artifact(DurableArtifactRequest {
                logical_name: "dependency-resolution.json".into(),
                media_type: "application/vnd.foundry.dependency-resolution.v1+json".into(),
                bytes,
            }) {
                failure.set(json!({"phase": "dependency_artifact", "error": error.to_string()}));
                phase.set(json!("failed"));
                return;
            }
            dependency_result.set(message.payload.clone());
            let Some(request) = dependency_plan.environment_start_request.clone() else {
                phase.set(json!("ready"));
                return;
            };
            match dependency_effect(DurableEffectRequest {
                key: "environment-start".into(),
                adapter: "foundry-worker".into(),
                operation: "environment_start".into(),
                input: request,
                result_type: "environment_start_result".into(),
                error_type: "environment_start_error".into(),
                replay_policy: DurableReplayPolicy::Idempotent,
            }) {
                Ok(_) => phase.set(json!("starting_environment")),
                Err(error) => {
                    failure.set(json!({"phase": "environment_start", "error": error.to_string()}));
                    phase.set(json!("failed"));
                }
            }
        });

        let health_effect = effect.clone();
        use_message("environment_start_result", move |message| {
            let Some(environment_id) = message
                .payload
                .get("environment_id")
                .and_then(Value::as_str)
            else {
                failure.set(json!({"phase": "environment_start", "error": "environment handle omitted its identity"}));
                phase.set(json!("failed"));
                return;
            };
            let Some(plan_digest) = message.payload.get("plan_digest").and_then(Value::as_str)
            else {
                failure.set(json!({"phase": "environment_start", "error": "environment handle omitted its plan digest"}));
                phase.set(json!("failed"));
                return;
            };
            environment_handle.set(message.payload.clone());
            let input = json!({
                "protocol_version": 2,
                "run_id": message.run_id,
                "environment_id": environment_id,
                "plan_digest": plan_digest,
            });
            match health_effect(DurableEffectRequest {
                key: "environment-health".into(),
                adapter: "foundry-worker".into(),
                operation: "environment_health".into(),
                input,
                result_type: "environment_health_result".into(),
                error_type: "environment_health_error".into(),
                replay_policy: DurableReplayPolicy::Idempotent,
            }) {
                Ok(_) => phase.set(json!("checking_environment")),
                Err(error) => {
                    failure.set(json!({"phase": "environment_health", "error": error.to_string()}));
                    phase.set(json!("failed"));
                }
            }
        });

        let migration_plan = plan.clone();
        let post_health_effect = effect.clone();
        use_message("environment_health_result", move |message| {
            if message.payload.get("healthy").and_then(Value::as_bool) != Some(true) {
                failure.set(message.payload.clone());
                phase.set(json!("failed"));
                return;
            }
            let handle = environment_handle.get();
            let mut input = json!({
                "protocol_version": 2,
                "run_id": message.run_id,
                "environment_id": handle.get("environment_id"),
                "plan_digest": handle.get("plan_digest"),
            });
            let has_migrations = migration_plan
                .migrations
                .as_array()
                .is_some_and(|migrations| !migrations.is_empty());
            let (key, operation, result_type, error_type) = if has_migrations {
                input["workspace"] = json!(migration_plan.workspace);
                input["migrations"] = migration_plan.migrations.clone();
                (
                    "environment-migrations",
                    "environment_migrations",
                    "environment_migrations_result",
                    "environment_migrations_error",
                )
            } else {
                (
                    "environment-snapshot",
                    "environment_snapshot",
                    "environment_snapshot_result",
                    "environment_snapshot_error",
                )
            };
            match post_health_effect(DurableEffectRequest {
                key: key.into(),
                adapter: "foundry-worker".into(),
                operation: operation.into(),
                input,
                result_type: result_type.into(),
                error_type: error_type.into(),
                replay_policy: DurableReplayPolicy::Idempotent,
            }) {
                Ok(_) => phase.set(json!(if has_migrations {
                    "migrating"
                } else {
                    "snapshotting_environment"
                })),
                Err(error) => {
                    failure.set(json!({"phase": operation, "error": error.to_string()}));
                    phase.set(json!("failed"));
                }
            }
        });

        let snapshot_effect = effect.clone();
        let migration_artifact = artifact.clone();
        use_message("environment_migrations_result", move |message| {
            if message.payload.get("green").and_then(Value::as_bool) != Some(true) {
                failure.set(message.payload.clone());
                phase.set(json!("failed"));
                return;
            }
            let _ = migration_artifact(DurableArtifactRequest {
                logical_name: "migration-results.json".into(),
                media_type: "application/vnd.foundry.migration-results.v1+json".into(),
                bytes: serde_json::to_vec(&message.payload).unwrap_or_default(),
            });
            let handle = environment_handle.get();
            let input = json!({
                "protocol_version": 2,
                "run_id": message.run_id,
                "environment_id": handle.get("environment_id"),
                "plan_digest": handle.get("plan_digest"),
            });
            match snapshot_effect(DurableEffectRequest {
                key: "environment-snapshot".into(),
                adapter: "foundry-worker".into(),
                operation: "environment_snapshot".into(),
                input,
                result_type: "environment_snapshot_result".into(),
                error_type: "environment_snapshot_error".into(),
                replay_policy: DurableReplayPolicy::Idempotent,
            }) {
                Ok(_) => phase.set(json!("snapshotting_environment")),
                Err(error) => {
                    failure
                        .set(json!({"phase": "environment_snapshot", "error": error.to_string()}));
                    phase.set(json!("failed"));
                }
            }
        });

        let snapshot_artifact = artifact.clone();
        use_message("environment_snapshot_result", move |message| {
            if message
                .payload
                .get("snapshot_digest")
                .and_then(Value::as_str)
                .is_none()
            {
                failure.set(
                    json!({"phase": "environment_snapshot", "error": "snapshot digest is missing"}),
                );
                phase.set(json!("failed"));
                return;
            }
            let _ = snapshot_artifact(DurableArtifactRequest {
                logical_name: "environment-snapshot.json".into(),
                media_type: "application/vnd.foundry.environment-snapshot.v1+json".into(),
                bytes: serde_json::to_vec(&message.payload).unwrap_or_default(),
            });
            environment_snapshot.set(message.payload.clone());
            phase.set(json!("ready"));
        });

        for message_type in [
            "dependency_error",
            "environment_start_error",
            "environment_health_error",
            "environment_migrations_error",
            "environment_snapshot_error",
        ] {
            use_message(message_type, move |message| {
                failure.set(message.payload.clone());
                phase.set(json!("failed"));
            });
        }
        use_message("environment_teardown_error", move |message| {
            failure.set(message.payload.clone());
            phase.set(json!("cleanup_failed"));
        });

        let teardown_effect = effect.clone();
        use_message("teardown", move |message| {
            let current = phase.get();
            let Some(current) = current.as_str() else {
                return;
            };
            if !matches!(current, "ready" | "failed") {
                return;
            }
            let handle = environment_handle.get();
            if handle.is_null() {
                phase.set(json!(if current == "failed" {
                    "failed_cleaned"
                } else {
                    "cleaned"
                }));
                return;
            }
            let input = json!({
                "protocol_version": 2,
                "run_id": message.run_id,
                "environment_id": handle.get("environment_id"),
                "plan_digest": handle.get("plan_digest"),
            });
            match teardown_effect(DurableEffectRequest {
                key: "environment-teardown".into(),
                adapter: "foundry-worker".into(),
                operation: "environment_teardown".into(),
                input,
                result_type: "environment_teardown_result".into(),
                error_type: "environment_teardown_error".into(),
                replay_policy: DurableReplayPolicy::Idempotent,
            }) {
                Ok(_) => phase.set(json!(if current == "failed" {
                    "tearing_down_after_failure"
                } else {
                    "tearing_down"
                })),
                Err(error) => {
                    failure
                        .set(json!({"phase": "environment_teardown", "error": error.to_string()}));
                    phase.set(json!("failed"));
                }
            }
        });
        use_message("environment_teardown_result", move |message| {
            if message
                .payload
                .get("cleanup_complete")
                .and_then(Value::as_bool)
                == Some(true)
            {
                phase.set(json!(
                    if phase.get().as_str() == Some("tearing_down_after_failure") {
                        "failed_cleaned"
                    } else {
                        "cleaned"
                    }
                ));
            } else {
                failure.set(message.payload.clone());
                phase.set(json!("failed"));
            }
        });
        PermissionManifest::default()
    })
}

fn apply_worker_context(request: &mut Value, context: Option<&Value>) {
    let Some(context) = context.and_then(Value::as_object) else {
        return;
    };
    for key in [
        "protocol_version",
        "dependency_layer",
        "resource_bindings",
        "integration_bindings",
        "secret_handles",
        "test_environment",
        "migration_phase",
        "resource_policy",
    ] {
        if let Some(value) = context.get(key) {
            request[key] = value.clone();
        }
    }
}

fn v2_worker_context(
    plan: &V2ExecutionPlan,
    state: &graphreact_core::DurableStateSnapshot,
    node_id: &str,
) -> Value {
    let binding = plan
        .node_bindings
        .get(node_id)
        .cloned()
        .unwrap_or_else(|| json!({}));
    let values = state.nodes.get(V2_PREFLIGHT_NODE);
    let resolution = values
        .and_then(|values| values.get("dependency_result"))
        .cloned()
        .unwrap_or(Value::Null);
    let handle = values
        .and_then(|values| values.get("environment_handle"))
        .cloned()
        .unwrap_or(Value::Null);
    let snapshot = values
        .and_then(|values| values.get("environment_snapshot"))
        .cloned()
        .unwrap_or(Value::Null);
    let dependency_layer = binding.get("package_root").and_then(|root| {
        if root.is_null() {
            return None;
        }
        Some(json!({
            "artifact_id": resolution.pointer("/dependency_layer/sha256"),
            "sha256": resolution.pointer("/evidence/dependency_layer_sha256"),
            "package_root": root.get("id"),
            "manifest_path": root.get("manifest_path"),
            "lockfile_path": root.get("lockfile_path"),
            "resolver_image": resolution.pointer("/evidence/resolver_image"),
            "platform": resolution.pointer("/evidence/platform"),
        }))
    });
    let environment = if handle.is_null() {
        Value::Null
    } else {
        json!({
            "environment_id": handle.get("environment_id"),
            "network_id": handle.get("network_id"),
            "snapshot_digest": snapshot.get("snapshot_digest"),
            "resources": binding.get("resource_bindings").cloned().unwrap_or_else(|| json!([])),
            "integrations": binding.get("integration_bindings").cloned().unwrap_or_else(|| json!([])),
        })
    };
    json!({
        "build_context": {
            "protocol_version": 2,
            "dependency_layer": dependency_layer,
            "resource_bindings": binding.get("resource_bindings").cloned().unwrap_or_else(|| json!([])),
            "integration_bindings": binding.get("integration_bindings").cloned().unwrap_or_else(|| json!([])),
            "secret_handles": binding.get("secret_handles").cloned().unwrap_or_else(|| json!([])),
        },
        "test_context": {
            "protocol_version": 2,
            "dependency_layer": dependency_layer,
            "test_environment": environment,
            "migration_phase": if plan.migrations.as_array().is_some_and(|items| !items.is_empty()) {
                "verified"
            } else {
                "not_required"
            },
            "resource_policy": if handle.is_null() {
                json!({"timeout_ms": 300_000, "memory_mb": 1024, "cpu_count": 2, "pids": 256, "network": "none"})
            } else {
                json!({"timeout_ms": 300_000, "memory_mb": 2048, "cpu_count": 2, "pids": 512, "network": "private-integration"})
            },
        }
    })
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
            let worker_context = use_durable_state("worker_context", Value::Null);
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
                apply_worker_context(&mut request, message.payload.get("build_context"));
                worker_context.set(message.payload.clone());
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
                request["attempt"] = json!(current_attempt);
                let context = worker_context.get();
                apply_worker_context(&mut request, context.get("test_context"));
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
            let evidence_artifact = artifact.clone();
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
                    let mut accepted = message.payload.clone();
                    if let Some(evidence) = accepted.get("implementation_evidence") {
                        let evidence_bytes = serde_json::to_vec(evidence).unwrap_or_default();
                        match evidence_artifact(DurableArtifactRequest {
                            logical_name: format!("{test_node_id}-evidence-{current_attempt}.json"),
                            media_type:
                                "application/vnd.foundry.node-implementation-evidence.v1+json"
                                    .into(),
                            bytes: evidence_bytes,
                        }) {
                            Ok(artifact_id) => {
                                accepted["evidence_artifact_id"] = json!(artifact_id);
                            }
                            Err(error) => {
                                retry_or_fail(
                                    phase,
                                    feedback,
                                    manager_decision,
                                    current_attempt,
                                    json!({"error": error.to_string()}),
                                );
                                return;
                            }
                        }
                    }
                    verdict.set(accepted);
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

pub fn run_artifacts(
    durability_dir: &Path,
    run_id: &str,
) -> Result<Vec<graphreact_persistence::ArtifactMetadata>, String> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let engine = open_existing(durability_dir)?;
    block_on(list_run_artifacts(&engine, &run_id)).map_err(|error| error.to_string())
}

pub fn read_run_artifact(
    durability_dir: &Path,
    run_id: &str,
    artifact_id: &str,
) -> Result<(graphreact_persistence::ArtifactMetadata, Vec<u8>), String> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let artifact_id = graphreact_persistence::ArtifactId::parse(artifact_id.to_owned())
        .map_err(|error| error.to_string())?;
    let engine = open_existing(durability_dir)?;
    let metadata = block_on(list_run_artifacts(&engine, &run_id))
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|metadata| metadata.id == artifact_id)
        .ok_or_else(|| "artifact does not belong to this run".to_string())?;
    let bytes = block_on(engine.read_artifact(&artifact_id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "artifact bytes are missing".to_string())?;
    Ok((metadata, bytes))
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
    preferred_run_id: Option<&RunId>,
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

    let run_id = preferred_run_id.cloned().unwrap_or_else(RunId::new);
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
    preferred_run_id: Option<&str>,
    v2: Option<V2ExecutionPlan>,
) -> Result<(), String> {
    debug_assert_eq!(MANAGER_DECISIONS.len(), 4);
    let mut definitions: HashMap<String, NodeDefinition> = jobs
        .iter()
        .map(|(node_id, job)| (node_id.clone(), definition(node_id.clone(), job.clone())))
        .collect();
    let mut graph = CommunicationGraph::new();
    graph.add_node(ir.root.as_str(), Attrs::new());
    if v2.is_some() {
        graph.add_node(V2_PREFLIGHT_NODE, Attrs::new());
    }
    let mut scheduler = Scheduler::new(graph);
    let root_definition = definitions
        .remove(&ir.root)
        .ok_or_else(|| "root definition missing".to_string())?;
    scheduler
        .register_node(root_definition, ir.root.as_str(), Attrs::new(), 0)
        .map_err(|error| error.to_string())?;
    if let Some(v2) = &v2 {
        scheduler
            .register_node(
                v2_preflight_definition(v2.clone()),
                V2_PREFLIGHT_NODE,
                Attrs::new(),
                0,
            )
            .map_err(|error| error.to_string())?;
    }

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
    let preferred_run_id = preferred_run_id
        .map(|value| RunId::parse(value.to_owned()).map_err(|error| error.to_string()))
        .transpose()?;
    let run = block_on(load_or_create_run(
        engine.as_ref(),
        idempotency_key,
        request_hash,
        preferred_run_id.as_ref(),
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
        let preflight_phase = v2.as_ref().map(|_| phase(&state, V2_PREFLIGHT_NODE));
        if preflight_phase.as_deref() == Some("failed") {
            let handle_exists = state
                .nodes
                .get(V2_PREFLIGHT_NODE)
                .and_then(|values| values.get("environment_handle"))
                .is_some_and(|handle| !handle.is_null());
            if handle_exists {
                enqueue_durable_message(
                    &scheduler,
                    engine.as_ref(),
                    FENCING_TOKEN,
                    V2_PREFLIGHT_NODE,
                    "teardown",
                    Value::Null,
                    run.run_id.clone(),
                    run.attempt_id.clone(),
                    CorrelationId::new(),
                )
                .map_err(|error| error.to_string())?;
                continue;
            }
        }
        if matches!(
            preflight_phase.as_deref(),
            Some("failed" | "failed_cleaned" | "cleanup_failed")
        ) {
            let detail = state
                .nodes
                .get(V2_PREFLIGHT_NODE)
                .and_then(|values| values.get("failure"))
                .cloned()
                .unwrap_or(Value::Null);
            return Err(format!("IR v2 pre-build lifecycle failed: {detail}"));
        }
        if targets
            .keys()
            .all(|node| phases.get(node).is_some_and(|value| value == "green"))
        {
            if let Some(current) = preflight_phase.as_deref() {
                if current == "ready" {
                    enqueue_durable_message(
                        &scheduler,
                        engine.as_ref(),
                        FENCING_TOKEN,
                        V2_PREFLIGHT_NODE,
                        "teardown",
                        Value::Null,
                        run.run_id.clone(),
                        run.attempt_id.clone(),
                        CorrelationId::new(),
                    )
                    .map_err(|error| error.to_string())?;
                    continue;
                }
                if current != "cleaned" {
                    continue;
                }
            }
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
            if let Some(current) = preflight_phase.as_deref() {
                if current == "ready" {
                    enqueue_durable_message(
                        &scheduler,
                        engine.as_ref(),
                        FENCING_TOKEN,
                        V2_PREFLIGHT_NODE,
                        "teardown",
                        Value::Null,
                        run.run_id.clone(),
                        run.attempt_id.clone(),
                        CorrelationId::new(),
                    )
                    .map_err(|error| error.to_string())?;
                    continue;
                }
                if current != "cleaned" {
                    continue;
                }
            }
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
        if preflight_phase.as_deref() == Some("pending")
            && !queues
                .inbox
                .iter()
                .chain(queues.postponed.iter())
                .any(|message| message.to == V2_PREFLIGHT_NODE && message.r#type == "prepare")
        {
            enqueue_durable_message(
                &scheduler,
                engine.as_ref(),
                FENCING_TOKEN,
                V2_PREFLIGHT_NODE,
                "prepare",
                Value::Null,
                run.run_id.clone(),
                run.attempt_id.clone(),
                CorrelationId::new(),
            )
            .map_err(|error| error.to_string())?;
            scheduled += 1;
        }
        for node_id in &plan.order {
            if !targets.contains_key(node_id) {
                continue;
            }
            let current = phases.get(node_id).map(String::as_str).unwrap_or("pending");
            if !matches!(current, "pending" | "retry") || queued(node_id) {
                continue;
            }
            if v2.is_some() && preflight_phase.as_deref() != Some("ready") {
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
                    v2.as_ref()
                        .map(|plan| v2_worker_context(plan, &state, node_id))
                        .unwrap_or(Value::Null),
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

    #[test]
    fn v2_context_binds_exact_resolution_and_environment_snapshot() {
        let plan = V2ExecutionPlan {
            dependency_request: None,
            environment_start_request: None,
            migrations: json!([{"resource_id": "db"}]),
            workspace: "/worktree".into(),
            node_bindings: BTreeMap::from([(
                "api".into(),
                json!({
                    "package_root": {
                        "id": "api-root",
                        "manifest_path": "package.json",
                        "lockfile_path": "package-lock.json"
                    },
                    "resource_bindings": [],
                    "integration_bindings": [],
                    "secret_handles": []
                }),
            )]),
        };
        let state = graphreact_core::DurableStateSnapshot {
            nodes: BTreeMap::from([(
                V2_PREFLIGHT_NODE.into(),
                BTreeMap::from([
                    (
                        "dependency_result".into(),
                        json!({
                            "evidence": {
                                "dependency_layer_sha256": "a".repeat(64),
                                "resolver_image": format!("resolver@sha256:{}", "b".repeat(64)),
                                "platform": "linux/amd64"
                            },
                            "dependency_layer": {"sha256": "a".repeat(64)}
                        }),
                    ),
                    (
                        "environment_handle".into(),
                        json!({"environment_id": "env-1", "network_id": "net-1"}),
                    ),
                    (
                        "environment_snapshot".into(),
                        json!({"snapshot_digest": "c".repeat(64)}),
                    ),
                ]),
            )]),
        };
        let context = v2_worker_context(&plan, &state, "api");
        assert_eq!(
            context.pointer("/build_context/dependency_layer/package_root"),
            Some(&json!("api-root"))
        );
        assert_eq!(
            context.pointer("/test_context/test_environment/environment_id"),
            Some(&json!("env-1"))
        );
        assert_eq!(
            context.pointer("/test_context/migration_phase"),
            Some(&json!("verified"))
        );
    }
}

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use futures::executor::block_on;
use graphreact_durable_runtime::DurableEffectAdapter;
use graphreact_persistence::{
    ArtifactId, ArtifactMetadata, AttemptId, EffectId, EffectOutcome, PersistenceEngine, RunId,
    RuntimeRecordV1,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MEDIA_TYPE: &str = "application/vnd.foundry.cancellation-reconciliation.v1+json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReconciliationStateV1 {
    Pending,
    Completed,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancellationReconciliationV1 {
    protocol_version: u32,
    run_id: RunId,
    attempt_id: AttemptId,
    effect_id: EffectId,
    request: Value,
    state: ReconciliationStateV1,
    cooperative_cancelled_effects: Vec<String>,
    cooperative_cancel_failures: u64,
    result: Option<Value>,
    artifact: Option<ArtifactMetadata>,
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn journal_path(root: &Path, run_id: &RunId) -> Result<PathBuf, String> {
    let directory = root.join("cancellation-reconciliation");
    if directory
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("cancellation reconciliation directory may not be a symlink".into());
    }
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{}.json", run_id.as_str())))
}

fn write_journal(path: &Path, journal: &CancellationReconciliationV1) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", ArtifactId::new()));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    use std::io::Write;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "reconciliation journal has no parent".to_string())?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

fn read_or_create_journal(
    root: &Path,
    run_id: &RunId,
    attempt_id: &AttemptId,
    request: Value,
    recovered_effect_id: Option<EffectId>,
) -> Result<(PathBuf, CancellationReconciliationV1), String> {
    let path = journal_path(root, run_id)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            let journal: CancellationReconciliationV1 =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if journal.protocol_version != 1
                || &journal.run_id != run_id
                || &journal.attempt_id != attempt_id
                || journal.request != request
            {
                return Err(
                    "cancellation reconciliation journal does not match the durable run".into(),
                );
            }
            Ok((path, journal))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let journal = CancellationReconciliationV1 {
                protocol_version: 1,
                run_id: run_id.clone(),
                attempt_id: attempt_id.clone(),
                effect_id: recovered_effect_id.unwrap_or_default(),
                request,
                state: ReconciliationStateV1::Pending,
                cooperative_cancelled_effects: Vec::new(),
                cooperative_cancel_failures: 0,
                result: None,
                artifact: None,
            };
            write_journal(&path, &journal)?;
            Ok((path, journal))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn pending_worker_effects(
    engine: &dyn PersistenceEngine,
    run_id: &RunId,
) -> Result<(Vec<EffectId>, Option<EffectId>), String> {
    let mut pending = BTreeMap::<EffectId, String>::new();
    let mut teardowns = BTreeSet::<EffectId>::new();
    for record in block_on(engine.replay(0)).map_err(|error| error.to_string())? {
        match record {
            RuntimeRecordV1::ActivationCommitted(commit) if &commit.run_id == run_id => {
                for intent in commit.effect_intents {
                    if intent.adapter == "foundry-worker" {
                        if intent.operation == "environment_teardown" {
                            teardowns.insert(intent.id.clone());
                        }
                        pending.insert(intent.id, intent.operation);
                    }
                }
            }
            RuntimeRecordV1::EffectCompleted { effect_id, .. } => {
                pending.remove(&effect_id);
            }
            _ => {}
        }
    }
    if teardowns.len() > 1 {
        return Err("cancelled run has multiple environment-teardown effects".into());
    }
    let teardown = teardowns.into_iter().next();
    Ok((
        pending
            .into_iter()
            .filter_map(|(effect_id, operation)| {
                (operation != "environment_teardown").then_some(effect_id)
            })
            .collect(),
        teardown,
    ))
}

fn recorded_effect_states(
    engine: &dyn PersistenceEngine,
    effect_id: &EffectId,
) -> Result<(bool, Option<Value>), String> {
    let mut dispatched = false;
    let mut completed = None;
    for record in block_on(engine.replay(0)).map_err(|error| error.to_string())? {
        match record {
            RuntimeRecordV1::EffectDispatched {
                effect_id: recorded,
                ..
            } if &recorded == effect_id => dispatched = true,
            RuntimeRecordV1::EffectCompleted {
                effect_id: recorded,
                outcome: EffectOutcome::Succeeded(result),
                ..
            } if &recorded == effect_id => completed = Some(result),
            RuntimeRecordV1::EffectCompleted {
                effect_id: recorded,
                outcome,
                ..
            } if &recorded == effect_id => {
                return Err(format!(
                    "environment teardown effect completed without success: {outcome:?}"
                ));
            }
            _ => {}
        }
    }
    Ok((dispatched, completed))
}

fn recover_ambiguous_environment_handle(
    engine: &dyn PersistenceEngine,
    fencing_token: u64,
    run_id: &RunId,
    adapter: &dyn DurableEffectAdapter,
) -> Result<Option<Value>, String> {
    let mut starts = BTreeMap::<EffectId, Value>::new();
    let mut dispatched = BTreeSet::<EffectId>::new();
    let mut outcomes = BTreeMap::<EffectId, EffectOutcome>::new();
    for record in block_on(engine.replay(0)).map_err(|error| error.to_string())? {
        match record {
            RuntimeRecordV1::ActivationCommitted(commit) if &commit.run_id == run_id => {
                for intent in commit.effect_intents {
                    if intent.adapter == "foundry-worker" && intent.operation == "environment_start"
                    {
                        starts.insert(intent.id, intent.input);
                    }
                }
            }
            RuntimeRecordV1::EffectDispatched { effect_id, .. } => {
                dispatched.insert(effect_id);
            }
            RuntimeRecordV1::EffectCompleted {
                effect_id, outcome, ..
            } => {
                outcomes.insert(effect_id, outcome);
            }
            _ => {}
        }
    }
    if starts.len() > 1 {
        return Err("cancelled run has multiple environment-start effects".into());
    }
    let Some((effect_id, input)) = starts.into_iter().next() else {
        return Ok(None);
    };
    let result = match outcomes.remove(&effect_id) {
        Some(EffectOutcome::Succeeded(result)) => result,
        Some(EffectOutcome::Failed { .. } | EffectOutcome::Cancelled) => return Ok(None),
        Some(EffectOutcome::Indeterminate) => {
            return Err("environment-start effect became indeterminate".into());
        }
        None if !dispatched.contains(&effect_id) => return Ok(None),
        None => {
            let result = block_on(adapter.execute(&effect_id, "environment_start", &input))
                .map_err(|error| error.to_string())?;
            block_on(engine.commit(
                fencing_token,
                &[RuntimeRecordV1::EffectCompleted {
                    effect_id,
                    outcome: EffectOutcome::Succeeded(result.clone()),
                    result_message: None,
                    completed_at_ms: unix_time_ms(),
                }],
            ))
            .map_err(|error| error.to_string())?;
            result
        }
    };
    let expected_plan = input.pointer("/plan/plan_digest");
    if result
        .get("environment_id")
        .and_then(Value::as_str)
        .is_none()
        || result.get("plan_digest") != expected_plan
        || result.get("run_id") != input.get("run_id")
    {
        return Err("recovered environment-start result does not match its durable intent".into());
    }
    Ok(Some(result))
}

fn artifact_bytes(journal: &CancellationReconciliationV1) -> Result<Vec<u8>, String> {
    let value = json!({
        "protocol_version": 1,
        "run_id": journal.run_id,
        "effect_id": journal.effect_id,
        "environment_id": journal.request.get("environment_id"),
        "plan_digest": journal.request.get("plan_digest"),
        "cooperative_cancelled_effects": journal.cooperative_cancelled_effects,
        "cooperative_cancel_failures": journal.cooperative_cancel_failures,
        "teardown": journal.result,
    });
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    let lower = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
    if [
        "authorization",
        "bearer ",
        "cookie",
        "password",
        "private_key",
        "private key",
        "nsec1",
        "ghp_",
        "github_pat_",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return Err("cancellation reconciliation evidence contains secret-shaped material".into());
    }
    Ok(bytes)
}

fn verify_result(request: &Value, result: &Value) -> Result<(), String> {
    if result.get("environment_id") != request.get("environment_id")
        || result.get("plan_digest") != request.get("plan_digest")
        || result.get("stopped").and_then(Value::as_bool) != Some(true)
        || result.get("cleanup_complete").and_then(Value::as_bool) != Some(true)
    {
        return Err(
            "cancelled environment teardown did not return complete matching evidence".into(),
        );
    }
    Ok(())
}

/// Reconciles a cancelled run after its monotonic cancellation record exists.
/// A local journal preserves the stable cleanup EffectId across an ambiguous
/// process exit; the authoritative outcome and evidence remain in GraphReact.
#[allow(clippy::too_many_arguments)]
pub fn reconcile_cancelled_environment(
    engine: &dyn PersistenceEngine,
    fencing_token: u64,
    durability_dir: &Path,
    run_id: &RunId,
    attempt_id: &AttemptId,
    environment_handle: Option<&Value>,
    adapter: &dyn DurableEffectAdapter,
) -> Result<Option<Value>, String> {
    let recovered_handle;
    let environment_handle = if environment_handle.is_some_and(|handle| !handle.is_null()) {
        environment_handle
    } else {
        recovered_handle =
            recover_ambiguous_environment_handle(engine, fencing_token, run_id, adapter)?;
        recovered_handle.as_ref()
    };
    let (pending_effects, existing_teardown) = pending_worker_effects(engine, run_id)?;
    let mut cancelled = BTreeSet::new();
    let mut failures = 0_u64;
    for effect_id in pending_effects {
        match block_on(adapter.cancel(&effect_id)) {
            Ok(()) => {
                cancelled.insert(effect_id.to_string());
            }
            Err(_) => failures = failures.saturating_add(1),
        }
    }
    let Some(handle) = environment_handle.filter(|handle| !handle.is_null()) else {
        return Ok(None);
    };
    let environment_id = handle
        .get("environment_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "cancelled environment handle has no identity".to_string())?;
    let plan_digest = handle
        .get("plan_digest")
        .and_then(Value::as_str)
        .ok_or_else(|| "cancelled environment handle has no plan digest".to_string())?;
    let request = json!({
        "protocol_version": 2,
        "run_id": run_id,
        "environment_id": environment_id,
        "plan_digest": plan_digest,
    });
    let (path, mut journal) = read_or_create_journal(
        durability_dir,
        run_id,
        attempt_id,
        request,
        existing_teardown,
    )?;

    if journal.state == ReconciliationStateV1::Pending {
        journal.cooperative_cancelled_effects = cancelled.into_iter().collect();
        journal.cooperative_cancel_failures = failures;
        write_journal(&path, &journal)?;

        let (dispatched, completed) = recorded_effect_states(engine, &journal.effect_id)?;
        if !dispatched {
            block_on(engine.commit(
                fencing_token,
                &[RuntimeRecordV1::EffectDispatched {
                    effect_id: journal.effect_id.clone(),
                    dispatched_at_ms: unix_time_ms(),
                }],
            ))
            .map_err(|error| error.to_string())?;
        }
        crate::durable::crash_injection("after_cancellation_teardown_dispatch");
        let result = if let Some(result) = completed {
            result
        } else {
            block_on(adapter.execute(&journal.effect_id, "environment_teardown", &journal.request))
                .map_err(|error| error.to_string())?
        };
        verify_result(&journal.request, &result)?;
        journal.result = Some(result);
        let bytes = artifact_bytes(&journal)?;
        journal.artifact = Some(ArtifactMetadata {
            id: ArtifactId::new(),
            run_id: run_id.clone(),
            logical_name: "cancellation-environment-reconciliation.json".into(),
            media_type: MEDIA_TYPE.into(),
            size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            sha256: Sha256::digest(&bytes).into(),
            created_at_ms: unix_time_ms(),
        });
        journal.state = ReconciliationStateV1::Completed;
        write_journal(&path, &journal)?;
        crate::durable::crash_injection("after_cancellation_teardown_result");
    }

    if journal.state == ReconciliationStateV1::Completed {
        let (_, completed) = recorded_effect_states(engine, &journal.effect_id)?;
        if completed.is_none() {
            let bytes = artifact_bytes(&journal)?;
            let artifact = journal
                .artifact
                .clone()
                .ok_or_else(|| "completed reconciliation omitted its artifact".to_string())?;
            block_on(engine.put_artifact(&artifact, &bytes)).map_err(|error| error.to_string())?;
            let result = journal
                .result
                .clone()
                .ok_or_else(|| "completed reconciliation omitted its result".to_string())?;
            block_on(engine.commit(
                fencing_token,
                &[
                    RuntimeRecordV1::EffectCompleted {
                        effect_id: journal.effect_id.clone(),
                        outcome: EffectOutcome::Succeeded(result),
                        result_message: None,
                        completed_at_ms: unix_time_ms(),
                    },
                    RuntimeRecordV1::ArtifactCommitted(artifact),
                ],
            ))
            .map_err(|error| error.to_string())?;
        }
        journal.state = ReconciliationStateV1::Committed;
        write_journal(&path, &journal)?;
        crate::durable::crash_injection("after_cancellation_evidence_commit");
    }

    journal
        .result
        .map(Some)
        .ok_or_else(|| "committed reconciliation omitted its result".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use graphreact_durable_runtime::{AdapterFuture, EffectAdapterError};
    use graphreact_persistence::{
        ActivationCommit, DeploymentDigest, DeploymentId, DurableStateWrite, EffectIntent,
        LocalConfig, LocalPersistence, MessageId, ReplayPolicy, RunStatus,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Debug, Default)]
    struct TestAdapter {
        executions: AtomicU64,
        cancellations: AtomicU64,
    }

    impl DurableEffectAdapter for TestAdapter {
        fn replay_policy(&self) -> ReplayPolicy {
            ReplayPolicy::Idempotent
        }

        fn execute<'a>(
            &'a self,
            _effect_id: &'a EffectId,
            operation: &'a str,
            input: &'a Value,
        ) -> AdapterFuture<'a, Value> {
            Box::pin(async move {
                self.executions.fetch_add(1, Ordering::SeqCst);
                match operation {
                    "environment_start" => Ok(json!({
                        "environment_id": "recovered-environment",
                        "run_id": input.get("run_id"),
                        "plan_digest": input.pointer("/plan/plan_digest"),
                        "network_id": "recovered-network",
                        "state": "ready",
                        "aliases": {},
                        "secret_handles": [],
                    })),
                    "environment_teardown" => Ok(json!({
                        "environment_id": input.get("environment_id"),
                        "plan_digest": input.get("plan_digest"),
                        "stopped": true,
                        "cleanup_complete": true,
                        "diagnostic_artifact": null,
                    })),
                    _ => Err(EffectAdapterError::Operation {
                        operation: operation.into(),
                        message: "unexpected operation".into(),
                    }),
                }
            })
        }

        fn cancel<'a>(&'a self, _effect_id: &'a EffectId) -> AdapterFuture<'a, ()> {
            Box::pin(async move {
                self.cancellations.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    fn store(label: &str) -> (PathBuf, LocalPersistence) {
        let path = std::env::temp_dir().join(format!(
            "foundry-cancellation-reconciliation-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir(&path).unwrap();
        let engine = LocalPersistence::open(LocalConfig::new(
            &path,
            DeploymentId::new(),
            DeploymentDigest::of(label.as_bytes()),
        ))
        .unwrap();
        (path, engine)
    }

    #[test]
    fn result_requires_exact_identity_and_complete_cleanup() {
        let request = json!({
            "environment_id": "environment-one",
            "plan_digest": "a".repeat(64),
        });
        let result = json!({
            "environment_id": "environment-one",
            "plan_digest": "a".repeat(64),
            "stopped": true,
            "cleanup_complete": true,
            "diagnostic_artifact": null,
        });
        verify_result(&request, &result).unwrap();
        let mut mismatched = result.clone();
        mismatched["plan_digest"] = json!("b".repeat(64));
        assert!(verify_result(&request, &mismatched).is_err());
        let mut incomplete = result;
        incomplete["cleanup_complete"] = json!(false);
        assert!(verify_result(&request, &incomplete).is_err());
    }

    #[test]
    fn artifact_projection_rejects_secret_material() {
        let journal = CancellationReconciliationV1 {
            protocol_version: 1,
            run_id: RunId::new(),
            attempt_id: AttemptId::new(),
            effect_id: EffectId::new(),
            request: json!({"environment_id": "one", "plan_digest": "a".repeat(64)}),
            state: ReconciliationStateV1::Completed,
            cooperative_cancelled_effects: Vec::new(),
            cooperative_cancel_failures: 0,
            result: Some(json!({"diagnostic": "Bearer hidden"})),
            artifact: None,
        };
        assert!(artifact_bytes(&journal).is_err());
    }

    #[test]
    fn reconciliation_reuses_one_effect_and_artifact_after_reopen() {
        let (path, engine) = store("replay");
        let run_id = RunId::new();
        let attempt_id = AttemptId::new();
        let adapter = TestAdapter::default();
        let handle = json!({
            "environment_id": "environment-run",
            "plan_digest": "a".repeat(64),
        });
        let first = reconcile_cancelled_environment(
            &engine,
            1,
            &path,
            &run_id,
            &attempt_id,
            Some(&handle),
            &adapter,
        )
        .unwrap();
        let second = reconcile_cancelled_environment(
            &engine,
            1,
            &path,
            &run_id,
            &attempt_id,
            Some(&handle),
            &adapter,
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(adapter.executions.load(Ordering::SeqCst), 1);
        let records = block_on(engine.replay(0)).unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(record, RuntimeRecordV1::EffectCompleted { .. }))
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(record, RuntimeRecordV1::ArtifactCommitted(_)))
                .count(),
            1
        );
        drop(engine);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn cancellation_invokes_pending_worker_effect_cancellation_without_an_environment() {
        let (path, engine) = store("cooperative");
        let run_id = RunId::new();
        let attempt_id = AttemptId::new();
        let effect_id = EffectId::new();
        block_on(engine.commit(
            1,
            &[RuntimeRecordV1::ActivationCommitted(ActivationCommit {
                run_id: run_id.clone(),
                attempt_id: attempt_id.clone(),
                input_message_id: MessageId::new(),
                state_writes: Vec::<DurableStateWrite>::new(),
                emitted_messages: Vec::new(),
                timers_scheduled: Vec::new(),
                timers_cancelled: Vec::new(),
                effect_intents: vec![EffectIntent {
                    id: effect_id,
                    key: "worker-build".into(),
                    run_id: run_id.clone(),
                    attempt_id: attempt_id.clone(),
                    node_id: "api".into(),
                    adapter: "foundry-worker".into(),
                    operation: "build".into(),
                    input: json!({}),
                    result_type: "build_result".into(),
                    error_type: "build_error".into(),
                    replay_policy: ReplayPolicy::Idempotent,
                }],
                artifacts: Vec::new(),
                resulting_status: RunStatus::WaitingEffect,
            })],
        ))
        .unwrap();
        let adapter = TestAdapter::default();
        assert_eq!(
            reconcile_cancelled_environment(
                &engine,
                1,
                &path,
                &run_id,
                &attempt_id,
                None,
                &adapter,
            )
            .unwrap(),
            None
        );
        assert_eq!(adapter.cancellations.load(Ordering::SeqCst), 1);
        assert_eq!(adapter.executions.load(Ordering::SeqCst), 0);
        drop(engine);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn cancellation_recovers_an_ambiguously_dispatched_environment_start() {
        let (path, engine) = store("ambiguous-start");
        let run_id = RunId::new();
        let attempt_id = AttemptId::new();
        let effect_id = EffectId::new();
        let plan_digest = "a".repeat(64);
        block_on(engine.commit(
            1,
            &[
                RuntimeRecordV1::ActivationCommitted(ActivationCommit {
                    run_id: run_id.clone(),
                    attempt_id: attempt_id.clone(),
                    input_message_id: MessageId::new(),
                    state_writes: Vec::new(),
                    emitted_messages: Vec::new(),
                    timers_scheduled: Vec::new(),
                    timers_cancelled: Vec::new(),
                    effect_intents: vec![EffectIntent {
                        id: effect_id.clone(),
                        key: "environment-start".into(),
                        run_id: run_id.clone(),
                        attempt_id: attempt_id.clone(),
                        node_id: "__foundry_v2_preflight".into(),
                        adapter: "foundry-worker".into(),
                        operation: "environment_start".into(),
                        input: json!({
                            "protocol_version": 2,
                            "run_id": run_id,
                            "plan": {"plan_digest": plan_digest},
                        }),
                        result_type: "environment_start_result".into(),
                        error_type: "environment_start_error".into(),
                        replay_policy: ReplayPolicy::Idempotent,
                    }],
                    artifacts: Vec::new(),
                    resulting_status: RunStatus::WaitingEffect,
                }),
                RuntimeRecordV1::EffectDispatched {
                    effect_id,
                    dispatched_at_ms: unix_time_ms(),
                },
            ],
        ))
        .unwrap();
        let adapter = TestAdapter::default();
        let result = reconcile_cancelled_environment(
            &engine,
            1,
            &path,
            &run_id,
            &attempt_id,
            None,
            &adapter,
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["environment_id"], "recovered-environment");
        assert_eq!(adapter.executions.load(Ordering::SeqCst), 2);
        let records = block_on(engine.replay(0)).unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(record, RuntimeRecordV1::EffectCompleted { .. }))
                .count(),
            2
        );
        drop(engine);
        let _ = std::fs::remove_dir_all(path);
    }
}

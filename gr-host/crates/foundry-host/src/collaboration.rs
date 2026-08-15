//! Durable architecture author/critic collaboration backed by GraphReact persistence.

use std::fs::{create_dir_all, read_to_string, OpenOptions};
use std::io::Write;
use std::path::Path;

use futures::executor::block_on;
use graphreact_durable_runtime::store_artifact;
use graphreact_persistence::{
    canonical_json_bytes, ArtifactId, AttemptId, DeploymentDigest, DeploymentId, LocalConfig,
    LocalPersistence, PersistenceEngine, RunId, RunStatus, RuntimeRecordV1,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use foundry_ir::{compile, Ir};

const FENCING_TOKEN: u64 = 1;
const ENTRYPOINT: &str = "foundry-architecture-collaboration";
const DEPLOYMENT_BYTES: &[u8] = b"foundry-architecture-collaboration-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollaborationPhase {
    AwaitingReview,
    ChangesRequested,
    Approved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewSummaryV1 {
    pub revision: u32,
    pub reviewer_context_id: String,
    pub verdict: String,
    pub artifact_id: String,
    pub sha256: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollaborationStateV1 {
    pub collaboration_version: u32,
    pub run_id: String,
    pub mode: String,
    pub phase: CollaborationPhase,
    pub revision: u32,
    pub author_context_id: String,
    pub candidate_artifact_id: String,
    pub candidate_sha256: String,
    pub latest_review: Option<ReviewSummaryV1>,
    pub last_operation_key: String,
    pub last_operation_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CollaborationStatusV1 {
    #[serde(flatten)]
    pub state: CollaborationStateV1,
    pub candidate: Value,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn operation_hash(value: &Value) -> [u8; 32] {
    Sha256::digest(canonical_json_bytes(value)).into()
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_ir(bytes: &[u8]) -> Result<Ir, String> {
    let ir: Ir = serde_json::from_slice(bytes)
        .map_err(|error| format!("IR JSON contract violation: {error}"))?;
    compile(&ir).map_err(|errors| {
        errors
            .into_iter()
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    })?;
    Ok(ir)
}

fn deployment_id(root: &Path) -> Result<DeploymentId, String> {
    create_dir_all(root).map_err(|error| error.to_string())?;
    let path = root.join("deployment-id");
    if let Ok(value) = read_to_string(&path) {
        return DeploymentId::parse(value.trim().to_owned()).map_err(|error| error.to_string());
    }
    let id = DeploymentId::new();
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(id.as_str().as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(id)
}

fn engine(root: &Path) -> Result<LocalPersistence, String> {
    create_dir_all(root).map_err(|error| error.to_string())?;
    let digest = DeploymentDigest::of(DEPLOYMENT_BYTES);
    let digest_path = root.join("deployment-digest");
    if let Ok(existing) = read_to_string(&digest_path) {
        if existing.trim() != digest.hex() {
            return Err("durability directory belongs to another Foundry deployment".into());
        }
    } else {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(digest_path)
            .map_err(|error| error.to_string())?;
        file.write_all(digest.hex().as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    LocalPersistence::open(LocalConfig::new(root, deployment_id(root)?, digest))
        .map_err(|error| error.to_string())
}

fn state_from_records(records: &[RuntimeRecordV1], run_id: &RunId) -> Option<CollaborationStateV1> {
    records.iter().rev().find_map(|record| match record {
        RuntimeRecordV1::RunStatusChanged {
            run_id: candidate,
            result: Some(result),
            ..
        } if candidate == run_id => serde_json::from_value(result.clone()).ok(),
        _ => None,
    })
}

fn run_state(
    engine: &dyn PersistenceEngine,
    run_id: &RunId,
) -> Result<(RunStatus, CollaborationStateV1), String> {
    let records = block_on(engine.replay(0)).map_err(|error| error.to_string())?;
    let is_collaboration = records.iter().any(|record| {
        matches!(record, RuntimeRecordV1::RunCreated { run_id: candidate, entrypoint, .. } if candidate == run_id && entrypoint == ENTRYPOINT)
    });
    if !is_collaboration {
        return Err(format!(
            "architecture collaboration run `{run_id}` was not found"
        ));
    }
    let mut state = state_from_records(&records, run_id)
        .ok_or_else(|| "architecture collaboration has no committed draft state".to_string())?;
    if let Some(review) = state.latest_review.as_mut() {
        if review.body.is_empty() {
            let artifact_id =
                ArtifactId::parse(review.artifact_id.clone()).map_err(|error| error.to_string())?;
            let bytes = block_on(engine.read_artifact(&artifact_id))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "durable architecture review artifact is missing".to_string())?;
            let persisted: Value =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            review.body = persisted
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
        }
    }
    let status = records
        .iter()
        .rev()
        .find_map(|record| match record {
            RuntimeRecordV1::RunStatusChanged {
                run_id: candidate,
                status,
                ..
            } if candidate == run_id => Some(*status),
            _ => None,
        })
        .unwrap_or(RunStatus::Queued);
    Ok((status, state))
}

fn idempotent_state(
    state: &CollaborationStateV1,
    key: &str,
    hash: &[u8; 32],
) -> Result<Option<CollaborationStateV1>, String> {
    if state.last_operation_key != key {
        return Ok(None);
    }
    if state.last_operation_hash != hex(hash) {
        return Err("architecture collaboration operation idempotency conflict".into());
    }
    Ok(Some(state.clone()))
}

fn commit_state(
    engine: &dyn PersistenceEngine,
    run_id: &RunId,
    status: RunStatus,
    state: &CollaborationStateV1,
) -> Result<(), String> {
    block_on(engine.commit(
        FENCING_TOKEN,
        &[RuntimeRecordV1::RunStatusChanged {
            run_id: run_id.clone(),
            status,
            result: Some(serde_json::to_value(state).map_err(|error| error.to_string())?),
            error: None,
            changed_at_ms: now_ms(),
        }],
    ))
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub fn begin(
    bytes: &[u8],
    durability_dir: &Path,
    author_context_id: &str,
    idempotency_key: &str,
) -> Result<CollaborationStateV1, String> {
    validate_ir(bytes)?;
    if author_context_id.trim().is_empty() || idempotency_key.trim().is_empty() {
        return Err("author context and idempotency key must not be empty".into());
    }
    let request_hash = operation_hash(&json!({
        "action": "begin",
        "mode": "architect_critic",
        "author_context_id": author_context_id,
        "candidate_sha256": sha256(bytes),
    }));
    let engine = engine(durability_dir)?;
    let records = block_on(engine.replay(0)).map_err(|error| error.to_string())?;
    let existing = records.iter().find_map(|record| match record {
        RuntimeRecordV1::RunCreated {
            run_id,
            request_hash: existing_hash,
            idempotency_key: existing_key,
            ..
        } if existing_key == idempotency_key => Some((run_id.clone(), *existing_hash)),
        _ => None,
    });
    let run_id = if let Some((run_id, existing_hash)) = existing {
        if existing_hash != request_hash {
            return Err("architecture collaboration idempotency conflict".into());
        }
        if let Some(state) = state_from_records(&records, &run_id) {
            return Ok(state);
        }
        run_id
    } else {
        let run_id = RunId::new();
        block_on(engine.commit(
            FENCING_TOKEN,
            &[
                RuntimeRecordV1::RunCreated {
                    run_id: run_id.clone(),
                    entrypoint: ENTRYPOINT.into(),
                    request_hash,
                    idempotency_key: idempotency_key.into(),
                    created_at_ms: now_ms(),
                },
                RuntimeRecordV1::AttemptStarted {
                    run_id: run_id.clone(),
                    attempt_id: AttemptId::new(),
                    number: 1,
                    started_at_ms: now_ms(),
                },
            ],
        ))
        .map_err(|error| error.to_string())?;
        run_id
    };
    let artifact = block_on(store_artifact(
        &engine,
        FENCING_TOKEN,
        run_id.clone(),
        "architecture-candidate-0001.json",
        "application/vnd.foundry.ir+json",
        bytes,
    ))
    .map_err(|error| error.to_string())?;
    let state = CollaborationStateV1 {
        collaboration_version: 1,
        run_id: run_id.to_string(),
        mode: "architect_critic".into(),
        phase: CollaborationPhase::AwaitingReview,
        revision: 1,
        author_context_id: author_context_id.into(),
        candidate_artifact_id: artifact.id.to_string(),
        candidate_sha256: sha256(bytes),
        latest_review: None,
        last_operation_key: idempotency_key.into(),
        last_operation_hash: hex(&request_hash),
    };
    commit_state(&engine, &run_id, RunStatus::WaitingEffect, &state)?;
    Ok(state)
}

pub fn revise(
    bytes: &[u8],
    durability_dir: &Path,
    run_id: &str,
    author_context_id: &str,
    expected_revision: u32,
    operation_key: &str,
) -> Result<CollaborationStateV1, String> {
    validate_ir(bytes)?;
    if author_context_id.trim().is_empty() || operation_key.trim().is_empty() {
        return Err("author context and operation key must not be empty".into());
    }
    if expected_revision == 0 {
        return Err("expected revision must be a positive integer".into());
    }
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let engine = engine(durability_dir)?;
    let (status, state) = run_state(&engine, &run_id)?;
    let hash = operation_hash(&json!({
        "action": "revise",
        "run_id": run_id,
        "expected_revision": expected_revision,
        "candidate_sha256": sha256(bytes),
    }));
    if let Some(existing) = idempotent_state(&state, operation_key, &hash)? {
        return Ok(existing);
    }
    if status.is_terminal() {
        return Err("approved architecture collaboration is immutable".into());
    }
    if state.author_context_id != author_context_id {
        return Err("only the original author context may revise this draft".into());
    }
    if state.revision != expected_revision {
        return Err(format!(
            "architecture draft revision conflict: expected {expected_revision}, current {}",
            state.revision
        ));
    }
    if state.phase != CollaborationPhase::ChangesRequested {
        return Err("a revision is accepted only after changes are requested".into());
    }
    let revision = state.revision + 1;
    let artifact = block_on(store_artifact(
        &engine,
        FENCING_TOKEN,
        run_id.clone(),
        format!("architecture-candidate-{revision:04}.json"),
        "application/vnd.foundry.ir+json",
        bytes,
    ))
    .map_err(|error| error.to_string())?;
    let next = CollaborationStateV1 {
        phase: CollaborationPhase::AwaitingReview,
        revision,
        candidate_artifact_id: artifact.id.to_string(),
        candidate_sha256: sha256(bytes),
        latest_review: None,
        last_operation_key: operation_key.into(),
        last_operation_hash: hex(&hash),
        ..state
    };
    commit_state(&engine, &run_id, RunStatus::WaitingEffect, &next)?;
    Ok(next)
}

#[allow(clippy::too_many_arguments)]
pub fn review(
    durability_dir: &Path,
    run_id: &str,
    reviewer_context_id: &str,
    expected_revision: u32,
    verdict: &str,
    body: &str,
    operation_key: &str,
) -> Result<CollaborationStateV1, String> {
    if !matches!(verdict, "approve" | "changes_requested") || body.trim().is_empty() {
        return Err("review requires approve|changes_requested and a non-empty body".into());
    }
    if reviewer_context_id.trim().is_empty() || operation_key.trim().is_empty() {
        return Err("reviewer context and operation key must not be empty".into());
    }
    if expected_revision == 0 {
        return Err("expected revision must be a positive integer".into());
    }
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let engine = engine(durability_dir)?;
    let (status, state) = run_state(&engine, &run_id)?;
    let hash = operation_hash(&json!({
        "action": "review",
        "run_id": run_id,
        "expected_revision": expected_revision,
        "reviewer_context_id": reviewer_context_id,
        "verdict": verdict,
        "body": body,
    }));
    if let Some(existing) = idempotent_state(&state, operation_key, &hash)? {
        return Ok(existing);
    }
    if status.is_terminal() {
        return Err("approved architecture collaboration is immutable".into());
    }
    if state.phase != CollaborationPhase::AwaitingReview {
        return Err("the author must submit a new revision before another review".into());
    }
    if state.revision != expected_revision {
        return Err(format!(
            "architecture draft revision conflict: expected {expected_revision}, current {}",
            state.revision
        ));
    }
    if state.author_context_id == reviewer_context_id {
        return Err("architecture review must come from an independent MCP context".into());
    }
    let candidate_id = ArtifactId::parse(state.candidate_artifact_id.clone())
        .map_err(|error| error.to_string())?;
    let candidate = block_on(engine.read_artifact(&candidate_id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "durable architecture candidate artifact is missing".to_string())?;
    validate_ir(&candidate)?;
    if sha256(&candidate) != state.candidate_sha256 {
        return Err("durable architecture candidate digest mismatch".into());
    }
    let review_bytes = serde_json::to_vec_pretty(&json!({
        "review_version": 1,
        "revision": state.revision,
        "reviewer_context_id": reviewer_context_id,
        "verdict": verdict,
        "body": body,
    }))
    .map_err(|error| error.to_string())?;
    let artifact = block_on(store_artifact(
        &engine,
        FENCING_TOKEN,
        run_id.clone(),
        format!("architecture-review-{:04}.json", state.revision),
        "application/vnd.foundry.architecture-review+json",
        &review_bytes,
    ))
    .map_err(|error| error.to_string())?;
    let approved = verdict == "approve";
    let next = CollaborationStateV1 {
        phase: if approved {
            CollaborationPhase::Approved
        } else {
            CollaborationPhase::ChangesRequested
        },
        latest_review: Some(ReviewSummaryV1 {
            revision: state.revision,
            reviewer_context_id: reviewer_context_id.into(),
            verdict: verdict.into(),
            artifact_id: artifact.id.to_string(),
            sha256: sha256(&review_bytes),
            body: body.into(),
        }),
        last_operation_key: operation_key.into(),
        last_operation_hash: hex(&hash),
        ..state
    };
    commit_state(
        &engine,
        &run_id,
        if approved {
            RunStatus::Succeeded
        } else {
            RunStatus::WaitingEffect
        },
        &next,
    )?;
    Ok(next)
}

pub fn status(durability_dir: &Path, run_id: &str) -> Result<CollaborationStatusV1, String> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|error| error.to_string())?;
    let engine = engine(durability_dir)?;
    let (_, state) = run_state(&engine, &run_id)?;
    let artifact_id = ArtifactId::parse(state.candidate_artifact_id.clone())
        .map_err(|error| error.to_string())?;
    let bytes = block_on(engine.read_artifact(&artifact_id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "durable architecture candidate artifact is missing".to_string())?;
    if sha256(&bytes) != state.candidate_sha256 {
        return Err("durable architecture candidate digest mismatch".into());
    }
    let candidate = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(CollaborationStatusV1 { state, candidate })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (std::path::PathBuf, Vec<u8>) {
        let root = std::env::temp_dir().join(format!("foundry-collaboration-{}", RunId::new()));
        let ir = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ir/examples/string-utils.ir.json"),
        )
        .unwrap();
        (root, ir)
    }

    #[test]
    fn independent_critic_gates_and_survives_reopen() {
        let (root, ir) = fixture();
        let draft = begin(&ir, &root, "codex", "begin-one").unwrap();
        assert_eq!(draft.phase, CollaborationPhase::AwaitingReview);
        let rejected = review(
            &root,
            &draft.run_id,
            "codex",
            1,
            "approve",
            "self review",
            "review-self",
        )
        .unwrap_err();
        assert!(rejected.contains("independent"));
        let changes = review(
            &root,
            &draft.run_id,
            "claude",
            1,
            "changes_requested",
            "add one edge case",
            "review-one",
        )
        .unwrap();
        assert_eq!(changes.phase, CollaborationPhase::ChangesRequested);
        let revised = revise(&ir, &root, &draft.run_id, "codex", 1, "revise-one").unwrap();
        assert_eq!(revised.revision, 2);
        let approved = review(
            &root,
            &draft.run_id,
            "claude",
            2,
            "approve",
            "compiler-valid and boundaries are explicit",
            "review-two",
        )
        .unwrap();
        assert_eq!(approved.phase, CollaborationPhase::Approved);
        let reopened = status(&root, &draft.run_id).unwrap();
        assert_eq!(reopened.state, approved);
        assert_eq!(
            reopened.candidate,
            serde_json::from_slice::<Value>(&ir).unwrap()
        );
        let _ = std::fs::remove_dir_all(root);
    }
}

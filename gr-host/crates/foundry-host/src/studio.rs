//! Durable Architecture Studio proposal repository.
//!
//! Immutable artifacts are written before the proposal head advances. A crash
//! between those operations leaves an unreferenced artifact, never a head that
//! points at missing bytes.

use std::collections::BTreeMap;
use std::fs::{create_dir_all, read_to_string, OpenOptions};
use std::io::Write;
use std::path::Path;

use foundry_ir::{
    apply_generated_studio_candidate, apply_studio_command, studio_semantic_digest,
    ArchitectureBuildHandoffV1, ArchitectureLayoutV1, ArchitectureProposalV1,
    ArchitectureRevisionV1, BoundaryLockV1, CriticReviewV1, CriticVerdictV1,
    HumanArchitectureApprovalV1, Ir, LayoutPointV1, ProposalStatusV1, StudioBindingV1,
    StudioCommandErrorV1, StudioCommandOutcomeV1, StudioCommandV1, StudioRationaleV1,
    StudioRevisionPhaseV1,
};
use futures::executor::block_on;
use graphreact_durable_runtime::store_artifact;
use graphreact_persistence::{
    canonical_json_bytes, ArtifactId, AttemptId, DeploymentDigest, DeploymentId, LocalConfig,
    LocalPersistence, PersistenceEngine, PersistenceError, RunId, RunStatus, RuntimeRecordV1,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::studio_room::{
    verify_room_event_chain, ArchitectureOperationV1, ArchitectureRoomEventV1,
    ArchitectureRoomTranscriptV1, MAX_EVENT_PAGE,
};

const FENCING_TOKEN: u64 = 1;
const ENTRYPOINT: &str = "foundry-architecture-studio";
const DEPLOYMENT_BYTES: &[u8] = b"foundry-architecture-studio-v1";
const LOCAL_LOCK_RETRY_LIMIT: std::time::Duration = std::time::Duration::from_secs(2);
const LOCAL_LOCK_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevisionArtifactsV1 {
    pub revision: ArchitectureRevisionV1,
    pub ir_artifact_id: String,
    pub rationale_artifact_id: String,
    pub locks_artifact_id: String,
    pub layout_artifact_id: String,
    #[serde(default)]
    pub structural_diff_artifact_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioOperationReceiptV1 {
    pub operation_key: String,
    pub request_hash: String,
    pub revision_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchitectureRoomPageRefV1 {
    pub artifact_id: String,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub event_count: usize,
    pub last_event_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchitectureRoomTranscriptIndexV1 {
    pub transcript_version: u32,
    pub operation: ArchitectureOperationV1,
    pub pages: Vec<ArchitectureRoomPageRefV1>,
    pub event_count: usize,
    pub last_sequence: u64,
    pub last_event_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchitectureRoomTranscriptRefV1 {
    pub operation_id: String,
    pub proposal_id: String,
    pub index_artifact_id: String,
    pub operation_digest: String,
    pub last_sequence: u64,
    pub last_event_digest: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioStateV1 {
    pub studio_version: u32,
    pub run_id: String,
    pub binding: StudioBindingV1,
    pub accepted_revision_id: Option<String>,
    pub proposals: Vec<ArchitectureProposalV1>,
    pub revisions: Vec<RevisionArtifactsV1>,
    #[serde(default)]
    pub critic_reviews: Vec<CriticReviewV1>,
    #[serde(default)]
    pub human_approvals: Vec<HumanArchitectureApprovalV1>,
    #[serde(default)]
    pub build_handoffs: Vec<ArchitectureBuildHandoffV1>,
    #[serde(default)]
    pub room_transcripts: BTreeMap<String, ArchitectureRoomTranscriptRefV1>,
    pub operation_receipts: BTreeMap<String, StudioOperationReceiptV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StudioSnapshotV1 {
    #[serde(flatten)]
    pub state: StudioStateV1,
    pub proposal: ArchitectureProposalV1,
    pub revision: ArchitectureRevisionV1,
    pub ir: Ir,
    pub rationale: StudioRationaleV1,
    pub locks: Vec<BoundaryLockV1>,
    pub layout: ArchitectureLayoutV1,
    pub structural_diff: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StudioError {
    #[error("{code}: {message}")]
    Api { code: &'static str, message: String },
}

impl StudioError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Api { code, .. } => code,
        }
    }
}

fn error(code: &'static str, message: impl Into<String>) -> StudioError {
    StudioError::Api {
        code,
        message: message.into(),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn digest<T: Serialize>(value: &T) -> String {
    let value = serde_json::to_value(value).expect("Studio contracts serialize");
    format!("{:x}", Sha256::digest(canonical_json_bytes(&value)))
}

fn deployment_id(root: &Path) -> Result<DeploymentId, StudioError> {
    create_dir_all(root).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    let path = root.join("deployment-id");
    if let Ok(value) = read_to_string(&path) {
        return DeploymentId::parse(value.trim().to_owned())
            .map_err(|e| error("SERVICE_NOT_READY", e.to_string()));
    }
    let id = DeploymentId::new();
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    file.write_all(id.as_str().as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    Ok(id)
}

fn engine(root: &Path) -> Result<LocalPersistence, StudioError> {
    create_dir_all(root).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    let deployment_digest = DeploymentDigest::of(DEPLOYMENT_BYTES);
    let digest_path = root.join("deployment-digest");
    if let Ok(existing) = read_to_string(&digest_path) {
        if existing.trim() != deployment_digest.hex() {
            return Err(error(
                "SERVICE_NOT_READY",
                "durability directory belongs to another Foundry deployment",
            ));
        }
    } else {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(digest_path)
            .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
        file.write_all(deployment_digest.hex().as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    }
    let config = LocalConfig::new(root, deployment_id(root)?, deployment_digest);
    let deadline = std::time::Instant::now() + LOCAL_LOCK_RETRY_LIMIT;
    loop {
        match LocalPersistence::open(config.clone()) {
            Ok(engine) => return Ok(engine),
            Err(PersistenceError::Locked(_)) if std::time::Instant::now() < deadline => {
                std::thread::sleep(LOCAL_LOCK_RETRY_INTERVAL);
            }
            Err(source) => return Err(error("SERVICE_NOT_READY", source.to_string())),
        }
    }
}

/// Opens, replays, and verifies the Studio durability store for readiness.
pub fn verify_readiness(root: &Path) -> Result<(), StudioError> {
    let engine = engine(root)?;
    let records = block_on(engine.replay(0))
        .map_err(|source| error("SERVICE_NOT_READY", source.to_string()))?;
    block_on(engine.verify()).map_err(|source| error("SERVICE_NOT_READY", source.to_string()))?;
    let mut latest_states = BTreeMap::new();
    for record in records {
        if let RuntimeRecordV1::RunStatusChanged {
            run_id,
            result: Some(result),
            ..
        } = record
        {
            if let Ok(state) = serde_json::from_value::<StudioStateV1>(result) {
                latest_states.insert(run_id.to_string(), state);
            }
        }
    }
    for state in latest_states.into_values() {
        for reference in state.room_transcripts.values() {
            verify_room_transcript_reference(&engine, reference)?;
        }
    }
    Ok(())
}

fn latest_state(records: &[RuntimeRecordV1], run_id: &RunId) -> Option<StudioStateV1> {
    records.iter().rev().find_map(|record| match record {
        RuntimeRecordV1::RunStatusChanged {
            run_id: candidate,
            result: Some(result),
            ..
        } if candidate == run_id => serde_json::from_value(result.clone()).ok(),
        _ => None,
    })
}

fn load_state(
    engine: &dyn PersistenceEngine,
    run_id: &RunId,
) -> Result<StudioStateV1, StudioError> {
    let records =
        block_on(engine.replay(0)).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    let exists = records.iter().any(|record| {
        matches!(record, RuntimeRecordV1::RunCreated { run_id: candidate, entrypoint, .. }
            if candidate == run_id && entrypoint == ENTRYPOINT)
    });
    if !exists {
        return Err(error(
            "NOT_FOUND",
            format!("Studio `{run_id}` was not found"),
        ));
    }
    latest_state(&records, run_id)
        .ok_or_else(|| error("SERVICE_NOT_READY", "Studio has no committed state"))
}

fn commit_state(
    engine: &dyn PersistenceEngine,
    run_id: &RunId,
    state: &StudioStateV1,
) -> Result<(), StudioError> {
    block_on(
        engine.commit(
            FENCING_TOKEN,
            &[RuntimeRecordV1::RunStatusChanged {
                run_id: run_id.clone(),
                status: RunStatus::WaitingEffect,
                result: Some(
                    serde_json::to_value(state)
                        .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?,
                ),
                error: None,
                changed_at_ms: now_ms(),
            }],
        ),
    )
    .map(|_| ())
    .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))
}

fn store_json<T: Serialize>(
    engine: &dyn PersistenceEngine,
    run_id: &RunId,
    name: impl Into<String>,
    media_type: &str,
    value: &T,
) -> Result<String, StudioError> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    block_on(store_artifact(
        engine,
        FENCING_TOKEN,
        run_id.clone(),
        name,
        media_type,
        &bytes,
    ))
    .map(|metadata| metadata.id.to_string())
    .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))
}

fn read_json<T: DeserializeOwned>(
    engine: &dyn PersistenceEngine,
    artifact_id: &str,
) -> Result<T, StudioError> {
    let id = ArtifactId::parse(artifact_id.to_owned())
        .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    let bytes = block_on(engine.read_artifact(&id))
        .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?
        .ok_or_else(|| error("SERVICE_NOT_READY", format!("artifact `{id}` is missing")))?;
    serde_json::from_slice(&bytes).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))
}

/// Mirrors a proposal room into immutable GraphReact artifacts and advances the
/// Studio state's transcript index only after every referenced page is stored.
/// Repeating this operation with an unchanged transcript is a no-op.
pub fn persist_room_transcript(
    durability_dir: &Path,
    transcript: &ArchitectureRoomTranscriptV1,
) -> Result<ArchitectureRoomTranscriptRefV1, StudioError> {
    let operation = &transcript.operation;
    let studio_run_id = operation
        .studio_run_id
        .as_deref()
        .ok_or_else(|| error("INVALID_COMMAND", "room is not bound to a Studio run"))?;
    let proposal_id = operation
        .proposal_id
        .as_deref()
        .ok_or_else(|| error("INVALID_COMMAND", "room is not bound to a proposal"))?;
    let run_id = RunId::parse(studio_run_id.to_owned())
        .map_err(|source| error("INVALID_COMMAND", source.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    if !state
        .proposals
        .iter()
        .any(|proposal| proposal.proposal_id == proposal_id)
    {
        return Err(error(
            "NOT_FOUND",
            format!("proposal `{proposal_id}` was not found"),
        ));
    }

    let operation_digest = digest(operation);
    let last_sequence = transcript.events.last().map_or(0, |event| event.sequence);
    let last_event_digest = transcript
        .events
        .last()
        .map(|event| event.event_digest.clone());
    if let Some(existing) = state.room_transcripts.get(&operation.operation_id) {
        if existing.operation_digest == operation_digest
            && existing.last_sequence == last_sequence
            && existing.last_event_digest == last_event_digest
        {
            return Ok(existing.clone());
        }
    }

    let mut pages = Vec::new();
    for (page_index, chunk) in transcript.events.chunks(MAX_EVENT_PAGE).enumerate() {
        let events: Vec<ArchitectureRoomEventV1> = chunk.to_vec();
        let Some(first) = events.first() else {
            continue;
        };
        let last = events.last().expect("non-empty transcript page");
        let artifact_id = store_json(
            &engine,
            &run_id,
            format!(
                "architecture-room-{}-page-{page_index}.json",
                operation.operation_id
            ),
            "application/vnd.foundry.architecture-room-events+json",
            &events,
        )?;
        pages.push(ArchitectureRoomPageRefV1 {
            artifact_id,
            first_sequence: first.sequence,
            last_sequence: last.sequence,
            event_count: events.len(),
            last_event_digest: last.event_digest.clone(),
        });
    }
    let index = ArchitectureRoomTranscriptIndexV1 {
        transcript_version: 1,
        operation: operation.clone(),
        pages,
        event_count: transcript.events.len(),
        last_sequence,
        last_event_digest: last_event_digest.clone(),
    };
    let index_artifact_id = store_json(
        &engine,
        &run_id,
        format!("architecture-room-{}-index.json", operation.operation_id),
        "application/vnd.foundry.architecture-room-index+json",
        &index,
    )?;
    let reference = ArchitectureRoomTranscriptRefV1 {
        operation_id: operation.operation_id.clone(),
        proposal_id: proposal_id.to_owned(),
        index_artifact_id,
        operation_digest,
        last_sequence,
        last_event_digest,
        updated_at_ms: now_ms(),
    };
    state
        .room_transcripts
        .insert(operation.operation_id.clone(), reference.clone());
    commit_state(&engine, &run_id, &state)?;
    Ok(reference)
}

fn verify_room_transcript_reference(
    engine: &dyn PersistenceEngine,
    reference: &ArchitectureRoomTranscriptRefV1,
) -> Result<(), StudioError> {
    let index: ArchitectureRoomTranscriptIndexV1 = read_json(engine, &reference.index_artifact_id)?;
    if index.transcript_version != 1
        || index.operation.operation_id != reference.operation_id
        || index.operation.proposal_id.as_deref() != Some(reference.proposal_id.as_str())
        || digest(&index.operation) != reference.operation_digest
        || index.last_sequence != reference.last_sequence
        || index.last_event_digest != reference.last_event_digest
    {
        return Err(error(
            "SERVICE_NOT_READY",
            "architecture room transcript index does not match Studio state",
        ));
    }
    let mut events = Vec::with_capacity(index.event_count);
    for page_ref in &index.pages {
        let page: Vec<ArchitectureRoomEventV1> = read_json(engine, &page_ref.artifact_id)?;
        let first = page.first().ok_or_else(|| {
            error(
                "SERVICE_NOT_READY",
                "architecture room transcript contains an empty page",
            )
        })?;
        let last = page.last().expect("verified non-empty transcript page");
        if page.len() != page_ref.event_count
            || first.sequence != page_ref.first_sequence
            || last.sequence != page_ref.last_sequence
            || last.event_digest != page_ref.last_event_digest
        {
            return Err(error(
                "SERVICE_NOT_READY",
                "architecture room transcript page metadata is corrupt",
            ));
        }
        events.extend(page);
    }
    if events.len() != index.event_count
        || events.last().map_or(0, |event| event.sequence) != index.last_sequence
        || events.last().map(|event| event.event_digest.clone()) != index.last_event_digest
    {
        return Err(error(
            "SERVICE_NOT_READY",
            "architecture room transcript page set is incomplete",
        ));
    }
    verify_room_event_chain(&index.operation, &events)
        .map_err(|source| error("SERVICE_NOT_READY", source.to_string()))
}

fn default_layout() -> ArchitectureLayoutV1 {
    ArchitectureLayoutV1 {
        layout_version: 1,
        positions: BTreeMap::new(),
        collapsed: Default::default(),
        selected_view: "component".into(),
        zoom: 1.0,
        viewport: LayoutPointV1 { x: 0.0, y: 0.0 },
    }
}

#[allow(clippy::too_many_arguments)]
fn revision_artifacts(
    engine: &dyn PersistenceEngine,
    run_id: &RunId,
    revision: ArchitectureRevisionV1,
    ir: &Ir,
    rationale: &StudioRationaleV1,
    locks: &[BoundaryLockV1],
    layout: &ArchitectureLayoutV1,
    changed_nodes: &[String],
    rebuild_nodes: &[String],
) -> Result<RevisionArtifactsV1, StudioError> {
    let prefix = format!("architecture-revision-{}", revision.revision_id);
    Ok(RevisionArtifactsV1 {
        ir_artifact_id: store_json(
            engine,
            run_id,
            format!("{prefix}-ir.json"),
            "application/vnd.foundry.ir+json",
            ir,
        )?,
        rationale_artifact_id: store_json(
            engine,
            run_id,
            format!("{prefix}-rationale.json"),
            "application/vnd.foundry.architecture-rationale+json",
            rationale,
        )?,
        locks_artifact_id: store_json(
            engine,
            run_id,
            format!("{prefix}-locks.json"),
            "application/vnd.foundry.architecture-locks+json",
            &locks,
        )?,
        layout_artifact_id: store_json(
            engine,
            run_id,
            format!("{prefix}-layout.json"),
            "application/vnd.foundry.architecture-layout+json",
            layout,
        )?,
        structural_diff_artifact_id: store_json(
            engine,
            run_id,
            format!("{prefix}-structural-diff.json"),
            "application/vnd.foundry.architecture-diff+json",
            &json!({
                "diff_version": 1,
                "changed_nodes": changed_nodes,
                "rebuild_nodes": rebuild_nodes,
            }),
        )?,
        revision,
    })
}

fn validate_binding(binding: &StudioBindingV1) -> Result<(), StudioError> {
    if binding.studio_version != 1
        || binding.community_id.trim().is_empty()
        || binding.repository_coordinate.trim().is_empty()
        || binding.base_commit.trim().is_empty()
        || binding.target_branch.trim().is_empty()
    {
        return Err(error(
            "INVALID_COMMAND",
            "Studio binding version and identity fields must be valid",
        ));
    }
    Ok(())
}

pub fn create(
    durability_dir: &Path,
    binding: StudioBindingV1,
    ir: Ir,
    rationale: StudioRationaleV1,
    creator_pubkey: &str,
    title: &str,
    idempotency_key: &str,
) -> Result<StudioStateV1, StudioError> {
    validate_binding(&binding)?;
    foundry_ir::compile(&ir).map_err(|diagnostics| {
        error(
            "COMPILER_REJECTED",
            diagnostics
                .into_iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        )
    })?;
    if creator_pubkey.trim().is_empty()
        || title.trim().is_empty()
        || idempotency_key.trim().is_empty()
    {
        return Err(error(
            "INVALID_COMMAND",
            "creator, proposal title, and idempotency key must not be empty",
        ));
    }
    let engine = engine(durability_dir)?;
    let request_hash: [u8; 32] = Sha256::digest(canonical_json_bytes(&json!({
        "binding": binding,
        "ir": ir,
        "rationale": rationale,
        "creator": creator_pubkey,
        "title": title,
    })))
    .into();
    let records =
        block_on(engine.replay(0)).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    if let Some((run_id, prior_hash)) = records.iter().find_map(|record| match record {
        RuntimeRecordV1::RunCreated {
            run_id,
            request_hash,
            idempotency_key: key,
            ..
        } if key == idempotency_key => Some((run_id, request_hash)),
        _ => None,
    }) {
        if prior_hash != &request_hash {
            return Err(error(
                "IDEMPOTENCY_CONFLICT",
                "Studio idempotency key was reused with different content",
            ));
        }
        return latest_state(&records, run_id)
            .ok_or_else(|| error("SERVICE_NOT_READY", "Studio creation did not commit state"));
    }

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
    .map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;

    let proposal_id = RunId::new().to_string();
    let revision_id = RunId::new().to_string();
    let locks = Vec::new();
    let semantic_digest = studio_semantic_digest(&ir, &rationale, &locks);
    let created_at_ms = now_ms();
    let revision = ArchitectureRevisionV1 {
        studio_version: 1,
        revision_id: revision_id.clone(),
        parent_revision_id: None,
        proposal_id: proposal_id.clone(),
        author_pubkey: creator_pubkey.into(),
        ir_digest: foundry_ir::ir_digest(&ir),
        rationale_digest: digest(&rationale),
        locks_digest: digest(&locks),
        semantic_digest: semantic_digest.clone(),
        phase: StudioRevisionPhaseV1::AwaitingCritic,
        created_at_ms,
    };
    let artifacts = revision_artifacts(
        &engine,
        &run_id,
        revision,
        &ir,
        &rationale,
        &locks,
        &default_layout(),
        &[],
        &[],
    )?;
    let proposal = ArchitectureProposalV1 {
        studio_version: 1,
        proposal_id,
        title: title.into(),
        creator_pubkey: creator_pubkey.into(),
        base_revision_id: revision_id.clone(),
        head_revision_id: revision_id,
        head_semantic_digest: semantic_digest,
        status: ProposalStatusV1::Open,
        created_at_ms,
        updated_at_ms: created_at_ms,
    };
    let state = StudioStateV1 {
        studio_version: 1,
        run_id: run_id.to_string(),
        binding,
        accepted_revision_id: None,
        proposals: vec![proposal],
        revisions: vec![artifacts],
        critic_reviews: Vec::new(),
        human_approvals: Vec::new(),
        build_handoffs: Vec::new(),
        room_transcripts: BTreeMap::new(),
        operation_receipts: BTreeMap::new(),
    };
    commit_state(&engine, &run_id, &state)?;
    Ok(state)
}

fn snapshot_from_state(
    engine: &dyn PersistenceEngine,
    state: StudioStateV1,
    proposal_id: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    snapshot_from_state_revision(engine, state, proposal_id, None)
}

fn snapshot_from_state_revision(
    engine: &dyn PersistenceEngine,
    state: StudioStateV1,
    proposal_id: &str,
    revision_id: Option<&str>,
) -> Result<StudioSnapshotV1, StudioError> {
    let proposal = state
        .proposals
        .iter()
        .find(|proposal| proposal.proposal_id == proposal_id)
        .cloned()
        .ok_or_else(|| {
            error(
                "NOT_FOUND",
                format!("proposal `{proposal_id}` was not found"),
            )
        })?;
    let selected_revision_id = revision_id.unwrap_or(&proposal.head_revision_id);
    let artifacts = state
        .revisions
        .iter()
        .find(|revision| revision.revision.revision_id == selected_revision_id)
        .ok_or_else(|| error("NOT_FOUND", "architecture revision is missing"))?;
    Ok(StudioSnapshotV1 {
        ir: read_json(engine, &artifacts.ir_artifact_id)?,
        rationale: read_json(engine, &artifacts.rationale_artifact_id)?,
        locks: read_json(engine, &artifacts.locks_artifact_id)?,
        layout: read_json(engine, &artifacts.layout_artifact_id)?,
        structural_diff: if artifacts.structural_diff_artifact_id.is_empty() {
            json!({ "diff_version": 1, "changed_nodes": [], "rebuild_nodes": [] })
        } else {
            read_json(engine, &artifacts.structural_diff_artifact_id)?
        },
        revision: artifacts.revision.clone(),
        proposal,
        state,
    })
}

pub fn snapshot(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let state = load_state(&engine, &run_id)?;
    snapshot_from_state(&engine, state, proposal_id)
}

/// Retrieves an immutable historical revision while retaining proposal context.
pub fn snapshot_revision(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let state = load_state(&engine, &run_id)?;
    snapshot_from_state_revision(&engine, state, proposal_id, Some(revision_id))
}

/// Lists the latest durable Studio states for one exact community/repository binding.
pub fn discover(
    durability_dir: &Path,
    community_id: &str,
    repository_coordinate: &str,
) -> Result<Vec<StudioStateV1>, StudioError> {
    let engine = engine(durability_dir)?;
    let records =
        block_on(engine.replay(0)).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    let mut states = BTreeMap::<String, StudioStateV1>::new();
    for record in records {
        if let RuntimeRecordV1::RunStatusChanged {
            run_id,
            result: Some(result),
            ..
        } = record
        {
            if let Ok(state) = serde_json::from_value::<StudioStateV1>(result) {
                if state.binding.community_id == community_id
                    && state.binding.repository_coordinate == repository_coordinate
                {
                    states.insert(run_id.to_string(), state);
                }
            }
        }
    }
    Ok(states.into_values().collect())
}

/// Resolves a build handoff back to its durable Studio binding.
pub fn find_build_handoff(
    durability_dir: &Path,
    build_run_id: &str,
) -> Result<(StudioStateV1, ArchitectureBuildHandoffV1), StudioError> {
    let engine = engine(durability_dir)?;
    let records =
        block_on(engine.replay(0)).map_err(|e| error("SERVICE_NOT_READY", e.to_string()))?;
    let mut states = BTreeMap::<String, StudioStateV1>::new();
    for record in records {
        if let RuntimeRecordV1::RunStatusChanged {
            run_id,
            result: Some(result),
            ..
        } = record
        {
            if let Ok(state) = serde_json::from_value::<StudioStateV1>(result) {
                states.insert(run_id.to_string(), state);
            }
        }
    }
    for state in states.into_values() {
        if let Some(handoff) = state
            .build_handoffs
            .iter()
            .find(|handoff| handoff.build_run_id == build_run_id)
            .cloned()
        {
            return Ok((state, handoff));
        }
    }
    Err(error(
        "NOT_FOUND",
        format!("build `{build_run_id}` was not found"),
    ))
}

pub fn apply_command(
    durability_dir: &Path,
    run_id: &str,
    command: &StudioCommandV1,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&(command, operation_key));
    if let Some(receipt) = state.operation_receipts.get(operation_key) {
        if receipt.request_hash != request_hash {
            return Err(error(
                "IDEMPOTENCY_CONFLICT",
                "operation key was reused with different command content",
            ));
        }
        return snapshot_from_state(&engine, state, &command.proposal_id);
    }
    let proposal_index = state
        .proposals
        .iter()
        .position(|proposal| proposal.proposal_id == command.proposal_id)
        .ok_or_else(|| error("NOT_FOUND", "proposal was not found"))?;
    let proposal = &state.proposals[proposal_index];
    if proposal.status != ProposalStatusV1::Open {
        return Err(error("INVALID_COMMAND", "proposal is not open"));
    }
    if proposal.head_semantic_digest != command.expected_head_digest {
        return Err(error(
            "REVISION_CONFLICT",
            format!(
                "expected `{}`, current `{}`",
                command.expected_head_digest, proposal.head_semantic_digest
            ),
        ));
    }
    let current = snapshot_from_state(&engine, state.clone(), &command.proposal_id)?;
    let StudioCommandOutcomeV1 {
        ir,
        rationale,
        locks,
        semantic_digest,
        changed_nodes,
        rebuild_nodes,
    } = apply_studio_command(&current.ir, &current.rationale, &current.locks, command)
        .map_err(command_error)?;
    let revision_id = RunId::new().to_string();
    let revision = ArchitectureRevisionV1 {
        studio_version: 1,
        revision_id: revision_id.clone(),
        parent_revision_id: Some(current.revision.revision_id),
        proposal_id: command.proposal_id.clone(),
        author_pubkey: command.actor_pubkey.clone(),
        ir_digest: foundry_ir::ir_digest(&ir),
        rationale_digest: digest(&rationale),
        locks_digest: digest(&locks),
        semantic_digest: semantic_digest.clone(),
        phase: StudioRevisionPhaseV1::AwaitingCritic,
        created_at_ms: now_ms(),
    };
    let artifacts = revision_artifacts(
        &engine,
        &run_id,
        revision,
        &ir,
        &rationale,
        &locks,
        &current.layout,
        &changed_nodes,
        &rebuild_nodes,
    )?;
    state.revisions.push(artifacts);
    state.proposals[proposal_index].head_revision_id = revision_id.clone();
    state.proposals[proposal_index].head_semantic_digest = semantic_digest;
    state.proposals[proposal_index].updated_at_ms = now_ms();
    store_json(
        &engine,
        &run_id,
        format!("architecture-command-{}.json", command.command_id),
        "application/vnd.foundry.architecture-command+json",
        command,
    )?;
    state.operation_receipts.insert(
        operation_key.into(),
        StudioOperationReceiptV1 {
            operation_key: operation_key.into(),
            request_hash,
            revision_id,
        },
    );
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, &command.proposal_id)
}

/// Advances a proposal with a complete agent candidate after lock and compiler validation.
#[allow(clippy::too_many_arguments)]
pub fn apply_generated_candidate(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    expected_head_digest: &str,
    actor_pubkey: &str,
    candidate: Ir,
    rationale: StudioRationaleV1,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&(
        "generated_candidate",
        proposal_id,
        expected_head_digest,
        actor_pubkey,
        &candidate,
        &rationale,
    ));
    if ensure_operation(&state, operation_key, &request_hash)?.is_some() {
        return snapshot_from_state(&engine, state, proposal_id);
    }
    let proposal_index = proposal_index(&state, proposal_id)?;
    if state.proposals[proposal_index].status != ProposalStatusV1::Open {
        return Err(error("INVALID_COMMAND", "proposal is not open"));
    }
    if state.proposals[proposal_index].head_semantic_digest != expected_head_digest {
        return Err(error(
            "REVISION_CONFLICT",
            format!(
                "expected `{expected_head_digest}`, current `{}`",
                state.proposals[proposal_index].head_semantic_digest
            ),
        ));
    }
    let current = snapshot_from_state(&engine, state.clone(), proposal_id)?;
    let StudioCommandOutcomeV1 {
        ir,
        rationale,
        locks,
        semantic_digest,
        changed_nodes,
        rebuild_nodes,
    } = apply_generated_studio_candidate(
        &current.ir,
        &current.rationale,
        &current.locks,
        candidate,
        rationale,
    )
    .map_err(command_error)?;
    let revision_id = RunId::new().to_string();
    let revision = ArchitectureRevisionV1 {
        studio_version: 1,
        revision_id: revision_id.clone(),
        parent_revision_id: Some(current.revision.revision_id),
        proposal_id: proposal_id.into(),
        author_pubkey: actor_pubkey.into(),
        ir_digest: foundry_ir::ir_digest(&ir),
        rationale_digest: digest(&rationale),
        locks_digest: digest(&locks),
        semantic_digest: semantic_digest.clone(),
        phase: StudioRevisionPhaseV1::AwaitingCritic,
        created_at_ms: now_ms(),
    };
    state.revisions.push(revision_artifacts(
        &engine,
        &run_id,
        revision,
        &ir,
        &rationale,
        &locks,
        &current.layout,
        &changed_nodes,
        &rebuild_nodes,
    )?);
    state.proposals[proposal_index].head_revision_id = revision_id.clone();
    state.proposals[proposal_index].head_semantic_digest = semantic_digest;
    state.proposals[proposal_index].updated_at_ms = now_ms();
    store_json(
        &engine,
        &run_id,
        format!("architecture-generative-command-{}.json", RunId::new()),
        "application/vnd.foundry.architecture-generative-command+json",
        &json!({
            "proposal_id": proposal_id,
            "expected_head_digest": expected_head_digest,
            "actor_pubkey": actor_pubkey,
            "operation_key": operation_key,
            "revision_id": &revision_id,
        }),
    )?;
    record_operation(&mut state, operation_key, request_hash, revision_id);
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, proposal_id)
}

fn ensure_operation(
    state: &StudioStateV1,
    operation_key: &str,
    request_hash: &str,
) -> Result<Option<String>, StudioError> {
    if operation_key.trim().is_empty() {
        return Err(error("INVALID_COMMAND", "operation key must not be empty"));
    }
    let Some(receipt) = state.operation_receipts.get(operation_key) else {
        return Ok(None);
    };
    if receipt.request_hash != request_hash {
        return Err(error(
            "IDEMPOTENCY_CONFLICT",
            "operation key was reused with different content",
        ));
    }
    Ok(Some(receipt.revision_id.clone()))
}

fn record_operation(
    state: &mut StudioStateV1,
    operation_key: &str,
    request_hash: String,
    revision_id: String,
) {
    state.operation_receipts.insert(
        operation_key.into(),
        StudioOperationReceiptV1 {
            operation_key: operation_key.into(),
            request_hash,
            revision_id,
        },
    );
}

fn proposal_index(state: &StudioStateV1, proposal_id: &str) -> Result<usize, StudioError> {
    state
        .proposals
        .iter()
        .position(|proposal| proposal.proposal_id == proposal_id)
        .ok_or_else(|| {
            error(
                "NOT_FOUND",
                format!("proposal `{proposal_id}` was not found"),
            )
        })
}

fn head_revision_index(state: &StudioStateV1, proposal_index: usize) -> Result<usize, StudioError> {
    let head = &state.proposals[proposal_index].head_revision_id;
    state
        .revisions
        .iter()
        .position(|candidate| candidate.revision.revision_id == *head)
        .ok_or_else(|| error("SERVICE_NOT_READY", "proposal head revision is missing"))
}

/// Creates a proposal branch from an exact immutable proposal head.
pub fn create_proposal(
    durability_dir: &Path,
    run_id: &str,
    source_proposal_id: &str,
    expected_head_digest: &str,
    creator_pubkey: &str,
    title: &str,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&(
        "create_proposal",
        source_proposal_id,
        expected_head_digest,
        creator_pubkey,
        title,
    ));
    if let Some(revision_id) = ensure_operation(&state, operation_key, &request_hash)? {
        let proposal = state
            .proposals
            .iter()
            .find(|proposal| proposal.head_revision_id == revision_id && proposal.title == title)
            .ok_or_else(|| error("SERVICE_NOT_READY", "proposal receipt target is missing"))?;
        return snapshot_from_state(&engine, state.clone(), &proposal.proposal_id);
    }
    if creator_pubkey.trim().is_empty() || title.trim().is_empty() {
        return Err(error(
            "INVALID_COMMAND",
            "creator and title must not be empty",
        ));
    }
    let source_index = proposal_index(&state, source_proposal_id)?;
    let source = &state.proposals[source_index];
    if source.head_semantic_digest != expected_head_digest {
        return Err(error(
            "REVISION_CONFLICT",
            format!(
                "expected `{expected_head_digest}`, current `{}`",
                source.head_semantic_digest
            ),
        ));
    }
    let created_at_ms = now_ms();
    let proposal_id = RunId::new().to_string();
    let proposal = ArchitectureProposalV1 {
        studio_version: 1,
        proposal_id: proposal_id.clone(),
        title: title.into(),
        creator_pubkey: creator_pubkey.into(),
        base_revision_id: source.head_revision_id.clone(),
        head_revision_id: source.head_revision_id.clone(),
        head_semantic_digest: source.head_semantic_digest.clone(),
        status: ProposalStatusV1::Open,
        created_at_ms,
        updated_at_ms: created_at_ms,
    };
    let revision_id = proposal.head_revision_id.clone();
    state.proposals.push(proposal);
    record_operation(&mut state, operation_key, request_hash, revision_id);
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, &proposal_id)
}

/// Rejects an open proposal without changing the accepted architecture.
pub fn reject_proposal(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    actor_pubkey: &str,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&("reject_proposal", proposal_id, actor_pubkey));
    if ensure_operation(&state, operation_key, &request_hash)?.is_some() {
        return snapshot_from_state(&engine, state, proposal_id);
    }
    let index = proposal_index(&state, proposal_id)?;
    if state.proposals[index].status != ProposalStatusV1::Open {
        return Err(error("INVALID_COMMAND", "proposal is not open"));
    }
    state.proposals[index].status = ProposalStatusV1::Rejected;
    state.proposals[index].updated_at_ms = now_ms();
    let revision_index = head_revision_index(&state, index)?;
    state.revisions[revision_index].revision.phase = StudioRevisionPhaseV1::Rejected;
    let revision_id = state.proposals[index].head_revision_id.clone();
    record_operation(&mut state, operation_key, request_hash, revision_id);
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, proposal_id)
}

/// Persists an independent critic verdict for the exact semantic digest.
#[allow(clippy::too_many_arguments)]
pub fn record_critic_review(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    expected_head_digest: &str,
    reviewer_pubkey: &str,
    verdict: CriticVerdictV1,
    diagnostics: Vec<String>,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&(
        "critic_review",
        proposal_id,
        expected_head_digest,
        reviewer_pubkey,
        &verdict,
        &diagnostics,
    ));
    if ensure_operation(&state, operation_key, &request_hash)?.is_some() {
        return snapshot_from_state(&engine, state, proposal_id);
    }
    let index = proposal_index(&state, proposal_id)?;
    let proposal = &state.proposals[index];
    if proposal.status != ProposalStatusV1::Open {
        return Err(error("INVALID_COMMAND", "proposal is not open"));
    }
    if proposal.head_semantic_digest != expected_head_digest {
        return Err(error(
            "REVISION_CONFLICT",
            "critic review targets a stale digest",
        ));
    }
    let revision_index = head_revision_index(&state, index)?;
    let revision = &state.revisions[revision_index].revision;
    if reviewer_pubkey.trim().is_empty() || reviewer_pubkey == revision.author_pubkey {
        return Err(error(
            "FORBIDDEN",
            "the architecture author cannot approve their own revision",
        ));
    }
    let review = CriticReviewV1 {
        studio_version: 1,
        review_id: RunId::new().to_string(),
        proposal_id: proposal_id.into(),
        revision_id: revision.revision_id.clone(),
        semantic_digest: expected_head_digest.into(),
        reviewer_pubkey: reviewer_pubkey.into(),
        verdict: verdict.clone(),
        diagnostics,
        created_at_ms: now_ms(),
    };
    store_json(
        &engine,
        &run_id,
        format!("architecture-critic-{}.json", review.review_id),
        "application/vnd.foundry.architecture-critic+json",
        &review,
    )?;
    state.critic_reviews.push(review);
    state.revisions[revision_index].revision.phase = match verdict {
        CriticVerdictV1::Approved => StudioRevisionPhaseV1::AwaitingHumanApproval,
        CriticVerdictV1::ChangesRequested => StudioRevisionPhaseV1::Draft,
    };
    let revision_id = state.revisions[revision_index].revision.revision_id.clone();
    record_operation(&mut state, operation_key, request_hash, revision_id);
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, proposal_id)
}

/// Commits a relay-verified kind-46011 human approval.
///
/// Signature, relay membership, repository policy, and agent-authority checks
/// are performed by the service boundary before this trusted function runs.
pub fn ingest_verified_human_approval(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    expected_head_digest: &str,
    event_id: &str,
    signer_pubkey: &str,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&(
        "human_approval",
        proposal_id,
        expected_head_digest,
        event_id,
        signer_pubkey,
    ));
    if ensure_operation(&state, operation_key, &request_hash)?.is_some() {
        return snapshot_from_state(&engine, state, proposal_id);
    }
    let index = proposal_index(&state, proposal_id)?;
    if state.proposals[index].head_semantic_digest != expected_head_digest {
        return Err(error(
            "REVISION_CONFLICT",
            "approval targets a stale digest",
        ));
    }
    let revision_index = head_revision_index(&state, index)?;
    let revision = &state.revisions[revision_index].revision;
    let critic_approved = state.critic_reviews.iter().any(|review| {
        review.revision_id == revision.revision_id
            && review.semantic_digest == expected_head_digest
            && review.verdict == CriticVerdictV1::Approved
    });
    if !critic_approved {
        return Err(error(
            "INVALID_COMMAND",
            "independent critic approval is required first",
        ));
    }
    if state
        .human_approvals
        .iter()
        .any(|approval| approval.event_id == event_id)
    {
        return Err(error(
            "IDEMPOTENCY_CONFLICT",
            "approval event was already used",
        ));
    }
    let approval = HumanArchitectureApprovalV1 {
        studio_version: 1,
        event_id: event_id.into(),
        proposal_id: proposal_id.into(),
        revision_id: revision.revision_id.clone(),
        semantic_digest: expected_head_digest.into(),
        signer_pubkey: signer_pubkey.into(),
        foundry_run_id: run_id.to_string(),
        verified_at_ms: now_ms(),
    };
    store_json(
        &engine,
        &run_id,
        format!("architecture-approval-{event_id}.json"),
        "application/vnd.foundry.architecture-approval+json",
        &approval,
    )?;
    state.human_approvals.push(approval);
    let revision_id = revision.revision_id.clone();
    record_operation(&mut state, operation_key, request_hash, revision_id);
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, proposal_id)
}

/// Promotes an exact revision after the configured number of distinct human approvals.
pub fn promote_proposal(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    expected_head_digest: &str,
    approvals_required: usize,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let approvals_required = approvals_required.max(1);
    let request_hash = digest(&(
        "promote_proposal",
        proposal_id,
        expected_head_digest,
        approvals_required,
    ));
    if ensure_operation(&state, operation_key, &request_hash)?.is_some() {
        return snapshot_from_state(&engine, state, proposal_id);
    }
    let index = proposal_index(&state, proposal_id)?;
    if state.proposals[index].status != ProposalStatusV1::Open
        || state.proposals[index].head_semantic_digest != expected_head_digest
    {
        return Err(error(
            "REVISION_CONFLICT",
            "proposal head is not promotable",
        ));
    }
    let revision_index = head_revision_index(&state, index)?;
    if state.revisions[revision_index].revision.phase
        != StudioRevisionPhaseV1::AwaitingHumanApproval
    {
        return Err(error("INVALID_COMMAND", "critic approval is not current"));
    }
    let signers = state
        .human_approvals
        .iter()
        .filter(|approval| approval.semantic_digest == expected_head_digest)
        .map(|approval| approval.signer_pubkey.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if signers.len() < approvals_required {
        return Err(error(
            "FORBIDDEN",
            format!(
                "{approvals_required} distinct human approvals required; {} received",
                signers.len()
            ),
        ));
    }
    let accepted_revision_id = state.proposals[index].head_revision_id.clone();
    for (candidate_index, proposal) in state.proposals.iter_mut().enumerate() {
        if candidate_index == index {
            proposal.status = ProposalStatusV1::Approved;
        } else if proposal.status == ProposalStatusV1::Open {
            proposal.status = ProposalStatusV1::Stale;
        }
        proposal.updated_at_ms = now_ms();
    }
    state.revisions[revision_index].revision.phase = StudioRevisionPhaseV1::Approved;
    state.accepted_revision_id = Some(accepted_revision_id.clone());
    record_operation(
        &mut state,
        operation_key,
        request_hash,
        accepted_revision_id,
    );
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, proposal_id)
}

/// Persists presentation state without changing the semantic digest or approvals.
pub fn update_layout(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    expected_head_digest: &str,
    layout: &ArchitectureLayoutV1,
    operation_key: &str,
) -> Result<StudioSnapshotV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&("update_layout", proposal_id, expected_head_digest, layout));
    if ensure_operation(&state, operation_key, &request_hash)?.is_some() {
        return snapshot_from_state(&engine, state, proposal_id);
    }
    let index = proposal_index(&state, proposal_id)?;
    if state.proposals[index].head_semantic_digest != expected_head_digest {
        return Err(error("REVISION_CONFLICT", "layout targets a stale head"));
    }
    let revision_index = head_revision_index(&state, index)?;
    let revision_id = state.revisions[revision_index].revision.revision_id.clone();
    let layout_artifact_id = store_json(
        &engine,
        &run_id,
        format!("architecture-layout-{revision_id}-{}.json", RunId::new()),
        "application/vnd.foundry.architecture-layout+json",
        layout,
    )?;
    state.revisions[revision_index].layout_artifact_id = layout_artifact_id;
    record_operation(&mut state, operation_key, request_hash, revision_id);
    commit_state(&engine, &run_id, &state)?;
    snapshot_from_state(&engine, state, proposal_id)
}

/// Creates exactly one durable build handoff for an approved immutable revision.
pub fn create_build_handoff(
    durability_dir: &Path,
    run_id: &str,
    proposal_id: &str,
    expected_head_digest: &str,
    current_base_commit: &str,
    operation_key: &str,
) -> Result<ArchitectureBuildHandoffV1, StudioError> {
    let run_id = RunId::parse(run_id.to_owned()).map_err(|e| error("NOT_FOUND", e.to_string()))?;
    let engine = engine(durability_dir)?;
    let mut state = load_state(&engine, &run_id)?;
    let request_hash = digest(&(
        "build_handoff",
        proposal_id,
        expected_head_digest,
        current_base_commit,
    ));
    if ensure_operation(&state, operation_key, &request_hash)?.is_some() {
        return state
            .build_handoffs
            .iter()
            .find(|handoff| handoff.operation_key == operation_key)
            .cloned()
            .ok_or_else(|| error("SERVICE_NOT_READY", "build handoff receipt is missing"));
    }
    if state.binding.base_commit != current_base_commit {
        return Err(error(
            "STALE_BASE",
            format!(
                "architecture is bound to `{}`, repository is `{current_base_commit}`",
                state.binding.base_commit
            ),
        ));
    }
    let index = proposal_index(&state, proposal_id)?;
    let proposal = &state.proposals[index];
    if proposal.status != ProposalStatusV1::Approved
        || proposal.head_semantic_digest != expected_head_digest
        || state.accepted_revision_id.as_deref() != Some(&proposal.head_revision_id)
    {
        return Err(error("FORBIDDEN", "exact approved revision is required"));
    }
    let handoff = ArchitectureBuildHandoffV1 {
        studio_version: 1,
        build_run_id: RunId::new().to_string(),
        proposal_id: proposal_id.into(),
        revision_id: proposal.head_revision_id.clone(),
        semantic_digest: expected_head_digest.into(),
        base_commit: current_base_commit.into(),
        operation_key: operation_key.into(),
        created_at_ms: now_ms(),
    };
    let revision_id = handoff.revision_id.clone();
    state.build_handoffs.push(handoff.clone());
    let revision_index = head_revision_index(&state, index)?;
    state.revisions[revision_index].revision.phase = StudioRevisionPhaseV1::Building;
    record_operation(&mut state, operation_key, request_hash, revision_id);
    commit_state(&engine, &run_id, &state)?;
    Ok(handoff)
}

/// Marks the approved revision delivered after idempotent draft publication.
pub fn mark_build_delivered(durability_dir: &Path, build_run_id: &str) -> Result<(), StudioError> {
    let engine = engine(durability_dir)?;
    let records = block_on(engine.replay(0))
        .map_err(|source| error("SERVICE_NOT_READY", source.to_string()))?;
    let mut state = records
        .iter()
        .filter_map(|record| match record {
            RuntimeRecordV1::RunStatusChanged {
                result: Some(result),
                ..
            } => serde_json::from_value::<StudioStateV1>(result.clone()).ok(),
            _ => None,
        })
        .find(|candidate| {
            candidate
                .build_handoffs
                .iter()
                .any(|handoff| handoff.build_run_id == build_run_id)
        })
        .ok_or_else(|| error("NOT_FOUND", "build handoff was not found"))?;
    let semantic_digest = state
        .build_handoffs
        .iter()
        .find(|handoff| handoff.build_run_id == build_run_id)
        .map(|handoff| handoff.semantic_digest.clone())
        .ok_or_else(|| error("NOT_FOUND", "build handoff was not found"))?;
    if let Some(revision) = state
        .revisions
        .iter_mut()
        .find(|revision| revision.revision.semantic_digest == semantic_digest)
    {
        if revision.revision.phase != StudioRevisionPhaseV1::Delivered {
            revision.revision.phase = StudioRevisionPhaseV1::Delivered;
            let run_id = RunId::parse(state.run_id.clone())
                .map_err(|source| error("SERVICE_NOT_READY", source.to_string()))?;
            commit_state(&engine, &run_id, &state)?;
        }
        return Ok(());
    }
    Err(error("SERVICE_NOT_READY", "build revision is missing"))
}

fn command_error(diagnostics: Vec<StudioCommandErrorV1>) -> StudioError {
    let code = diagnostics
        .first()
        .map(|diagnostic| diagnostic.code.as_str())
        .unwrap_or("INVALID_COMMAND");
    let stable_code = match code {
        "COMPILER_REJECTED" => "COMPILER_REJECTED",
        "BOUNDARY_LOCKED" => "BOUNDARY_LOCKED",
        _ => "INVALID_COMMAND",
    };
    error(
        stable_code,
        serde_json::to_string(&diagnostics).unwrap_or_else(|_| "command rejected".into()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio_room::{
        ArchitectureOperationKindV1, ArchitectureRoomActorKindV1, ArchitectureRoomLedger,
        ArchitectureRoomPayloadV1,
    };
    use foundry_ir::StudioOperationV1;

    fn fixture() -> (std::path::PathBuf, Ir) {
        let root = std::env::temp_dir().join(format!("foundry-studio-{}", RunId::new()));
        let ir = serde_json::from_slice(
            &std::fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../ir/examples/string-utils.ir.json"),
            )
            .unwrap(),
        )
        .unwrap();
        (root, ir)
    }

    fn binding() -> StudioBindingV1 {
        StudioBindingV1 {
            studio_version: 1,
            community_id: "community-one".into(),
            repository_coordinate: format!("30617:{}:foundry", "a".repeat(64)),
            base_commit: "b".repeat(40),
            target_branch: "main".into(),
        }
    }

    #[test]
    fn local_engine_waits_for_an_overlapping_service_operation() {
        let (root, _) = fixture();
        let held_engine = engine(&root).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            drop(held_engine);
        });

        let reopened = engine(&root).unwrap();
        release.join().unwrap();
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn command_advances_exact_head_and_survives_reopen() {
        let (root, ir) = fixture();
        let state = create(
            &root,
            binding(),
            ir,
            StudioRationaleV1::default(),
            "human",
            "Initial architecture",
            "create-one",
        )
        .unwrap();
        let proposal = &state.proposals[0];
        let command = StudioCommandV1 {
            command_version: 1,
            command_id: "command-one".into(),
            proposal_id: proposal.proposal_id.clone(),
            expected_head_digest: proposal.head_semantic_digest.clone(),
            actor_pubkey: "human".into(),
            operations: vec![StudioOperationV1::SetWriteTarget {
                node_id: "hyphenate".into(),
                write_target: "src/hyphenate-v2.py".into(),
            }],
        };
        let updated = apply_command(&root, &state.run_id, &command, "edit-one").unwrap();
        assert_ne!(updated.proposal.head_revision_id, proposal.head_revision_id);
        assert_eq!(
            updated.revision.phase,
            StudioRevisionPhaseV1::AwaitingCritic
        );
        let reopened = snapshot(&root, &state.run_id, &updated.proposal.proposal_id).unwrap();
        assert_eq!(reopened.revision, updated.revision);
    }

    #[test]
    fn crash_between_artifact_write_and_head_commit_leaves_head_recoverable() {
        let (root, ir) = fixture();
        let created = create(
            &root,
            binding(),
            ir,
            StudioRationaleV1::default(),
            "human",
            "Crash-safe architecture",
            "create-crash-boundary",
        )
        .unwrap();
        let proposal = created.proposals[0].clone();
        let before = snapshot(&root, &created.run_id, &proposal.proposal_id).unwrap();
        let persistence = engine(&root).unwrap();
        let run_id = RunId::parse(created.run_id.clone()).unwrap();
        let mut orphan_revision = before.revision.clone();
        orphan_revision.revision_id = RunId::new().to_string();
        orphan_revision.parent_revision_id = Some(before.revision.revision_id.clone());
        orphan_revision.phase = StudioRevisionPhaseV1::AwaitingCritic;

        let orphan = revision_artifacts(
            &persistence,
            &run_id,
            orphan_revision,
            &before.ir,
            &before.rationale,
            &before.locks,
            &before.layout,
            &["hyphenate".into()],
            &["hyphenate".into()],
        )
        .unwrap();
        drop(persistence);

        let recovered = snapshot(&root, &created.run_id, &proposal.proposal_id).unwrap();
        assert_eq!(recovered.revision, before.revision);
        assert_eq!(recovered.proposal, before.proposal);

        let persistence = engine(&root).unwrap();
        let orphan_id = ArtifactId::parse(orphan.ir_artifact_id).unwrap();
        assert!(block_on(persistence.read_artifact(&orphan_id))
            .unwrap()
            .is_some());
        drop(persistence);

        let command = StudioCommandV1 {
            command_version: 1,
            command_id: "command-after-crash".into(),
            proposal_id: proposal.proposal_id,
            expected_head_digest: proposal.head_semantic_digest,
            actor_pubkey: "human".into(),
            operations: vec![StudioOperationV1::SetWriteTarget {
                node_id: "hyphenate".into(),
                write_target: "src/recovered.py".into(),
            }],
        };
        let committed = apply_command(&root, &created.run_id, &command, "recover-edit").unwrap();
        let retried = apply_command(&root, &created.run_id, &command, "recover-edit").unwrap();
        assert_eq!(retried.revision, committed.revision);
        assert_eq!(retried.proposal, committed.proposal);
    }

    #[test]
    fn stale_head_and_idempotency_conflict_fail_closed() {
        let (root, ir) = fixture();
        let state = create(
            &root,
            binding(),
            ir,
            StudioRationaleV1::default(),
            "human",
            "Initial architecture",
            "create-two",
        )
        .unwrap();
        let proposal = &state.proposals[0];
        let mut command = StudioCommandV1 {
            command_version: 1,
            command_id: "command-two".into(),
            proposal_id: proposal.proposal_id.clone(),
            expected_head_digest: "stale".into(),
            actor_pubkey: "human".into(),
            operations: vec![StudioOperationV1::SetWriteTarget {
                node_id: "hyphenate".into(),
                write_target: "src/hyphenate-v2.py".into(),
            }],
        };
        let conflict = apply_command(&root, &state.run_id, &command, "edit-two").unwrap_err();
        assert_eq!(conflict.code(), "REVISION_CONFLICT");
        command.expected_head_digest = proposal.head_semantic_digest.clone();
        apply_command(&root, &state.run_id, &command, "edit-two").unwrap();
        command.operations = vec![StudioOperationV1::SetWriteTarget {
            node_id: "hyphenate".into(),
            write_target: "src/different.py".into(),
        }];
        let conflict = apply_command(&root, &state.run_id, &command, "edit-two").unwrap_err();
        assert_eq!(conflict.code(), "IDEMPOTENCY_CONFLICT");
    }

    #[test]
    fn room_transcript_pages_are_artifacts_before_the_index_advances() {
        let (root, ir) = fixture();
        let state = create(
            &root,
            binding(),
            ir,
            StudioRationaleV1::default(),
            "architect",
            "Room evidence",
            "create-room-evidence",
        )
        .unwrap();
        let proposal = state.proposals[0].clone();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let request = serde_json::json!({"specification": "test"});
        let (operation, _) = ledger
            .create(
                &state.binding.repository_coordinate,
                "room-operation",
                &request,
                ArchitectureOperationKindV1::InitialArchitecture,
                "architect",
                1,
                vec!["read".into(), "edit".into()],
                false,
            )
            .unwrap();
        ledger
            .bind_proposal(
                &operation.operation_id,
                &state.run_id,
                &proposal.proposal_id,
                &proposal.base_revision_id,
                &proposal.head_semantic_digest,
            )
            .unwrap();
        ledger
            .append_event(
                &operation.operation_id,
                ArchitectureRoomActorKindV1::Architect,
                "architect",
                ArchitectureRoomPayloadV1::Message {
                    message: "Candidate ready for compilation".into(),
                },
            )
            .unwrap();

        let transcript = ledger.transcript(&operation.operation_id).unwrap();
        let first = persist_room_transcript(&root, &transcript).unwrap();
        let repeated = persist_room_transcript(&root, &transcript).unwrap();
        assert_eq!(first, repeated);
        assert_eq!(first.last_sequence, 2);

        let reopened = snapshot(&root, &state.run_id, &proposal.proposal_id).unwrap();
        assert_eq!(
            reopened.state.room_transcripts.get(&operation.operation_id),
            Some(&first)
        );
        let persistence = engine(&root).unwrap();
        let index: ArchitectureRoomTranscriptIndexV1 =
            read_json(&persistence, &first.index_artifact_id).unwrap();
        assert_eq!(index.event_count, 2);
        assert_eq!(index.pages.len(), 1);
        let page: Vec<ArchitectureRoomEventV1> =
            read_json(&persistence, &index.pages[0].artifact_id).unwrap();
        assert_eq!(page, transcript.events);
        drop(persistence);
        verify_readiness(&root).unwrap();

        let persistence = engine(&root).unwrap();
        let run_id = RunId::parse(state.run_id.clone()).unwrap();
        let mut corrupt_state = load_state(&persistence, &run_id).unwrap();
        corrupt_state
            .room_transcripts
            .get_mut(&operation.operation_id)
            .unwrap()
            .operation_digest = "corrupt".into();
        commit_state(&persistence, &run_id, &corrupt_state).unwrap();
        drop(persistence);
        assert_eq!(
            verify_readiness(&root).unwrap_err().code(),
            "SERVICE_NOT_READY"
        );
    }

    #[test]
    fn critic_human_promotion_and_build_bind_the_exact_revision() {
        let (root, ir) = fixture();
        let state = create(
            &root,
            binding(),
            ir,
            StudioRationaleV1::default(),
            "architect",
            "Governed architecture",
            "create-governed",
        )
        .unwrap();
        let proposal = &state.proposals[0];
        let reviewed = record_critic_review(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            "independent-critic",
            CriticVerdictV1::Approved,
            Vec::new(),
            "critic-one",
        )
        .unwrap();
        assert_eq!(
            reviewed.revision.phase,
            StudioRevisionPhaseV1::AwaitingHumanApproval
        );
        let approved = ingest_verified_human_approval(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            "event-one",
            "human-owner",
            "approval-one",
        )
        .unwrap();
        assert_eq!(approved.state.human_approvals.len(), 1);
        let promoted = promote_proposal(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            1,
            "promote-one",
        )
        .unwrap();
        assert_eq!(promoted.proposal.status, ProposalStatusV1::Approved);
        let stale = create_build_handoff(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            "wrong-base",
            "build-stale",
        )
        .unwrap_err();
        assert_eq!(stale.code(), "STALE_BASE");
        let handoff = create_build_handoff(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            &state.binding.base_commit,
            "build-one",
        )
        .unwrap();
        let replayed = create_build_handoff(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            &state.binding.base_commit,
            "build-one",
        )
        .unwrap();
        assert_eq!(handoff, replayed);
        mark_build_delivered(&root, &handoff.build_run_id).unwrap();
        let delivered = snapshot(&root, &state.run_id, &proposal.proposal_id).unwrap();
        assert_eq!(delivered.revision.phase, StudioRevisionPhaseV1::Delivered);
    }

    #[test]
    fn promotion_requires_distinct_human_signers() {
        let (root, ir) = fixture();
        let state = create(
            &root,
            binding(),
            ir,
            StudioRationaleV1::default(),
            "architect",
            "Two-person governed architecture",
            "create-two-person",
        )
        .unwrap();
        let proposal = &state.proposals[0];
        record_critic_review(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            "independent-critic",
            CriticVerdictV1::Approved,
            Vec::new(),
            "critic-two-person",
        )
        .unwrap();

        ingest_verified_human_approval(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            "event-owner-one",
            "human-owner",
            "approval-owner-one",
        )
        .unwrap();
        ingest_verified_human_approval(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            "event-owner-two",
            "human-owner",
            "approval-owner-two",
        )
        .unwrap();

        let insufficient = promote_proposal(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            2,
            "promote-too-early",
        )
        .unwrap_err();
        assert_eq!(insufficient.code(), "FORBIDDEN");
        assert!(insufficient
            .to_string()
            .contains("2 distinct human approvals required; 1 received"));

        ingest_verified_human_approval(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            "event-maintainer",
            "human-maintainer",
            "approval-maintainer",
        )
        .unwrap();
        let promoted = promote_proposal(
            &root,
            &state.run_id,
            &proposal.proposal_id,
            &proposal.head_semantic_digest,
            2,
            "promote-two-person",
        )
        .unwrap();
        assert_eq!(promoted.proposal.status, ProposalStatusV1::Approved);
        assert_eq!(promoted.state.human_approvals.len(), 3);
    }
}

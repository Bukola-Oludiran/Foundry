//! Durable operation and curated event ledger for Architecture Studio rooms.
//!
//! Room records are append-only from the API's perspective. Each acknowledged
//! mutation replaces one checksummed JSON document using write-sync-rename so a
//! restart observes either the previous state or the complete next state.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use graphreact_persistence::{canonical_json_bytes, RunId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const STORAGE_VERSION: u32 = 1;
const PROTOCOL_VERSION: u32 = 1;
static MUTATION_LOCK: Mutex<()> = Mutex::new(());
pub const MAX_AUTHORED_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_TOOL_SUMMARY_BYTES: usize = 4 * 1024;
pub const MAX_EVENT_PAGE: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchitectureOperationKindV1 {
    InitialArchitecture,
    GenerativeEdit,
    CriticRepair,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchitectureOperationStateV1 {
    Queued,
    Architecting,
    WaitingInput,
    Compiling,
    CriticReview,
    Repairing,
    Succeeded,
    Failed,
    Cancelled,
    Indeterminate,
}

impl ArchitectureOperationStateV1 {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Indeterminate
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchitectureRoomActorKindV1 {
    Human,
    Architect,
    Critic,
    Compiler,
    Foundry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceModeV1 {
    Immediate,
    Checkpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceDeliveryV1 {
    Queued,
    Delivered,
    Checkpointed,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArchitectureRoomPayloadV1 {
    Lifecycle {
        stage: ArchitectureOperationStateV1,
        message: String,
    },
    Message {
        message: String,
    },
    Plan {
        summary: String,
    },
    Tool {
        category: String,
        purpose: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_summary: Option<String>,
    },
    CompilerDiagnostics {
        diagnostics: Vec<String>,
    },
    Question {
        question_id: String,
        prompt: String,
    },
    HumanGuidance {
        message_id: String,
        mode: GuidanceModeV1,
        delivery: GuidanceDeliveryV1,
        content: String,
    },
    CriticVerdict {
        verdict: String,
        diagnostics: Vec<String>,
    },
    Revision {
        revision_id: String,
        semantic_digest: String,
    },
    Terminal {
        state: ArchitectureOperationStateV1,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchitectureRoomEventV1 {
    pub protocol_version: u32,
    pub event_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_event_id: Option<String>,
    pub sequence: u64,
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub studio_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
    pub actor_kind: ArchitectureRoomActorKindV1,
    pub actor_id: String,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_event_digest: Option<String>,
    pub event_digest: String,
    #[serde(flatten)]
    pub payload: ArchitectureRoomPayloadV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchitectureOperationV1 {
    pub protocol_version: u32,
    pub operation_id: String,
    pub repository_coordinate: String,
    pub actor_id: String,
    pub approval_threshold: usize,
    pub permitted_operations: Vec<String>,
    pub human_actor: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub studio_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_head_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_proposal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_event_id: Option<String>,
    pub kind: ArchitectureOperationKindV1,
    pub state: ArchitectureOperationStateV1,
    pub architect_job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub critic_job_id: Option<String>,
    pub repair_round: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_question_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredArchitectureOperationV1 {
    storage_version: u32,
    idempotency_key: String,
    request_digest: String,
    request: Value,
    operation: ArchitectureOperationV1,
    events: Vec<ArchitectureRoomEventV1>,
    #[serde(default)]
    guidance_receipts: std::collections::BTreeMap<String, GuidanceReceiptV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct GuidanceReceiptV1 {
    request_digest: String,
    event_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArchitectureRoomError {
    #[error("INVALID_COMMAND: {0}")]
    Invalid(String),
    #[error("IDEMPOTENCY_CONFLICT: operation key was reused with different content")]
    IdempotencyConflict,
    #[error("NOT_FOUND: architecture operation was not found")]
    NotFound,
    #[error("INVALID_TRANSITION: {0}")]
    InvalidTransition(String),
    #[error("SERVICE_NOT_READY: {0}")]
    Storage(String),
}

#[derive(Debug, Clone)]
pub struct RecoverableArchitectureOperationV1 {
    pub operation: ArchitectureOperationV1,
    pub idempotency_key: String,
    pub request: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchitectureRoomTranscriptV1 {
    pub operation: ArchitectureOperationV1,
    pub events: Vec<ArchitectureRoomEventV1>,
}

pub struct ArchitectureRoomLedger {
    root: PathBuf,
}

impl ArchitectureRoomLedger {
    pub fn open(durability_root: &Path) -> Result<Self, ArchitectureRoomError> {
        let root = durability_root.join("architecture-operations");
        fs::create_dir_all(&root).map_err(storage_error)?;
        Ok(Self { root })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        repository_coordinate: &str,
        idempotency_key: &str,
        request: &Value,
        kind: ArchitectureOperationKindV1,
        actor_id: &str,
        approval_threshold: usize,
        permitted_operations: Vec<String>,
        human_actor: bool,
    ) -> Result<(ArchitectureOperationV1, bool), ArchitectureRoomError> {
        validate_text(repository_coordinate, "repository coordinate", 2_048)?;
        validate_text(idempotency_key, "idempotency key", 512)?;
        validate_text(actor_id, "actor identity", 512)?;
        let _guard = mutation_guard()?;
        let request_digest = digest_value(request);
        for path in self.record_paths()? {
            let stored = read_record(&path)?;
            if stored.idempotency_key == idempotency_key {
                if stored.request_digest != request_digest {
                    return Err(ArchitectureRoomError::IdempotencyConflict);
                }
                return Ok((stored.operation, false));
            }
            if stored.operation.repository_coordinate == repository_coordinate
                && stored.operation.proposal_id.is_none()
                && !stored.operation.state.terminal()
            {
                return Err(ArchitectureRoomError::InvalidTransition(format!(
                    "architecture operation {} is already active for this repository",
                    stored.operation.operation_id
                )));
            }
        }
        let now = now_ms();
        let operation_id = RunId::new().to_string();
        let operation = ArchitectureOperationV1 {
            protocol_version: PROTOCOL_VERSION,
            operation_id: operation_id.clone(),
            repository_coordinate: repository_coordinate.to_owned(),
            actor_id: actor_id.to_owned(),
            approval_threshold,
            permitted_operations,
            human_actor,
            studio_run_id: None,
            proposal_id: None,
            base_revision_id: None,
            expected_head_digest: None,
            parent_proposal_id: None,
            parent_event_id: None,
            kind,
            state: ArchitectureOperationStateV1::Queued,
            architect_job_id: format!("studio-architect-{operation_id}-1"),
            critic_job_id: None,
            repair_round: 0,
            active_question_id: None,
            created_at_ms: now,
            updated_at_ms: now,
            terminal_result: None,
            error: None,
        };
        let mut stored = StoredArchitectureOperationV1 {
            storage_version: STORAGE_VERSION,
            idempotency_key: idempotency_key.to_owned(),
            request_digest,
            request: request.clone(),
            operation,
            events: Vec::new(),
            guidance_receipts: std::collections::BTreeMap::new(),
        };
        append_event_to(
            &mut stored,
            ArchitectureRoomActorKindV1::Foundry,
            actor_id,
            ArchitectureRoomPayloadV1::Lifecycle {
                stage: ArchitectureOperationStateV1::Queued,
                message: "Architecture request accepted".into(),
            },
            None,
        )?;
        create_synced(&self.path(&operation_id), &stored)?;
        Ok((stored.operation, true))
    }

    pub fn get(
        &self,
        operation_id: &str,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        Ok(self.read(operation_id)?.operation)
    }

    pub fn bind_proposal(
        &self,
        operation_id: &str,
        studio_run_id: &str,
        proposal_id: &str,
        base_revision_id: &str,
        expected_head_digest: &str,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        validate_text(studio_run_id, "Studio run id", 512)?;
        validate_text(proposal_id, "proposal id", 512)?;
        validate_text(base_revision_id, "base revision id", 512)?;
        validate_text(expected_head_digest, "expected head digest", 128)?;
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        for path in self.record_paths()? {
            let other = read_record(&path)?.operation;
            if other.operation_id != operation_id
                && other.repository_coordinate == stored.operation.repository_coordinate
                && other.proposal_id.as_deref() == Some(proposal_id)
                && !other.state.terminal()
            {
                return Err(ArchitectureRoomError::InvalidTransition(format!(
                    "architecture operation {} is already active for proposal {proposal_id}",
                    other.operation_id
                )));
            }
        }
        stored.operation.studio_run_id = Some(studio_run_id.to_owned());
        stored.operation.proposal_id = Some(proposal_id.to_owned());
        stored.operation.base_revision_id = Some(base_revision_id.to_owned());
        stored.operation.expected_head_digest = Some(expected_head_digest.to_owned());
        stored.operation.updated_at_ms = now_ms();
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(stored.operation)
    }

    pub fn link_room_branch(
        &self,
        operation_id: &str,
        parent_proposal_id: &str,
        parent_event_id: Option<&str>,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        validate_text(parent_proposal_id, "parent proposal id", 512)?;
        if let Some(event_id) = parent_event_id {
            validate_text(event_id, "parent event id", 512)?;
        }
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        stored.operation.parent_proposal_id = Some(parent_proposal_id.to_owned());
        stored.operation.parent_event_id = parent_event_id.map(str::to_owned);
        stored.operation.updated_at_ms = now_ms();
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(stored.operation)
    }

    pub fn list_for_repository(
        &self,
        repository_coordinate: &str,
    ) -> Result<Vec<ArchitectureOperationV1>, ArchitectureRoomError> {
        let mut operations = Vec::new();
        for path in self.record_paths()? {
            let operation = read_record(&path)?.operation;
            if operation.repository_coordinate == repository_coordinate {
                operations.push(operation);
            }
        }
        operations.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
        Ok(operations)
    }

    pub fn events(
        &self,
        operation_id: &str,
        after: u64,
        limit: usize,
    ) -> Result<Vec<ArchitectureRoomEventV1>, ArchitectureRoomError> {
        let limit = limit.clamp(1, MAX_EVENT_PAGE);
        Ok(self
            .read(operation_id)?
            .events
            .into_iter()
            .filter(|event| event.sequence > after)
            .take(limit)
            .collect())
    }

    pub fn transcript(
        &self,
        operation_id: &str,
    ) -> Result<ArchitectureRoomTranscriptV1, ArchitectureRoomError> {
        let stored = self.read(operation_id)?;
        Ok(ArchitectureRoomTranscriptV1 {
            operation: stored.operation,
            events: stored.events,
        })
    }

    pub fn checkpoint_guidance(
        &self,
        operation_id: &str,
    ) -> Result<Vec<String>, ArchitectureRoomError> {
        let stored = self.read(operation_id)?;
        let mut guidance = std::collections::BTreeMap::new();
        for event in stored.events {
            if let ArchitectureRoomPayloadV1::HumanGuidance {
                message_id,
                delivery,
                content,
                ..
            } = event.payload
            {
                guidance.insert(message_id, (delivery, content));
            }
        }
        Ok(guidance
            .into_values()
            .filter_map(|(delivery, content)| {
                (delivery == GuidanceDeliveryV1::Checkpointed).then_some(content)
            })
            .collect())
    }

    pub fn append_event(
        &self,
        operation_id: &str,
        actor_kind: ArchitectureRoomActorKindV1,
        actor_id: &str,
        payload: ArchitectureRoomPayloadV1,
    ) -> Result<ArchitectureRoomEventV1, ArchitectureRoomError> {
        validate_text(actor_id, "actor identity", 512)?;
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        let event = append_event_to(&mut stored, actor_kind, actor_id, payload, None)?;
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(event)
    }

    pub fn append_external_event(
        &self,
        operation_id: &str,
        source_event_id: &str,
        actor_kind: ArchitectureRoomActorKindV1,
        actor_id: &str,
        payload: ArchitectureRoomPayloadV1,
    ) -> Result<ArchitectureRoomEventV1, ArchitectureRoomError> {
        validate_text(source_event_id, "source event id", 512)?;
        validate_text(actor_id, "actor identity", 512)?;
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        if let Some(existing) = stored
            .events
            .iter()
            .find(|event| event.source_event_id.as_deref() == Some(source_event_id))
        {
            return Ok(existing.clone());
        }
        let event = append_event_to(
            &mut stored,
            actor_kind,
            actor_id,
            payload,
            Some(source_event_id.to_owned()),
        )?;
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(event)
    }

    pub fn submit_guidance(
        &self,
        operation_id: &str,
        message_id: &str,
        mode: GuidanceModeV1,
        delivery: GuidanceDeliveryV1,
        content: &str,
        actor_id: &str,
    ) -> Result<ArchitectureRoomEventV1, ArchitectureRoomError> {
        validate_text(message_id, "message id", 512)?;
        validate_text(content, "guidance", MAX_AUTHORED_MESSAGE_BYTES)?;
        validate_text(actor_id, "actor identity", 512)?;
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        if stored.operation.state.terminal() {
            return Err(ArchitectureRoomError::InvalidTransition(
                "guidance cannot be added to a terminal operation".into(),
            ));
        }
        let request_digest = digest_value(&serde_json::json!({
            "message_id": message_id,
            "mode": mode,
            "content": content,
            "actor_id": actor_id,
        }));
        if let Some(receipt) = stored.guidance_receipts.get(message_id) {
            if receipt.request_digest != request_digest {
                return Err(ArchitectureRoomError::IdempotencyConflict);
            }
            return stored
                .events
                .iter()
                .find(|event| event.event_id == receipt.event_id)
                .cloned()
                .ok_or_else(|| {
                    ArchitectureRoomError::Storage(
                        "guidance receipt references a missing room event".into(),
                    )
                });
        }
        let event = append_event_to(
            &mut stored,
            ArchitectureRoomActorKindV1::Human,
            actor_id,
            ArchitectureRoomPayloadV1::HumanGuidance {
                message_id: message_id.to_owned(),
                mode,
                delivery,
                content: content.to_owned(),
            },
            None,
        )?;
        stored.guidance_receipts.insert(
            message_id.to_owned(),
            GuidanceReceiptV1 {
                request_digest,
                event_id: event.event_id.clone(),
            },
        );
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(event)
    }

    pub fn set_active_job(
        &self,
        operation_id: &str,
        actor_kind: ArchitectureRoomActorKindV1,
        job_id: &str,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        validate_text(job_id, "agent job id", 512)?;
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        match actor_kind {
            ArchitectureRoomActorKindV1::Architect => {
                stored.operation.architect_job_id = job_id.to_owned();
            }
            ArchitectureRoomActorKindV1::Critic => {
                stored.operation.critic_job_id = Some(job_id.to_owned());
            }
            _ => {
                return Err(ArchitectureRoomError::Invalid(
                    "only architect or critic can own an agent job".into(),
                ))
            }
        }
        stored.operation.updated_at_ms = now_ms();
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(stored.operation)
    }

    pub fn wait_for_input(
        &self,
        operation_id: &str,
        question_id: &str,
        prompt: &str,
        actor_id: &str,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        validate_text(question_id, "question id", 512)?;
        validate_text(prompt, "question prompt", MAX_AUTHORED_MESSAGE_BYTES)?;
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        if stored.operation.state.terminal() {
            return Err(ArchitectureRoomError::InvalidTransition(
                "a terminal operation cannot wait for input".into(),
            ));
        }
        stored.operation.state = ArchitectureOperationStateV1::WaitingInput;
        stored.operation.active_question_id = Some(question_id.to_owned());
        stored.operation.updated_at_ms = now_ms();
        append_event_to(
            &mut stored,
            ArchitectureRoomActorKindV1::Architect,
            actor_id,
            ArchitectureRoomPayloadV1::Question {
                question_id: question_id.to_owned(),
                prompt: prompt.to_owned(),
            },
            None,
        )?;
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(stored.operation)
    }

    pub fn answer_question(
        &self,
        operation_id: &str,
        question_id: &str,
        actor_id: &str,
    ) -> Result<RecoverableArchitectureOperationV1, ArchitectureRoomError> {
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        if stored.operation.state != ArchitectureOperationStateV1::WaitingInput
            || stored.operation.active_question_id.as_deref() != Some(question_id)
        {
            return Err(ArchitectureRoomError::InvalidTransition(
                "the question is no longer active".into(),
            ));
        }
        stored.operation.active_question_id = None;
        stored.operation.state = ArchitectureOperationStateV1::Queued;
        stored.operation.updated_at_ms = now_ms();
        append_event_to(
            &mut stored,
            ArchitectureRoomActorKindV1::Foundry,
            actor_id,
            ArchitectureRoomPayloadV1::Lifecycle {
                stage: ArchitectureOperationStateV1::Queued,
                message: "Human answer committed; architect resumption queued".into(),
            },
            None,
        )?;
        let recovered = RecoverableArchitectureOperationV1 {
            operation: stored.operation.clone(),
            idempotency_key: stored.idempotency_key.clone(),
            request: stored.request.clone(),
        };
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(recovered)
    }

    pub fn set_repair_round(
        &self,
        operation_id: &str,
        repair_round: u32,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        if repair_round > 3 {
            return Err(ArchitectureRoomError::Invalid(
                "repair round exceeds the configured maximum".into(),
            ));
        }
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        stored.operation.repair_round = repair_round;
        stored.operation.updated_at_ms = now_ms();
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(stored.operation)
    }

    pub fn transition(
        &self,
        operation_id: &str,
        next: ArchitectureOperationStateV1,
        message: &str,
        actor_id: &str,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        validate_text(message, "lifecycle message", MAX_AUTHORED_MESSAGE_BYTES)?;
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        let current = stored.operation.state;
        if current == next {
            return Ok(stored.operation);
        }
        if current.terminal() && current != next {
            return Err(ArchitectureRoomError::InvalidTransition(format!(
                "terminal state {current:?} is immutable"
            )));
        }
        stored.operation.state = next;
        stored.operation.updated_at_ms = now_ms();
        if matches!(
            next,
            ArchitectureOperationStateV1::Failed | ArchitectureOperationStateV1::Indeterminate
        ) {
            stored.operation.error = Some(message.to_owned());
        }
        let payload = if next.terminal() {
            ArchitectureRoomPayloadV1::Terminal {
                state: next,
                message: message.to_owned(),
            }
        } else {
            ArchitectureRoomPayloadV1::Lifecycle {
                stage: next,
                message: message.to_owned(),
            }
        };
        append_event_to(
            &mut stored,
            ArchitectureRoomActorKindV1::Foundry,
            actor_id,
            payload,
            None,
        )?;
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(stored.operation)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete(
        &self,
        operation_id: &str,
        studio_run_id: &str,
        proposal_id: &str,
        revision_id: &str,
        semantic_digest: &str,
        result: Value,
        actor_id: &str,
    ) -> Result<ArchitectureOperationV1, ArchitectureRoomError> {
        let _guard = mutation_guard()?;
        let mut stored = self.read(operation_id)?;
        if stored.operation.state.terminal()
            && stored.operation.state != ArchitectureOperationStateV1::Succeeded
        {
            return Err(ArchitectureRoomError::InvalidTransition(
                "cannot complete a terminal operation".into(),
            ));
        }
        stored.operation.studio_run_id = Some(studio_run_id.to_owned());
        stored.operation.proposal_id = Some(proposal_id.to_owned());
        stored.operation.state = ArchitectureOperationStateV1::Succeeded;
        stored.operation.updated_at_ms = now_ms();
        stored.operation.terminal_result = Some(result);
        append_event_to(
            &mut stored,
            ArchitectureRoomActorKindV1::Foundry,
            actor_id,
            ArchitectureRoomPayloadV1::Revision {
                revision_id: revision_id.to_owned(),
                semantic_digest: semantic_digest.to_owned(),
            },
            None,
        )?;
        append_event_to(
            &mut stored,
            ArchitectureRoomActorKindV1::Foundry,
            actor_id,
            ArchitectureRoomPayloadV1::Terminal {
                state: ArchitectureOperationStateV1::Succeeded,
                message: "Architecture compiled and independently reviewed".into(),
            },
            None,
        )?;
        replace_synced(&self.path(operation_id), &stored)?;
        Ok(stored.operation)
    }

    pub fn recoverable(
        &self,
    ) -> Result<Vec<RecoverableArchitectureOperationV1>, ArchitectureRoomError> {
        let mut operations = Vec::new();
        for path in self.record_paths()? {
            let stored = read_record(&path)?;
            if !stored.operation.state.terminal()
                && stored.operation.state != ArchitectureOperationStateV1::WaitingInput
            {
                operations.push(RecoverableArchitectureOperationV1 {
                    operation: stored.operation,
                    idempotency_key: stored.idempotency_key,
                    request: stored.request,
                });
            }
        }
        operations.sort_by(|left, right| {
            left.operation
                .operation_id
                .cmp(&right.operation.operation_id)
        });
        Ok(operations)
    }

    fn read(
        &self,
        operation_id: &str,
    ) -> Result<StoredArchitectureOperationV1, ArchitectureRoomError> {
        RunId::parse(operation_id.to_owned()).map_err(|error| {
            ArchitectureRoomError::Invalid(format!("invalid operation id: {error}"))
        })?;
        read_record(&self.path(operation_id))
    }

    fn path(&self, operation_id: &str) -> PathBuf {
        self.root.join(format!("{operation_id}.json"))
    }

    fn record_paths(&self) -> Result<Vec<PathBuf>, ArchitectureRoomError> {
        let mut paths = fs::read_dir(&self.root)
            .map_err(storage_error)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        paths.sort();
        Ok(paths)
    }
}

fn append_event_to(
    stored: &mut StoredArchitectureOperationV1,
    actor_kind: ArchitectureRoomActorKindV1,
    actor_id: &str,
    payload: ArchitectureRoomPayloadV1,
    source_event_id: Option<String>,
) -> Result<ArchitectureRoomEventV1, ArchitectureRoomError> {
    validate_payload(&payload)?;
    let sequence = u64::try_from(stored.events.len())
        .map_err(|error| ArchitectureRoomError::Storage(error.to_string()))?
        .saturating_add(1);
    let event_id = RunId::new().to_string();
    let previous_event_digest = stored.events.last().map(|event| event.event_digest.clone());
    let digest_input = serde_json::json!({
        "protocol_version": PROTOCOL_VERSION,
        "event_id": event_id,
        "source_event_id": source_event_id,
        "sequence": sequence,
        "operation_id": stored.operation.operation_id,
        "studio_run_id": stored.operation.studio_run_id,
        "proposal_id": stored.operation.proposal_id,
        "actor_kind": actor_kind,
        "actor_id": actor_id,
        "created_at_ms": now_ms(),
        "previous_event_digest": previous_event_digest,
        "payload": payload,
    });
    let created_at_ms = digest_input["created_at_ms"].as_u64().unwrap_or_default();
    let event = ArchitectureRoomEventV1 {
        protocol_version: PROTOCOL_VERSION,
        event_id,
        source_event_id,
        sequence,
        operation_id: stored.operation.operation_id.clone(),
        studio_run_id: stored.operation.studio_run_id.clone(),
        proposal_id: stored.operation.proposal_id.clone(),
        revision_id: None,
        actor_kind,
        actor_id: actor_id.to_owned(),
        created_at_ms,
        previous_event_digest,
        event_digest: digest_value(&digest_input),
        payload,
    };
    stored.events.push(event.clone());
    Ok(event)
}

fn validate_payload(payload: &ArchitectureRoomPayloadV1) -> Result<(), ArchitectureRoomError> {
    match payload {
        ArchitectureRoomPayloadV1::Lifecycle { message, .. }
        | ArchitectureRoomPayloadV1::Message { message }
        | ArchitectureRoomPayloadV1::Terminal { message, .. } => {
            validate_text(message, "room message", MAX_AUTHORED_MESSAGE_BYTES)
        }
        ArchitectureRoomPayloadV1::Plan { summary } => {
            validate_text(summary, "plan summary", MAX_AUTHORED_MESSAGE_BYTES)
        }
        ArchitectureRoomPayloadV1::Tool {
            category,
            purpose,
            status,
            result_summary,
            ..
        } => {
            validate_text(category, "tool category", 128)?;
            validate_text(purpose, "tool purpose", MAX_TOOL_SUMMARY_BYTES)?;
            validate_text(status, "tool status", 128)?;
            if let Some(summary) = result_summary {
                validate_text(summary, "tool result summary", MAX_TOOL_SUMMARY_BYTES)?;
            }
            Ok(())
        }
        ArchitectureRoomPayloadV1::CompilerDiagnostics { diagnostics }
        | ArchitectureRoomPayloadV1::CriticVerdict { diagnostics, .. } => {
            if diagnostics.len() > 200 {
                return Err(ArchitectureRoomError::Invalid(
                    "room diagnostics exceed 200 entries".into(),
                ));
            }
            for diagnostic in diagnostics {
                validate_text(diagnostic, "diagnostic", MAX_AUTHORED_MESSAGE_BYTES)?;
            }
            Ok(())
        }
        ArchitectureRoomPayloadV1::Question {
            question_id,
            prompt,
        } => {
            validate_text(question_id, "question id", 512)?;
            validate_text(prompt, "question", MAX_AUTHORED_MESSAGE_BYTES)
        }
        ArchitectureRoomPayloadV1::HumanGuidance {
            message_id,
            content,
            ..
        } => {
            validate_text(message_id, "message id", 512)?;
            validate_text(content, "guidance", MAX_AUTHORED_MESSAGE_BYTES)
        }
        ArchitectureRoomPayloadV1::Revision {
            revision_id,
            semantic_digest,
        } => {
            validate_text(revision_id, "revision id", 512)?;
            validate_text(semantic_digest, "semantic digest", 128)
        }
    }
}

fn validate_text(value: &str, label: &str, maximum: usize) -> Result<(), ArchitectureRoomError> {
    if value.trim().is_empty() {
        return Err(ArchitectureRoomError::Invalid(format!(
            "{label} must not be empty"
        )));
    }
    if value.len() > maximum {
        return Err(ArchitectureRoomError::Invalid(format!(
            "{label} exceeds {maximum} bytes"
        )));
    }
    Ok(())
}

fn mutation_guard() -> Result<std::sync::MutexGuard<'static, ()>, ArchitectureRoomError> {
    MUTATION_LOCK
        .lock()
        .map_err(|error| ArchitectureRoomError::Storage(error.to_string()))
}

fn digest_value(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical_json_bytes(value)))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn read_record(path: &Path) -> Result<StoredArchitectureOperationV1, ArchitectureRoomError> {
    if !path.exists() {
        return Err(ArchitectureRoomError::NotFound);
    }
    let bytes = fs::read(path).map_err(storage_error)?;
    let stored: StoredArchitectureOperationV1 =
        serde_json::from_slice(&bytes).map_err(storage_error)?;
    if stored.storage_version != STORAGE_VERSION {
        return Err(ArchitectureRoomError::Storage(format!(
            "unsupported room storage version {}",
            stored.storage_version
        )));
    }
    verify_events(&stored)?;
    Ok(stored)
}

fn verify_events(stored: &StoredArchitectureOperationV1) -> Result<(), ArchitectureRoomError> {
    verify_room_event_chain(&stored.operation, &stored.events)
}

pub fn verify_room_event_chain(
    operation: &ArchitectureOperationV1,
    events: &[ArchitectureRoomEventV1],
) -> Result<(), ArchitectureRoomError> {
    let mut previous: Option<&str> = None;
    for (index, event) in events.iter().enumerate() {
        let expected_sequence = u64::try_from(index)
            .map_err(|error| ArchitectureRoomError::Storage(error.to_string()))?
            .saturating_add(1);
        if event.sequence != expected_sequence
            || event.previous_event_digest.as_deref() != previous
            || event.operation_id != operation.operation_id
        {
            return Err(ArchitectureRoomError::Storage(
                "architecture room event chain is corrupt".into(),
            ));
        }
        let digest_input = serde_json::json!({
            "protocol_version": event.protocol_version,
            "event_id": event.event_id,
            "source_event_id": event.source_event_id,
            "sequence": event.sequence,
            "operation_id": event.operation_id,
            "studio_run_id": event.studio_run_id,
            "proposal_id": event.proposal_id,
            "actor_kind": event.actor_kind,
            "actor_id": event.actor_id,
            "created_at_ms": event.created_at_ms,
            "previous_event_digest": event.previous_event_digest,
            "payload": event.payload,
        });
        if digest_value(&digest_input) != event.event_digest {
            return Err(ArchitectureRoomError::Storage(
                "architecture room event digest mismatch".into(),
            ));
        }
        previous = Some(&event.event_digest);
    }
    Ok(())
}

fn create_synced(
    path: &Path,
    stored: &StoredArchitectureOperationV1,
) -> Result<(), ArchitectureRoomError> {
    let bytes = serde_json::to_vec_pretty(stored).map_err(storage_error)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(storage_error)?;
    file.write_all(&bytes).map_err(storage_error)?;
    file.sync_all().map_err(storage_error)?;
    sync_parent(path)
}

fn replace_synced(
    path: &Path,
    stored: &StoredArchitectureOperationV1,
) -> Result<(), ArchitectureRoomError> {
    let temporary = path.with_extension(format!("{}.tmp", RunId::new()));
    let bytes = serde_json::to_vec_pretty(stored).map_err(storage_error)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(storage_error)?;
    file.write_all(&bytes).map_err(storage_error)?;
    file.sync_all().map_err(storage_error)?;
    fs::rename(&temporary, path).map_err(storage_error)?;
    sync_parent(path)
}

fn sync_parent(path: &Path) -> Result<(), ArchitectureRoomError> {
    let parent = path.parent().ok_or_else(|| {
        ArchitectureRoomError::Storage("room record has no parent directory".into())
    })?;
    let directory = OpenOptions::new()
        .read(true)
        .open(parent)
        .map_err(storage_error)?;
    directory.sync_all().map_err(storage_error)
}

fn storage_error(error: impl std::fmt::Display) -> ArchitectureRoomError {
    ArchitectureRoomError::Storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root() -> PathBuf {
        std::env::temp_dir().join(format!("foundry-room-test-{}", RunId::new()))
    }

    #[test]
    fn event_chain_survives_reopen_and_pages_by_sequence() {
        let root = temporary_root();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let (operation, created) = ledger
            .create(
                "30617:owner:repo",
                "create-one",
                &serde_json::json!({"spec": "test"}),
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        assert!(created);
        ledger
            .transition(
                &operation.operation_id,
                ArchitectureOperationStateV1::Architecting,
                "Architect started",
                "foundry",
            )
            .unwrap();
        drop(ledger);

        let reopened = ArchitectureRoomLedger::open(&root).unwrap();
        let page = reopened.events(&operation.operation_id, 1, 200).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].sequence, 2);
        assert_eq!(
            page[0].previous_event_digest.as_deref(),
            reopened.events(&operation.operation_id, 0, 1).unwrap()[0]
                .event_digest
                .as_str()
                .into()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_replacement_is_ignored_but_committed_event_tampering_fails_closed() {
        let root = temporary_root();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let (operation, _) = ledger
            .create(
                "30617:owner:repo",
                "crash-boundary",
                &serde_json::json!({"spec": "test"}),
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into()],
                true,
            )
            .unwrap();
        let record_path = root
            .join("architecture-operations")
            .join(format!("{}.json", operation.operation_id));
        let interrupted_path = record_path.with_extension("interrupted.tmp");
        fs::write(&interrupted_path, b"{\"torn\":").unwrap();
        drop(ledger);

        let reopened = ArchitectureRoomLedger::open(&root).unwrap();
        assert_eq!(
            reopened
                .events(&operation.operation_id, 0, 200)
                .unwrap()
                .len(),
            1
        );
        drop(reopened);

        let mut committed: Value =
            serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
        committed["events"][0]["message"] = Value::String("tampered".into());
        fs::write(&record_path, serde_json::to_vec_pretty(&committed).unwrap()).unwrap();
        let reopened = ArchitectureRoomLedger::open(&root).unwrap();
        assert!(matches!(
            reopened.events(&operation.operation_id, 0, 200),
            Err(ArchitectureRoomError::Storage(_))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn room_event_pages_are_capped_and_cursor_continuation_has_no_gap() {
        let root = temporary_root();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let (operation, _) = ledger
            .create(
                "30617:owner:repo",
                "paged-room",
                &serde_json::json!({"spec": "test"}),
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into()],
                true,
            )
            .unwrap();
        let mut stored = ledger.read(&operation.operation_id).unwrap();
        for index in 0..205 {
            append_event_to(
                &mut stored,
                ArchitectureRoomActorKindV1::Foundry,
                "foundry",
                ArchitectureRoomPayloadV1::Message {
                    message: format!("event {index}"),
                },
                None,
            )
            .unwrap();
        }
        replace_synced(&ledger.path(&operation.operation_id), &stored).unwrap();

        let first = ledger
            .events(&operation.operation_id, 0, usize::MAX)
            .unwrap();
        let second = ledger
            .events(&operation.operation_id, 200, usize::MAX)
            .unwrap();
        assert_eq!(first.len(), MAX_EVENT_PAGE);
        assert_eq!(first.last().unwrap().sequence, 200);
        assert_eq!(second.len(), 6);
        assert_eq!(second.first().unwrap().sequence, 201);
        assert_eq!(second.last().unwrap().sequence, 206);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn idempotency_reuses_matching_request_and_rejects_conflict() {
        let root = temporary_root();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let request = serde_json::json!({"spec": "one"});
        let (first, created) = ledger
            .create(
                "30617:owner:repo",
                "stable-key",
                &request,
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        assert!(created);
        let (retried, created) = ledger
            .create(
                "30617:owner:repo",
                "stable-key",
                &request,
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        assert!(!created);
        assert_eq!(retried.operation_id, first.operation_id);
        assert_eq!(
            ledger.create(
                "30617:owner:repo",
                "stable-key",
                &serde_json::json!({"spec": "different"}),
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            ),
            Err(ArchitectureRoomError::IdempotencyConflict)
        );
        assert!(matches!(
            ledger.create(
                "30617:owner:repo",
                "different-key",
                &request,
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            ),
            Err(ArchitectureRoomError::InvalidTransition(_))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_messages_fail_before_commit() {
        let root = temporary_root();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let (operation, _) = ledger
            .create(
                "30617:owner:repo",
                "bounded",
                &serde_json::json!({"spec": "test"}),
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        let result = ledger.append_event(
            &operation.operation_id,
            ArchitectureRoomActorKindV1::Human,
            "human",
            ArchitectureRoomPayloadV1::Message {
                message: "x".repeat(MAX_AUTHORED_MESSAGE_BYTES + 1),
            },
        );
        assert!(matches!(result, Err(ArchitectureRoomError::Invalid(_))));
        assert_eq!(
            ledger
                .events(&operation.operation_id, 0, 200)
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn question_pauses_recovery_until_the_exact_answer_is_committed() {
        let root = temporary_root();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let (operation, _) = ledger
            .create(
                "30617:owner:repo",
                "question",
                &serde_json::json!({"spec": "test"}),
                ArchitectureOperationKindV1::InitialArchitecture,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        ledger
            .wait_for_input(
                &operation.operation_id,
                "question-one",
                "Which consistency model?",
                "architect",
            )
            .unwrap();
        assert!(ledger.recoverable().unwrap().is_empty());
        assert!(matches!(
            ledger.answer_question(&operation.operation_id, "wrong", "foundry"),
            Err(ArchitectureRoomError::InvalidTransition(_))
        ));
        let recovered = ledger
            .answer_question(&operation.operation_id, "question-one", "foundry")
            .unwrap();
        assert_eq!(
            recovered.operation.state,
            ArchitectureOperationStateV1::Queued
        );
        assert_eq!(ledger.recoverable().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn proposal_binding_serializes_one_operation_but_allows_independent_proposals() {
        let root = temporary_root();
        let ledger = ArchitectureRoomLedger::open(&root).unwrap();
        let (first, _) = ledger
            .create(
                "30617:owner:repo",
                "first",
                &serde_json::json!({"proposal": "one"}),
                ArchitectureOperationKindV1::GenerativeEdit,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        ledger
            .bind_proposal(
                &first.operation_id,
                "run",
                "proposal-one",
                "revision",
                "digest",
            )
            .unwrap();
        let (conflict, _) = ledger
            .create(
                "30617:owner:repo",
                "conflict",
                &serde_json::json!({"proposal": "one-again"}),
                ArchitectureOperationKindV1::GenerativeEdit,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        assert!(matches!(
            ledger.bind_proposal(
                &conflict.operation_id,
                "run",
                "proposal-one",
                "revision",
                "digest"
            ),
            Err(ArchitectureRoomError::InvalidTransition(_))
        ));
        ledger
            .transition(
                &conflict.operation_id,
                ArchitectureOperationStateV1::Failed,
                "conflict",
                "foundry",
            )
            .unwrap();
        let (independent, _) = ledger
            .create(
                "30617:owner:repo",
                "independent",
                &serde_json::json!({"proposal": "two"}),
                ArchitectureOperationKindV1::GenerativeEdit,
                "human",
                1,
                vec!["read".into(), "edit".into()],
                true,
            )
            .unwrap();
        ledger
            .bind_proposal(
                &independent.operation_id,
                "run",
                "proposal-two",
                "revision",
                "digest",
            )
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

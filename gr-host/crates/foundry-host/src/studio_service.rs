//! Authenticated single-community HTTP boundary for Architecture Studio.
//!
//! Capabilities live only in service memory, expire after five minutes, and
//! are bound to one community, repository, actor, and operation set. Buzz
//! obtains them with a fresh NIP-98 request signed by its desktop identity.

use std::collections::{BTreeSet, HashMap};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use foundry_ir::{
    ArchitectureLayoutV1, ArchitectureRequest, CriticVerdictV1, Ir, ProposalStatusV1,
    RationaleEntryV1, StudioBindingV1, StudioCommandV1, StudioOperationV1, StudioRationaleV1,
};
use graphreact_persistence::RunId;
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;

use crate::agent_runtime::{
    AgentGuidanceDeliveryV2, AgentJobRequestV1, AgentRoleV1, AgentRuntime, BuzzAcpAgentRuntime,
    PiPoolAgentRuntime,
};
use crate::studio::{self, StudioError, StudioSnapshotV1};
use crate::studio_room::{
    ArchitectureOperationKindV1, ArchitectureOperationStateV1, ArchitectureRoomActorKindV1,
    ArchitectureRoomError, ArchitectureRoomLedger, ArchitectureRoomPayloadV1, GuidanceDeliveryV1,
    GuidanceModeV1,
};

const SESSION_TTL_SECONDS: u64 = 300;
const NIP98_MAX_AGE_SECONDS: u64 = 60;

#[derive(Clone)]
struct ServiceState {
    durability_dir: PathBuf,
    public_url: String,
    community_id: String,
    service_pubkey: String,
    service_keys: Keys,
    relay_api_url: String,
    http_client: reqwest::Client,
    repository_paths: Arc<HashMap<String, PathBuf>>,
    worker_url: String,
    worker_token: String,
    architect_runtime: Arc<dyn AgentRuntime>,
    critic_runtime: Arc<dyn AgentRuntime>,
    policy: Arc<Policy>,
    sessions: Arc<Mutex<HashMap<String, Capability>>>,
    nip98_replays: Arc<Mutex<HashMap<String, u64>>>,
}

#[derive(Default)]
struct Policy {
    readers: BTreeSet<String>,
    editors: BTreeSet<String>,
    critics: BTreeSet<String>,
    approvers: BTreeSet<String>,
    builders: BTreeSet<String>,
    agents: BTreeSet<String>,
    approval_threshold: usize,
}

#[derive(Clone)]
struct Capability {
    community_id: String,
    repository_coordinate: String,
    actor_pubkey: String,
    operations: BTreeSet<String>,
    expires_at: u64,
    human: bool,
    approval_threshold: usize,
}

#[derive(Debug, Serialize)]
struct ApiErrorBody {
    protocol_version: u32,
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    structural_diff: Option<Box<Value>>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    body: ApiErrorBody,
}

impl ApiError {
    fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ApiErrorBody {
                protocol_version: 1,
                code: code.into(),
                message: message.into(),
                current_head: None,
                structural_diff: None,
            },
        }
    }
}

fn enrich_revision_conflict(error: StudioError, current: &StudioSnapshotV1) -> ApiError {
    let mut error = ApiError::from(error);
    if error.body.code == "REVISION_CONFLICT" {
        error.body.current_head = Some(current.proposal.head_semantic_digest.clone());
        error.body.structural_diff = serde_json::to_value(&current.structural_diff)
            .ok()
            .map(Box::new);
    }
    error
}

impl From<StudioError> for ApiError {
    fn from(error: StudioError) -> Self {
        let status = match error.code() {
            "NOT_FOUND" => StatusCode::NOT_FOUND,
            "FORBIDDEN" => StatusCode::FORBIDDEN,
            "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "STALE_BASE" => StatusCode::CONFLICT,
            "SERVICE_NOT_READY" => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        Self::new(status, error.code(), error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

impl From<ArchitectureRoomError> for ApiError {
    fn from(error: ArchitectureRoomError) -> Self {
        let (status, code) = match &error {
            ArchitectureRoomError::Invalid(_) => (StatusCode::BAD_REQUEST, "INVALID_COMMAND"),
            ArchitectureRoomError::IdempotencyConflict => {
                (StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT")
            }
            ArchitectureRoomError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            ArchitectureRoomError::InvalidTransition(_) => {
                (StatusCode::CONFLICT, "INVALID_TRANSITION")
            }
            ArchitectureRoomError::Storage(_) => {
                (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_NOT_READY")
            }
        };
        Self::new(status, code, error.to_string())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SessionRequest {
    protocol_version: u32,
    community_id: String,
    repository_coordinate: String,
    #[serde(default = "default_target_branch")]
    target_branch: String,
}

fn default_target_branch() -> String {
    "main".into()
}

#[derive(Serialize)]
struct SessionResponse {
    protocol_version: u32,
    capability: String,
    expires_at: u64,
    audience: String,
    actor_pubkey: String,
    operations: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateStudioRequest {
    binding: StudioBindingV1,
    ir: Ir,
    #[serde(default)]
    rationale: StudioRationaleV1,
    title: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ArchitectStudioRequest {
    binding: StudioBindingV1,
    title: String,
    product_spec: String,
    allowed_languages: Vec<String>,
    #[serde(default)]
    policy_constraints: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyCommandRequest {
    command_version: u32,
    command_id: String,
    proposal_id: String,
    expected_head_digest: String,
    operations: Vec<StudioOperationV1>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CriticRequest {
    expected_head_digest: String,
    verdict: CriticVerdictV1,
    #[serde(default)]
    diagnostics: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateProposalRequest {
    source_proposal_id: String,
    expected_head_digest: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalRequest {
    expected_head_digest: String,
    event_json: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromotionRequest {
    expected_head_digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildRequest {
    expected_head_digest: String,
    current_base_commit: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum GenerativeCommandKind {
    SplitNode,
    MergeNodes,
    RewriteSubtree,
    ResolveDiagnostics,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GenerativeRequest {
    expected_head_digest: String,
    kind: GenerativeCommandKind,
    #[serde(default)]
    selected_nodes: Vec<String>,
    instruction: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GenerativeOperationRequest {
    run_id: String,
    proposal_id: String,
    expected_head_digest: String,
    kind: GenerativeCommandKind,
    #[serde(default)]
    selected_nodes: Vec<String>,
    instruction: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RebaseOperationRequest {
    run_id: String,
    target_proposal_id: String,
    onto_proposal_id: String,
    expected_target_digest: String,
    expected_onto_digest: String,
    instruction: String,
}

impl GenerativeOperationRequest {
    fn command(&self) -> GenerativeRequest {
        GenerativeRequest {
            expected_head_digest: self.expected_head_digest.clone(),
            kind: self.kind.clone(),
            selected_nodes: self.selected_nodes.clone(),
            instruction: self.instruction.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiscoveryQuery {
    repository: String,
    proposal: Option<String>,
    revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoomEventsQuery {
    #[serde(default)]
    after: u64,
    #[serde(default = "default_room_page_limit")]
    limit: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationListQuery {
    repository: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchitectureGuidanceRequest {
    message_id: String,
    mode: GuidanceModeV1,
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchitectureQuestionAnswerRequest {
    question_id: String,
    message_id: String,
    content: String,
}

fn default_room_page_limit() -> usize {
    200
}

#[derive(Serialize)]
struct StudioProjection {
    #[serde(flatten)]
    snapshot: StudioSnapshotV1,
    permissions: PermissionProjection,
    last_verified_at: String,
}

#[derive(Serialize)]
struct PermissionProjection {
    can_edit: bool,
    can_review: bool,
    can_approve: bool,
    can_build: bool,
    approvals_required: usize,
    approvals_received: usize,
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn write_pretty_json<T: Serialize>(
    directory: &std::path::Path,
    name: &str,
    value: &T,
) -> Result<PathBuf, ApiError> {
    let path = directory.join(name);
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    std::fs::write(&path, bytes).map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    Ok(path)
}

fn write_text(directory: &std::path::Path, name: &str, value: &str) -> Result<PathBuf, ApiError> {
    let path = directory.join(name);
    std::fs::write(&path, value).map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    Ok(path)
}

fn csv_set(name: &str) -> BTreeSet<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn operation_key(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_COMMAND",
                "Idempotency-Key is required",
            )
        })
}

fn capability(
    state: &ServiceState,
    headers: &HeaderMap,
    repository: &str,
    operation: &str,
) -> Result<Capability, ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            ApiError::new(StatusCode::UNAUTHORIZED, "FORBIDDEN", "missing capability")
        })?;
    let mut sessions = state.sessions.lock().map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    sessions.retain(|_, session| session.expires_at > epoch_seconds());
    let capability = sessions
        .get(token)
        .filter(|session| {
            session.community_id == state.community_id
                && session.repository_coordinate == repository
                && session.expires_at > epoch_seconds()
                && session.operations.contains(operation)
        })
        .cloned()
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "capability scope denied",
            )
        })?;
    Ok(capability)
}

fn operations_for(policy: &Policy, actor: &str, repository_coordinate: &str) -> BTreeSet<String> {
    let mut operations = BTreeSet::new();
    let repository_owner = repository_coordinate.split(':').nth(1);
    let owns_repository = repository_owner == Some(actor);
    if policy.readers.contains(actor)
        || policy.editors.contains(actor)
        || policy.agents.contains(actor)
        || policy.critics.contains(actor)
        || policy.approvers.contains(actor)
        || policy.builders.contains(actor)
        || owns_repository
    {
        operations.insert("read".into());
    }
    if policy.editors.contains(actor) || policy.agents.contains(actor) || owns_repository {
        operations.insert("edit".into());
    }
    if policy.critics.contains(actor) {
        operations.insert("review".into());
    }
    if policy.approvers.contains(actor) || owns_repository {
        operations.insert("approve".into());
    }
    if policy.builders.contains(actor) || owns_repository {
        operations.insert("build".into());
    }
    operations
}

struct SignedRepositoryPolicy {
    owner: String,
    editors: BTreeSet<String>,
    approval_threshold: usize,
}

async fn signed_repository_policy(
    state: &ServiceState,
    repository_coordinate: &str,
    target_branch: &str,
) -> Result<SignedRepositoryPolicy, ApiError> {
    let mut coordinate = repository_coordinate.splitn(3, ':');
    if coordinate.next() != Some("30617") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            "repository coordinate must be 30617:<owner>:<identifier>",
        ));
    }
    let owner = coordinate.next().unwrap_or_default().to_ascii_lowercase();
    let identifier = coordinate.next().unwrap_or_default();
    if owner.len() != 64
        || !owner.bytes().all(|byte| byte.is_ascii_hexdigit())
        || identifier.is_empty()
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            "repository coordinate is malformed",
        ));
    }
    let url = format!("{}/query", state.relay_api_url.trim_end_matches('/'));
    let body = serde_json::to_vec(&json!([{
        "authors": [&owner],
        "kinds": [30_617],
        "#d": [identifier],
        "limit": 1,
    }]))
    .map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    let authorization = service_nip98_header(&state.service_keys, "POST", &url, &body)?;
    let response = state
        .http_client
        .post(url)
        .header("authorization", authorization)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            "current repository policy could not be read",
        ));
    }
    let events = response.json::<Vec<Value>>().await.map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    let event_json = events.into_iter().next().ok_or_else(|| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "repository has no current signed announcement",
        )
    })?;
    let event = Event::from_json(event_json.to_string())
        .map_err(|error| ApiError::new(StatusCode::FORBIDDEN, "FORBIDDEN", error.to_string()))?;
    event
        .verify()
        .map_err(|error| ApiError::new(StatusCode::FORBIDDEN, "FORBIDDEN", error.to_string()))?;
    if event.pubkey.to_hex() != owner || event.kind != Kind::Custom(30_617) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "repository announcement identity does not match its coordinate",
        ));
    }
    Ok(policy_from_verified_announcement(
        owner,
        &event,
        target_branch,
    ))
}

fn policy_from_verified_announcement(
    owner: String,
    event: &Event,
    target_branch: &str,
) -> SignedRepositoryPolicy {
    let mut editors = BTreeSet::new();
    let mut approval_threshold = 1usize;
    for tag in event.tags.iter().map(|tag| tag.as_slice()) {
        let key = tag.first().map(String::as_str);
        let actor = tag.get(1).map(String::as_str);
        let marker = tag.last().map(String::as_str);
        let direct_editor = matches!(key, Some("maintainer" | "push-allowed"));
        let marked_editor =
            key == Some("p") && matches!(marker, Some("maintainer" | "push-allowed"));
        if direct_editor || marked_editor {
            if let Some(actor) = actor {
                editors.insert(actor.to_ascii_lowercase());
            }
        } else if key == Some("foundry-approval")
            && tag.get(1).map(String::as_str) == Some(target_branch)
        {
            approval_threshold = tag
                .get(2)
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(1);
        }
    }
    SignedRepositoryPolicy {
        owner,
        editors,
        approval_threshold,
    }
}

fn apply_signed_repository_policy(
    operations: &mut BTreeSet<String>,
    actor: &str,
    signed: &SignedRepositoryPolicy,
) {
    operations.insert("read".into());
    if actor == signed.owner || signed.editors.contains(actor) {
        operations.insert("edit".into());
        operations.insert("approve".into());
        operations.insert("build".into());
    }
}

fn verify_nip98(
    state: &ServiceState,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<String, ApiError> {
    let encoded = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Nostr "))
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "FORBIDDEN", "NIP-98 required"))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "FORBIDDEN",
                "invalid NIP-98 encoding",
            )
        })?;
    let event_json: Value = serde_json::from_slice(&decoded).map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "FORBIDDEN",
            "invalid NIP-98 event",
        )
    })?;
    let event = Event::from_json(&decoded).map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "FORBIDDEN",
            "invalid NIP-98 event",
        )
    })?;
    event.verify().map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "FORBIDDEN",
            "invalid NIP-98 signature",
        )
    })?;
    let created_at = event_json
        .get("created_at")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ApiError::new(StatusCode::UNAUTHORIZED, "FORBIDDEN", "missing created_at")
        })?;
    let now = epoch_seconds();
    if created_at > now.saturating_add(5) || now.saturating_sub(created_at) > NIP98_MAX_AGE_SECONDS
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "FORBIDDEN",
            "expired NIP-98 event",
        ));
    }
    let tags = event_json
        .get("tags")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::new(StatusCode::UNAUTHORIZED, "FORBIDDEN", "missing NIP-98 tags")
        })?;
    let tag = |name: &str| {
        tags.iter().find_map(|item| {
            let values = item.as_array()?;
            (values.first()?.as_str()? == name)
                .then(|| values.get(1)?.as_str())
                .flatten()
        })
    };
    let expected_url = format!("{}/v1/studio/session", state.public_url);
    if tag("u") != Some(expected_url.as_str()) || tag("method") != Some("POST") {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "FORBIDDEN",
            "wrong NIP-98 audience",
        ));
    }
    let expected_payload = format!("{:x}", sha2::Sha256::digest(body));
    if tag("payload") != Some(expected_payload.as_str()) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "FORBIDDEN",
            "wrong NIP-98 payload",
        ));
    }
    let event_id = event_json
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "FORBIDDEN", "missing event id"))?;
    let mut replays = state.nip98_replays.lock().map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    replays.retain(|_, timestamp| now.saturating_sub(*timestamp) <= NIP98_MAX_AGE_SECONDS);
    if replays.insert(event_id.into(), created_at).is_some() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "FORBIDDEN",
            "NIP-98 replay rejected",
        ));
    }
    event_json
        .get("pubkey")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "FORBIDDEN",
                "missing actor pubkey",
            )
        })
}

fn service_nip98_header(
    keys: &Keys,
    method: &str,
    url: &str,
    body: &[u8],
) -> Result<String, ApiError> {
    let payload_hash = format!("{:x}", sha2::Sha256::digest(body));
    let nonce = RunId::new();
    let tags = [
        vec!["u", url],
        vec!["method", method],
        vec!["payload", payload_hash.as_str()],
        vec!["nonce", nonce.as_str()],
    ]
    .into_iter()
    .map(Tag::parse)
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    let event = EventBuilder::new(Kind::HttpAuth, "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD.encode(event.as_json())
    ))
}

async fn verify_approval_on_relay(
    state: &ServiceState,
    event_id: &str,
    signer: &str,
) -> Result<(), ApiError> {
    let url = format!("{}/query", state.relay_api_url.trim_end_matches('/'));
    let body = serde_json::to_vec(&json!([{
        "ids": [event_id],
        "authors": [signer],
        "kinds": [46_011],
        "limit": 1,
    }]))
    .map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    let authorization = service_nip98_header(&state.service_keys, "POST", &url, &body)?;
    let response = state
        .http_client
        .post(url)
        .header("authorization", authorization)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            format!("community relay returned {}", response.status()),
        ));
    }
    let events = response.json::<Vec<Value>>().await.map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    if !events
        .iter()
        .any(|event| event.get("id").and_then(Value::as_str) == Some(event_id))
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "approval event is not present on the community relay",
        ));
    }
    Ok(())
}

async fn publish_service_event(
    state: &ServiceState,
    kind: u16,
    created_at: u64,
    tags: Vec<Vec<String>>,
    content: String,
) -> Result<String, ApiError> {
    let tags = tags
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    let event = EventBuilder::new(Kind::Custom(kind), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(&state.service_keys)
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    let url = format!("{}/events", state.relay_api_url.trim_end_matches('/'));
    let body = event.as_json().into_bytes();
    let authorization = service_nip98_header(&state.service_keys, "POST", &url, &body)?;
    let response = state
        .http_client
        .post(url)
        .header("authorization", authorization)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            format!("community relay returned {}", response.status()),
        ));
    }
    Ok(event.id.to_hex())
}

fn lifecycle_kind(status: &str) -> u16 {
    match status {
        "queued" => 43_001,
        "waiting_effect" => 43_003,
        "cancelling" | "cancelled" => 43_004,
        "succeeded" => 43_005,
        "failed" | "indeterminate" => 43_006,
        _ => 43_002,
    }
}

async fn monitor_build(state: Arc<ServiceState>, handoff: foundry_ir::ArchitectureBuildHandoffV1) {
    let mut last_status = String::new();
    loop {
        let value = match build_status_value(&state, &handoff.build_run_id) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Foundry Studio build monitor: {}", error.body.message);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("queued")
            .to_owned();
        if status != last_status {
            let ordinal = match status.as_str() {
                "queued" => 1,
                "running" => 2,
                "waiting_effect" => 3,
                "cancelling" | "cancelled" => 4,
                "succeeded" => 5,
                _ => 6,
            };
            let tags = vec![
                vec!["foundry-run".into(), handoff.build_run_id.clone()],
                vec!["proposal".into(), handoff.proposal_id.clone()],
                vec!["revision".into(), handoff.semantic_digest.clone()],
                vec!["status".into(), status.clone()],
            ];
            match publish_service_event(
                &state,
                lifecycle_kind(&status),
                handoff.created_at_ms / 1_000 + ordinal,
                tags,
                value.to_string(),
            )
            .await
            {
                Ok(_) => last_status.clone_from(&status),
                Err(error) => {
                    eprintln!("Foundry Studio event projection: {}", error.body.message);
                }
            }
        }
        if matches!(
            status.as_str(),
            "succeeded" | "failed" | "cancelled" | "indeterminate"
        ) {
            if status == "succeeded" {
                let directory = state
                    .durability_dir
                    .join("build-runs")
                    .join(&handoff.build_run_id);
                if let Ok(artifacts) =
                    crate::durable::run_artifacts(&directory, &handoff.build_run_id)
                {
                    for (index, artifact) in artifacts.into_iter().enumerate() {
                        let digest = artifact
                            .sha256
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<String>();
                        let _ = publish_service_event(
                            &state,
                            1_063,
                            handoff.created_at_ms / 1_000
                                + 100
                                + u64::try_from(index).unwrap_or(u64::MAX),
                            vec![
                                vec!["foundry-run".into(), handoff.build_run_id.clone()],
                                vec!["artifact".into(), artifact.id.to_string()],
                                vec!["sha256".into(), digest],
                                vec!["media-type".into(), artifact.media_type.clone()],
                            ],
                            artifact.logical_name,
                        )
                        .await;
                    }
                }
                if let Err(error) = publish_studio_draft(&state, &handoff).await {
                    eprintln!(
                        "Foundry Studio draft publication failed: {}",
                        error.body.message
                    );
                    let _ = publish_service_event(
                        &state,
                        43_006,
                        handoff.created_at_ms / 1_000 + 7,
                        vec![
                            vec!["foundry-run".into(), handoff.build_run_id.clone()],
                            vec!["proposal".into(), handoff.proposal_id.clone()],
                            vec!["revision".into(), handoff.semantic_digest.clone()],
                            vec!["status".into(), "delivery_failed".into()],
                        ],
                        error.body.message,
                    )
                    .await;
                } else if let Err(error) =
                    studio::mark_build_delivered(&state.durability_dir, &handoff.build_run_id)
                {
                    eprintln!("Foundry Studio delivery commit failed: {error}");
                }
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn publish_studio_draft(
    state: &ServiceState,
    handoff: &foundry_ir::ArchitectureBuildHandoffV1,
) -> Result<(), ApiError> {
    let (studio_state, _) =
        studio::find_build_handoff(&state.durability_dir, &handoff.build_run_id)?;
    let repository = state
        .repository_paths
        .get(&studio_state.binding.repository_coordinate)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                "repository mount disappeared before draft publication",
            )
        })?;
    let input_dir = state
        .durability_dir
        .join("build-inputs")
        .join(&handoff.build_run_id);
    let build_durability = state
        .durability_dir
        .join("build-runs")
        .join(&handoff.build_run_id);
    let executable = std::env::current_exe().map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    let output = tokio::process::Command::new(executable)
        .arg("publish")
        .args(["--run", &handoff.build_run_id])
        .args(["--repo", &repository.to_string_lossy()])
        .args(["--base", &studio_state.binding.target_branch])
        .args(["--ir", &input_dir.join("ir.json").to_string_lossy()])
        .args(["--durability-dir", &build_durability.to_string_lossy()])
        .args([
            "--summary",
            &input_dir.join("review-summary.md").to_string_lossy(),
        ])
        .arg("--draft-pr")
        .env_remove("FOUNDRY_STUDIO_SERVICE_NSEC")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    if !output.status.success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "SERVICE_NOT_READY",
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(())
}

async fn readiness(State(state): State<Arc<ServiceState>>) -> impl IntoResponse {
    let persistence = studio::verify_readiness(&state.durability_dir).is_ok();
    let repositories = !state.repository_paths.is_empty()
        && state.repository_paths.values().all(|path| path.is_dir());
    let relay = state
        .http_client
        .get(format!(
            "{}/info",
            state.relay_api_url.trim_end_matches('/')
        ))
        .header("accept", "application/nostr+json")
        .send()
        .await
        .is_ok_and(|response| response.status().is_success());
    let configured_dependencies = reqwest::Url::parse(&state.worker_url).is_ok()
        && state.architect_runtime.identity() != state.critic_runtime.identity()
        && !state.worker_token.is_empty()
        && !state.architect_runtime.identity().is_empty()
        && !state.critic_runtime.identity().is_empty();
    let ready = persistence && repositories && relay && configured_dependencies;
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "protocol_version": 1,
            "ready": ready,
            "community_id": state.community_id,
            "service_pubkey": state.service_pubkey,
            "checks": {
                "persistence_verified": persistence,
                "repositories_available": repositories,
                "relay_reachable": relay,
                "dependencies_configured": configured_dependencies,
            }
        })),
    )
}

async fn exchange_session(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<SessionResponse>, ApiError> {
    let actor = verify_nip98(&state, &headers, &body)?;
    let request: SessionRequest = serde_json::from_slice(&body).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    if request.protocol_version != 1 || request.community_id != state.community_id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "community scope denied",
        ));
    }
    let signed_policy = signed_repository_policy(
        &state,
        &request.repository_coordinate,
        &request.target_branch,
    )
    .await?;
    let mut operations = operations_for(&state.policy, &actor, &request.repository_coordinate);
    apply_signed_repository_policy(&mut operations, &actor, &signed_policy);
    if operations.is_empty() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "actor has no repository role",
        ));
    }
    let token = RunId::new().to_string();
    let expires_at = epoch_seconds().saturating_add(SESSION_TTL_SECONDS);
    state
        .sessions
        .lock()
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?
        .insert(
            token.clone(),
            Capability {
                community_id: request.community_id,
                repository_coordinate: request.repository_coordinate,
                actor_pubkey: actor.clone(),
                operations: operations.clone(),
                expires_at,
                human: !state.policy.agents.contains(&actor),
                approval_threshold: signed_policy
                    .approval_threshold
                    .max(state.policy.approval_threshold),
            },
        );
    Ok(Json(SessionResponse {
        protocol_version: 1,
        capability: token,
        expires_at,
        audience: state.service_pubkey.clone(),
        actor_pubkey: actor,
        operations,
    }))
}

fn projection(
    _state: &ServiceState,
    capability: &Capability,
    snapshot: StudioSnapshotV1,
) -> StudioProjection {
    let digest = snapshot.revision.semantic_digest.clone();
    let approvals_received = snapshot
        .state
        .human_approvals
        .iter()
        .filter(|approval| approval.semantic_digest == digest)
        .map(|approval| approval.signer_pubkey.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    StudioProjection {
        permissions: PermissionProjection {
            can_edit: capability.operations.contains("edit"),
            can_review: capability.operations.contains("review"),
            can_approve: capability.operations.contains("approve"),
            can_build: capability.operations.contains("build"),
            approvals_required: capability.approval_threshold,
            approvals_received,
        },
        snapshot,
        last_verified_at: epoch_seconds().to_string(),
    }
}

fn project_agent_runtime_event(
    durability_dir: &std::path::Path,
    operation_id: &str,
    actor_kind: ArchitectureRoomActorKindV1,
    actor_id: &str,
    event: Value,
) {
    let Some(source_event_id) = event.get("event_id").and_then(Value::as_str) else {
        return;
    };
    let job_id = event.get("job_id").and_then(Value::as_str);
    let payload = match event.get("kind").and_then(Value::as_str) {
        Some("lifecycle") => ArchitectureRoomPayloadV1::Message {
            message: event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Agent lifecycle changed")
                .to_owned(),
        },
        Some("plan") => ArchitectureRoomPayloadV1::Plan {
            summary: event
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("Agent updated its working plan")
                .to_owned(),
        },
        Some("tool") => ArchitectureRoomPayloadV1::Tool {
            category: event
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned(),
            purpose: event
                .get("purpose")
                .and_then(Value::as_str)
                .unwrap_or("Agent tool activity")
                .to_owned(),
            status: event
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("updated")
                .to_owned(),
            duration_ms: None,
            result_summary: None,
        },
        Some("message") => ArchitectureRoomPayloadV1::Message {
            message: event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Agent completed its response")
                .to_owned(),
        },
        Some("compiler_diagnostics") => ArchitectureRoomPayloadV1::CompilerDiagnostics {
            diagnostics: event
                .get("diagnostics")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .take(200)
                .map(|diagnostic| diagnostic.chars().take(16 * 1024).collect())
                .collect(),
        },
        _ => return,
    };
    let _ = ArchitectureRoomLedger::open(durability_dir).and_then(|ledger| {
        if let Some(job_id) = job_id {
            ledger.set_active_job(operation_id, actor_kind, job_id)?;
        }
        ledger.append_external_event(operation_id, source_event_id, actor_kind, actor_id, payload)
    });
}

async fn execute_room_critic(
    state: &Arc<ServiceState>,
    run_id: &str,
    snapshot: &StudioSnapshotV1,
    room_operation_id: Option<&str>,
) -> Result<(CriticVerdictV1, Vec<String>), ApiError> {
    let critic_runtime = Arc::clone(&state.critic_runtime);
    let critic_job_id = format!(
        "studio-critic-{:x}",
        sha2::Sha256::digest(format!("{run_id}:{}", snapshot.revision.semantic_digest))
    );
    let critic_payload = json!({
        "job_id": &critic_job_id,
        "ir": &snapshot.ir,
        "semantic_digest": &snapshot.revision.semantic_digest,
        "rationale": &snapshot.rationale,
        "locks": &snapshot.locks,
    });
    let critic_room_operation = room_operation_id.map(str::to_owned);
    let critic_room_durability = state.durability_dir.clone();
    let critic_identity = state.critic_runtime.identity().to_owned();
    let critic_run_id = run_id.to_owned();
    let critic = tokio::task::spawn_blocking(move || {
        let job = AgentJobRequestV1::new(
            critic_job_id,
            critic_run_id,
            AgentRoleV1::Critic,
            "architecture_review",
            critic_payload,
        );
        let event_sink = |event: Value| {
            if let Some(operation_id) = &critic_room_operation {
                project_agent_runtime_event(
                    &critic_room_durability,
                    operation_id,
                    ArchitectureRoomActorKindV1::Critic,
                    &critic_identity,
                    event,
                );
            }
        };
        match critic_room_operation.as_ref() {
            Some(_) => critic_runtime.execute_with_events(&job, &event_sink),
            None => critic_runtime.execute(&job),
        }
    })
    .await
    .map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?
    .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_NOT_READY", error))?;
    let verdict = match critic.get("verdict").and_then(Value::as_str) {
        Some("approved") => CriticVerdictV1::Approved,
        Some("changes_requested") => CriticVerdictV1::ChangesRequested,
        _ => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                "critic returned an invalid verdict",
            ))
        }
    };
    let diagnostics = critic
        .get("diagnostics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    Ok((verdict, diagnostics))
}

async fn create_studio(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<CreateStudioRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let mut capability = capability(
        &state,
        &headers,
        &request.binding.repository_coordinate,
        "edit",
    )?;
    if request.binding.community_id != state.community_id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "community scope denied",
        ));
    }
    let signed_policy = signed_repository_policy(
        &state,
        &request.binding.repository_coordinate,
        &request.binding.target_branch,
    )
    .await?;
    capability.approval_threshold = signed_policy
        .approval_threshold
        .max(state.policy.approval_threshold);
    let created = studio::create(
        &state.durability_dir,
        request.binding,
        request.ir,
        request.rationale,
        &capability.actor_pubkey,
        &request.title,
        operation_key(&headers)?,
    )?;
    let proposal_id = created
        .proposals
        .first()
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVICE_NOT_READY",
                "created Studio has no proposal",
            )
        })?
        .proposal_id
        .clone();
    let snapshot = studio::snapshot(&state.durability_dir, &created.run_id, &proposal_id)?;
    Ok(Json(projection(&state, &capability, snapshot)))
}

async fn architect_studio(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<ArchitectStudioRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let capability = authorize_architect_request(&state, &headers, &request).await?;
    let operation = operation_key(&headers)?.to_owned();
    run_architect_studio(state, capability, request, operation, None)
        .await
        .map(Json)
}

async fn authorize_architect_request(
    state: &ServiceState,
    headers: &HeaderMap,
    request: &ArchitectStudioRequest,
) -> Result<Capability, ApiError> {
    let mut capability = capability(
        state,
        headers,
        &request.binding.repository_coordinate,
        "edit",
    )?;
    if request.binding.community_id != state.community_id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "community scope denied",
        ));
    }
    let signed_policy = signed_repository_policy(
        state,
        &request.binding.repository_coordinate,
        &request.binding.target_branch,
    )
    .await?;
    capability.approval_threshold = signed_policy
        .approval_threshold
        .max(state.policy.approval_threshold);
    Ok(capability)
}

async fn run_architect_studio(
    state: Arc<ServiceState>,
    capability: Capability,
    request: ArchitectStudioRequest,
    operation: String,
    room_operation_id: Option<&str>,
) -> Result<StudioProjection, ApiError> {
    let operation_file_key = format!("{:x}", sha2::Sha256::digest(operation.as_bytes()));
    let output = state
        .durability_dir
        .join("agent-candidates")
        .join(format!("initial-{operation_file_key}.ir.json"));
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    }
    let request_record = output.with_extension("request.json");
    let request_value = serde_json::to_value(&request).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    if request_record.exists() {
        let existing: Value =
            serde_json::from_slice(&std::fs::read(&request_record).map_err(|error| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "SERVICE_NOT_READY",
                    error.to_string(),
                )
            })?)
            .map_err(|error| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "SERVICE_NOT_READY",
                    error.to_string(),
                )
            })?;
        if existing != request_value {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "Studio creation key was reused with different content",
            ));
        }
    } else {
        write_pretty_json(
            request_record.parent().unwrap_or(&state.durability_dir),
            request_record
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("initial-request.json"),
            &request,
        )?;
    }
    let product_spec = request.product_spec.clone();
    let repository_coordinate = request.binding.repository_coordinate.clone();
    let base_commit = request.binding.base_commit.clone();
    let architecture_request = ArchitectureRequest {
        architecture_version: 1,
        product_spec: request.product_spec.clone(),
        repository: request.binding.repository_coordinate.clone(),
        base_revision: request.binding.base_commit.clone(),
        allowed_languages: request.allowed_languages,
        policy_constraints: request.policy_constraints,
        existing_ir: None,
    };
    let architect_runtime = Arc::clone(&state.architect_runtime);
    let architect_run_id = format!("studio-create-{operation}");
    let room_operation = room_operation_id.map(str::to_owned);
    let room_durability = state.durability_dir.clone();
    let architect_identity = state.architect_runtime.identity().to_owned();
    let ir = if output.exists() {
        serde_json::from_slice::<Ir>(&std::fs::read(&output).map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?)
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?
    } else {
        let output_for_agent = output.with_extension(format!("{}.tmp", RunId::new()));
        let committed_output = output;
        tokio::task::spawn_blocking(move || {
            let event_sink = |event: Value| {
                if let Some(operation_id) = &room_operation {
                    project_agent_runtime_event(
                        &room_durability,
                        operation_id,
                        ArchitectureRoomActorKindV1::Architect,
                        &architect_identity,
                        event,
                    );
                }
            };
            let agent = crate::architect::RuntimeArchitectureAgent {
                runtime: architect_runtime.as_ref(),
                run_id: &architect_run_id,
                event_sink: room_operation
                    .as_ref()
                    .map(|_| &event_sink as &(dyn Fn(Value) + Send + Sync)),
            };
            let ir = crate::architect::architect(&agent, &architecture_request, &output_for_agent)?;
            std::fs::rename(&output_for_agent, &committed_output)
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(ir)
        })
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?
        .map_err(|error| {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "COMPILER_REJECTED", error)
        })?
    };
    if let Some(operation_id) = room_operation_id {
        ArchitectureRoomLedger::open(&state.durability_dir)?.transition(
            operation_id,
            ArchitectureOperationStateV1::Compiling,
            "The architect candidate satisfies the Foundry IR compiler",
            &state.service_pubkey,
        )?;
    }
    let rationale = StudioRationaleV1 {
        entries: ir
            .nodes
            .iter()
            .map(|node| {
                (
                    node.id.clone(),
                    RationaleEntryV1 {
                        summary: format!("Initial architecture for {}", request.product_spec),
                        responsibilities: vec![format!("Provide {}", node.provides.name)],
                        constraints: vec!["Compiler-valid Foundry IR v1".into()],
                    },
                )
            })
            .collect(),
    };
    let created = studio::create(
        &state.durability_dir,
        request.binding,
        ir,
        rationale,
        &capability.actor_pubkey,
        &request.title,
        &operation,
    )?;
    let proposal_id = created
        .proposals
        .first()
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVICE_NOT_READY",
                "created Studio has no proposal",
            )
        })?
        .proposal_id
        .clone();
    let mut current = studio::snapshot(&state.durability_dir, &created.run_id, &proposal_id)?;
    if let Some(operation_id) = room_operation_id {
        ArchitectureRoomLedger::open(&state.durability_dir)?.bind_proposal(
            operation_id,
            &created.run_id,
            &proposal_id,
            &current.revision.revision_id,
            &current.revision.semantic_digest,
        )?;
    }
    for review_round in 1..=3 {
        if let Some(operation_id) = room_operation_id {
            let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
            ledger.set_repair_round(operation_id, review_round - 1)?;
            ledger.transition(
                operation_id,
                ArchitectureOperationStateV1::CriticReview,
                &format!("The independent critic is reviewing round {review_round} of 3"),
                &state.service_pubkey,
            )?;
        }
        let (verdict, diagnostics) =
            execute_room_critic(&state, &created.run_id, &current, room_operation_id).await?;
        if let Some(operation_id) = room_operation_id {
            ArchitectureRoomLedger::open(&state.durability_dir)?.append_event(
                operation_id,
                ArchitectureRoomActorKindV1::Critic,
                state.critic_runtime.identity(),
                ArchitectureRoomPayloadV1::CriticVerdict {
                    verdict: match &verdict {
                        CriticVerdictV1::Approved => "approved",
                        CriticVerdictV1::ChangesRequested => "changes_requested",
                    }
                    .into(),
                    diagnostics: diagnostics.clone(),
                },
            )?;
        }
        let approved = verdict == CriticVerdictV1::Approved;
        let reviewed = studio::record_critic_review(
            &state.durability_dir,
            &created.run_id,
            &proposal_id,
            &current.revision.semantic_digest,
            &format!("foundry-critic:{}", state.service_pubkey),
            verdict,
            diagnostics.clone(),
            &format!("{operation}:critic:{review_round}"),
        )?;
        if approved {
            return Ok(projection(&state, &capability, reviewed));
        }
        if review_round == 3 {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "COMPILER_REJECTED",
                format!(
                    "independent critic still requested changes after three rounds: {}",
                    diagnostics.join("; ")
                ),
            ));
        }
        if let Some(operation_id) = room_operation_id {
            ArchitectureRoomLedger::open(&state.durability_dir)?.transition(
                operation_id,
                ArchitectureOperationStateV1::Repairing,
                &format!("The architect is addressing critic feedback for round {review_round}"),
                &state.service_pubkey,
            )?;
        }
        let mut languages = reviewed
            .ir
            .nodes
            .iter()
            .filter_map(|node| {
                node.implementation
                    .language
                    .clone()
                    .or_else(|| reviewed.ir.spec.language.clone())
            })
            .collect::<Vec<_>>();
        languages.sort();
        languages.dedup();
        let checkpoint_guidance = match room_operation_id {
            Some(operation_id) => ArchitectureRoomLedger::open(&state.durability_dir)?
                .checkpoint_guidance(operation_id)?,
            None => Vec::new(),
        };
        let mut repair_constraints = vec![
            "Preserve existing external interfaces unless the diagnostic requires a compatible correction".into(),
            "Return the complete strict Foundry IR v1 document".into(),
        ];
        repair_constraints.extend(
            checkpoint_guidance
                .into_iter()
                .map(|guidance| format!("Human checkpoint guidance: {guidance}")),
        );
        let repair_request = ArchitectureRequest {
            architecture_version: 1,
            product_spec: format!(
                "Repair the compiled architecture for `{product_spec}` using the independent critic diagnostics: {}",
                diagnostics.join("; ")
            ),
            repository: repository_coordinate.clone(),
            base_revision: base_commit.clone(),
            allowed_languages: languages,
            policy_constraints: repair_constraints,
            existing_ir: Some(reviewed.ir.clone()),
        };
        let repair_output = state.durability_dir.join("agent-candidates").join(format!(
            "initial-{operation_file_key}-repair-{review_round}.ir.json"
        ));
        let repair_runtime = Arc::clone(&state.architect_runtime);
        let repair_run_id = format!("{}-critic-repair-{review_round}", created.run_id);
        let repair_room_operation = room_operation_id.map(str::to_owned);
        let repair_room_durability = state.durability_dir.clone();
        let repair_identity = state.architect_runtime.identity().to_owned();
        let candidate = tokio::task::spawn_blocking(move || {
            let event_sink = |event: Value| {
                if let Some(operation_id) = &repair_room_operation {
                    project_agent_runtime_event(
                        &repair_room_durability,
                        operation_id,
                        ArchitectureRoomActorKindV1::Architect,
                        &repair_identity,
                        event,
                    );
                }
            };
            let agent = crate::architect::RuntimeArchitectureAgent {
                runtime: repair_runtime.as_ref(),
                run_id: &repair_run_id,
                event_sink: repair_room_operation
                    .as_ref()
                    .map(|_| &event_sink as &(dyn Fn(Value) + Send + Sync)),
            };
            crate::architect::architect(&agent, &repair_request, &repair_output)
        })
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?
        .map_err(|error| {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "COMPILER_REJECTED", error)
        })?;
        let repair_rationale = StudioRationaleV1 {
            entries: candidate
                .nodes
                .iter()
                .map(|node| {
                    (
                        node.id.clone(),
                        RationaleEntryV1 {
                            summary: format!(
                                "Critic-guided architecture repair round {}",
                                review_round + 1
                            ),
                            responsibilities: vec![format!("Provide {}", node.provides.name)],
                            constraints: diagnostics.clone(),
                        },
                    )
                })
                .collect(),
        };
        current = studio::apply_generated_candidate(
            &state.durability_dir,
            &created.run_id,
            &proposal_id,
            &reviewed.revision.semantic_digest,
            &format!("foundry-architect:{}", state.service_pubkey),
            candidate,
            repair_rationale,
            &format!("{operation}:repair:{review_round}"),
        )?;
        if let Some(operation_id) = room_operation_id {
            ArchitectureRoomLedger::open(&state.durability_dir)?.transition(
                operation_id,
                ArchitectureOperationStateV1::Compiling,
                "The repaired candidate satisfies the Foundry IR compiler",
                &state.service_pubkey,
            )?;
        }
    }
    Err(ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "SERVICE_NOT_READY",
        "critic loop ended without a terminal decision",
    ))
}

async fn submit_architecture_operation(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<ArchitectStudioRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let capability = authorize_architect_request(&state, &headers, &request).await?;
    let idempotency_key = operation_key(&headers)?.to_owned();
    let request_value = serde_json::to_value(&request).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let (operation, created) = ledger.create(
        &request.binding.repository_coordinate,
        &idempotency_key,
        &request_value,
        ArchitectureOperationKindV1::InitialArchitecture,
        &capability.actor_pubkey,
        capability.approval_threshold,
        capability.operations.iter().cloned().collect(),
        capability.human,
    )?;
    if created {
        spawn_architecture_operation(
            Arc::clone(&state),
            operation.operation_id.clone(),
            capability,
            request,
            idempotency_key,
        );
    }
    Ok((
        if created {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(serde_json::to_value(operation).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?),
    ))
}

fn spawn_architecture_operation(
    task_state: Arc<ServiceState>,
    operation_id: String,
    capability: Capability,
    request: ArchitectStudioRequest,
    idempotency_key: String,
) {
    let task_actor = capability.actor_pubkey.clone();
    tokio::spawn(async move {
        let ledger = match ArchitectureRoomLedger::open(&task_state.durability_dir) {
            Ok(ledger) => ledger,
            Err(_) => return,
        };
        let current = match ledger.get(&operation_id) {
            Ok(operation) => operation,
            Err(_) => return,
        };
        if current.state == ArchitectureOperationStateV1::Queued
            && ledger
                .transition(
                    &operation_id,
                    ArchitectureOperationStateV1::Architecting,
                    "The architect is producing a candidate ownership tree",
                    &task_state.service_pubkey,
                )
                .is_err()
        {
            return;
        }
        match run_architect_studio(
            Arc::clone(&task_state),
            capability,
            request,
            idempotency_key,
            Some(&operation_id),
        )
        .await
        {
            Ok(projection) => {
                let result = match serde_json::to_value(&projection) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = ledger.transition(
                            &operation_id,
                            ArchitectureOperationStateV1::Failed,
                            &error.to_string(),
                            &task_state.service_pubkey,
                        );
                        return;
                    }
                };
                let _ = ledger.complete(
                    &operation_id,
                    &projection.snapshot.state.run_id,
                    &projection.snapshot.proposal.proposal_id,
                    &projection.snapshot.revision.revision_id,
                    &projection.snapshot.revision.semantic_digest,
                    result,
                    &task_state.service_pubkey,
                );
            }
            Err(error) => {
                let can_pause_for_question = ledger
                    .get(&operation_id)
                    .map(|operation| operation.proposal_id.is_none())
                    .unwrap_or(false);
                if can_pause_for_question {
                    if let Some(encoded) = error.body.message.strip_prefix("ARCHITECT_QUESTION:") {
                        if let Ok(question) = serde_json::from_str::<Value>(encoded) {
                            if let (Some(question_id), Some(prompt)) = (
                                question.get("question_id").and_then(Value::as_str),
                                question.get("prompt").and_then(Value::as_str),
                            ) {
                                let _ = ledger.wait_for_input(
                                    &operation_id,
                                    question_id,
                                    prompt,
                                    task_state.architect_runtime.identity(),
                                );
                                return;
                            }
                        }
                    }
                }
                let _ = ledger.append_event(
                    &operation_id,
                    ArchitectureRoomActorKindV1::Human,
                    &task_actor,
                    ArchitectureRoomPayloadV1::Message {
                        message: "The original product specification remains available for retry."
                            .into(),
                    },
                );
                let _ = ledger.transition(
                    &operation_id,
                    ArchitectureOperationStateV1::Failed,
                    &error.body.message,
                    &task_state.service_pubkey,
                );
            }
        }
    });
}

fn spawn_generative_operation(
    task_state: Arc<ServiceState>,
    operation_id: String,
    capability: Capability,
    request: GenerativeOperationRequest,
    idempotency_key: String,
) {
    let task_actor = capability.actor_pubkey.clone();
    tokio::spawn(async move {
        let ledger = match ArchitectureRoomLedger::open(&task_state.durability_dir) {
            Ok(ledger) => ledger,
            Err(_) => return,
        };
        if ledger
            .transition(
                &operation_id,
                ArchitectureOperationStateV1::Architecting,
                "The architect is generating a proposal-scoped semantic revision",
                &task_state.service_pubkey,
            )
            .is_err()
        {
            return;
        }
        let command = request.command();
        match run_generate_revision(
            Arc::clone(&task_state),
            capability,
            request.run_id,
            request.proposal_id,
            command,
            idempotency_key,
            Some(&operation_id),
        )
        .await
        {
            Ok(projection) => {
                let result = match serde_json::to_value(&projection) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = ledger.transition(
                            &operation_id,
                            ArchitectureOperationStateV1::Failed,
                            &error.to_string(),
                            &task_state.service_pubkey,
                        );
                        return;
                    }
                };
                let _ = ledger.complete(
                    &operation_id,
                    &projection.snapshot.state.run_id,
                    &projection.snapshot.proposal.proposal_id,
                    &projection.snapshot.revision.revision_id,
                    &projection.snapshot.revision.semantic_digest,
                    result,
                    &task_state.service_pubkey,
                );
            }
            Err(error) => {
                let _ = ledger.append_event(
                    &operation_id,
                    ArchitectureRoomActorKindV1::Human,
                    &task_actor,
                    ArchitectureRoomPayloadV1::Message {
                        message:
                            "The accepted proposal head remains unchanged and available for retry."
                                .into(),
                    },
                );
                let _ = ledger.transition(
                    &operation_id,
                    ArchitectureOperationStateV1::Failed,
                    &error.body.message,
                    &task_state.service_pubkey,
                );
            }
        }
    });
}

async fn submit_generative_operation(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<GenerativeOperationRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let current = studio::snapshot(&state.durability_dir, &request.run_id, &request.proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "edit",
    )?;
    if request.instruction.trim().is_empty() || request.selected_nodes.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            "generative commands require selected nodes and an instruction",
        ));
    }
    if current.proposal.head_semantic_digest != request.expected_head_digest {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "generative command targets a stale proposal head",
        ));
    }
    let idempotency_key = operation_key(&headers)?.to_owned();
    let request_value = serde_json::to_value(&request).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let (created_operation, created) = ledger.create(
        &current.state.binding.repository_coordinate,
        &idempotency_key,
        &request_value,
        ArchitectureOperationKindV1::GenerativeEdit,
        &capability.actor_pubkey,
        capability.approval_threshold,
        capability.operations.iter().cloned().collect(),
        capability.human,
    )?;
    let operation = if created {
        match ledger.bind_proposal(
            &created_operation.operation_id,
            &request.run_id,
            &request.proposal_id,
            &current.revision.revision_id,
            &request.expected_head_digest,
        ) {
            Ok(operation) => operation,
            Err(error) => {
                let _ = ledger.transition(
                    &created_operation.operation_id,
                    ArchitectureOperationStateV1::Failed,
                    &error.to_string(),
                    &state.service_pubkey,
                );
                return Err(error.into());
            }
        }
    } else {
        created_operation
    };
    if created {
        spawn_generative_operation(
            Arc::clone(&state),
            operation.operation_id.clone(),
            capability,
            request,
            idempotency_key,
        );
    }
    Ok((
        if created {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(serde_json::to_value(operation).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?),
    ))
}

fn spawn_rebase_operation(
    task_state: Arc<ServiceState>,
    operation_id: String,
    capability: Capability,
    request: RebaseOperationRequest,
    idempotency_key: String,
) {
    tokio::spawn(async move {
        let ledger = match ArchitectureRoomLedger::open(&task_state.durability_dir) {
            Ok(ledger) => ledger,
            Err(_) => return,
        };
        if ledger
            .transition(
                &operation_id,
                ArchitectureOperationStateV1::Architecting,
                "The architect is rebasing the stale proposal onto the selected current proposal",
                &task_state.service_pubkey,
            )
            .is_err()
        {
            return;
        }
        let result = async {
            let target = studio::snapshot(
                &task_state.durability_dir,
                &request.run_id,
                &request.target_proposal_id,
            )?;
            let onto = studio::snapshot(
                &task_state.durability_dir,
                &request.run_id,
                &request.onto_proposal_id,
            )?;
            if target.revision.semantic_digest != request.expected_target_digest
                || onto.revision.semantic_digest != request.expected_onto_digest
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "REVISION_CONFLICT",
                    "a proposal head changed before rebase execution",
                ));
            }
            if target.proposal.status != ProposalStatusV1::Stale
                || onto.proposal.status != ProposalStatusV1::Approved
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "STALE_BASE",
                    "rebase requires a stale source proposal and the current approved proposal",
                ));
            }
            let rebased = studio::create_proposal(
                &task_state.durability_dir,
                &request.run_id,
                &request.onto_proposal_id,
                &request.expected_onto_digest,
                &capability.actor_pubkey,
                &format!("Rebase of {}", target.proposal.title),
                &format!("{idempotency_key}:branch"),
            )?;
            ledger.bind_proposal(
                &operation_id,
                &request.run_id,
                &rebased.proposal.proposal_id,
                &rebased.revision.revision_id,
                &rebased.revision.semantic_digest,
            )?;
            let target_ir = serde_json::to_string(&target.ir).map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "SERVICE_NOT_READY",
                    error.to_string(),
                )
            })?;
            if target_ir.len() > 256 * 1024 {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "INVALID_COMMAND",
                    "the stale proposal is too large for bounded rebase context",
                ));
            }
            let command = GenerativeRequest {
                expected_head_digest: rebased.revision.semantic_digest.clone(),
                kind: GenerativeCommandKind::RewriteSubtree,
                selected_nodes: vec![rebased.ir.root.clone()],
                instruction: format!(
                    "{}. Reapply the intent of this stale proposal while preserving the current external contracts and boundary locks. Stale proposal IR: {target_ir}",
                    request.instruction
                ),
            };
            run_generate_revision(
                Arc::clone(&task_state),
                capability,
                request.run_id,
                rebased.proposal.proposal_id,
                command,
                format!("{idempotency_key}:rebase"),
                Some(&operation_id),
            )
            .await
        }
        .await;
        match result {
            Ok(projection) => {
                if let Ok(result) = serde_json::to_value(&projection) {
                    let _ = ledger.complete(
                        &operation_id,
                        &projection.snapshot.state.run_id,
                        &projection.snapshot.proposal.proposal_id,
                        &projection.snapshot.revision.revision_id,
                        &projection.snapshot.revision.semantic_digest,
                        result,
                        &task_state.service_pubkey,
                    );
                }
            }
            Err(error) => {
                let _ = ledger.transition(
                    &operation_id,
                    ArchitectureOperationStateV1::Failed,
                    &error.body.message,
                    &task_state.service_pubkey,
                );
            }
        }
    });
}

async fn submit_rebase_operation(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<RebaseOperationRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if request.target_proposal_id == request.onto_proposal_id
        || request.instruction.trim().is_empty()
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            "rebase requires distinct proposals and a non-empty instruction",
        ));
    }
    let target = studio::snapshot(
        &state.durability_dir,
        &request.run_id,
        &request.target_proposal_id,
    )?;
    let onto = studio::snapshot(
        &state.durability_dir,
        &request.run_id,
        &request.onto_proposal_id,
    )?;
    let capability = capability(
        &state,
        &headers,
        &target.state.binding.repository_coordinate,
        "edit",
    )?;
    if target.revision.semantic_digest != request.expected_target_digest
        || onto.revision.semantic_digest != request.expected_onto_digest
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "a proposal head changed before rebase submission",
        ));
    }
    if target.proposal.status != ProposalStatusV1::Stale
        || onto.proposal.status != ProposalStatusV1::Approved
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_BASE",
            "rebase requires a stale source proposal and the current approved proposal",
        ));
    }
    let idempotency_key = operation_key(&headers)?.to_owned();
    let request_value = serde_json::to_value(&request).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let (created_operation, created) = ledger.create(
        &target.state.binding.repository_coordinate,
        &idempotency_key,
        &request_value,
        ArchitectureOperationKindV1::Rebase,
        &capability.actor_pubkey,
        capability.approval_threshold,
        capability.operations.iter().cloned().collect(),
        capability.human,
    )?;
    let operation = if created {
        let operation = match ledger.bind_proposal(
            &created_operation.operation_id,
            &request.run_id,
            &request.target_proposal_id,
            &target.revision.revision_id,
            &request.expected_target_digest,
        ) {
            Ok(operation) => operation,
            Err(error) => {
                let _ = ledger.transition(
                    &created_operation.operation_id,
                    ArchitectureOperationStateV1::Failed,
                    &error.to_string(),
                    &state.service_pubkey,
                );
                return Err(error.into());
            }
        };
        ledger.link_room_branch(&operation.operation_id, &request.target_proposal_id, None)?
    } else {
        created_operation
    };
    if created {
        spawn_rebase_operation(
            Arc::clone(&state),
            operation.operation_id.clone(),
            capability,
            request,
            idempotency_key,
        );
    }
    Ok((
        if created {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(serde_json::to_value(operation).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?),
    ))
}

async fn get_architecture_operation(
    State(state): State<Arc<ServiceState>>,
    Path(operation_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let operation = ArchitectureRoomLedger::open(&state.durability_dir)?.get(&operation_id)?;
    capability(&state, &headers, &operation.repository_coordinate, "read")?;
    Ok(Json(serde_json::to_value(operation).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?))
}

async fn list_architecture_operations(
    State(state): State<Arc<ServiceState>>,
    Query(query): Query<OperationListQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    capability(&state, &headers, &query.repository, "read")?;
    let operations = ArchitectureRoomLedger::open(&state.durability_dir)?
        .list_for_repository(&query.repository)?;
    Ok(Json(json!({
        "protocol_version": 1,
        "operations": operations,
    })))
}

fn persist_bound_room_transcript(
    state: &ServiceState,
    ledger: &ArchitectureRoomLedger,
    operation_id: &str,
) -> Result<(), ApiError> {
    let transcript = ledger.transcript(operation_id)?;
    if transcript.operation.studio_run_id.is_some() && transcript.operation.proposal_id.is_some() {
        studio::persist_room_transcript(&state.durability_dir, &transcript)?;
    }
    Ok(())
}

async fn list_architecture_room_events(
    State(state): State<Arc<ServiceState>>,
    Path(operation_id): Path<String>,
    Query(query): Query<RoomEventsQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let operation = ledger.get(&operation_id)?;
    capability(&state, &headers, &operation.repository_coordinate, "read")?;
    persist_bound_room_transcript(&state, &ledger, &operation_id)?;
    let events = ledger.events(&operation_id, query.after, query.limit)?;
    Ok(Json(json!({
        "protocol_version": 1,
        "operation_id": operation_id,
        "events": events,
    })))
}

async fn submit_architecture_guidance(
    State(state): State<Arc<ServiceState>>,
    Path(operation_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ArchitectureGuidanceRequest>,
) -> Result<Json<Value>, ApiError> {
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let operation = ledger.get(&operation_id)?;
    let capability = capability(&state, &headers, &operation.repository_coordinate, "edit")?;
    let _admitted = ledger.submit_guidance(
        &operation_id,
        &request.message_id,
        request.mode,
        GuidanceDeliveryV1::Queued,
        &request.content,
        &capability.actor_pubkey,
    )?;
    let can_steer = matches!(
        operation.state,
        ArchitectureOperationStateV1::Architecting | ArchitectureOperationStateV1::Repairing
    );
    let requested_immediate = request.mode == GuidanceModeV1::Immediate && can_steer;
    let runtime = Arc::clone(&state.architect_runtime);
    let job_id = operation.architect_job_id.clone();
    let message_id = request.message_id.clone();
    let content = request.content.clone();
    let delivery = if can_steer {
        tokio::task::spawn_blocking(move || {
            runtime.guide(&job_id, &message_id, &content, requested_immediate)
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(AgentGuidanceDeliveryV2::Checkpointed)
    } else {
        AgentGuidanceDeliveryV2::Checkpointed
    };
    let delivery = match delivery {
        AgentGuidanceDeliveryV2::Queued => GuidanceDeliveryV1::Queued,
        AgentGuidanceDeliveryV2::Delivered => GuidanceDeliveryV1::Delivered,
        AgentGuidanceDeliveryV2::Checkpointed => GuidanceDeliveryV1::Checkpointed,
        AgentGuidanceDeliveryV2::Rejected => GuidanceDeliveryV1::Rejected,
    };
    let event = ledger.append_external_event(
        &operation_id,
        &format!("guidance-delivery:{}:{delivery:?}", request.message_id),
        ArchitectureRoomActorKindV1::Human,
        &capability.actor_pubkey,
        ArchitectureRoomPayloadV1::HumanGuidance {
            message_id: request.message_id,
            mode: request.mode,
            delivery,
            content: request.content,
        },
    )?;
    persist_bound_room_transcript(&state, &ledger, &operation_id)?;
    Ok(Json(serde_json::to_value(event).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?))
}

async fn cancel_architecture_operation(
    State(state): State<Arc<ServiceState>>,
    Path(operation_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    operation_key(&headers)?;
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let operation = ledger.get(&operation_id)?;
    capability(&state, &headers, &operation.repository_coordinate, "edit")?;
    let cancelled = ledger.transition(
        &operation_id,
        ArchitectureOperationStateV1::Cancelled,
        "Architecture operation cancelled by a repository editor",
        &state.service_pubkey,
    )?;
    let runtime = if operation.state == ArchitectureOperationStateV1::CriticReview {
        Arc::clone(&state.critic_runtime)
    } else {
        Arc::clone(&state.architect_runtime)
    };
    let job_id = if operation.state == ArchitectureOperationStateV1::CriticReview {
        operation.critic_job_id
    } else {
        Some(operation.architect_job_id)
    };
    if let Some(job_id) = job_id {
        let _ = tokio::task::spawn_blocking(move || runtime.cancel(&job_id)).await;
    }
    persist_bound_room_transcript(&state, &ledger, &operation_id)?;
    Ok(Json(serde_json::to_value(cancelled).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?))
}

async fn answer_architecture_question(
    State(state): State<Arc<ServiceState>>,
    Path(operation_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ArchitectureQuestionAnswerRequest>,
) -> Result<Json<Value>, ApiError> {
    operation_key(&headers)?;
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let operation = ledger.get(&operation_id)?;
    let capability = capability(&state, &headers, &operation.repository_coordinate, "edit")?;
    ledger.submit_guidance(
        &operation_id,
        &request.message_id,
        GuidanceModeV1::Checkpoint,
        GuidanceDeliveryV1::Delivered,
        &request.content,
        &capability.actor_pubkey,
    )?;
    let recovered =
        ledger.answer_question(&operation_id, &request.question_id, &state.service_pubkey)?;
    let resume_key = format!(
        "{}:answer:{}",
        recovered.idempotency_key, request.message_id
    );
    match recovered.operation.kind {
        ArchitectureOperationKindV1::InitialArchitecture => {
            let mut architect_request: ArchitectStudioRequest =
                serde_json::from_value(recovered.request).map_err(|error| {
                    ApiError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "SERVICE_NOT_READY",
                        format!("persisted architecture request is invalid: {error}"),
                    )
                })?;
            architect_request.policy_constraints.push(format!(
                "Human answer to question {}: {}",
                request.question_id, request.content
            ));
            spawn_architecture_operation(
                Arc::clone(&state),
                operation_id.clone(),
                capability,
                architect_request,
                resume_key,
            );
        }
        ArchitectureOperationKindV1::GenerativeEdit => {
            let mut generative_request: GenerativeOperationRequest =
                serde_json::from_value(recovered.request).map_err(|error| {
                    ApiError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "SERVICE_NOT_READY",
                        format!("persisted generative request is invalid: {error}"),
                    )
                })?;
            generative_request.instruction.push_str(&format!(
                "\nHuman answer to question {}: {}",
                request.question_id, request.content
            ));
            spawn_generative_operation(
                Arc::clone(&state),
                operation_id.clone(),
                capability,
                generative_request,
                resume_key,
            );
        }
        ArchitectureOperationKindV1::CriticRepair | ArchitectureOperationKindV1::Rebase => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "INVALID_COMMAND",
                "this operation kind cannot resume from a question",
            ));
        }
    }
    persist_bound_room_transcript(&state, &ledger, &operation_id)?;
    Ok(Json(json!({"accepted": true})))
}

async fn stream_architecture_room_events(
    State(state): State<Arc<ServiceState>>,
    Path(operation_id): Path<String>,
    Query(query): Query<RoomEventsQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl futures::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
    let operation = ledger.get(&operation_id)?;
    capability(&state, &headers, &operation.repository_coordinate, "read")?;
    let stream = futures::stream::unfold(
        (state, operation_id, query.after, false),
        |(state, operation_id, cursor, finished)| async move {
            if finished {
                return None;
            }
            let ledger = match ArchitectureRoomLedger::open(&state.durability_dir) {
                Ok(ledger) => ledger,
                Err(error) => {
                    let event = SseEvent::default()
                        .event("foundry-architecture-room")
                        .json_data(
                            json!({"code": "SERVICE_NOT_READY", "message": error.to_string()}),
                        )
                        .unwrap_or_else(|_| SseEvent::default().event("foundry-architecture-room"));
                    return Some((Ok(event), (state, operation_id, cursor, true)));
                }
            };
            let events = ledger.events(&operation_id, cursor, 1).unwrap_or_default();
            if let Some(room_event) = events.into_iter().next() {
                if let Err(error) = persist_bound_room_transcript(&state, &ledger, &operation_id) {
                    let event = SseEvent::default()
                        .event("foundry-architecture-room")
                        .json_data(json!({
                            "code": error.body.code,
                            "message": error.body.message,
                        }))
                        .unwrap_or_else(|_| SseEvent::default().event("foundry-architecture-room"));
                    return Some((Ok(event), (state, operation_id, cursor, true)));
                }
                let next_cursor = room_event.sequence;
                let terminal = ledger
                    .get(&operation_id)
                    .map(|operation| operation.state.terminal())
                    .unwrap_or(true);
                let no_more = ledger
                    .events(&operation_id, next_cursor, 1)
                    .map(|events| events.is_empty())
                    .unwrap_or(true);
                let event = SseEvent::default()
                    .id(next_cursor.to_string())
                    .event("foundry-architecture-room")
                    .json_data(room_event)
                    .unwrap_or_else(|_| SseEvent::default().event("foundry-architecture-room"));
                return Some((
                    Ok(event),
                    (state, operation_id, next_cursor, terminal && no_more),
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            Some((
                Ok(SseEvent::default().comment("waiting")),
                (state, operation_id, cursor, false),
            ))
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn discover_studio(
    State(state): State<Arc<ServiceState>>,
    Query(query): Query<DiscoveryQuery>,
    headers: HeaderMap,
) -> Result<Json<StudioProjection>, ApiError> {
    let capability = capability(&state, &headers, &query.repository, "read")?;
    let studio_state = studio::discover(
        &state.durability_dir,
        &state.community_id,
        &query.repository,
    )?
    .into_iter()
    .max_by_key(|candidate| {
        candidate
            .proposals
            .iter()
            .map(|proposal| proposal.updated_at_ms)
            .max()
            .unwrap_or_default()
    })
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Studio was not found"))?;
    let proposal_id = query
        .proposal
        .or_else(|| {
            studio_state
                .proposals
                .iter()
                .find(|proposal| proposal.status == foundry_ir::ProposalStatusV1::Open)
                .or_else(|| studio_state.proposals.first())
                .map(|proposal| proposal.proposal_id.clone())
        })
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Studio has no proposal")
        })?;
    let snapshot = match query.revision.as_deref().filter(|value| !value.is_empty()) {
        Some(revision_id) => studio::snapshot_revision(
            &state.durability_dir,
            &studio_state.run_id,
            &proposal_id,
            revision_id,
        )?,
        None => studio::snapshot(&state.durability_dir, &studio_state.run_id, &proposal_id)?,
    };
    Ok(Json(projection(&state, &capability, snapshot)))
}

async fn get_snapshot(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<StudioProjection>, ApiError> {
    let snapshot = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &snapshot.state.binding.repository_coordinate,
        "read",
    )?;
    Ok(Json(projection(&state, &capability, snapshot)))
}

async fn apply_command(
    State(state): State<Arc<ServiceState>>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ApplyCommandRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &request.proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "edit",
    )?;
    let mut operations = request.operations;
    for operation in &mut operations {
        match operation {
            StudioOperationV1::AddBoundaryLock { lock } if capability.human => {
                lock.locked_by_pubkey.clone_from(&capability.actor_pubkey);
            }
            StudioOperationV1::AddBoundaryLock { .. }
            | StudioOperationV1::RemoveBoundaryLock { .. }
                if !capability.human =>
            {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "FORBIDDEN",
                    "agent authority cannot add or remove human boundary locks",
                ));
            }
            _ => {}
        }
    }
    let command = StudioCommandV1 {
        command_version: request.command_version,
        command_id: request.command_id,
        proposal_id: request.proposal_id.clone(),
        expected_head_digest: request.expected_head_digest,
        actor_pubkey: capability.actor_pubkey.clone(),
        operations,
    };
    let next = studio::apply_command(
        &state.durability_dir,
        &run_id,
        &command,
        operation_key(&headers)?,
    )
    .map_err(|error| enrich_revision_conflict(error, &current))?;
    Ok(Json(projection(&state, &capability, next)))
}

async fn create_proposal(
    State(state): State<Arc<ServiceState>>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CreateProposalRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &request.source_proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "edit",
    )?;
    let next = studio::create_proposal(
        &state.durability_dir,
        &run_id,
        &request.source_proposal_id,
        &request.expected_head_digest,
        &capability.actor_pubkey,
        &request.title,
        operation_key(&headers)?,
    )?;
    Ok(Json(projection(&state, &capability, next)))
}

async fn reject_proposal(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "edit",
    )?;
    let next = studio::reject_proposal(
        &state.durability_dir,
        &run_id,
        &proposal_id,
        &capability.actor_pubkey,
        operation_key(&headers)?,
    )?;
    Ok(Json(projection(&state, &capability, next)))
}

async fn record_critic(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<CriticRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "review",
    )?;
    let next = studio::record_critic_review(
        &state.durability_dir,
        &run_id,
        &proposal_id,
        &request.expected_head_digest,
        &capability.actor_pubkey,
        request.verdict,
        request.diagnostics,
        operation_key(&headers)?,
    )?;
    Ok(Json(projection(&state, &capability, next)))
}

async fn generate_revision(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<GenerativeRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "edit",
    )?;
    let operation = operation_key(&headers)?.to_owned();
    run_generate_revision(
        state,
        capability,
        run_id,
        proposal_id,
        request,
        operation,
        None,
    )
    .await
    .map(Json)
}

#[allow(clippy::too_many_arguments)]
async fn run_generate_revision(
    state: Arc<ServiceState>,
    capability: Capability,
    run_id: String,
    proposal_id: String,
    request: GenerativeRequest,
    operation: String,
    room_operation_id: Option<&str>,
) -> Result<StudioProjection, ApiError> {
    if request.instruction.trim().is_empty() || request.selected_nodes.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            "generative commands require selected nodes and an instruction",
        ));
    }
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    if current.proposal.head_semantic_digest != request.expected_head_digest {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "generative command targets a stale proposal head",
        ));
    }
    if request.selected_nodes.iter().any(|node| {
        !current
            .ir
            .nodes
            .iter()
            .any(|candidate| candidate.id == *node)
    }) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            "generative command selected an unknown node",
        ));
    }
    let operation_file_key = format!("{:x}", sha2::Sha256::digest(operation.as_bytes()));
    let output = state
        .durability_dir
        .join("agent-candidates")
        .join(format!("{operation_file_key}.json"));
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    }
    let mut languages = current
        .ir
        .nodes
        .iter()
        .filter_map(|node| {
            node.implementation
                .language
                .clone()
                .or_else(|| current.ir.spec.language.clone())
        })
        .collect::<Vec<_>>();
    languages.sort();
    languages.dedup();
    let architecture_request = ArchitectureRequest {
        architecture_version: 1,
        product_spec: format!(
            "Architecture Studio {:?} on [{}]: {}",
            request.kind,
            request.selected_nodes.join(", "),
            request.instruction
        ),
        repository: current.state.binding.repository_coordinate.clone(),
        base_revision: current.state.binding.base_commit.clone(),
        allowed_languages: languages,
        policy_constraints: vec![
            "Preserve every Architecture Studio boundary lock".into(),
            "Return the complete strict Foundry IR v1 document".into(),
        ],
        existing_ir: Some(current.ir.clone()),
    };
    let architect_runtime = Arc::clone(&state.architect_runtime);
    let architect_run_id = format!("{run_id}:generative:{operation}");
    let output_for_agent = output.clone();
    let room_operation = room_operation_id.map(str::to_owned);
    let room_durability = state.durability_dir.clone();
    let architect_identity = state.architect_runtime.identity().to_owned();
    let candidate = tokio::task::spawn_blocking(move || {
        let event_sink = |event: Value| {
            if let Some(operation_id) = &room_operation {
                project_agent_runtime_event(
                    &room_durability,
                    operation_id,
                    ArchitectureRoomActorKindV1::Architect,
                    &architect_identity,
                    event,
                );
            }
        };
        let agent = crate::architect::RuntimeArchitectureAgent {
            runtime: architect_runtime.as_ref(),
            run_id: &architect_run_id,
            event_sink: room_operation
                .as_ref()
                .map(|_| &event_sink as &(dyn Fn(Value) + Send + Sync)),
        };
        crate::architect::architect(&agent, &architecture_request, &output_for_agent)
    })
    .await
    .map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?
    .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "COMPILER_REJECTED", error))?;
    if let Some(operation_id) = room_operation_id {
        ArchitectureRoomLedger::open(&state.durability_dir)?.transition(
            operation_id,
            ArchitectureOperationStateV1::Compiling,
            "The generated proposal satisfies the Foundry IR compiler",
            &state.service_pubkey,
        )?;
    }
    let mut rationale = current.rationale.clone();
    for node in &request.selected_nodes {
        rationale.entries.insert(
            node.clone(),
            RationaleEntryV1 {
                summary: request.instruction.clone(),
                responsibilities: vec![format!("Generated by Studio {:?}", request.kind)],
                constraints: vec!["Compiler-valid and boundary-lock preserving".into()],
            },
        );
    }
    let next = studio::apply_generated_candidate(
        &state.durability_dir,
        &run_id,
        &proposal_id,
        &request.expected_head_digest,
        &format!("foundry-architect:{}", state.service_pubkey),
        candidate,
        rationale,
        &operation,
    )?;

    let mut candidate_snapshot = next;
    for review_round in 1..=3 {
        if let Some(operation_id) = room_operation_id {
            let ledger = ArchitectureRoomLedger::open(&state.durability_dir)?;
            ledger.set_repair_round(operation_id, review_round - 1)?;
            ledger.transition(
                operation_id,
                ArchitectureOperationStateV1::CriticReview,
                &format!("The independent critic is reviewing round {review_round}"),
                &state.service_pubkey,
            )?;
        }
        let (verdict, diagnostics) =
            execute_room_critic(&state, &run_id, &candidate_snapshot, room_operation_id).await?;
        if let Some(operation_id) = room_operation_id {
            ArchitectureRoomLedger::open(&state.durability_dir)?.append_event(
                operation_id,
                ArchitectureRoomActorKindV1::Critic,
                state.critic_runtime.identity(),
                ArchitectureRoomPayloadV1::CriticVerdict {
                    verdict: match verdict {
                        CriticVerdictV1::Approved => "approved",
                        CriticVerdictV1::ChangesRequested => "changes_requested",
                    }
                    .into(),
                    diagnostics: diagnostics.clone(),
                },
            )?;
        }
        let approved = verdict == CriticVerdictV1::Approved;
        let reviewed = studio::record_critic_review(
            &state.durability_dir,
            &run_id,
            &proposal_id,
            &candidate_snapshot.revision.semantic_digest,
            &format!("foundry-critic:{}", state.service_pubkey),
            verdict,
            diagnostics.clone(),
            &format!("{operation}:critic:{review_round}"),
        )?;
        if approved {
            return Ok(projection(&state, &capability, reviewed));
        }
        if review_round == 3 {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "COMPILER_REJECTED",
                format!(
                    "independent critic still requested changes after three rounds: {}",
                    diagnostics.join("; ")
                ),
            ));
        }
        if let Some(operation_id) = room_operation_id {
            ArchitectureRoomLedger::open(&state.durability_dir)?.transition(
                operation_id,
                ArchitectureOperationStateV1::Repairing,
                &format!("The architect is addressing critic feedback for round {review_round}"),
                &state.service_pubkey,
            )?;
        }
        let mut languages = reviewed
            .ir
            .nodes
            .iter()
            .filter_map(|node| {
                node.implementation
                    .language
                    .clone()
                    .or_else(|| reviewed.ir.spec.language.clone())
            })
            .collect::<Vec<_>>();
        languages.sort();
        languages.dedup();
        let checkpoint_guidance = match room_operation_id {
            Some(operation_id) => ArchitectureRoomLedger::open(&state.durability_dir)?
                .checkpoint_guidance(operation_id)?,
            None => Vec::new(),
        };
        let mut policy_constraints = vec![
            "Preserve every Architecture Studio boundary lock".into(),
            "Keep changes inside the selected proposal subtree and return complete strict IR v1"
                .into(),
        ];
        policy_constraints.extend(
            checkpoint_guidance
                .into_iter()
                .map(|guidance| format!("Human checkpoint guidance: {guidance}")),
        );
        let repair_request = ArchitectureRequest {
            architecture_version: 1,
            product_spec: format!(
                "Repair the {:?} proposal after critic diagnostics: {}",
                request.kind,
                diagnostics.join("; ")
            ),
            repository: reviewed.state.binding.repository_coordinate.clone(),
            base_revision: reviewed.state.binding.base_commit.clone(),
            allowed_languages: languages,
            policy_constraints,
            existing_ir: Some(reviewed.ir.clone()),
        };
        let repair_output = state
            .durability_dir
            .join("agent-candidates")
            .join(format!("{operation_file_key}-repair-{review_round}.json"));
        let repair_runtime = Arc::clone(&state.architect_runtime);
        let repair_run_id = format!("{run_id}:generative-repair:{review_round}");
        let repair_room_operation = room_operation_id.map(str::to_owned);
        let repair_room_durability = state.durability_dir.clone();
        let repair_identity = state.architect_runtime.identity().to_owned();
        let repaired_candidate = tokio::task::spawn_blocking(move || {
            let event_sink = |event: Value| {
                if let Some(operation_id) = &repair_room_operation {
                    project_agent_runtime_event(
                        &repair_room_durability,
                        operation_id,
                        ArchitectureRoomActorKindV1::Architect,
                        &repair_identity,
                        event,
                    );
                }
            };
            let agent = crate::architect::RuntimeArchitectureAgent {
                runtime: repair_runtime.as_ref(),
                run_id: &repair_run_id,
                event_sink: repair_room_operation
                    .as_ref()
                    .map(|_| &event_sink as &(dyn Fn(Value) + Send + Sync)),
            };
            crate::architect::architect(&agent, &repair_request, &repair_output)
        })
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?
        .map_err(|error| {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "COMPILER_REJECTED", error)
        })?;
        if let Some(operation_id) = room_operation_id {
            ArchitectureRoomLedger::open(&state.durability_dir)?.transition(
                operation_id,
                ArchitectureOperationStateV1::Compiling,
                "The repaired generative candidate satisfies the Foundry compiler",
                &state.service_pubkey,
            )?;
        }
        candidate_snapshot = studio::apply_generated_candidate(
            &state.durability_dir,
            &run_id,
            &proposal_id,
            &reviewed.revision.semantic_digest,
            &format!("foundry-architect:{}", state.service_pubkey),
            repaired_candidate,
            reviewed.rationale.clone(),
            &format!("{operation}:repair:{review_round}"),
        )?;
    }
    Err(ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "SERVICE_NOT_READY",
        "generative critic loop ended without a terminal decision",
    ))
}

fn approval_tags(event_json: &str) -> Result<(String, HashMap<String, String>), ApiError> {
    let event = Event::from_json(event_json).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    event
        .verify()
        .map_err(|error| ApiError::new(StatusCode::BAD_REQUEST, "FORBIDDEN", error.to_string()))?;
    let value: Value = serde_json::from_str(event_json).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    if value.get("kind").and_then(Value::as_u64) != Some(46_011) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            "approval must be kind 46011",
        ));
    }
    let tags = value
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tag| {
            let values = tag.as_array()?;
            Some((
                values.first()?.as_str()?.to_owned(),
                values.get(1)?.as_str()?.to_owned(),
            ))
        })
        .collect();
    let signer = value
        .get("pubkey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok((signer, tags))
}

async fn ingest_approval(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<ApprovalRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    let requester = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "approve",
    )?;
    if !requester.human {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "agent-derived authority cannot satisfy the human approval gate",
        ));
    }
    let (signer, tags) = approval_tags(&request.event_json)?;
    let signed_policy = signed_repository_policy(
        &state,
        &current.state.binding.repository_coordinate,
        &current.state.binding.target_branch,
    )
    .await?;
    let eligible_human = state.policy.approvers.contains(&signer)
        || signer == signed_policy.owner
        || signed_policy.editors.contains(&signer);
    let approval_threshold = signed_policy
        .approval_threshold
        .max(state.policy.approval_threshold);
    if signer != requester.actor_pubkey
        || !eligible_human
        || tags.get("repository") != Some(&current.state.binding.repository_coordinate)
        || tags.get("revision") != Some(&request.expected_head_digest)
        || tags.get("proposal") != Some(&proposal_id)
        || tags.get("foundry-run") != Some(&run_id)
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "approval event scope or signer is invalid",
        ));
    }
    let event: Value = serde_json::from_str(&request.event_json).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_COMMAND",
            error.to_string(),
        )
    })?;
    let event_id = event.get("id").and_then(Value::as_str).unwrap_or_default();
    verify_approval_on_relay(&state, event_id, &signer).await?;
    let next = studio::ingest_verified_human_approval(
        &state.durability_dir,
        &run_id,
        &proposal_id,
        &request.expected_head_digest,
        event_id,
        &signer,
        operation_key(&headers)?,
    )?;
    let approvals = next
        .state
        .human_approvals
        .iter()
        .filter(|approval| approval.semantic_digest == request.expected_head_digest)
        .map(|approval| approval.signer_pubkey.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let mut requester = requester;
    requester.approval_threshold = approval_threshold;
    let next = if approvals >= approval_threshold {
        studio::promote_proposal(
            &state.durability_dir,
            &run_id,
            &proposal_id,
            &request.expected_head_digest,
            approval_threshold,
            &format!("{}:promote", operation_key(&headers)?),
        )?
    } else {
        next
    };
    Ok(Json(projection(&state, &requester, next)))
}

async fn promote(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<PromotionRequest>,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    let mut capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "approve",
    )?;
    let signed_policy = signed_repository_policy(
        &state,
        &current.state.binding.repository_coordinate,
        &current.state.binding.target_branch,
    )
    .await?;
    capability.approval_threshold = signed_policy
        .approval_threshold
        .max(state.policy.approval_threshold);
    let next = studio::promote_proposal(
        &state.durability_dir,
        &run_id,
        &proposal_id,
        &request.expected_head_digest,
        capability.approval_threshold,
        operation_key(&headers)?,
    )?;
    Ok(Json(projection(&state, &capability, next)))
}

async fn update_layout(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(layout): Json<ArchitectureLayoutV1>,
) -> Result<Json<StudioProjection>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    let capability = capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "edit",
    )?;
    let next = studio::update_layout(
        &state.durability_dir,
        &run_id,
        &proposal_id,
        &current.proposal.head_semantic_digest,
        &layout,
        operation_key(&headers)?,
    )?;
    Ok(Json(projection(&state, &capability, next)))
}

async fn build(
    State(state): State<Arc<ServiceState>>,
    Path((run_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<BuildRequest>,
) -> Result<Json<Value>, ApiError> {
    let current = studio::snapshot(&state.durability_dir, &run_id, &proposal_id)?;
    capability(
        &state,
        &headers,
        &current.state.binding.repository_coordinate,
        "build",
    )?;
    let repository = state
        .repository_paths
        .get(&current.state.binding.repository_coordinate)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                "repository is not mounted in this community service",
            )
        })?;
    let actual_base =
        crate::repository::git_revision(repository, &current.state.binding.target_branch)
            .map_err(|error| ApiError::new(StatusCode::CONFLICT, "STALE_BASE", error))?;
    if request.current_base_commit != actual_base {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_BASE",
            format!(
                "Buzz observed `{}`, repository is `{actual_base}`",
                request.current_base_commit
            ),
        ));
    }
    let handoff = studio::create_build_handoff(
        &state.durability_dir,
        &run_id,
        &proposal_id,
        &request.expected_head_digest,
        &actual_base,
        operation_key(&headers)?,
    )?;
    let input_dir = state
        .durability_dir
        .join("build-inputs")
        .join(&handoff.build_run_id);
    std::fs::create_dir_all(&input_dir).map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    let ir_path = write_pretty_json(&input_dir, "ir.json", &current.ir)?;
    let rationale_path = write_pretty_json(&input_dir, "rationale.json", &current.rationale)?;
    let layout_path = write_pretty_json(&input_dir, "layout.json", &current.layout)?;
    let locks_path = write_pretty_json(&input_dir, "locks.json", &current.locks)?;
    let evidence = serde_json::to_string_pretty(&json!({
        "studio_run_id": current.state.run_id,
        "approved_revision": current.revision,
        "proposal_history": current.state.proposals,
        "critic_reviews": current.state.critic_reviews,
        "human_approval_event_ids": current
            .state
            .human_approvals
            .iter()
            .map(|approval| approval.event_id.as_str())
            .collect::<Vec<_>>(),
        "structural_diff": current.structural_diff,
        "base_commit": &actual_base,
    }))
    .map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    write_text(
        &input_dir,
        "review-summary.md",
        &format!("## Architecture Studio evidence\n\n```json\n{evidence}\n```\n\n"),
    )?;
    let build_durability = state
        .durability_dir
        .join("build-runs")
        .join(&handoff.build_run_id);
    let workspace = state.durability_dir.join("workspaces");
    let executable = std::env::current_exe().map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?;
    std::process::Command::new(executable)
        .arg("build")
        .args(["--ir", &ir_path.to_string_lossy()])
        .args(["--repo", &repository.to_string_lossy()])
        .args(["--base", &actual_base])
        .args(["--durability", "local"])
        .args(["--durability-dir", &build_durability.to_string_lossy()])
        .args(["--workspace", &workspace.to_string_lossy()])
        .args(["--pi-pool", &state.worker_url])
        .args(["--durable-run-id", &handoff.build_run_id])
        .args(["--studio-rationale", &rationale_path.to_string_lossy()])
        .args(["--studio-layout", &layout_path.to_string_lossy()])
        .args(["--studio-locks", &locks_path.to_string_lossy()])
        .env_remove("FOUNDRY_STUDIO_SERVICE_NSEC")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_NOT_READY",
                error.to_string(),
            )
        })?;
    tokio::spawn(monitor_build(state.clone(), handoff.clone()));
    Ok(Json(serde_json::to_value(handoff).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SERVICE_NOT_READY",
            error.to_string(),
        )
    })?))
}

fn build_status_value(state: &ServiceState, build_run_id: &str) -> Result<Value, ApiError> {
    let (_, handoff) = studio::find_build_handoff(&state.durability_dir, build_run_id)?;
    let directory = state.durability_dir.join("build-runs").join(build_run_id);
    let status = crate::durable::run_status(&directory, build_run_id)
        .map(|status| format!("{status:?}").to_ascii_lowercase())
        .unwrap_or_else(|_| "queued".into());
    Ok(json!({
        "protocol_version": 1,
        "build_run_id": build_run_id,
        "status": status,
        "proposal_id": handoff.proposal_id,
        "revision_id": handoff.revision_id,
        "semantic_digest": handoff.semantic_digest,
        "base_commit": handoff.base_commit,
    }))
}

async fn get_build_status(
    State(state): State<Arc<ServiceState>>,
    Path(build_run_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (studio_state, _) = studio::find_build_handoff(&state.durability_dir, &build_run_id)?;
    capability(
        &state,
        &headers,
        &studio_state.binding.repository_coordinate,
        "read",
    )?;
    Ok(Json(build_status_value(&state, &build_run_id)?))
}

async fn cancel_build(
    State(state): State<Arc<ServiceState>>,
    Path(build_run_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    operation_key(&headers)?;
    let (studio_state, _) = studio::find_build_handoff(&state.durability_dir, &build_run_id)?;
    capability(
        &state,
        &headers,
        &studio_state.binding.repository_coordinate,
        "build",
    )?;
    crate::durable::request_cancel(
        &state.durability_dir.join("build-runs").join(&build_run_id),
        &build_run_id,
    )
    .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_NOT_READY", error))?;
    Ok(Json(json!({
        "protocol_version": 1,
        "build_run_id": build_run_id,
        "cancellation_requested": true,
    })))
}

async fn list_build_artifacts(
    State(state): State<Arc<ServiceState>>,
    Path(build_run_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (studio_state, _) = studio::find_build_handoff(&state.durability_dir, &build_run_id)?;
    capability(
        &state,
        &headers,
        &studio_state.binding.repository_coordinate,
        "read",
    )?;
    let artifacts = crate::durable::run_artifacts(
        &state.durability_dir.join("build-runs").join(&build_run_id),
        &build_run_id,
    )
    .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_NOT_READY", error))?;
    Ok(Json(json!({
        "protocol_version": 1,
        "build_run_id": build_run_id,
        "artifacts": artifacts,
    })))
}

async fn download_build_artifact(
    State(state): State<Arc<ServiceState>>,
    Path((build_run_id, artifact_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (studio_state, _) = studio::find_build_handoff(&state.durability_dir, &build_run_id)?;
    capability(
        &state,
        &headers,
        &studio_state.binding.repository_coordinate,
        "read",
    )?;
    let (metadata, bytes) = crate::durable::read_run_artifact(
        &state.durability_dir.join("build-runs").join(&build_run_id),
        &build_run_id,
        &artifact_id,
    )
    .map_err(|error| ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", error))?;
    let mut response = bytes.into_response();
    let content_type = metadata.media_type.parse().map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_NOT_READY",
            format!("invalid artifact media type: {error}"),
        )
    })?;
    response.headers_mut().insert("content-type", content_type);
    Ok(response)
}

async fn stream_build(
    State(state): State<Arc<ServiceState>>,
    Path(build_run_id): Path<String>,
    headers: HeaderMap,
) -> Result<Sse<impl futures::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let (studio_state, _) = studio::find_build_handoff(&state.durability_dir, &build_run_id)?;
    capability(
        &state,
        &headers,
        &studio_state.binding.repository_coordinate,
        "read",
    )?;
    let stream = futures::stream::unfold(
        (state, build_run_id, false),
        |(state, build_run_id, finished)| async move {
            if finished {
                return None;
            }
            let value = build_status_value(&state, &build_run_id).unwrap_or_else(
                |error| json!({ "code": error.body.code, "message": error.body.message }),
            );
            let status = value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let finished = matches!(
                status,
                "succeeded" | "failed" | "cancelled" | "indeterminate"
            );
            let event = SseEvent::default()
                .event("foundry-build")
                .json_data(value)
                .unwrap_or_else(|_| SseEvent::default().event("foundry-build"));
            if !finished {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Some((Ok(event), (state, build_run_id, finished)))
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn required_arg(args: &[String], flag: &str) -> Result<String, String> {
    args.iter()
        .position(|argument| argument == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
        .ok_or_else(|| format!("missing required {flag}"))
}

fn optional_arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|argument| argument == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn pi_pool_identity(url: &str, token: &str) -> String {
    format!("pi-pool:{url}:{:x}", sha2::Sha256::digest(token))
}

fn buzz_runtime(role: &str, args: &[String]) -> Result<Arc<dyn AgentRuntime>, String> {
    let gateway = required_arg(args, "--buzz-acp-gateway")?;
    let upper_role = role.to_ascii_uppercase();
    let capability = std::env::var(format!("FOUNDRY_BUZZ_{upper_role}_CAPABILITY"))
        .map_err(|_| format!("FOUNDRY_BUZZ_{upper_role}_CAPABILITY is required"))?;
    let agent_id = std::env::var(format!("FOUNDRY_BUZZ_{upper_role}_AGENT_ID"))
        .map_err(|_| format!("FOUNDRY_BUZZ_{upper_role}_AGENT_ID is required"))?;
    Ok(Arc::new(BuzzAcpAgentRuntime::new(
        gateway, capability, agent_id,
    )?))
}

pub fn serve(args: &[String]) -> Result<(), String> {
    let listen = required_arg(args, "--listen")?
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid --listen: {error}"))?;
    let public_url = required_arg(args, "--public-url")?
        .trim_end_matches('/')
        .to_owned();
    let durability_dir = PathBuf::from(required_arg(args, "--durability-dir")?);
    let community_id = required_arg(args, "--community-id")?;
    let service_secret = std::env::var("FOUNDRY_STUDIO_SERVICE_NSEC")
        .map_err(|_| "FOUNDRY_STUDIO_SERVICE_NSEC is required".to_string())?;
    let service_keys = Keys::parse(&service_secret)
        .map_err(|error| format!("invalid FOUNDRY_STUDIO_SERVICE_NSEC: {error}"))?;
    let service_pubkey = service_keys.public_key().to_hex();
    if std::env::var("FOUNDRY_STUDIO_SERVICE_PUBKEY")
        .ok()
        .is_some_and(|expected| expected != service_pubkey)
    {
        return Err("FOUNDRY_STUDIO_SERVICE_PUBKEY does not match the service key".into());
    }
    let relay_api_url = required_arg(args, "--relay-api-url")?;
    let repositories_file = required_arg(args, "--repositories")?;
    let repository_paths: HashMap<String, PathBuf> = serde_json::from_slice(
        &std::fs::read(&repositories_file)
            .map_err(|error| format!("read --repositories: {error}"))?,
    )
    .map_err(|error| format!("parse --repositories: {error}"))?;
    let worker_url = required_arg(args, "--pi-pool")?;
    let worker_token = std::env::var("FOUNDRY_WORKER_TOKEN")
        .map_err(|_| "FOUNDRY_WORKER_TOKEN is required".to_string())?;
    let architect_runtime: Arc<dyn AgentRuntime> =
        match optional_arg(args, "--architect-runtime").as_deref() {
            None | Some("pi-pool") => Arc::new(PiPoolAgentRuntime::new(
                worker_url.clone(),
                worker_token.clone(),
                pi_pool_identity(&worker_url, &worker_token),
            )),
            Some("buzz-acp") => buzz_runtime("architect", args)?,
            Some(other) => return Err(format!("unsupported --architect-runtime {other}")),
        };
    let critic_runtime: Arc<dyn AgentRuntime> =
        match optional_arg(args, "--critic-runtime").as_deref() {
            None | Some("pi-pool") => {
                let critic_url = required_arg(args, "--critic-pool")?;
                let critic_token = std::env::var("FOUNDRY_CRITIC_TOKEN")
                    .map_err(|_| "FOUNDRY_CRITIC_TOKEN is required".to_string())?;
                Arc::new(PiPoolAgentRuntime::new(
                    critic_url.clone(),
                    critic_token.clone(),
                    pi_pool_identity(&critic_url, &critic_token),
                ))
            }
            Some("buzz-acp") => buzz_runtime("critic", args)?,
            Some(other) => return Err(format!("unsupported --critic-runtime {other}")),
        };
    if architect_runtime.identity() == critic_runtime.identity() {
        return Err("architect and critic must use independent configured identities".into());
    }
    let policy = Policy {
        readers: csv_set("FOUNDRY_STUDIO_READERS"),
        editors: csv_set("FOUNDRY_STUDIO_EDITORS"),
        critics: csv_set("FOUNDRY_STUDIO_CRITICS"),
        approvers: csv_set("FOUNDRY_STUDIO_APPROVERS"),
        builders: csv_set("FOUNDRY_STUDIO_BUILDERS"),
        agents: csv_set("FOUNDRY_STUDIO_AGENTS"),
        approval_threshold: std::env::var("FOUNDRY_STUDIO_APPROVAL_THRESHOLD")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1)
            .max(1),
    };
    let state = Arc::new(ServiceState {
        durability_dir,
        public_url,
        community_id,
        service_pubkey,
        service_keys,
        relay_api_url,
        http_client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|error| error.to_string())?,
        repository_paths: Arc::new(repository_paths),
        worker_url,
        worker_token,
        architect_runtime,
        critic_runtime,
        policy: Arc::new(policy),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        nip98_replays: Arc::new(Mutex::new(HashMap::new())),
    });
    let handoffs_to_recover = state
        .repository_paths
        .keys()
        .filter_map(|repository| {
            studio::discover(&state.durability_dir, &state.community_id, repository).ok()
        })
        .flatten()
        .flat_map(|studio_state| studio_state.build_handoffs)
        .collect::<Vec<_>>();
    let max_body_bytes = std::env::var("FOUNDRY_STUDIO_MAX_BODY_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(2 * 1024 * 1024);
    let recoverable_operations = ArchitectureRoomLedger::open(&state.durability_dir)
        .and_then(|ledger| ledger.recoverable())
        .map_err(|error| error.to_string())?;
    let router = Router::new()
        .route("/v1/studio/readiness", get(readiness))
        .route("/v1/studio/session", post(exchange_session))
        .route("/v1/studios", post(create_studio))
        .route("/v1/studios/architect", post(architect_studio))
        .route(
            "/v1/studio-operations/architect",
            post(submit_architecture_operation),
        )
        .route(
            "/v1/studio-operations/generate",
            post(submit_generative_operation),
        )
        .route(
            "/v1/studio-operations/rebase",
            post(submit_rebase_operation),
        )
        .route("/v1/studio-operations", get(list_architecture_operations))
        .route(
            "/v1/studio-operations/{operation_id}",
            get(get_architecture_operation),
        )
        .route(
            "/v1/studio-operations/{operation_id}/room",
            get(list_architecture_room_events),
        )
        .route(
            "/v1/studio-operations/{operation_id}/messages",
            post(submit_architecture_guidance),
        )
        .route(
            "/v1/studio-operations/{operation_id}/answers",
            post(answer_architecture_question),
        )
        .route(
            "/v1/studio-operations/{operation_id}/cancel",
            post(cancel_architecture_operation),
        )
        .route(
            "/v1/studio-operations/{operation_id}/events",
            get(stream_architecture_room_events),
        )
        .route("/v1/studios/discover", get(discover_studio))
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}",
            get(get_snapshot),
        )
        .route("/v1/studios/{run_id}/commands", post(apply_command))
        .route("/v1/studios/{run_id}/proposals", post(create_proposal))
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}/reject",
            post(reject_proposal),
        )
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}/critic",
            post(record_critic),
        )
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}/generate",
            post(generate_revision),
        )
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}/approvals",
            post(ingest_approval),
        )
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}/promote",
            post(promote),
        )
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}/layout",
            post(update_layout),
        )
        .route(
            "/v1/studios/{run_id}/proposals/{proposal_id}/build",
            post(build),
        )
        .route("/v1/studio-builds/{build_run_id}", get(get_build_status))
        .route(
            "/v1/studio-builds/{build_run_id}/cancel",
            post(cancel_build),
        )
        .route(
            "/v1/studio-builds/{build_run_id}/artifacts",
            get(list_build_artifacts),
        )
        .route(
            "/v1/studio-builds/{build_run_id}/artifacts/{artifact_id}",
            get(download_build_artifact),
        )
        .route("/v1/studio-builds/{build_run_id}/events", get(stream_build))
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .with_state(state.clone());
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        for recovered in recoverable_operations {
            let capability = Capability {
                community_id: state.community_id.clone(),
                repository_coordinate: recovered.operation.repository_coordinate.clone(),
                actor_pubkey: recovered.operation.actor_id.clone(),
                operations: recovered
                    .operation
                    .permitted_operations
                    .iter()
                    .cloned()
                    .collect(),
                expires_at: u64::MAX,
                human: recovered.operation.human_actor,
                approval_threshold: recovered.operation.approval_threshold,
            };
            let operation_id = recovered.operation.operation_id.clone();
            let invalid_request = |message: String| {
                let _ = ArchitectureRoomLedger::open(&state.durability_dir).and_then(|ledger| {
                    ledger.transition(
                        &operation_id,
                        ArchitectureOperationStateV1::Indeterminate,
                        &message,
                        &state.service_pubkey,
                    )
                });
            };
            match recovered.operation.kind {
                ArchitectureOperationKindV1::InitialArchitecture => {
                    match serde_json::from_value::<ArchitectStudioRequest>(recovered.request) {
                        Ok(request) => spawn_architecture_operation(
                            Arc::clone(&state),
                            operation_id,
                            capability,
                            request,
                            recovered.idempotency_key,
                        ),
                        Err(error) => invalid_request(format!(
                            "persisted architecture request is invalid: {error}"
                        )),
                    }
                }
                ArchitectureOperationKindV1::GenerativeEdit => {
                    match serde_json::from_value::<GenerativeOperationRequest>(recovered.request) {
                        Ok(request) => spawn_generative_operation(
                            Arc::clone(&state),
                            operation_id,
                            capability,
                            request,
                            recovered.idempotency_key,
                        ),
                        Err(error) => invalid_request(format!(
                            "persisted generative request is invalid: {error}"
                        )),
                    }
                }
                ArchitectureOperationKindV1::Rebase => {
                    match serde_json::from_value::<RebaseOperationRequest>(recovered.request) {
                        Ok(request) => spawn_rebase_operation(
                            Arc::clone(&state),
                            operation_id,
                            capability,
                            request,
                            recovered.idempotency_key,
                        ),
                        Err(error) => {
                            invalid_request(format!("persisted rebase request is invalid: {error}"))
                        }
                    }
                }
                ArchitectureOperationKindV1::CriticRepair => {
                    invalid_request("this critic repair operation cannot yet be recovered".into())
                }
            }
        }
        for handoff in handoffs_to_recover {
            tokio::spawn(monitor_build(state.clone(), handoff));
        }
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .map_err(|error| error.to_string())?;
        axum::serve(listener, router)
            .await
            .map_err(|error| error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ServiceState {
        let keys = Keys::generate();
        ServiceState {
            durability_dir: std::env::temp_dir().join(format!("studio-service-{}", RunId::new())),
            public_url: "https://foundry.example".into(),
            community_id: "community".into(),
            service_pubkey: keys.public_key().to_hex(),
            service_keys: keys,
            relay_api_url: "https://relay.example".into(),
            http_client: reqwest::Client::new(),
            repository_paths: Arc::new(HashMap::new()),
            worker_url: "http://127.0.0.1:8787".into(),
            worker_token: "worker".into(),
            architect_runtime: Arc::new(PiPoolAgentRuntime::new(
                "http://127.0.0.1:8787".into(),
                "worker".into(),
                "test-architect",
            )),
            critic_runtime: Arc::new(PiPoolAgentRuntime::new(
                "http://127.0.0.1:8788".into(),
                "critic".into(),
                "test-critic",
            )),
            policy: Arc::new(Policy::default()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            nip98_replays: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn signed_header(keys: &Keys, body: &[u8], created_at: u64, url: &str) -> HeaderMap {
        let payload = format!("{:x}", sha2::Sha256::digest(body));
        let tags = [
            vec!["u", url],
            vec!["method", "POST"],
            vec!["payload", payload.as_str()],
            vec!["nonce", "test-nonce"],
        ]
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
        let event = EventBuilder::new(Kind::HttpAuth, "")
            .tags(tags)
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(keys)
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!(
                "Nostr {}",
                base64::engine::general_purpose::STANDARD.encode(event.as_json())
            )
            .parse()
            .unwrap(),
        );
        headers
    }

    #[test]
    fn nip98_session_exchange_rejects_replay_expiry_and_wrong_audience() {
        let state = state();
        let actor = Keys::generate();
        let body = br#"{"protocol_version":1}"#;
        let valid = signed_header(
            &actor,
            body,
            epoch_seconds(),
            "https://foundry.example/v1/studio/session",
        );
        assert_eq!(
            verify_nip98(&state, &valid, body).unwrap(),
            actor.public_key().to_hex()
        );
        assert_eq!(
            verify_nip98(&state, &valid, body).unwrap_err().status,
            StatusCode::UNAUTHORIZED
        );

        let expired = signed_header(
            &actor,
            body,
            epoch_seconds().saturating_sub(NIP98_MAX_AGE_SECONDS + 1),
            "https://foundry.example/v1/studio/session",
        );
        assert!(verify_nip98(&state, &expired, body).is_err());
        let wrong_audience = signed_header(
            &actor,
            body,
            epoch_seconds(),
            "https://other.example/v1/studio/session",
        );
        assert!(verify_nip98(&state, &wrong_audience, body).is_err());
    }

    #[test]
    fn signed_announcement_drives_editors_and_branch_threshold() {
        let owner = Keys::generate();
        let editor = Keys::generate().public_key().to_hex();
        let tags = [
            vec!["d", "repo"],
            vec!["p", editor.as_str(), "", "maintainer"],
            vec!["foundry-approval", "main", "2"],
        ]
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
        let event = EventBuilder::new(Kind::Custom(30_617), "")
            .tags(tags)
            .sign_with_keys(&owner)
            .unwrap();
        let policy = policy_from_verified_announcement(owner.public_key().to_hex(), &event, "main");
        assert!(policy.editors.contains(&editor));
        assert_eq!(policy.approval_threshold, 2);
        let mut operations = BTreeSet::new();
        apply_signed_repository_policy(&mut operations, &editor, &policy);
        assert!(operations.contains("edit"));
        assert!(operations.contains("approve"));
    }
}

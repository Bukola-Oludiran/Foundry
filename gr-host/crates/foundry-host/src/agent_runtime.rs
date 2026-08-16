//! Replaceable execution boundary for architecture agents.
//!
//! The local pi-pool adapter preserves Foundry's existing standalone behavior.
//! The Buzz ACP adapter speaks a job-oriented protocol so a retry after a
//! Foundry restart reuses the same job identity rather than starting a second
//! model turn.

use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const PROTOCOL_VERSION: u32 = 1;
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);
// The gateway owns per-turn liveness (300s silence, 600s absolute by
// default). Poll long enough to observe and durably report that terminal
// decision instead of racing it from the Foundry client.
const DEFAULT_JOB_TIMEOUT: Duration = Duration::from_secs(660);

/// Role assigned to one bounded model job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRoleV1 {
    Architect,
    Critic,
}

/// Stable request submitted to an agent runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentJobRequestV1 {
    pub protocol_version: u32,
    pub job_id: String,
    pub run_id: String,
    /// Stable proposal-scoped conversation. Runtimes that support persistent
    /// sessions reuse it across bounded jobs; others rely on the committed
    /// room transcript included in `input`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub role: AgentRoleV1,
    pub operation: String,
    pub input: Value,
}

impl AgentJobRequestV1 {
    pub fn new(
        job_id: impl Into<String>,
        run_id: impl Into<String>,
        role: AgentRoleV1,
        operation: impl Into<String>,
        input: Value,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            job_id: job_id.into(),
            run_id: run_id.into(),
            conversation_id: None,
            role,
            operation: operation.into(),
            input,
        }
    }

    pub fn with_conversation_id(mut self, conversation_id: Option<&str>) -> Self {
        self.conversation_id = conversation_id.map(str::to_owned);
        self
    }
}

/// Durable state reported by the Buzz ACP runtime gateway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentJobStateV1 {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Indeterminate,
}

/// Versioned response returned for submission and status requests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentJobStatusV1 {
    pub protocol_version: u32,
    pub job_id: String,
    pub state: AgentJobStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Object-safe boundary implemented by every source of agent intelligence.
pub trait AgentRuntime: Send + Sync {
    /// Stable identity used to enforce architect/critic independence.
    fn identity(&self) -> &str;

    /// Execute or recover one stable job and return its structured output.
    fn execute(&self, request: &AgentJobRequestV1) -> Result<Value, String>;

    /// Execute while projecting curated provider activity. Implementations
    /// without streaming support retain the normal deterministic result.
    fn execute_with_events(
        &self,
        request: &AgentJobRequestV1,
        _event_sink: &(dyn Fn(Value) + Send + Sync),
    ) -> Result<Value, String> {
        self.execute(request)
    }

    /// Cooperatively cancel a job. Cancellation never implies rollback.
    #[allow(dead_code)] // Wired when Studio exposes cancellation for in-flight agent jobs.
    fn cancel(&self, job_id: &str) -> Result<(), String>;

    /// Deliver human guidance to an active architect, or retain it for the
    /// next deterministic checkpoint when live steering is unavailable.
    fn guide(
        &self,
        _job_id: &str,
        _message_id: &str,
        _content: &str,
        _immediate: bool,
    ) -> Result<AgentGuidanceDeliveryV2, String> {
        Ok(AgentGuidanceDeliveryV2::Checkpointed)
    }
}

/// Provider-neutral delivery result for durable human guidance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentGuidanceDeliveryV2 {
    Queued,
    Delivered,
    Checkpointed,
    Rejected,
}

/// Adapter for the existing role-specific pi-pool HTTP endpoints.
pub struct PiPoolAgentRuntime {
    base_url: String,
    token: String,
    identity: String,
}

impl PiPoolAgentRuntime {
    pub fn new(base_url: String, token: String, identity: impl Into<String>) -> Self {
        Self {
            base_url,
            token,
            identity: identity.into(),
        }
    }

    fn endpoint(request: &AgentJobRequestV1) -> Result<&'static str, String> {
        match (request.role, request.operation.as_str()) {
            (AgentRoleV1::Architect, "architect") => Ok("/architect"),
            (AgentRoleV1::Critic, "architecture_review") => Ok("/architecture-review"),
            _ => Err(format!(
                "pi-pool does not support {:?} operation {:?}",
                request.role, request.operation
            )),
        }
    }
}

impl AgentRuntime for PiPoolAgentRuntime {
    fn identity(&self) -> &str {
        &self.identity
    }

    fn execute(&self, request: &AgentJobRequestV1) -> Result<Value, String> {
        if request.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "unsupported agent job protocol version {}",
                request.protocol_version
            ));
        }
        crate::http::http_post_json(
            &self.base_url,
            Self::endpoint(request)?,
            &request.input,
            &self.token,
        )
    }

    fn cancel(&self, _job_id: &str) -> Result<(), String> {
        // The legacy pi-pool contract has no cancellation endpoint. Existing
        // requests still obey their bounded HTTP timeout.
        Ok(())
    }
}

/// Client for Buzz's job-oriented ACP runtime gateway.
pub struct BuzzAcpAgentRuntime {
    gateway_url: String,
    capability: String,
    agent_id: String,
    client: Client,
    poll_interval: Duration,
    job_timeout: Duration,
}

impl BuzzAcpAgentRuntime {
    pub fn new(gateway_url: String, capability: String, agent_id: String) -> Result<Self, String> {
        if agent_id.trim().is_empty() {
            return Err("Buzz ACP agent identity must not be empty".into());
        }
        let gateway_url = gateway_url.trim_end_matches('/').to_owned();
        reqwest::Url::parse(&gateway_url)
            .map_err(|error| format!("invalid Buzz ACP gateway URL: {error}"))?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            gateway_url,
            capability,
            agent_id,
            client,
            poll_interval: DEFAULT_POLL_INTERVAL,
            job_timeout: DEFAULT_JOB_TIMEOUT,
        })
    }

    #[cfg(test)]
    fn with_timing(mut self, poll_interval: Duration, job_timeout: Duration) -> Self {
        self.poll_interval = poll_interval;
        self.job_timeout = job_timeout;
        self
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<AgentJobStatusV1, String> {
        if self.capability.contains(['\r', '\n']) {
            return Err("Buzz ACP capability contains an invalid newline".into());
        }
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.gateway_url))
            .bearer_auth(&self.capability)
            .header("X-Buzz-Agent-Id", &self.agent_id);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(|error| error.to_string())?;
        let status = response.status();
        let bytes = response.bytes().map_err(|error| error.to_string())?;
        if !status.is_success() {
            let detail = String::from_utf8_lossy(&bytes);
            return Err(format!(
                "Buzz ACP gateway returned HTTP {status}: {}",
                detail.chars().take(512).collect::<String>()
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid Buzz ACP response: {error}"))
    }

    fn request_events(&self, job_id: &str, after: u64) -> Result<Vec<Value>, String> {
        if self.capability.contains(['\r', '\n']) {
            return Err("Buzz ACP capability contains an invalid newline".into());
        }
        let response = self
            .client
            .get(format!(
                "{}/v2/acp/jobs/{job_id}/events?after={after}",
                self.gateway_url
            ))
            .bearer_auth(&self.capability)
            .header("X-Buzz-Agent-Id", &self.agent_id)
            .send()
            .map_err(|error| error.to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            // Compatibility with a protocol-v1 gateway during rolling upgrades.
            return Ok(Vec::new());
        }
        let status = response.status();
        let bytes = response.bytes().map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "Buzz ACP gateway event request returned HTTP {status}: {}",
                String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(512)
                    .collect::<String>()
            ));
        }
        #[derive(Deserialize)]
        struct EventPage {
            protocol_version: u32,
            events: Vec<Value>,
        }
        let page: EventPage = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid Buzz ACP event response: {error}"))?;
        if page.protocol_version != 2 {
            return Err(format!(
                "unsupported Buzz ACP event protocol version {}",
                page.protocol_version
            ));
        }
        Ok(page.events)
    }

    fn execute_observed(
        &self,
        request: &AgentJobRequestV1,
        event_sink: Option<&(dyn Fn(Value) + Send + Sync)>,
    ) -> Result<Value, String> {
        if request.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "unsupported agent job protocol version {}",
                request.protocol_version
            ));
        }
        let body = serde_json::to_value(request).map_err(|error| error.to_string())?;
        let submitted = self.request(reqwest::Method::POST, "/v1/acp/jobs", Some(&body))?;
        let mut event_cursor = 0;
        self.project_events(request, &mut event_cursor, event_sink)?;
        if let Some(output) = Self::finish(submitted, &request.job_id)? {
            self.project_events(request, &mut event_cursor, event_sink)?;
            return Ok(output);
        }

        let started = Instant::now();
        loop {
            if started.elapsed() >= self.job_timeout {
                return Err(format!("Buzz ACP job {} timed out", request.job_id));
            }
            thread::sleep(self.poll_interval);
            let status = self.request(
                reqwest::Method::GET,
                &format!("/v1/acp/jobs/{}", request.job_id),
                None,
            )?;
            self.project_events(request, &mut event_cursor, event_sink)?;
            if let Some(output) = Self::finish(status, &request.job_id)? {
                self.project_events(request, &mut event_cursor, event_sink)?;
                return Ok(output);
            }
        }
    }

    fn project_events(
        &self,
        request: &AgentJobRequestV1,
        cursor: &mut u64,
        event_sink: Option<&(dyn Fn(Value) + Send + Sync)>,
    ) -> Result<(), String> {
        let Some(event_sink) = event_sink else {
            return Ok(());
        };
        for event in self.request_events(&request.job_id, *cursor)? {
            if let Some(sequence) = event.get("sequence").and_then(Value::as_u64) {
                *cursor = (*cursor).max(sequence);
            }
            event_sink(event);
        }
        Ok(())
    }

    fn finish(status: AgentJobStatusV1, expected_job_id: &str) -> Result<Option<Value>, String> {
        if status.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "unsupported Buzz ACP protocol version {}",
                status.protocol_version
            ));
        }
        if status.job_id != expected_job_id {
            return Err("Buzz ACP gateway returned a mismatched job identity".into());
        }
        match status.state {
            AgentJobStateV1::Queued | AgentJobStateV1::Running => Ok(None),
            AgentJobStateV1::Succeeded => status
                .output
                .map(Some)
                .ok_or_else(|| "Buzz ACP job succeeded without structured output".into()),
            AgentJobStateV1::Failed
            | AgentJobStateV1::Cancelled
            | AgentJobStateV1::Indeterminate => Err(status
                .error
                .unwrap_or_else(|| format!("Buzz ACP job ended in state {:?}", status.state))),
        }
    }
}

impl AgentRuntime for BuzzAcpAgentRuntime {
    fn identity(&self) -> &str {
        &self.agent_id
    }

    fn execute(&self, request: &AgentJobRequestV1) -> Result<Value, String> {
        self.execute_observed(request, None)
    }

    fn execute_with_events(
        &self,
        request: &AgentJobRequestV1,
        event_sink: &(dyn Fn(Value) + Send + Sync),
    ) -> Result<Value, String> {
        self.execute_observed(request, Some(event_sink))
    }

    fn cancel(&self, job_id: &str) -> Result<(), String> {
        let status = self.request(
            reqwest::Method::POST,
            &format!("/v1/acp/jobs/{job_id}/cancel"),
            Some(&serde_json::json!({
                "protocol_version": PROTOCOL_VERSION,
                "job_id": job_id,
            })),
        )?;
        if status.job_id != job_id {
            return Err("Buzz ACP gateway returned a mismatched job identity".into());
        }
        Ok(())
    }

    fn guide(
        &self,
        job_id: &str,
        message_id: &str,
        content: &str,
        immediate: bool,
    ) -> Result<AgentGuidanceDeliveryV2, String> {
        #[derive(Deserialize)]
        struct Response {
            protocol_version: u32,
            delivery: AgentGuidanceDeliveryV2,
        }
        let response = self
            .client
            .post(format!(
                "{}/v2/acp/jobs/{job_id}/messages",
                self.gateway_url
            ))
            .bearer_auth(&self.capability)
            .header("X-Buzz-Agent-Id", &self.agent_id)
            .json(&serde_json::json!({
                "protocol_version": 2,
                "message_id": message_id,
                "mode": if immediate { "immediate" } else { "checkpoint" },
                "content": content,
            }))
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let bytes = response.bytes().map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "Buzz ACP guidance returned HTTP {status}: {}",
                String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(512)
                    .collect::<String>()
            ));
        }
        let response: Response = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid Buzz ACP guidance response: {error}"))?;
        if response.protocol_version != 2 {
            return Err("unsupported Buzz ACP guidance protocol version".into());
        }
        Ok(response.delivery)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn spawn_gateway(
        responses: Vec<AgentJobStatusV1>,
    ) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&requests);
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = vec![0; 16 * 1024];
                let read = stream.read(&mut bytes).unwrap();
                let text = String::from_utf8_lossy(&bytes[..read]).to_string();
                observed.lock().unwrap().push(text);
                let body = serde_json::to_vec(&response).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        (format!("http://{address}"), requests, handle)
    }

    fn status(job_id: &str, state: AgentJobStateV1, output: Option<Value>) -> AgentJobStatusV1 {
        AgentJobStatusV1 {
            protocol_version: 1,
            job_id: job_id.into(),
            state,
            output,
            error: None,
        }
    }

    #[test]
    fn buzz_runtime_reuses_job_identity_while_polling() {
        let (url, requests, handle) = spawn_gateway(vec![
            status("job-one", AgentJobStateV1::Queued, None),
            status("job-one", AgentJobStateV1::Running, None),
            status(
                "job-one",
                AgentJobStateV1::Succeeded,
                Some(serde_json::json!({"proposal": {}})),
            ),
        ]);
        let runtime = BuzzAcpAgentRuntime::new(url, "secret-capability".into(), "architect".into())
            .unwrap()
            .with_timing(Duration::from_millis(1), Duration::from_secs(1));
        let request = AgentJobRequestV1::new(
            "job-one",
            "run-one",
            AgentRoleV1::Architect,
            "architect",
            serde_json::json!({"prompt": "design"}),
        );
        let output = runtime.execute(&request).unwrap();
        handle.join().unwrap();
        assert_eq!(output, serde_json::json!({"proposal": {}}));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("POST /v1/acp/jobs "));
        assert!(requests[0].contains("\"job_id\":\"job-one\""));
        assert!(requests[0]
            .to_ascii_lowercase()
            .contains("x-buzz-agent-id: architect"));
        assert!(requests[1].starts_with("GET /v1/acp/jobs/job-one "));
        assert!(requests[2].starts_with("GET /v1/acp/jobs/job-one "));
    }

    #[test]
    fn buzz_runtime_fails_closed_on_mismatched_job_identity() {
        let (url, _, handle) = spawn_gateway(vec![status(
            "other-job",
            AgentJobStateV1::Succeeded,
            Some(serde_json::json!({})),
        )]);
        let runtime = BuzzAcpAgentRuntime::new(url, "capability".into(), "critic".into()).unwrap();
        let request = AgentJobRequestV1::new(
            "expected-job",
            "run-one",
            AgentRoleV1::Critic,
            "architecture_review",
            serde_json::json!({}),
        );
        let error = runtime.execute(&request).unwrap_err();
        handle.join().unwrap();
        assert!(error.contains("mismatched job identity"));
    }

    #[test]
    fn buzz_runtime_cancels_the_exact_job() {
        let (url, requests, handle) =
            spawn_gateway(vec![status("job-cancel", AgentJobStateV1::Cancelled, None)]);
        let runtime =
            BuzzAcpAgentRuntime::new(url, "capability".into(), "architect".into()).unwrap();
        runtime.cancel("job-cancel").unwrap();
        handle.join().unwrap();
        let requests = requests.lock().unwrap();
        assert!(requests[0].starts_with("POST /v1/acp/jobs/job-cancel/cancel "));
        assert!(requests[0].contains("\"job_id\":\"job-cancel\""));
    }
}

//! Private, versioned JSON-lines bridge used by the MCP façade.
//!
//! The sidecar owns transport normalization only. Every operation executes the existing
//! `foundry-host` command, so GraphReact persistence remains the sole durable build authority.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 1_048_576;
const MAX_CONCURRENT_COMMANDS: usize = 16;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HostOperation {
    Validate,
    Architect,
    Build,
    Status,
    Cancel,
    Rearchitect,
    Publish,
}

impl HostOperation {
    fn command(self) -> &'static str {
        match self {
            Self::Validate => "validate",
            Self::Architect => "architect",
            Self::Build => "build",
            Self::Status => "status",
            Self::Cancel => "cancel",
            Self::Rearchitect => "rearchitect",
            Self::Publish => "publish",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteParams {
    operation: HostOperation,
    #[serde(default)]
    arguments: Vec<String>,
    cwd: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelExecutionParams {
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SidecarRequest {
    protocol_version: u32,
    id: String,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    state: Value,
}

#[derive(Debug, Serialize)]
struct CancellationResult {
    cancelled: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum SidecarResult {
    Command(CommandResult),
    Cancellation(CancellationResult),
}

#[derive(Debug, Serialize)]
struct SidecarError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
struct SidecarResponse {
    protocol_version: u32,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<SidecarResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SidecarError>,
}

fn run_id(stdout: &str) -> Option<&str> {
    stdout.lines().find_map(|line| {
        line.split_once("durable run:")
            .and_then(|(_, tail)| tail.split_whitespace().next())
    })
}

fn status(stdout: &str) -> Option<(&str, &str)> {
    stdout.lines().find_map(|line| {
        let (run_id, value) = line.split_once(':')?;
        let value = value.trim();
        (!run_id.trim().is_empty()
            && !value.is_empty()
            && value
                .chars()
                .all(|character| character.is_ascii_alphabetic() || character == '_'))
        .then_some((run_id.trim(), value))
    })
}

fn normalized_state(operation: HostOperation, stdout: &str) -> Value {
    let mut state = serde_json::Map::from_iter([
        ("command".into(), json!(operation.command())),
        ("stdout".into(), json!(stdout)),
    ]);
    if let Some(run_id) = run_id(stdout) {
        state.insert("runId".into(), json!(run_id));
    }
    if matches!(operation, HostOperation::Status) {
        if let Some((run_id, status)) = status(stdout) {
            state.insert("runId".into(), json!(run_id));
            state.insert("status".into(), json!(status.to_ascii_lowercase()));
        }
    }
    if matches!(operation, HostOperation::Publish) {
        if let Some(url) = stdout
            .lines()
            .find_map(|line| line.strip_prefix("draft pull request:").map(str::trim))
        {
            state.insert("draftPullRequestUrl".into(), json!(url));
        }
    }
    Value::Object(state)
}

fn collect_output(
    status: ExitStatus,
    stdout: thread::JoinHandle<io::Result<Vec<u8>>>,
    stderr: thread::JoinHandle<io::Result<Vec<u8>>>,
    operation: HostOperation,
) -> Result<CommandResult, SidecarError> {
    let read = |stream: thread::JoinHandle<io::Result<Vec<u8>>>| {
        stream
            .join()
            .map_err(|_| SidecarError {
                code: "HOST_UNAVAILABLE",
                message: "host output reader panicked".into(),
            })?
            .map_err(|error| SidecarError {
                code: "HOST_UNAVAILABLE",
                message: error.to_string(),
            })
    };
    let stdout = String::from_utf8_lossy(&read(stdout)?).trim().to_owned();
    let stderr = String::from_utf8_lossy(&read(stderr)?).trim().to_owned();
    Ok(CommandResult {
        exit_code: status.code().unwrap_or(1),
        state: normalized_state(operation, &stdout),
        stdout,
        stderr,
    })
}

enum WaitOutcome {
    Completed(ExitStatus),
    Cancelled,
}

fn configure_process(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
}

fn terminate_process(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // SAFETY: this child was placed in a fresh process group whose id is its positive pid.
        // A negative pid therefore targets only the host command and its descendants.
        let process_group = i32::try_from(child.id()).expect("child pid fits in i32");
        let group_killed = unsafe { libc::kill(-process_group, libc::SIGKILL) == 0 };
        if !group_killed {
            let _ = child.kill();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn wait_for_child(
    child: &mut std::process::Child,
    cancellation: &Receiver<()>,
) -> Result<WaitOutcome, SidecarError> {
    loop {
        match cancellation.try_recv() {
            Ok(()) | Err(TryRecvError::Disconnected) => {
                terminate_process(child);
                return Ok(WaitOutcome::Cancelled);
            }
            Err(TryRecvError::Empty) => {}
        }
        if let Some(status) = child.try_wait().map_err(|error| SidecarError {
            code: "HOST_UNAVAILABLE",
            message: error.to_string(),
        })? {
            return Ok(WaitOutcome::Completed(status));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn execute(
    params: ExecuteParams,
    cancellation: Receiver<()>,
) -> Result<CommandResult, SidecarError> {
    if !params.cwd.is_absolute() || !params.cwd.is_dir() {
        return Err(SidecarError {
            code: "INVALID_CWD",
            message: "cwd must be an existing absolute directory".into(),
        });
    }
    if params
        .arguments
        .iter()
        .any(|argument| argument.as_bytes().contains(&0))
    {
        return Err(SidecarError {
            code: "INVALID_ARGUMENT",
            message: "arguments may not contain NUL bytes".into(),
        });
    }
    let executable = std::env::current_exe().map_err(|error| SidecarError {
        code: "HOST_UNAVAILABLE",
        message: error.to_string(),
    })?;
    let mut command = Command::new(executable);
    command
        .arg(params.operation.command())
        .args(params.arguments)
        .current_dir(params.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process(&mut command);
    let mut child = command.spawn().map_err(|error| SidecarError {
        code: "HOST_UNAVAILABLE",
        message: error.to_string(),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| SidecarError {
        code: "HOST_UNAVAILABLE",
        message: "host stdout was not captured".into(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| SidecarError {
        code: "HOST_UNAVAILABLE",
        message: "host stderr was not captured".into(),
    })?;
    let read_stdout = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stdout = stdout;
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let read_stderr = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stderr = stderr;
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });

    match wait_for_child(&mut child, &cancellation)? {
        WaitOutcome::Completed(status) => {
            collect_output(status, read_stdout, read_stderr, params.operation)
        }
        WaitOutcome::Cancelled => {
            let _ = read_stdout.join();
            let _ = read_stderr.join();
            Err(SidecarError {
                code: "COMMAND_CANCELLED",
                message: "host command was cancelled by its caller".into(),
            })
        }
    }
}

fn error_response(id: String, code: &'static str, message: impl Into<String>) -> SidecarResponse {
    SidecarResponse {
        protocol_version: PROTOCOL_VERSION,
        id,
        result: None,
        error: Some(SidecarError {
            code,
            message: message.into(),
        }),
    }
}

fn validate_request(request: &SidecarRequest) -> Option<SidecarResponse> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Some(error_response(
            request.id.clone(),
            "UNSUPPORTED_PROTOCOL",
            format!("expected protocol version {PROTOCOL_VERSION}"),
        ));
    }
    if request.id.is_empty() {
        return Some(error_response(
            String::new(),
            "INVALID_REQUEST",
            "request id must not be empty",
        ));
    }
    None
}

fn write_response(stdout: &Mutex<io::Stdout>, response: &SidecarResponse) {
    let Ok(mut stdout) = stdout.lock() else {
        return;
    };
    if serde_json::to_writer(&mut *stdout, response).is_ok() {
        let _ = stdout.write_all(b"\n").and_then(|()| stdout.flush());
    }
}

pub fn serve() -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let active = Arc::new(Mutex::new(HashMap::new()));
    let mut executions: Vec<thread::JoinHandle<()>> = Vec::new();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > MAX_REQUEST_BYTES {
            write_response(
                &stdout,
                &error_response(
                    String::new(),
                    "REQUEST_TOO_LARGE",
                    format!("request exceeds {MAX_REQUEST_BYTES} bytes"),
                ),
            );
            continue;
        }
        let request = match serde_json::from_str::<SidecarRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &stdout,
                    &error_response(String::new(), "INVALID_REQUEST", error.to_string()),
                );
                continue;
            }
        };
        if let Some(response) = validate_request(&request) {
            write_response(&stdout, &response);
            continue;
        }
        if request.method == "cancel_execution" {
            let params = match serde_json::from_value::<CancelExecutionParams>(request.params) {
                Ok(params) => params,
                Err(error) => {
                    write_response(
                        &stdout,
                        &error_response(request.id, "INVALID_REQUEST", error.to_string()),
                    );
                    continue;
                }
            };
            let cancelled = active
                .lock()
                .map_err(|_| "active command registry is poisoned".to_string())?
                .get(&params.request_id)
                .is_some_and(|sender: &mpsc::Sender<()>| sender.send(()).is_ok());
            write_response(
                &stdout,
                &SidecarResponse {
                    protocol_version: PROTOCOL_VERSION,
                    id: request.id,
                    result: Some(SidecarResult::Cancellation(CancellationResult {
                        cancelled,
                    })),
                    error: None,
                },
            );
            continue;
        }
        if request.method != "execute" {
            write_response(
                &stdout,
                &error_response(
                    request.id,
                    "METHOD_NOT_FOUND",
                    format!("unknown method {}", request.method),
                ),
            );
            continue;
        }
        let params = match serde_json::from_value::<ExecuteParams>(request.params) {
            Ok(params) => params,
            Err(error) => {
                write_response(
                    &stdout,
                    &error_response(request.id, "INVALID_REQUEST", error.to_string()),
                );
                continue;
            }
        };
        let mut index = 0;
        while index < executions.len() {
            if executions[index].is_finished() {
                executions
                    .swap_remove(index)
                    .join()
                    .map_err(|_| "sidecar execution thread panicked".to_string())?;
            } else {
                index += 1;
            }
        }
        if executions.len() >= MAX_CONCURRENT_COMMANDS {
            write_response(
                &stdout,
                &error_response(
                    request.id,
                    "SIDECAR_BUSY",
                    format!("sidecar allows at most {MAX_CONCURRENT_COMMANDS} active commands"),
                ),
            );
            continue;
        }
        let (cancel, cancellation) = mpsc::channel();
        {
            let mut active = active
                .lock()
                .map_err(|_| "active command registry is poisoned".to_string())?;
            if active.contains_key(&request.id) {
                write_response(
                    &stdout,
                    &error_response(
                        request.id.clone(),
                        "DUPLICATE_REQUEST",
                        "request id is already active",
                    ),
                );
                continue;
            }
            active.insert(request.id.clone(), cancel);
        }
        let output = Arc::clone(&stdout);
        let active_commands = Arc::clone(&active);
        let request_id = request.id;
        executions.push(thread::spawn(move || {
            let response = match execute(params, cancellation) {
                Ok(result) => SidecarResponse {
                    protocol_version: PROTOCOL_VERSION,
                    id: request_id.clone(),
                    result: Some(SidecarResult::Command(result)),
                    error: None,
                },
                Err(error) => SidecarResponse {
                    protocol_version: PROTOCOL_VERSION,
                    id: request_id.clone(),
                    result: None,
                    error: Some(error),
                },
            };
            if let Ok(mut active) = active_commands.lock() {
                active.remove(&request_id);
            }
            write_response(&output, &response);
        }));
    }
    if let Ok(active) = active.lock() {
        for cancellation in active.values() {
            let _ = cancellation.send(());
        }
    }
    for execution in executions {
        execution
            .join()
            .map_err(|_| "sidecar execution thread panicked".to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_durable_run_and_status_output() {
        let build = normalized_state(
            HostOperation::Build,
            "header\n  durable run: run-0123456789abcdef (Running)",
        );
        assert_eq!(build["runId"], "run-0123456789abcdef");
        let status = normalized_state(HostOperation::Status, "run-0123456789abcdef: Succeeded");
        assert_eq!(status["status"], "succeeded");
    }

    #[test]
    fn rejects_unknown_protocol_and_request_fields() {
        let wrong_protocol = serde_json::from_str::<SidecarRequest>(
            r#"{"protocol_version":2,"id":"one","method":"execute","params":{"operation":"validate","arguments":[],"cwd":"/tmp"}}"#,
        )
        .unwrap();
        assert_eq!(
            validate_request(&wrong_protocol)
                .unwrap()
                .error
                .unwrap()
                .code,
            "UNSUPPORTED_PROTOCOL"
        );
        let unknown = serde_json::from_str::<SidecarRequest>(
            r#"{"protocol_version":1,"id":"two","method":"execute","params":{"operation":"validate","arguments":[],"cwd":"/tmp","command":"sh"}}"#,
        )
        .unwrap();
        assert!(serde_json::from_value::<ExecuteParams>(unknown.params).is_err());
    }

    #[test]
    fn cancellation_params_are_strict_and_identify_the_target_request() {
        let request = serde_json::from_str::<SidecarRequest>(
            r#"{"protocol_version":1,"id":"cancel-one","method":"cancel_execution","params":{"request_id":"build-one"}}"#,
        )
        .unwrap();
        let params = serde_json::from_value::<CancelExecutionParams>(request.params).unwrap();
        assert_eq!(params.request_id, "build-one");

        let unknown = serde_json::from_str::<SidecarRequest>(
            r#"{"protocol_version":1,"id":"cancel-two","method":"cancel_execution","params":{"request_id":"build-two","signal":"kill"}}"#,
        )
        .unwrap();
        assert!(serde_json::from_value::<CancelExecutionParams>(unknown.params).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_terminates_an_active_child() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        configure_process(&mut command);
        let mut child = command.spawn().unwrap();
        let (cancel, cancellation) = mpsc::channel();
        cancel.send(()).unwrap();
        assert!(matches!(
            wait_for_child(&mut child, &cancellation).unwrap(),
            WaitOutcome::Cancelled
        ));
        assert!(child.try_wait().unwrap().is_some());
    }
}

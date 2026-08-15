//! Private, versioned JSON-lines bridge used by the MCP façade.
//!
//! The sidecar owns transport normalization only. Every operation executes the existing
//! `foundry-host` command, so GraphReact persistence remains the sole durable build authority.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

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
struct SidecarRequest {
    protocol_version: u32,
    id: String,
    method: String,
    params: ExecuteParams,
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
struct SidecarError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
struct SidecarResponse {
    protocol_version: u32,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<CommandResult>,
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

fn execute(params: ExecuteParams) -> Result<CommandResult, SidecarError> {
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
    let output = Command::new(executable)
        .arg(params.operation.command())
        .args(params.arguments)
        .current_dir(params.cwd)
        .output()
        .map_err(|error| SidecarError {
            code: "HOST_UNAVAILABLE",
            message: error.to_string(),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Ok(CommandResult {
        exit_code: output.status.code().unwrap_or(1),
        state: normalized_state(params.operation, &stdout),
        stdout,
        stderr,
    })
}

fn handle(line: &str) -> SidecarResponse {
    let parsed = serde_json::from_str::<SidecarRequest>(line);
    let request = match parsed {
        Ok(request) => request,
        Err(error) => {
            return SidecarResponse {
                protocol_version: PROTOCOL_VERSION,
                id: String::new(),
                result: None,
                error: Some(SidecarError {
                    code: "INVALID_REQUEST",
                    message: error.to_string(),
                }),
            };
        }
    };
    if request.protocol_version != PROTOCOL_VERSION {
        return SidecarResponse {
            protocol_version: PROTOCOL_VERSION,
            id: request.id,
            result: None,
            error: Some(SidecarError {
                code: "UNSUPPORTED_PROTOCOL",
                message: format!("expected protocol version {PROTOCOL_VERSION}"),
            }),
        };
    }
    if request.method != "execute" {
        return SidecarResponse {
            protocol_version: PROTOCOL_VERSION,
            id: request.id,
            result: None,
            error: Some(SidecarError {
                code: "METHOD_NOT_FOUND",
                message: format!("unknown method {}", request.method),
            }),
        };
    }
    match execute(request.params) {
        Ok(result) => SidecarResponse {
            protocol_version: PROTOCOL_VERSION,
            id: request.id,
            result: Some(result),
            error: None,
        },
        Err(error) => SidecarResponse {
            protocol_version: PROTOCOL_VERSION,
            id: request.id,
            result: None,
            error: Some(error),
        },
    }
}

pub fn serve() -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let mut executions: Vec<thread::JoinHandle<()>> = Vec::new();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
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
            executions
                .remove(0)
                .join()
                .map_err(|_| "sidecar execution thread panicked".to_string())?;
        }
        let output = Arc::clone(&stdout);
        executions.push(thread::spawn(move || {
            let response = if line.len() > MAX_REQUEST_BYTES {
                SidecarResponse {
                    protocol_version: PROTOCOL_VERSION,
                    id: String::new(),
                    result: None,
                    error: Some(SidecarError {
                        code: "REQUEST_TOO_LARGE",
                        message: format!("request exceeds {MAX_REQUEST_BYTES} bytes"),
                    }),
                }
            } else {
                handle(&line)
            };
            let Ok(mut stdout) = output.lock() else {
                return;
            };
            if serde_json::to_writer(&mut *stdout, &response).is_ok() {
                let _ = stdout.write_all(b"\n").and_then(|()| stdout.flush());
            }
        }));
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
        let wrong_protocol = handle(
            r#"{"protocol_version":2,"id":"one","method":"execute","params":{"operation":"validate","arguments":[],"cwd":"/tmp"}}"#,
        );
        assert_eq!(wrong_protocol.error.unwrap().code, "UNSUPPORTED_PROTOCOL");
        let unknown = handle(
            r#"{"protocol_version":1,"id":"two","method":"execute","params":{"operation":"validate","arguments":[],"cwd":"/tmp","command":"sh"}}"#,
        );
        assert_eq!(unknown.error.unwrap().code, "INVALID_REQUEST");
    }
}

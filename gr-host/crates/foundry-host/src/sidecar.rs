//! Private line-framed JSON-RPC 2.0 bridge for the TypeScript MCP façade.

use foundry_engine::{AssemblyVerdict, Engine, NodeVerdict, SerializableBuildPlan};
use foundry_ir::types::Architecture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError { code: i32, message: String }

fn ir(params: &Value) -> Result<Architecture, String> {
    serde_json::from_value(params.get("ir").cloned().ok_or("missing ir")?).map_err(|e| e.to_string())
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| format!("missing {key}"))
}

fn execute(engine: &mut Engine, request: &RpcRequest) -> Result<Value, String> {
    match request.method.as_str() {
        "health" => Ok(json!({"ok": true, "protocol": 1})),
        "compile_ir" => {
            let input = ir(&request.params)?;
            let plan = engine.compile_architecture(&input).map_err(|e| e.to_string())?;
            serde_json::to_value(SerializableBuildPlan::from(&plan)).map_err(|e| e.to_string())
        }
        "invalidation_set" => {
            let input = ir(&request.params)?;
            let node = required(&request.params, "node_id")?;
            let plan = engine.compile_architecture(&input).map_err(|e| e.to_string())?;
            Ok(json!({"node_id": node, "invalidates": plan.invalidation_set(node)}))
        }
        "start_build" => {
            let input = ir(&request.params)?;
            let build_id = required(&request.params, "build_id")?.to_string();
            let revision = required(&request.params, "architecture_revision")?.to_string();
            serde_json::to_value(engine.start_architecture(build_id, revision, &input).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
        "get_build" => serde_json::to_value(engine.build(required(&request.params, "build_id")?).map_err(|e| e.to_string())?).map_err(|e| e.to_string()),
        "record_node" => {
            let verdict: NodeVerdict = serde_json::from_value(request.params.get("verdict").cloned().ok_or("missing verdict")?).map_err(|e| e.to_string())?;
            let build_id = required(&request.params, "build_id")?.to_string();
            let node_id = required(&request.params, "node_id")?.to_string();
            serde_json::to_value(engine.record_node(&build_id, &node_id, verdict).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
        "record_assembly" => {
            let verdict: AssemblyVerdict = serde_json::from_value(request.params.get("verdict").cloned().ok_or("missing verdict")?).map_err(|e| e.to_string())?;
            let build_id = required(&request.params, "build_id")?.to_string();
            serde_json::to_value(engine.record_assembly(&build_id, verdict).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
        "cancel_build" | "$/cancelRequest" => {
            let build_id = required(&request.params, "build_id")?.to_string();
            serde_json::to_value(engine.cancel(&build_id).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        }
        other => Err(format!("unknown method `{other}`")),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut engine = Engine::default();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let response = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => {
                let id = request.id.clone().unwrap_or(Value::Null);
                match execute(&mut engine, &request) {
                    Ok(result) => RpcResponse { jsonrpc: "2.0", id, result: Some(result), error: None },
                    Err(message) => RpcResponse { jsonrpc: "2.0", id, result: None, error: Some(RpcError { code: -32000, message }) },
                }
            }
            Err(error) => RpcResponse { jsonrpc: "2.0", id: Value::Null, result: None, error: Some(RpcError { code: -32700, message: error.to_string() }) },
        };
        if serde_json::to_writer(&mut stdout, &response).is_err() { break; }
        if stdout.write_all(b"\n").and_then(|_| stdout.flush()).is_err() { break; }
    }
}

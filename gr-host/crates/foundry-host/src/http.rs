//! Minimal blocking HTTP/1.1 JSON client for driving the local pi-pool. Dependency-free
//! (raw `TcpStream`): connects, POSTs a JSON body with `Connection: close`, reads to EOF,
//! and parses the response body. Sufficient for localhost; not a general HTTP client.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub fn http_post_json(base: &str, path: &str, body: &Value, token: &str) -> Result<Value, String> {
    if token.contains(['\r', '\n']) {
        return Err("worker token contains an invalid newline".into());
    }
    let addr = base.strip_prefix("http://").unwrap_or(base);
    let body_bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;

    let mut stream = TcpStream::connect(addr).map_err(|e| format!("connect {addr}: {e}"))?;
    // Builds can take a while once a real LLM is wired; keep the read window generous.
    stream.set_read_timeout(Some(Duration::from_secs(300))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(60))).ok();

    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    );
    stream
        .write_all(head.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.write_all(&body_bytes).map_err(|e| e.to_string())?;
    stream.flush().ok();

    let mut resp = Vec::new();
    stream.read_to_end(&mut resp).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&resp);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "invalid HTTP status line".to_string())?;
    let split = text
        .find("\r\n\r\n")
        .ok_or_else(|| "no header/body separator".to_string())?;
    let body_str = text[split + 4..].trim();
    let value: Value = serde_json::from_str(body_str).map_err(|e| {
        format!(
            "parse response: {e}; raw={}",
            body_str.chars().take(200).collect::<String>()
        )
    })?;
    if !(200..300).contains(&status) {
        return Err(format!("worker returned HTTP {status}: {value}"));
    }
    Ok(value)
}

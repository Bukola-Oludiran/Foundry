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

pub fn http_get_bytes(
    base: &str,
    path: &str,
    token: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if token.contains(['\r', '\n']) || path.contains(['\r', '\n']) {
        return Err("worker request contains an invalid newline".into());
    }
    let addr = base.strip_prefix("http://").unwrap_or(base);
    let mut stream =
        TcpStream::connect(addr).map_err(|error| format!("connect {addr}: {error}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(30))).ok();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nAccept: application/octet-stream\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    stream
        .take(u64::try_from(max_bytes).unwrap_or(u64::MAX) + 64 * 1024)
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    parse_bytes_response(&response, max_bytes)
}

fn parse_bytes_response(response: &[u8], max_bytes: usize) -> Result<Vec<u8>, String> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "no header/body separator".to_string())?;
    let headers = std::str::from_utf8(&response[..split])
        .map_err(|_| "worker returned non-UTF-8 HTTP headers".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "invalid HTTP status line".to_string())?;
    let body = &response[split + 4..];
    if body.len() > max_bytes {
        return Err("worker artifact exceeded its byte bound".into());
    }
    if !(200..300).contains(&status) {
        let detail = String::from_utf8_lossy(body);
        return Err(format!(
            "worker returned HTTP {status}: {}",
            detail.chars().take(200).collect::<String>()
        ));
    }
    let declared_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    if declared_length != Some(body.len()) {
        return Err("worker artifact Content-Length did not match its body".into());
    }
    Ok(body.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_response_is_bounded_and_length_checked() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n\0\x01\x02\xff";
        assert_eq!(
            parse_bytes_response(response, 4).unwrap(),
            b"\0\x01\x02\xff"
        );
        assert!(parse_bytes_response(response, 3).is_err());
        assert!(
            parse_bytes_response(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n1234", 8).is_err()
        );
    }
}

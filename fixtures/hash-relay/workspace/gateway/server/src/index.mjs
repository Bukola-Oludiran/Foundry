import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

export function health() { return true; }

export function relay(bytes, executable = process.env.HASH_RELAY_CHECKSUM_CLI) {
  if (!executable) throw new Error("CHECKSUM_CLI_UNAVAILABLE");
  const result = spawnSync(executable, [], { input: `${Buffer.from(bytes).toString("base64")}\n`, encoding: "utf8", timeout: 2000 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "CHECKSUM_PROCESS_FAILED");
  return { digest: JSON.parse(result.stdout.trim()) };
}

const port = Number(process.env.HASH_RELAY_PORT || 0);
if (port) {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ready":true}'); return; }
    if (request.method !== "POST" || request.url !== "/checksum" || request.headers["content-type"] !== "application/octet-stream") { response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":"INVALID_REQUEST"}'); return; }
    const chunks = []; let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size <= 1048576) chunks.push(chunk); });
    request.on("end", () => { try { if (size > 1048576) throw new Error("PAYLOAD_TOO_LARGE"); const body = JSON.stringify(relay(Buffer.concat(chunks))); response.writeHead(200, { "content-type": "application/json" }); response.end(body); } catch (error) { response.writeHead(422, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message })); } });
  });
  server.listen(port, "127.0.0.1");
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { FoundryHostClient } from "../core/host-client.ts";
import { WorkspaceRegistry } from "../core/workspaces.ts";
import { createFoundryMcpServer } from "./server.ts";

const workspaces = WorkspaceRegistry.fromEnvironment();
const client = FoundryHostClient.configured(workspaces);
const handle = serveStdio(() => createFoundryMcpServer(client), { legacy: "serve", onerror: (error) => console.error(error) });

let closing = false;
async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  await handle.close();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.once("end", () => void shutdown());

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createService, localAuth } from "./bootstrap.ts";
import { createFoundryMcpServer } from "./server.ts";
import { closeLocalWorker, ensureLocalWorker } from "./local-worker.ts";

const managedWorker = await ensureLocalWorker();
if (managedWorker) process.env.FOUNDRY_WORKER_URL = managedWorker.url;
const service = createService();
const handle = serveStdio(() => createFoundryMcpServer(service, localAuth("stdio")), { legacy: "serve", onerror: (error) => console.error(error) });
let closing = false;
async function shutdown(code = 0): Promise<void> { if (closing) return; closing = true; await handle.close(); await service.engine.close(); service.store.close(); await closeLocalWorker(managedWorker); process.exit(code); }
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.once("end", () => void shutdown());

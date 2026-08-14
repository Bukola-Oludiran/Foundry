import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createConfiguredFoundryServer } from "../../pi-pool/src/server.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface ManagedLocalWorker {
  server: Server;
  url: string;
}

/**
 * Starts a worker owned exclusively by this MCP process.
 *
 * The configured URL determines whether local management is appropriate and
 * which loopback interface to use, but its port is intentionally ignored. A
 * session-private ephemeral port prevents one stdio client's shutdown from
 * taking another client's shared worker away.
 */
export async function ensureLocalWorker(workerUrl = process.env.FOUNDRY_WORKER_URL ?? "http://127.0.0.1:8787"): Promise<ManagedLocalWorker | null> {
  if (workerUrl === "disabled" || process.env.FOUNDRY_MANAGE_LOCAL_WORKER === "0") return null;
  const configured = new URL(workerUrl);
  if (configured.protocol !== "http:" || !LOOPBACK.has(configured.hostname)) return null;

  process.env.FOUNDRY_TESTER ??= "piston";
  const server = await createConfiguredFoundryServer();
  const hostname = configured.hostname.replace(/^\[(.*)\]$/, "$1");
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, hostname, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Managed Foundry worker did not expose a listening address");
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return { server, url: `http://${host}:${address.port}` };
}

export async function closeLocalWorker(worker: ManagedLocalWorker | null): Promise<void> {
  if (!worker) return;
  await new Promise<void>((resolve, reject) => worker.server.close((error) => error ? reject(error) : resolve()));
}

import type { JobContext } from "../src/contract.ts";

export function fixtureContext(
  jobId: string,
  network: "none" | "model-egress",
): JobContext {
  return {
    protocol_version: 1,
    job_id: jobId,
    run_id: "fixture-run",
    ir_digest: "0".repeat(64),
    base_commit: "fixture-base",
    resource_policy: {
      timeout_ms: 10_000,
      memory_mb: 256,
      cpu_count: 1,
      pids: 64,
      network,
    },
  };
}

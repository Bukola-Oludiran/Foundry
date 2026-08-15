import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FoundryHostClient, HostCommandError, RustSidecarRunner } from "../core/host-client.ts";
import { WorkspaceRegistry } from "../core/workspaces.ts";

const root = mkdtempSync(join(tmpdir(), "foundry-collaboration-live-"));
cpSync(resolve("ir/examples/string-utils.ir.json"), join(root, "candidate.ir.json"));
const binary = resolve("gr-host/target/debug/foundry-host");
const workspaces = new WorkspaceRegistry({ project: root });
const author = new FoundryHostClient(workspaces, new RustSidecarRunner(binary), "codex-test");
const critic = new FoundryHostClient(workspaces, new RustSidecarRunner(binary), "claude-test");

try {
  const begun = await author.beginArchitectureReview({ workspaceId: "project", ir: "candidate.ir.json", durabilityDir: ".foundry/architecture", idempotencyKey: "live-begin" });
  const first = begun.state.collaboration as any;
  assert.equal(first.phase, "awaiting_review");
  await assert.rejects(
    author.submitArchitectureReview({ workspaceId: "project", runId: first.run_id, durabilityDir: ".foundry/architecture", expectedRevision: 1, verdict: "approve", body: "self approval must fail", operationKey: "live-self-review" }),
    (error: unknown) => error instanceof HostCommandError && /independent/.test(error.message),
  );
  const changes = await critic.submitArchitectureReview({ workspaceId: "project", runId: first.run_id, durabilityDir: ".foundry/architecture", expectedRevision: 1, verdict: "changes_requested", body: "Exercise the durable revision path before approval.", operationKey: "live-review-one" });
  assert.equal((changes.state.collaboration as any).phase, "changes_requested");
  const revised = await author.reviseArchitectureDraft({ workspaceId: "project", runId: first.run_id, ir: "candidate.ir.json", durabilityDir: ".foundry/architecture", expectedRevision: 1, operationKey: "live-revision-two" });
  assert.equal((revised.state.collaboration as any).revision, 2);
  const approved = await critic.submitArchitectureReview({ workspaceId: "project", runId: first.run_id, durabilityDir: ".foundry/architecture", expectedRevision: 2, verdict: "approve", body: "Compiler-valid candidate and independent revision evidence confirmed.", operationKey: "live-review-two" });
  assert.equal((approved.state.collaboration as any).phase, "approved");
  console.log("VALID Codex author → durable Foundry draft → Claude critic");
} finally {
  await Promise.all([author.close(), critic.close()]);
}

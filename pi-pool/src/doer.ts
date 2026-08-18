// The doer (`POST /build`): implement one node's `provides` into its write_target,
// reading only its declared dependency interfaces. v1 uses single-shot synthesis
// (completeSimple-style) — a leaf/integrator is synthesis-shaped, so no agentic tool
// loop is needed yet (that's the FST+abortOnToolSuccess variant for later, multi-turn
// doers). Every write goes THROUGH the sandbox, so even a controlled write is scope-proven.

import type { BuildRequest, BuildRequestV2, BuildResult } from "./contract.ts";
import type { LlmClient } from "./llm.ts";
import { runSandboxed } from "./sandbox.ts";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { SpawnSyncReturns } from "node:child_process";

export const DOER_SYSTEM =
  "You implement exactly one module of a larger software system, to a fixed interface " +
  "contract. You never redefine your dependencies — you import them. You may respond with " +
  "`FOUNDRY_TOOL read <import_name>` to inspect one declared dependency. Otherwise output only code.";

const MAX_DOER_TURNS = 3;
const MAX_TOOL_BYTES = 256 * 1024;

/** Build the doer prompt from the node's contract + its dependency interfaces. */
export function assemblePrompt(req: BuildRequest | BuildRequestV2): string {
  const ops = req.provides.operations
    .map(
      (o) =>
        `  - ${o.signature}${o.description ? " — " + o.description : ""}` +
        (o.properties && o.properties.length
          ? `\n    contract: ${o.properties.join("; ")}`
          : ""),
    )
    .join("\n");
  const deps = req.requires.length
    ? req.requires
        .map(
          (d) =>
            `  - from ${d.import_name} import ${d.interface.operations.map((o) => o.name).join(", ")}` +
            `   (${d.interface.operations.map((o) => o.signature).join("; ")})`,
        )
        .join("\n")
    : "  (none)";
  const integrator =
    req.kind === "integrator"
      ? `\nThis is an integrator: compose the dependencies to satisfy the interface.` +
        (req.composition ? ` Hint: ${req.composition}` : "")
      : "";
  return (
    `Implement the file \`${req.write_target}\` in ${req.language}.\n\n` +
    `Provide this interface:\n${ops}\n\n` +
    `Dependencies (import EXACTLY by these names; do not redefine them):\n${deps}\n${integrator}\n\n` +
    `Respond with ONLY the ${req.language} code, in a single fenced \`\`\`${req.language} block.`
  );
}

/** Pull the code out of an LLM response (first fenced block, else the whole text). */
export function extractCode(text: string): string {
  const m = text.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  return (m?.[1] ?? text).trim() + "\n";
}

const abs = (workspace: string, p: string): string =>
  isAbsolute(p) ? p : join(workspace, p);

export async function buildNode(
  req: BuildRequest | BuildRequestV2,
  llm: LlmClient,
  sandboxRunner: (
    scope: Parameters<typeof runSandboxed>[0],
    command: string,
    args: string[],
    opts?: { cwd?: string; input?: string },
  ) => SpawnSyncReturns<string> = runSandboxed,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const target = abs(req.workspace, req.write_target);
  // The host/compiler owns the workspace file layout; ensure the target exists so the
  // sandboxed write (and realpath) resolve. This is host setup, not the doer writing.
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, "");

  let prompt = assemblePrompt(req);
  let code: string | null = null;
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (let turn = 1; turn <= MAX_DOER_TURNS; turn++) {
    if (signal?.aborted) throw new Error("job cancelled");
    const response = await llm.complete({
      system: DOER_SYSTEM,
      prompt,
      maxTokens: 2048,
      meta: {
        node_id: req.node_id,
        kind: req.kind,
        attempt: req.attempt,
        turn,
      },
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    if (signal?.aborted) throw new Error("job cancelled");
    const tool = response.text
      .trim()
      .match(/^FOUNDRY_TOOL\s+read\s+([a-zA-Z0-9_-]+)$/);
    if (!tool) {
      code = extractCode(response.text);
      break;
    }
    const dependency = req.requires.find(
      (candidate) => candidate.import_name === tool[1],
    );
    if (!dependency) {
      prompt += `\n\nTool error: '${tool[1]}' is not a declared dependency. Choose a declared import or emit code.`;
      continue;
    }
    const content = readFileSync(
      abs(req.workspace, dependency.read_path),
      "utf8",
    );
    if (Buffer.byteLength(content) > MAX_TOOL_BYTES) {
      prompt += `\n\nTool error: '${tool[1]}' exceeds the ${MAX_TOOL_BYTES}-byte read limit. Emit code from its interface.`;
      continue;
    }
    prompt += `\n\nTool result for declared dependency '${tool[1]}':\n\`\`\`${req.language}\n${content}\n\`\`\``;
  }
  if (code === null) {
    return {
      node_id: req.node_id,
      ok: false,
      wrote: [],
      summary: "doer exhausted its bounded tool loop",
      error: `no code after ${MAX_DOER_TURNS} turns`,
      failure_code: "TOOL_LOOP_EXHAUSTED",
      artifact: null,
      usage,
    };
  }
  if (signal?.aborted) throw new Error("job cancelled");

  // Write through the sandbox: scoped to this node's target + read-only on its read-set.
  const scope = {
    workspace: req.workspace,
    readPaths: req.requires.map((r) => abs(req.workspace, r.read_path)),
    writeTarget: target,
    allowNetwork: false,
    resourcePolicy: req.resource_policy,
  };
  const w = sandboxRunner(scope, "tee", [target], {
    input: code,
  });
  if (w.status !== 0) {
    return {
      node_id: req.node_id,
      ok: false,
      wrote: [],
      summary: "sandboxed write failed",
      error: (w.stderr || "").trim() || `exit ${w.status}`,
      failure_code: "SANDBOX_WRITE_FAILED",
      artifact: null,
      usage,
    };
  }
  const content = readFileSync(target);
  return {
    node_id: req.node_id,
    ok: true,
    wrote: [req.write_target],
    summary: `wrote ${code.split("\n").length} lines to ${req.write_target}`,
    error: null,
    failure_code: null,
    artifact: {
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
      media_type: "text/plain; charset=utf-8",
    },
    usage,
  };
}

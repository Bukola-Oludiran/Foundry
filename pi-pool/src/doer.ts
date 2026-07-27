// The doer (`POST /build`): implement one node's `provides` into its write_target,
// reading only its declared dependency interfaces. v1 uses single-shot synthesis
// (completeSimple-style) — a leaf/integrator is synthesis-shaped, so no agentic tool
// loop is needed yet (that's the FST+abortOnToolSuccess variant for later, multi-turn
// doers). Every write goes THROUGH the sandbox, so even a controlled write is scope-proven.

import type { BuildRequest, BuildResult } from "./contract.ts";
import type { LlmClient } from "./llm.ts";
import { runSandboxed } from "./sandbox.ts";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";

export const DOER_SYSTEM =
  "You implement exactly one module of a larger software system, to a fixed interface " +
  "contract. You never redefine your dependencies — you import them. You output only code.";

/** Build the doer prompt from the node's contract + its dependency interfaces. */
export function assemblePrompt(req: BuildRequest): string {
  const ops = req.provides.operations
    .map(
      (o) =>
        `  - ${o.signature}${o.description ? " — " + o.description : ""}` +
        (o.properties && o.properties.length ? `\n    contract: ${o.properties.join("; ")}` : ""),
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
  return (m ? m[1] : text).trim() + "\n";
}

const abs = (workspace: string, p: string): string => (isAbsolute(p) ? p : join(workspace, p));

export async function buildNode(req: BuildRequest, llm: LlmClient): Promise<BuildResult> {
  const target = abs(req.workspace, req.write_target);
  // The host/compiler owns the workspace file layout; ensure the target exists so the
  // sandboxed write (and realpath) resolve. This is host setup, not the doer writing.
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, "");

  const res = await llm.complete({
    system: DOER_SYSTEM,
    prompt: assemblePrompt(req),
    maxTokens: 2048,
    meta: { node_id: req.node_id, kind: req.kind, attempt: req.attempt },
  });
  const code = extractCode(res.text);

  // Write through the sandbox: scoped to this node's target + read-only on its read-set.
  const scope = {
    workspace: req.workspace,
    readPaths: req.requires.map((r) => abs(req.workspace, r.read_path)),
    writeTarget: target,
  };
  const w = runSandboxed(scope, "/bin/sh", ["-c", `cat > "${target}"`], { input: code });
  if (w.status !== 0) {
    return {
      node_id: req.node_id,
      ok: false,
      wrote: [],
      summary: "sandboxed write failed",
      error: (w.stderr || "").trim() || `exit ${w.status}`,
      usage: res.usage,
    };
  }
  return {
    node_id: req.node_id,
    ok: true,
    wrote: [req.write_target],
    summary: `wrote ${code.split("\n").length} lines to ${req.write_target}`,
    error: null,
    usage: res.usage,
  };
}

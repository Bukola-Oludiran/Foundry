import type { ArchitectureJobRequest, ArchitectureResult } from "./contract.ts";
import type { LlmClient } from "./llm.ts";

const SYSTEM = `You are Foundry's architecture agent. Return one strict JSON object with exactly
two keys: "ir" (Foundry Dyad IR version 1) and "rationale" (a concise string). The IR must form a
complete ownership tree and acyclic dependency graph. Every node has a parent-owned deterministic
acceptance mandate. Use only allowed languages and safe repository-relative output paths. Do not
include markdown fences or implementation code.`;

export async function proposeArchitecture(
  job: ArchitectureJobRequest,
  llm: LlmClient,
): Promise<ArchitectureResult> {
  const feedback = job.diagnostics.length
    ? `\nThe prior proposal was rejected. Repair every diagnostic:\n- ${job.diagnostics.join("\n- ")}`
    : "";
  const response = await llm.complete({
    system: SYSTEM,
    prompt: `ArchitectureRequest:\n${JSON.stringify(job.request)}${feedback}`,
    maxTokens: 8192,
    meta: { role: "architect", attempt: job.attempt },
  });
  const cleaned = response.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(
      `architect returned invalid JSON: ${String((error as Error).message)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("architect response must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "ir" && key !== "rationale") ||
    !record.ir ||
    typeof record.rationale !== "string"
  ) {
    throw new Error("architect response requires exactly ir and rationale");
  }
  return {
    proposal: record.ir,
    rationale: record.rationale,
    usage: response.usage,
  };
}

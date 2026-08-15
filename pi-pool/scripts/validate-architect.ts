import { readFileSync } from "node:fs";
import { proposeArchitecture } from "../src/architect.ts";
import { StubLlm } from "../src/llm.ts";
import { validateArchitectureRequest } from "../src/validation.ts";

const ir = JSON.parse(
  readFileSync(
    new URL("../../ir/examples/string-utils.ir.json", import.meta.url),
    "utf8",
  ),
) as unknown;
const request = validateArchitectureRequest({
  protocol_version: 1,
  job_id: "architecture-fixture-1",
  attempt: 2,
  diagnostics: ["prior proposal used an unsafe path"],
  request: {
    architecture_version: 1,
    product_spec: "Build deterministic string utilities",
    repository: ".",
    base_revision: "fixture-base",
    allowed_languages: ["python", "typescript", "go"],
    policy_constraints: ["no network in tests"],
  },
});
let sawFeedback = false;
const result = await proposeArchitecture(
  request,
  new StubLlm((prompt) => {
    sawFeedback = prompt.prompt.includes("unsafe path");
    return JSON.stringify({
      ir,
      rationale: "A small dependency-first design.",
    });
  }),
);
if (!sawFeedback || result.rationale.length === 0) {
  throw new Error(
    "architect did not receive repair diagnostics or emit rationale",
  );
}
console.log("OK strict architecture request, feedback, IR, and rationale");

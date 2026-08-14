import { assemblePrompt } from "../src/doer.ts";
import type { BuildRequest } from "../src/contract.ts";

const base: BuildRequest = {
  node_id: "example",
  kind: "leaf",
  language: "python",
  workspace: "/tmp/foundry-feedback",
  write_target: "src/example.py",
  provides: {
    name: "Example",
    operations: [{ name: "example", signature: "example(s: string) -> string" }],
  },
  requires: [],
  composition: null,
  children: [],
  attempt: 1,
  feedback: null,
};

const first = assemblePrompt(base);
if (first.includes("independent tester rejected")) {
  throw new Error("first-attempt prompt must not claim a prior rejection");
}

const feedback = "collapse: expected a-b, actual a---b";
const retry = assemblePrompt({ ...base, attempt: 2, feedback });
if (!retry.includes("independent tester rejected") || !retry.includes(feedback)) {
  throw new Error("retry prompt did not carry the independent tester's feedback");
}

console.log("✅ retry prompt carries tester feedback; first attempt remains clean");

import { buildNode } from "../src/doer.ts";
import { StubLlm } from "../src/llm.ts";
import type { BuildRequest } from "../src/contract.ts";
import { fixtureContext } from "./context.ts";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

const workspace = mkdtempSync(join(tmpdir(), "foundry-doer-tools-"));
mkdirSync(join(workspace, "src"));
writeFileSync(
  join(workspace, "src/dependency.py"),
  "def dependency(): return 41\n",
);

const request: BuildRequest = {
  ...fixtureContext("doer:build:1", "model-egress"),
  node_id: "answer",
  kind: "leaf",
  language: "python",
  workspace,
  write_target: "src/answer.py",
  provides: {
    name: "Answer",
    operations: [{ name: "answer", signature: "answer() -> number" }],
  },
  requires: [
    {
      node: "dependency",
      interface: {
        name: "Dependency",
        operations: [
          { name: "dependency", signature: "dependency() -> number" },
        ],
      },
      import_name: "dependency",
      read_path: "src/dependency.py",
    },
  ],
  composition: null,
  children: [],
  attempt: 1,
  feedback: null,
};

let turns = 0;
const llm = new StubLlm((llmRequest) => {
  turns++;
  if (turns === 1) return "FOUNDRY_TOOL read dependency";
  if (!llmRequest.prompt.includes("def dependency(): return 41")) {
    throw new Error(
      "declared dependency tool result was not returned to the doer",
    );
  }
  return "```python\nfrom dependency import dependency\ndef answer(): return dependency() + 1\n```";
});

const fakeSandbox = (
  _scope: unknown,
  _command: string,
  args: string[],
  opts: { input?: string } = {},
): SpawnSyncReturns<string> => {
  writeFileSync(args[0]!, opts.input ?? "");
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  };
};

try {
  const result = await buildNode(request, llm, fakeSandbox);
  const written = readFileSync(join(workspace, request.write_target), "utf8");
  const ok =
    result.ok &&
    turns === 2 &&
    written.includes("dependency() + 1") &&
    result.artifact !== null;
  console.log(
    `${ok ? "OK" : "BAD"} bounded declared-dependency tool loop (${turns} turns)`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

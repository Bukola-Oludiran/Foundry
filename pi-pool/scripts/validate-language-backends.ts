import { executeTest } from "../src/tester.ts";
import { buildNode } from "../src/doer.ts";
import { StubLlm } from "../src/llm.ts";
import type { BuildRequest, TestRequest } from "../src/contract.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContext } from "./context.ts";
import type { SpawnSyncReturns } from "node:child_process";

const fixtures = [
  {
    language: "python",
    target: "src/doubler.py",
    source: "def double(value):\n    return value * 2\n",
    call: "double(21)",
  },
  {
    language: "typescript",
    target: "src/doubler.ts",
    source:
      "export function double(value: number): number { return value * 2; }\n",
    call: "double(21)",
  },
  {
    language: "go",
    target: "src/doubler.go",
    source: "package main\n\nfunc Double(value int) int { return value * 2 }\n",
    call: "Double(21)",
  },
] as const;

let failures = 0;
for (const fixture of fixtures) {
  const workspace = mkdtempSync(join(tmpdir(), `foundry-${fixture.language}-`));
  try {
    mkdirSync(join(workspace, "src"));
    const buildRequest: BuildRequest = {
      ...fixtureContext(`${fixture.language}:build`, "model-egress"),
      node_id: "doubler",
      kind: "leaf",
      language: fixture.language,
      workspace,
      write_target: fixture.target,
      provides: {
        name: "Doubler",
        operations: [{ name: "double", signature: "double(value) -> number" }],
      },
      requires: [],
      composition: null,
      children: [],
      attempt: 1,
      feedback: null,
    };
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
    const build = await buildNode(
      buildRequest,
      new StubLlm(() => fixture.source),
      fakeSandbox,
    );
    const request: TestRequest = {
      ...fixtureContext(`${fixture.language}:test`, "none"),
      node_id: "doubler",
      language: fixture.language,
      workspace,
      write_target: fixture.target,
      provides: {
        name: "Doubler",
        operations: [{ name: "double", signature: "double(value) -> number" }],
      },
      acceptance: {
        mandate_owner: "spec",
        language: fixture.language,
        cases: [{ name: "doubles", call: fixture.call, expect: 42 }],
      },
      deps: [],
    };
    const result = await executeTest(request);
    const green =
      build.ok && build.artifact !== null && result.verdict === "green";
    if (!green) failures++;
    console.log(
      `${green ? "GREEN" : "RED  "} ${fixture.language} build + test`,
    );
    if (!green) console.error(build, result.failures);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

process.exitCode = failures === 0 ? 0 : 1;

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRequest } from "../src/contract.ts";
import { extractImplementationEvidence } from "../src/evidence.ts";
import { languageBackend } from "../src/language-backend.ts";
import { fixtureContext } from "./context.ts";

const fixtures = [
  {
    language: "python",
    target: "src/service.py",
    source:
      "SECRET = 'must-not-leak'\nstate = 1\ndef Execute(value):\n    local = value\n    return local\nclass Store:\n    count = 0\n    def Save(self, value): return value\n",
    expected: ["SECRET", "state", "Execute", "Store", "count", "Save"],
  },
  {
    language: "typescript",
    target: "src/service.ts",
    source:
      "const secret = 'must-not-leak'; export function execute(value: number): number { const local = value; return local; } export class Store { count: number = 0; save(value: number) { return value; } }",
    expected: ["secret", "execute", "Store", "count", "save"],
  },
  {
    language: "go",
    target: "src/service.go",
    source:
      'package service\nconst Secret = "must-not-leak"\nvar State int\ntype Store struct { Count int; hidden int }\nfunc Execute(value int) int { local := value; return local }\n',
    expected: ["Secret", "State", "Store", "Count", "hidden", "Execute"],
  },
] as const;

let failures = 0;
for (const fixture of fixtures) {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-evidence-"));
  try {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, fixture.target), fixture.source);
    const request: TestRequest = {
      ...fixtureContext(`${fixture.language}:evidence`, "none"),
      proposal_id: "proposal-1",
      revision_id: "revision-1",
      semantic_digest: "semantic-1",
      attempt: 2,
      node_id: "service",
      language: fixture.language,
      workspace,
      write_target: fixture.target,
      provides: {
        name: "Service",
        operations: [{ name: "execute", signature: "execute(value)" }],
      },
      acceptance: {
        mandate_owner: "spec",
        language: fixture.language,
        cases: [],
      },
      deps: [],
    };
    const evidence = extractImplementationEvidence(
      request,
      [],
      languageBackend(fixture.language),
      { duration_ms: 10, memory_mb: null },
    );
    const names = new Set(evidence.symbols.map((symbol) => symbol.name));
    const valid =
      fixture.expected.every((name) => names.has(name)) &&
      !names.has("local") &&
      !JSON.stringify(evidence).includes("must-not-leak") &&
      evidence.contract_mappings[0]?.status === "matched" &&
      evidence.revision_id === "revision-1" &&
      evidence.semantic_digest === "semantic-1";
    if (!valid) failures += 1;
    console.log(
      `${valid ? "GREEN" : "RED  "} ${fixture.language} source evidence`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

process.exitCode = failures === 0 ? 0 : 1;

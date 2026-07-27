// Validates the deterministic /test runner-generator against local `python3`,
// driven by the REAL example IR (Foundry/ir/examples/string-utils.ir.json).
// This proves the /test verdict logic end-to-end minus the Piston executor swap:
//   - correct reference impls  -> every node GREEN
//   - a buggy hyphenate impl   -> hyphenate + its integrator go RED (blast radius)
//
// Run: node Foundry/pi-pool/scripts/validate-runner-gen.ts

import { generatePythonRunner, parseVerdict } from "../src/runner-gen.ts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const IR_PATH = "/Users/damioludiran/jays-workspace/Foundry/ir/examples/string-utils.ir.json";
const SCRATCH = "/private/tmp/claude-501/-Users-damioludiran-jays-workspace/a5be29ce-6b3e-4e08-8895-00df35313dae/scratchpad";

const sanitize = (id: string): string => id.replace(/-/g, "_");

// Reference (correct) flat modules — what a doer would produce (flat imports, as in Piston).
const CORRECT: Record<string, string> = {
  lowercase: `def lower(s):\n    return s.lower()\n`,
  trim: `def trim(s):\n    return s.strip()\n`,
  hyphenate:
    `import re\n\n` +
    `def hyphenate(s):\n` +
    `    s = re.sub(r"\\s+", "-", s.strip())\n` +
    `    s = re.sub(r"[^a-z0-9-]", "", s)\n` +
    `    s = re.sub(r"-+", "-", s).strip("-")\n` +
    `    return s\n`,
  string_utils:
    `from lowercase import lower\n` +
    `from trim import trim\n` +
    `from hyphenate import hyphenate\n\n` +
    `def slugify(s):\n    return hyphenate(trim(lower(s)))\n`,
};

// A plausible doer mistake: forgets to collapse internal whitespace runs.
const BUGGY_HYPHENATE =
  `import re\n\n` +
  `def hyphenate(s):\n` +
  `    s = re.sub(r"[^a-z0-9\\s-]", "", s.strip())\n` +
  `    return s.replace(" ", "-")\n`;

interface Node {
  id: string;
  provides: { operations: { name: string }[] };
  acceptance: { cases: { name: string; call?: string; expect?: unknown }[] };
}

function testNode(node: Node, modules: Record<string, string>): { verdict: "green" | "red"; passed: number; failed: number; detail: string } {
  const dir = mkdtempSync(join(SCRATCH, "foundry-test-"));
  try {
    for (const [name, content] of Object.entries(modules)) {
      writeFileSync(join(dir, `${name}.py`), content);
    }
    const runner = generatePythonRunner({
      moduleImportName: sanitize(node.id),
      opNames: node.provides.operations.map((o) => o.name),
      cases: node.acceptance.cases,
    });
    writeFileSync(join(dir, "__runner.py"), runner);
    const proc = spawnSync("python3", ["__runner.py"], { cwd: dir, encoding: "utf-8" });
    const v = parseVerdict(proc.stdout ?? "");
    if (!v) {
      return { verdict: "red", passed: 0, failed: -1, detail: `no verdict; stderr: ${(proc.stderr ?? "").trim().slice(0, 200)}` };
    }
    const detail = v.failures.length
      ? v.failures.map((f) => `${f.case}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}${f.error ? " err=" + f.error : ""}`).join("; ")
      : "all cases pass";
    return { verdict: v.failed === 0 ? "green" : "red", passed: v.passed, failed: v.failed, detail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- run ----
const ir = JSON.parse(readFileSync(IR_PATH, "utf-8")) as { nodes: Node[] };
let failures = 0;

console.log("== happy path (correct impls) — expect all GREEN ==");
for (const node of ir.nodes) {
  const r = testNode(node, CORRECT);
  const ok = r.verdict === "green";
  if (!ok) failures++;
  console.log(`  ${ok ? "GREEN" : "RED  "} ${node.id.padEnd(14)} ${r.passed}p/${r.failed}f  ${ok ? "" : "← " + r.detail}`);
}

console.log("\n== induced failure (buggy hyphenate) — expect hyphenate + string-utils RED, leaves GREEN ==");
const broken = { ...CORRECT, hyphenate: BUGGY_HYPHENATE };
const expectRed = new Set(["hyphenate", "string-utils"]);
for (const node of ir.nodes) {
  const r = testNode(node, broken);
  const shouldBeRed = expectRed.has(node.id);
  const asExpected = shouldBeRed ? r.verdict === "red" : r.verdict === "green";
  if (!asExpected) failures++;
  console.log(`  ${(r.verdict === "green" ? "GREEN" : "RED  ")} ${node.id.padEnd(14)} ${asExpected ? "(as expected)" : "✗ UNEXPECTED"}  ${r.verdict === "red" ? "← " + r.detail : ""}`);
}

console.log(`\n${failures === 0 ? "✅ runner-gen validated" : `❌ ${failures} unexpected outcome(s)`}`);
process.exit(failures === 0 ? 0 : 1);

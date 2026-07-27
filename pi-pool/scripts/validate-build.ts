// End-to-end data-plane slice (stub LLM, local python3) — proves M1a+M1b+M1c together:
//   contract → doer prompt → (stub) LLM → SANDBOXED write → tester verdict.
// Builds every node bottom-up through buildNode (writes via Seatbelt), then runs the
// deterministic tester on each. Then swaps in a buggy hyphenate and shows the failure
// blast-radius flow through the REAL build pipeline (hyphenate + its integrator red).
//
// Run: node Foundry/pi-pool/scripts/validate-build.ts   (macOS; no Piston/LLM needed)

import { buildNode } from "../src/doer.ts";
import { StubLlm, type LlmRequest } from "../src/llm.ts";
import { generatePythonRunner, parseVerdict } from "../src/runner-gen.ts";
import type { BuildRequest, DepRef, Interface } from "../src/contract.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const IR = new URL("../../ir/examples/string-utils.ir.json", import.meta.url);
const SCRATCH = tmpdir();
const sanitize = (id: string): string => id.replace(/-/g, "_");
const fence = (code: string): string => "```python\n" + code + "\n```";

interface IrNode {
  id: string;
  kind: "leaf" | "integrator";
  provides: Interface;
  requires?: { node: string; interface: string }[];
  implementation: { write_target: string; composition?: string; children?: string[] };
  acceptance: { cases: { name: string; call?: string; expect?: unknown }[] };
}

// --- canned "LLM outputs" (fenced code) keyed by node id ---
const IMPL: Record<string, string> = {
  lowercase: fence(`def lower(s):\n    return s.lower()`),
  trim: fence(`def trim(s):\n    return s.strip()`),
  hyphenate: fence(
    `import re\n\ndef hyphenate(s):\n    s = re.sub(r"\\s+", "-", s.strip())\n    s = re.sub(r"[^a-z0-9-]", "", s)\n    s = re.sub(r"-+", "-", s).strip("-")\n    return s`,
  ),
  "string-utils": fence(
    `from lowercase import lower\nfrom trim import trim\nfrom hyphenate import hyphenate\n\ndef slugify(s):\n    return hyphenate(trim(lower(s)))`,
  ),
};
const BUGGY_HYPHENATE = fence(
  `import re\n\ndef hyphenate(s):\n    s = re.sub(r"[^a-z0-9\\s-]", "", s.strip())\n    return s.replace(" ", "-")  # BUG: no whitespace-run collapse`,
);

const ir = JSON.parse(readFileSync(IR, "utf-8")) as { nodes: IrNode[] };
const byId = new Map(ir.nodes.map((n) => [n.id, n]));

function toBuildRequest(node: IrNode, workspace: string): BuildRequest {
  const requires: DepRef[] = (node.requires ?? []).map((r) => {
    const p = byId.get(r.node)!;
    return { node: r.node, interface: p.provides, import_name: sanitize(r.node), read_path: p.implementation.write_target };
  });
  return {
    node_id: node.id,
    kind: node.kind,
    language: "python",
    workspace,
    write_target: node.implementation.write_target,
    provides: node.provides,
    requires,
    composition: node.implementation.composition ?? null,
    children: (node.implementation.children ?? []).map((c) => ({
      node: c,
      import_name: sanitize(c),
      read_path: byId.get(c)!.implementation.write_target,
    })),
    attempt: 1,
    feedback: null,
  };
}

function topoOrder(nodes: IrNode[]): IrNode[] {
  const indeg = new Map(nodes.map((n) => [n.id, (n.requires ?? []).length]));
  const succ = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const r of n.requires ?? []) succ.get(r.node)!.push(n.id);
  const order: string[] = [];
  let frontier = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort();
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      order.push(id);
      for (const d of succ.get(id)!) {
        indeg.set(d, indeg.get(d)! - 1);
        if (indeg.get(d) === 0) next.push(d);
      }
    }
    frontier = next.sort();
  }
  return order.map((id) => byId.get(id)!);
}

function testNode(node: IrNode, srcDir: string): { verdict: "green" | "red"; detail: string } {
  const runner = generatePythonRunner({
    moduleImportName: sanitize(node.id),
    opNames: node.provides.operations.map((o) => o.name),
    cases: node.acceptance.cases,
  });
  writeFileSync(join(srcDir, "__runner.py"), runner);
  const proc = spawnSync("python3", ["__runner.py"], { cwd: srcDir, encoding: "utf-8" });
  const v = parseVerdict(proc.stdout ?? "");
  if (!v) return { verdict: "red", detail: `no verdict; ${(proc.stderr ?? "").trim().slice(0, 120)}` };
  const detail = v.failures.length
    ? v.failures.map((f) => `${f.case}: exp ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`).join("; ")
    : "all cases pass";
  return { verdict: v.failed === 0 ? "green" : "red", detail };
}

async function main() {
  const ws = mkdtempSync(join(SCRATCH, "foundry-build-"));
  const srcDir = join(ws, "src");
  mkdirSync(srcDir);
  let bad = 0;
  const order = topoOrder(ir.nodes);

  console.log("== M1c: build every node bottom-up (doer stub → SANDBOXED write), then verify ==");
  console.log(`  build order: ${order.map((n) => n.id).join(" → ")}\n`);

  const stub = new StubLlm((req: LlmRequest) => IMPL[(req.meta?.node_id as string) ?? ""] ?? "```python\n# no impl\n```");
  for (const node of order) {
    const r = await buildNode(toBuildRequest(node, ws), stub);
    console.log(`  ${r.ok ? "BUILT" : "FAIL "} ${node.id.padEnd(14)} ${r.ok ? r.summary : "← " + r.error}`);
    if (!r.ok) bad++;
  }
  console.log();
  for (const node of ir.nodes) {
    const t = testNode(node, srcDir);
    const ok = t.verdict === "green";
    if (!ok) bad++;
    console.log(`  ${ok ? "GREEN" : "RED  "} ${node.id.padEnd(14)} ${ok ? "" : "← " + t.detail}`);
  }

  console.log("\n== induced failure: doer emits a buggy hyphenate — expect hyphenate + string-utils RED ==");
  const buggyStub = new StubLlm((req: LlmRequest) => {
    const id = (req.meta?.node_id as string) ?? "";
    return id === "hyphenate" ? BUGGY_HYPHENATE : IMPL[id] ?? "```python\n# no impl\n```";
  });
  await buildNode(toBuildRequest(byId.get("hyphenate")!, ws), buggyStub); // rebuild only hyphenate
  const expectRed = new Set(["hyphenate", "string-utils"]);
  for (const node of ir.nodes) {
    const t = testNode(node, srcDir);
    const asExpected = expectRed.has(node.id) ? t.verdict === "red" : t.verdict === "green";
    if (!asExpected) bad++;
    console.log(`  ${t.verdict === "green" ? "GREEN" : "RED  "} ${node.id.padEnd(14)} ${asExpected ? "(as expected)" : "✗ UNEXPECTED"} ${t.verdict === "red" ? "← " + t.detail : ""}`);
  }

  rmSync(ws, { recursive: true, force: true });
  console.log(`\n${bad === 0 ? "✅ M1c data-plane loop validated (contract → doer → sandboxed write → tester)" : `❌ ${bad} failure(s)`}`);
  process.exit(bad === 0 ? 0 : 1);
}
main();

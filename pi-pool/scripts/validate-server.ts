// Drives the pi-pool HTTP server end-to-end: bottom-up POST /build for every node,
// then POST /test each, asserting green. Proves the data plane as a live service
// (stub LLM + local python3), which is exactly what the M3 GraphReact host will call.
//
// Run: node Foundry/pi-pool/scripts/validate-server.ts   (macOS; no Piston/LLM/key)

import { createFoundryServer } from "../src/server.ts";
import { sandboxAvailability } from "../src/sandbox.ts";
import { fixtureContext } from "./context.ts";
import { StubLlm, type LlmRequest } from "../src/llm.ts";
import type {
  BuildRequest,
  TestRequest,
  DepRef,
  Interface,
  BuildResult,
  TestResult,
} from "../src/contract.ts";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";

const IR = new URL("../../ir/examples/string-utils.ir.json", import.meta.url);
const sandbox = sandboxAvailability();
if (!sandbox.available) {
  console.log(`SKIP — sandbox unavailable (${sandbox.reason})`);
  process.exit(0);
}
const SCRATCH = tmpdir();
const sanitize = (id: string): string => id.replace(/-/g, "_");
const fence = (code: string): string => "```python\n" + code + "\n```";

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

interface IrNode {
  id: string;
  kind: "leaf" | "integrator";
  provides: Interface;
  requires?: { node: string; interface: string }[];
  implementation: {
    write_target: string;
    composition?: string;
    children?: string[];
  };
  acceptance: TestRequest["acceptance"];
}

const ir = JSON.parse(readFileSync(IR, "utf-8")) as { nodes: IrNode[] };
const byId = new Map(ir.nodes.map((n) => [n.id, n]));

const depsOf = (node: IrNode) =>
  (node.requires ?? []).map((r) => ({
    import_name: sanitize(r.node),
    read_path: byId.get(r.node)!.implementation.write_target,
  }));

function toBuild(node: IrNode, workspace: string): BuildRequest {
  const requires: DepRef[] = (node.requires ?? []).map((r) => ({
    node: r.node,
    interface: byId.get(r.node)!.provides,
    import_name: sanitize(r.node),
    read_path: byId.get(r.node)!.implementation.write_target,
  }));
  return {
    ...fixtureContext(`${node.id}:build:1`, "model-egress"),
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

function toTest(node: IrNode, workspace: string): TestRequest {
  return {
    ...fixtureContext(`${node.id}:test:1`, "none"),
    node_id: node.id,
    language: "python",
    workspace,
    write_target: node.implementation.write_target,
    provides: node.provides,
    acceptance: node.acceptance,
    deps: depsOf(node),
  };
}

function topoOrder(nodes: IrNode[]): IrNode[] {
  const indeg = new Map(nodes.map((n) => [n.id, (n.requires ?? []).length]));
  const succ = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes)
    for (const r of n.requires ?? []) succ.get(r.node)!.push(n.id);
  const order: string[] = [];
  let frontier = nodes
    .filter((n) => indeg.get(n.id) === 0)
    .map((n) => n.id)
    .sort();
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

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const r = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fixture-token",
    },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

async function main() {
  const ws = mkdtempSync(join(SCRATCH, "foundry-srv-"));
  mkdirSync(join(ws, "src"));
  const llm = new StubLlm(
    (r: LlmRequest) => IMPL[(r.meta?.node_id as string) ?? ""] ?? "# none\n",
  );
  const server = createFoundryServer({
    llm,
    authToken: "fixture-token",
    workspaceRoot: ws,
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let bad = 0;

  try {
    const health = await (await fetch(base + "/health")).json();
    console.log(
      `== pi-pool live at ${base} (health: ${JSON.stringify(health)}) ==\n`,
    );

    console.log("-- POST /build (bottom-up) --");
    for (const node of topoOrder(ir.nodes)) {
      const r = await post<BuildResult>(base, "/build", toBuild(node, ws));
      if (!r.ok) bad++;
      console.log(
        `  ${r.ok ? "BUILT" : "FAIL "} ${node.id.padEnd(14)} ${r.ok ? r.summary : "← " + r.error}`,
      );
    }

    console.log("\n-- POST /test --");
    for (const node of ir.nodes) {
      const r = await post<TestResult>(base, "/test", toTest(node, ws));
      const ok = r.verdict === "green";
      if (!ok) bad++;
      console.log(
        `  ${ok ? "GREEN" : "RED  "} ${node.id.padEnd(14)} ${r.passed}p/${r.failed}f ${ok ? "" : "← " + JSON.stringify(r.failures[0])}`,
      );
    }
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(ws, { recursive: true, force: true });
  }

  console.log(
    `\n${bad === 0 ? "✅ pi-pool HTTP server validated (build + test over HTTP, green)" : `❌ ${bad} failure(s)`}`,
  );
  process.exit(bad === 0 ? 0 : 1);
}
main();

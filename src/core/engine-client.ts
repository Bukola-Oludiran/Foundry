import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AnyFoundryArchitecture } from "./types.ts";
import { primaryTarget } from "./delivery.ts";
import { compileProductArchitecture } from "./product.ts";

export interface EngineBuildState {
  build_id: string;
  architecture_revision: string;
  plan: EnginePlan;
  nodes: Record<string, "pending" | "waiting_children" | "ready" | "leased" | "verifying" | "integration_ready" | "integrating" | "green" | "red" | "contract_weak" | "infrastructure_blocked" | "cancelled">;
  cancelled: boolean;
  assembly: "pending" | "running" | "green" | "red" | "cancelled";
}

export interface EnginePlan {
  order: string[];
  generations: string[][];
  dependents: Record<string, string[]>;
  dependencies: Record<string, string[]>;
  read_sets: Record<string, string[]>;
  import_names: Record<string, string>;
  write_targets: Record<string, string>;
  owners: Record<string, string | null>;
  product?: boolean;
  node_paths?: Record<string, string>;
  work_kinds?: Record<string, "implementation" | "integration">;
  work_actors?: Record<string, "client" | "system">;
  children?: Record<string, string[]>;
  node_invalidation?: Record<string, string[]>;
  deliverables?: Record<string, string>;
}

export interface EnginePort {
  compile(ir: AnyFoundryArchitecture): Promise<EnginePlan>;
  invalidationSet(ir: AnyFoundryArchitecture, nodeId: string): Promise<string[]>;
  startBuild(buildId: string, revisionId: string, ir: AnyFoundryArchitecture): Promise<EngineBuildState>;
  getBuild(buildId: string): Promise<EngineBuildState>;
  recordNode(buildId: string, nodeId: string, verdict: EngineBuildState["nodes"][string]): Promise<EngineBuildState>;
  recordAssembly(buildId: string, verdict: EngineBuildState["assembly"]): Promise<EngineBuildState>;
  cancelBuild(buildId: string): Promise<EngineBuildState>;
  close(): Promise<void>;
}

export class RustEngineClient implements EnginePort {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private closing = false;

  constructor(private readonly binary: string, private readonly args: string[] = []) { this.start(); }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.binary, this.args, { stdio: ["pipe", "pipe", "pipe"] }); this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk) => process.stderr.write(`[foundry-engine] ${chunk}`));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      const error = new Error(`Foundry engine exited (${code ?? signal ?? "unknown"})`);
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
      if (!this.closing) setTimeout(() => { if (!this.child && !this.closing) this.start(); }, 25);
    });
    child.on("error", (error) => { for (const call of this.pending.values()) call.reject(error); this.pending.clear(); });
    return child;
  }

  private onLine(line: string): void {
    let message: any; try { message = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(String(message.id)); if (!pending) return;
    this.pending.delete(String(message.id));
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Foundry engine client is closed")); const id = randomUUID(), child = this.start();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }

  compile(ir: AnyFoundryArchitecture): Promise<EnginePlan> { return this.call("compile_ir", { ir }); }
  async invalidationSet(ir: AnyFoundryArchitecture, nodeId: string): Promise<string[]> { return (await this.call<{ invalidates: string[] }>("invalidation_set", { ir, node_id: nodeId })).invalidates; }
  startBuild(buildId: string, revisionId: string, ir: AnyFoundryArchitecture): Promise<EngineBuildState> { return this.call("start_build", { build_id: buildId, architecture_revision: revisionId, ir }); }
  getBuild(buildId: string): Promise<EngineBuildState> { return this.call("get_build", { build_id: buildId }); }
  recordNode(buildId: string, nodeId: string, verdict: EngineBuildState["nodes"][string]): Promise<EngineBuildState> { return this.call("record_node", { build_id: buildId, node_id: nodeId, verdict }); }
  recordAssembly(buildId: string, verdict: EngineBuildState["assembly"]): Promise<EngineBuildState> { return this.call("record_assembly", { build_id: buildId, verdict }); }
  cancelBuild(buildId: string): Promise<EngineBuildState> { return this.call("cancel_build", { build_id: buildId }); }
  async close(): Promise<void> { this.closing = true; const child = this.child; if (!child) return; child.stdin.end(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
}

export class InProcessEngine implements EnginePort {
  private builds = new Map<string, EngineBuildState>();
  async compile(ir: AnyFoundryArchitecture): Promise<EnginePlan> {
    if (ir.version === 5) {
      const compiled = compileProductArchitecture(ir); if (!compiled.plan) throw new Error(compiled.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; ")); const product = compiled.plan;
      const dependencies = Object.fromEntries(product.workItems.map((item) => [item.workId, [...item.dependencies]])), dependents = Object.fromEntries(product.workItems.map((item) => [item.workId, [] as string[]]));
      for (const [consumer, providers] of Object.entries(dependencies)) for (const provider of providers) { if (!dependents[provider]) throw new Error(`unknown recursive work dependency ${provider}`); dependents[provider]!.push(consumer); }
      const degree = Object.fromEntries(Object.entries(dependencies).map(([work, providers]) => [work, providers.length])), order: string[] = [], generations: string[][] = []; let ready = Object.keys(degree).filter((work) => degree[work] === 0).sort();
      while (ready.length) { generations.push(ready); const next: string[] = []; for (const work of ready) { order.push(work); for (const consumer of dependents[work]!) if (--degree[consumer] === 0) next.push(consumer); } ready = next.sort(); }
      if (order.length !== product.workItems.length) throw new Error("combined recursive work graph has a cycle");
      const write_targets = Object.fromEntries(product.workItems.map((item) => [item.workId, item.writeTargets[0] ?? ""])), read_sets = Object.fromEntries(product.workItems.map((item) => [item.workId, item.dependencies.map((provider) => write_targets[provider]).filter(Boolean)]));
      return { order, generations, dependencies, dependents, read_sets, import_names: Object.fromEntries(product.workItems.map((item) => [item.workId, item.workId.replace(/[-/:]/g, "_")])), write_targets, owners: Object.fromEntries(product.workItems.map((item) => [item.workId, product.owners[item.nodePath]])), product: true, node_paths: Object.fromEntries(product.workItems.map((item) => [item.workId, item.nodePath])), work_kinds: Object.fromEntries(product.workItems.map((item) => [item.workId, item.kind])), work_actors: Object.fromEntries(product.workItems.map((item) => [item.workId, item.actor])), children: product.children, node_invalidation: product.invalidation, deliverables: Object.fromEntries(product.deliverables.map((entry) => [entry.deliverableId, entry.ownerPath])) };
    }
    const ids = new Set(ir.nodes.map((n) => n.id));
    if (!ids.has(ir.root)) throw new Error(`root ${ir.root} is not a node`);
    const dependencies: Record<string, string[]> = {}, dependents: Record<string, string[]> = {}, owners: Record<string, string | null> = {}, write_targets: Record<string, string> = {}, read_sets: Record<string, string[]> = {}, import_names: Record<string, string> = {};
    for (const node of ir.nodes) { dependencies[node.id] = []; dependents[node.id] = []; owners[node.id] = node.owner; write_targets[node.id] = primaryTarget(node).path; import_names[node.id] = node.id.replace(/-/g, "_"); }
    for (const node of ir.nodes) for (const req of node.requires ?? []) { if (!ids.has(req.node)) throw new Error(`unknown dependency ${req.node}`); dependencies[node.id]!.push(req.node); dependents[req.node]!.push(node.id); }
    const degree = Object.fromEntries(Object.entries(dependencies).map(([id, deps]) => [id, deps.length])); const order: string[] = [], generations: string[][] = [];
    let ready = Object.keys(degree).filter((id) => degree[id] === 0).sort();
    while (ready.length) { generations.push(ready); const next: string[] = []; for (const id of ready) { order.push(id); for (const c of dependents[id]!) if (--degree[c] === 0) next.push(c); } ready = next.sort(); }
    if (order.length !== ir.nodes.length) throw new Error("dependency graph has a cycle");
    for (const node of ir.nodes) read_sets[node.id] = dependencies[node.id]!.map((id) => write_targets[id]!);
    return { order, generations, dependents, dependencies, read_sets, import_names, write_targets, owners };
  }
  async invalidationSet(ir: AnyFoundryArchitecture, nodeId: string): Promise<string[]> { const plan = await this.compile(ir); if (plan.product) return [...(plan.node_invalidation?.[nodeId] ?? [])]; const out = new Set<string>(), q = [nodeId]; while (q.length) for (const c of plan.dependents[q.shift()!] ?? []) if (!out.has(c)) { out.add(c); q.push(c); } return [...out].sort(); }
  async startBuild(buildId: string, revisionId: string, ir: AnyFoundryArchitecture): Promise<EngineBuildState> { const plan = await this.compile(ir), nodes = Object.fromEntries(plan.order.map((id) => [id, plan.dependencies[id]!.length ? (plan.product ? "waiting_children" : "pending") : plan.work_actors?.[id] === "system" ? "integration_ready" : "ready"])) as EngineBuildState["nodes"]; const state: EngineBuildState = { build_id: buildId, architecture_revision: revisionId, plan, nodes, cancelled: false, assembly: "pending" }; this.builds.set(buildId, state); return structuredClone(state); }
  async getBuild(buildId: string): Promise<EngineBuildState> { const state = this.builds.get(buildId); if (!state) throw new Error(`unknown build ${buildId}`); return structuredClone(state); }
  async recordNode(buildId: string, nodeId: string, verdict: EngineBuildState["nodes"][string]): Promise<EngineBuildState> { const state = await this.getBuild(buildId); if (state.cancelled) throw new Error(`build ${buildId} is cancelled`); state.nodes[nodeId] = verdict; for (const id of state.plan.order) if (["pending", "waiting_children"].includes(state.nodes[id]!) && state.plan.dependencies[id]!.every((d) => state.nodes[d] === "green")) state.nodes[id] = state.plan.work_actors?.[id] === "system" ? "integration_ready" : "ready"; this.builds.set(buildId, state); return structuredClone(state); }
  async recordAssembly(buildId: string, verdict: EngineBuildState["assembly"]): Promise<EngineBuildState> { const state = await this.getBuild(buildId); if (!Object.values(state.nodes).every((node) => node === "green")) throw new Error("assembly requires every authored node green"); state.assembly = verdict; this.builds.set(buildId, state); return structuredClone(state); }
  async cancelBuild(buildId: string): Promise<EngineBuildState> { const state = await this.getBuild(buildId); state.cancelled = true; state.assembly = "cancelled"; for (const id of Object.keys(state.nodes)) if (!['green','red'].includes(state.nodes[id]!)) state.nodes[id] = "cancelled"; this.builds.set(buildId, state); return structuredClone(state); }
  async close(): Promise<void> {}
}

import { Resvg } from "@resvg/resvg-js";
import type { AnyFoundryArchitecture, ArchitecturePackageManifest, DiagramArtifact, FoundryArchitecture, FoundryProductArchitectureV5, FoundryProductNodeV5 } from "./types.ts";
import { ArtifactStore, sha256 } from "./artifacts.ts";

type Edge = { from: string; to: string; label?: string };
type View = { id: string; kind: DiagramArtifact["kind"]; title: string; nodes: Array<{ id: string; label: string }>; edges: Edge[]; reason?: string; positions?: Record<string, { x: number; y: number; width?: number; height?: number }> };

const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const puml = (value: string): string => value.replace(/[\r\n]/g, " ").replace(/["{}]/g, "_");

function legacyViews(ir: FoundryArchitecture): View[] {
  const baseNodes = ir.nodes.map((n) => ({ id: n.id, label: n.id }));
  const result: View[] = [
    { id: "ownership", kind: "ownership", title: "Ownership", nodes: baseNodes, edges: ir.nodes.filter((n) => n.owner).map((n) => ({ from: n.owner!, to: n.id, label: "owns" })) },
    { id: "dependencies", kind: "dependencies", title: "Dependencies", nodes: baseNodes, edges: ir.nodes.flatMap((n) => (n.requires ?? []).map((r) => ({ from: r.node, to: n.id, label: r.interface }))) },
    { id: "interfaces", kind: "interfaces", title: "Interfaces", nodes: ir.nodes.map((n) => ({ id: n.id, label: `${n.id}\n${n.provides.name}\n${n.provides.operations.map((o) => o.signature).join("\n")}` })), edges: [] },
  ];
  for (const scenario of ir.scenarios ?? []) {
    const ids = [...new Set(scenario.steps.flatMap((step) => [step.from, step.to]))];
    result.push({ id: `sequence-${scenario.id}`, kind: "sequence", title: scenario.name, nodes: ids.map((id) => ({ id, label: id })), edges: [...scenario.steps].sort((a, b) => a.order - b.order).map((s) => ({ from: s.from, to: s.to, label: s.message })) });
  }
  const deployment = ir.deployment;
  result.push(deployment?.nodes.length ? {
    id: "deployment", kind: "deployment", title: "Deployment",
    nodes: deployment.nodes.map((n) => ({ id: n.id, label: `${n.name}\n[${n.kind}]` })), edges: deployment.links,
  } : { id: "deployment", kind: "deployment", title: "Deployment", nodes: [], edges: [], reason: "No runtime deployment topology applies to this architecture." });
  for (const model of ir.stateModels ?? []) {
    result.push({ id: `state-${model.id}`, kind: "state", title: `${model.subject} state`, nodes: model.states.map((id) => ({ id: `${model.id}:${id}`, label: id })), edges: model.transitions.map((t) => ({ from: `${model.id}:${t.from}`, to: `${model.id}:${t.to}`, label: t.event })) });
  }
  result.push({ id: "state-foundry-build", kind: "state", title: "Foundry build lifecycle", nodes: ["pending", "ready", "leased", "verifying", "green", "red", "contract_weak", "infrastructure_blocked", "rearchitecture", "cancelled"].map((id) => ({ id: `build:${id}`, label: id })), edges: [
    ["pending", "ready", "dependencies green"], ["ready", "leased", "claim"], ["leased", "verifying", "submit"], ["verifying", "green", "accepted green"], ["verifying", "red", "authored failure"], ["verifying", "contract_weak", "mutation weakness"], ["verifying", "infrastructure_blocked", "verifier unavailable"], ["infrastructure_blocked", "ready", "infrastructure retry"], ["contract_weak", "rearchitecture", "refine acceptance"], ["red", "ready", "authored retry"], ["red", "rearchitecture", "budget exhausted"], ["pending", "cancelled", "cancel"], ["ready", "cancelled", "cancel"], ["leased", "cancelled", "cancel"], ["verifying", "cancelled", "cancel"],
  ].map(([from, to, label]) => ({ from: `build:${from}`, to: `build:${to}`, label })) });
  const byView = new Map((ir.layouts ?? []).map((entry) => [entry.viewId, entry.positions]));
  for (const view of result) view.positions = byView.get(view.id);
  return result;
}

function flattenProduct(root: FoundryProductNodeV5): Array<{ path: string; parent: string | null; node: FoundryProductNodeV5 }> {
  const out: Array<{ path: string; parent: string | null; node: FoundryProductNodeV5 }> = [];
  const walk = (node: FoundryProductNodeV5, parent: string | null) => { const path = parent ? `${parent}/${node.id}` : node.id; out.push({ path, parent, node }); for (const child of node.children ?? []) walk(child, path); };
  walk(root, null); return out;
}

function productViews(ir: FoundryProductArchitectureV5): View[] {
  const flat = flattenProduct(ir.product), baseNodes = flat.map(({ path, node }) => ({ id: path, label: `${node.id}\n[${node.kind}]\n${node.mandate.outcome}` }));
  const result: View[] = [
    { id: "ownership", kind: "ownership", title: "Product composition and ownership", nodes: baseNodes, edges: flat.filter((entry) => entry.parent).map((entry) => ({ from: entry.parent!, to: entry.path, label: "owns / integrates" })) },
    { id: "interfaces", kind: "interfaces", title: "Product public contracts", nodes: flat.map(({ path, node }) => ({ id: path, label: `${node.id}\n${node.contracts.flatMap((contract) => [contract.id, ...contract.operations.map((operation) => operation.signature)]).join("\n")}` })), edges: [] },
    { id: "evidence-tree", kind: "ownership", title: "Recursive build and evidence tree", nodes: flat.map(({ path, node }) => ({ id: path, label: `${node.id}\n${node.kind === "leaf" ? "implementation evidence" : "integration + child digests"}\n${(node.deliverables ?? []).map((entry) => entry.deliverableId).join(", ") || "no deliverable"}` })), edges: flat.filter((entry) => entry.parent).map((entry) => ({ from: entry.path, to: entry.parent!, label: "evidence digest ascends" })) },
  ];
  for (const { path, node } of flat.filter((entry) => entry.node.kind === "composite")) {
    const childNodes = (node.children ?? []).map((child) => ({ id: `${path}/${child.id}`, label: child.id }));
    const edges = (node.dependencies ?? []).map((edge) => ({ from: `${path}/${edge.provider}`, to: `${path}/${edge.consumer}`, label: edge.contractId }));
    result.push({ id: `dependencies-${path}`, kind: "dependencies", title: `${path} dependency DAG`, nodes: childNodes, edges });
  }
  for (const scenario of ir.scenarios ?? []) { const ids = [...new Set(scenario.steps.flatMap((step) => [step.from, step.to]))]; result.push({ id: `sequence-${scenario.id}`, kind: "sequence", title: scenario.name, nodes: ids.map((id) => ({ id, label: id })), edges: [...scenario.steps].sort((a, b) => a.order - b.order).map((step) => ({ from: step.from, to: step.to, label: step.message })) }); }
  const deployment = ir.deployment; result.push(deployment?.nodes.length ? { id: "deployment", kind: "deployment", title: "Deployment", nodes: deployment.nodes.map((node) => ({ id: node.id, label: `${node.name}\n[${node.kind}]` })), edges: deployment.links } : { id: "deployment", kind: "deployment", title: "Deployment", nodes: [], edges: [], reason: "No runtime deployment topology applies to this architecture." });
  for (const model of ir.stateModels ?? []) result.push({ id: `state-${model.id}`, kind: "state", title: `${model.subject} state`, nodes: model.states.map((id) => ({ id: `${model.id}:${id}`, label: id })), edges: model.transitions.map((transition) => ({ from: `${model.id}:${transition.from}`, to: `${model.id}:${transition.to}`, label: transition.event })) });
  result.push({ id: "state-foundry-product-build", kind: "state", title: "Recursive product build lifecycle", nodes: ["waiting_children", "ready", "leased", "verifying", "integration_ready", "integrating", "green", "red", "contract_weak", "infrastructure_blocked", "cancelled"].map((id) => ({ id: `product-build:${id}`, label: id })), edges: [["waiting_children", "ready", "providers green"], ["ready", "leased", "claim"], ["leased", "verifying", "submit"], ["verifying", "integration_ready", "implementation green"], ["integration_ready", "integrating", "system integration"], ["integrating", "green", "composite accepted"], ["verifying", "red", "authored failure"], ["integrating", "red", "contract mismatch"], ["verifying", "contract_weak", "weak evidence"], ["verifying", "infrastructure_blocked", "verifier unavailable"], ["waiting_children", "cancelled", "cancel"]].map(([from, to, label]) => ({ from: `product-build:${from}`, to: `product-build:${to}`, label })) });
  const byView = new Map((ir.layouts ?? []).map((entry) => [entry.viewId, entry.positions])); for (const view of result) view.positions = byView.get(view.id); return result;
}

function views(ir: AnyFoundryArchitecture): View[] { return ir.version === 5 ? productViews(ir) : legacyViews(ir); }

function plantUml(view: View): string {
  const lines = ["@startuml", "skinparam componentStyle rectangle", `title ${puml(view.title)}`];
  if (view.kind === "sequence") {
    for (const node of view.nodes) lines.push(`participant "${puml(node.label)}" as ${alias(node.id)}`);
    for (const edge of view.edges) lines.push(`${alias(edge.from)} -> ${alias(edge.to)} : ${puml(edge.label ?? "")}`);
  } else if (view.kind === "state") {
    for (const node of view.nodes) lines.push(`state "${puml(node.label)}" as ${alias(node.id)}`);
    for (const edge of view.edges) lines.push(`${alias(edge.from)} --> ${alias(edge.to)} : ${puml(edge.label ?? "")}`);
  } else {
    for (const node of view.nodes) lines.push(`component "${puml(node.label)}" as ${alias(node.id)}`);
    for (const edge of view.edges) lines.push(`${alias(edge.from)} --> ${alias(edge.to)} : ${puml(edge.label ?? "")}`);
  }
  lines.push("@enduml", "");
  return lines.join("\n");
}

function alias(id: string): string { return `n_${Buffer.from(id).toString("hex")}`; }

function layout(view: View): Map<string, { x: number; y: number; w: number; h: number }> {
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  view.nodes.forEach((node, index) => { const hint = view.positions?.[node.id], lines = node.label.split("\n"); const sequence = view.kind === "sequence"; positions.set(node.id, { x: hint?.x ?? 60 + index * (sequence ? 190 : 260), y: hint?.y ?? 80 + (sequence ? 0 : Math.floor(index / 3) * 180), w: hint?.width ?? (sequence ? 150 : 220), h: hint?.height ?? Math.max(76, 32 + lines.length * 18) }); });
  return positions;
}

function canvasSize(view: View): { width: number; height: number } { const values = [...layout(view).values()]; return { width: Math.max(800, ...values.map((p) => p.x + p.w + 60)), height: view.kind === "sequence" ? Math.max(320, 180 + view.edges.length * 64) : Math.max(260, ...values.map((p) => p.y + p.h + 60)) }; }

function textLines(label: string, max = 42): string[] { return label.split("\n").flatMap((line) => { const words = line.split(/\s+/), lines: string[] = []; let current = ""; for (const word of words) { if (current && `${current} ${word}`.length > max) { lines.push(current); current = word; } else current = current ? `${current} ${word}` : word; } if (current) lines.push(current); return lines; }); }
function svgText(x: number, y: number, label: string, size = 13, anchor = "start"): string { return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, sans-serif" font-size="${size}" fill="#26313d">${textLines(label).map((line, index) => `<tspan x="${x}" dy="${index ? 17 : 0}">${esc(line)}</tspan>`).join("")}</text>`; }

function svg(view: View): string {
  const pos = layout(view);
  const { width, height } = canvasSize(view);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(view.title)}">`, `<rect width="100%" height="100%" fill="#fbfaf7"/>`, `<text x="40" y="38" font-family="sans-serif" font-size="22" font-weight="700">${esc(view.title)}</text>`, `<defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#39424e"/></marker></defs>`];
  if (view.kind === "sequence") {
    for (const node of view.nodes) { const p = pos.get(node.id)!; parts.push(`<g data-semantic-id="${esc(node.id)}"><rect x="${p.x}" y="${p.y}" width="${p.w}" height="52" rx="8" fill="#e9f0f4" stroke="#26313d" stroke-width="2"/>${svgText(p.x + p.w / 2, p.y + 31, node.label, 13, "middle")}<line x1="${p.x + p.w / 2}" y1="${p.y + 52}" x2="${p.x + p.w / 2}" y2="${height - 30}" stroke="#82909d" stroke-dasharray="5 5"/></g>`); }
    view.edges.forEach((edge, index) => { const a = pos.get(edge.from), b = pos.get(edge.to); if (!a || !b) return; const y = 170 + index * 58, x1 = a.x + a.w / 2, x2 = b.x + b.w / 2; parts.push(`<line data-from-semantic-id="${esc(edge.from)}" data-to-semantic-id="${esc(edge.to)}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#39424e" stroke-width="2" marker-end="url(#a)"/>${svgText((x1 + x2) / 2, y - 9, edge.label ?? "", 11, "middle")}`); });
    parts.push("</svg>"); return parts.join("");
  }
  for (const edge of view.edges) {
    const a = pos.get(edge.from), b = pos.get(edge.to); if (!a || !b) continue;
    const x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
    parts.push(`<line data-from-semantic-id="${esc(edge.from)}" data-to-semantic-id="${esc(edge.to)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#39424e" stroke-width="2" marker-end="url(#a)"/>`);
    if (edge.label) parts.push(svgText((x1 + x2) / 2, (y1 + y2) / 2 - 8, edge.label, 11, "middle"));
  }
  for (const node of view.nodes) {
    const p = pos.get(node.id)!;
    parts.push(`<g data-semantic-id="${esc(node.id)}"><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="8" fill="#e9f0f4" stroke="#26313d" stroke-width="2"/>${svgText(p.x + 12, p.y + 27, node.label)}</g>`);
  }
  parts.push("</svg>"); return parts.join("");
}

function png(view: View): Buffer {
  const rendered = new Resvg(svg(view), { fitTo: { mode: "original" }, font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render().asPng();
  if (rendered.length < 1024) throw new Error(`PNG_RENDER_EMPTY:${view.id}`);
  return Buffer.from(rendered);
}

function assertRasterizedLabels(): void {
  const probe = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="64"><rect width="320" height="64" fill="#fff"/><text x="8" y="40" font-family="Arial, sans-serif" font-size="24" fill="#000">Foundry label probe</text></svg>', { font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render();
  let nonWhite = 0; for (let index = 0; index < probe.pixels.length; index += 4) if (probe.pixels[index] < 240 || probe.pixels[index + 1] < 240 || probe.pixels[index + 2] < 240) nonWhite++;
  if (nonWhite < 32) throw new Error("PNG_LABEL_PIXELS_MISSING");
}

function excalidrawDocument(all: View[]): string {
  const elements: any[] = [];
  let frameX = 0;
  for (const view of all.filter((v) => !v.reason)) {
    const frameId = `frame-${view.id}`;
    elements.push({ id: frameId, type: "frame", x: frameX, y: 0, width: 800, height: 700, name: view.title, customData: { viewId: view.id } });
    const positions = layout(view);
    for (const [index, edge] of view.edges.entries()) {
      const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) continue; const x = frameX + from.x + from.w / 2, y = from.y + from.h / 2, dx = to.x + to.w / 2 - (from.x + from.w / 2), dy = to.y + to.h / 2 - (from.y + from.h / 2);
      elements.push({ id: `${view.id}-edge-${index}`, type: "arrow", x, y, width: dx, height: dy, points: [[0, 0], [dx, dy]], strokeColor: "#39424e", endArrowhead: "arrow", frameId, customData: { viewId: view.id, fromSemanticId: edge.from, toSemanticId: edge.to, relationshipKind: view.kind, label: edge.label ?? "" } });
    }
    for (const node of view.nodes) {
      const p = positions.get(node.id)!;
      elements.push({ id: `${view.id}-${alias(node.id)}`, type: "rectangle", x: frameX + p.x, y: p.y, width: p.w, height: p.h, frameId, strokeColor: "#26313d", backgroundColor: "#e9f0f4", customData: { viewId: view.id, semanticId: node.id } });
      elements.push({ id: `${view.id}-${alias(node.id)}-label`, type: "text", x: frameX + p.x + 12, y: p.y + 20, width: Math.max(1, p.w - 24), height: 24, text: node.label, originalText: node.label, fontSize: 16, fontFamily: 1, textAlign: "center", verticalAlign: "middle", strokeColor: "#26313d", frameId, customData: { viewId: view.id, labelForSemanticId: node.id } });
    }
    frameX += 850;
  }
  return JSON.stringify({ type: "excalidraw", version: 2, source: "foundry", elements, appState: { viewBackgroundColor: "#fbfaf7" }, files: {} }, null, 2);
}

export function renderArchitecture(ir: AnyFoundryArchitecture, revisionId: string, store: ArtifactStore): ArchitecturePackageManifest {
  const sourceDigest = sha256(JSON.stringify(ir));
  assertRasterizedLabels();
  const all = views(ir); const diagrams: DiagramArtifact[] = [];
  for (const view of all) {
    if (view.reason) { diagrams.push({ viewId: view.id, kind: view.kind, status: "not_applicable", reason: view.reason, semanticIds: [], artifacts: [] }); continue; }
    const svgBody = svg(view); for (const label of [view.title, ...view.nodes.map((node) => node.label), ...view.edges.map((edge) => edge.label ?? "")].filter(Boolean)) if (!svgBody.includes(esc(textLines(label).at(0)!))) throw new Error(`PROJECTION_LABEL_MISSING:${view.id}`);
    const outputs = [["plantuml", plantUml(view), "text/vnd.plantuml"], ["svg", svgBody, "image/svg+xml"], ["png", png(view), "image/png"]] as const;
    const artifacts = outputs.map(([format, body]) => { const saved = store.put(body); return { format, digest: saved.digest, uri: `foundry://artifacts/${saved.digest}` }; });
    diagrams.push({ viewId: view.id, kind: view.kind, status: "rendered", semanticIds: view.nodes.map((n) => n.id), relationships: view.edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}) })), artifacts });
  }
  const excalidraw = store.put(excalidrawDocument(all));
  const partial = { schemaVersion: 1 as const, revisionId, sourceDigest, renderer: { name: "foundry-projection" as const, version: "2.0.0", rasterizer: "@resvg/resvg-js@2.6.2", font: "Arial-compatible-v1" }, diagrams, excalidraw: { digest: excalidraw.digest, uri: `foundry://artifacts/${excalidraw.digest}` } };
  return { ...partial, digest: sha256(JSON.stringify(partial)) };
}

export function validateLayoutImport(ir: AnyFoundryArchitecture, excalidraw: unknown): Record<string, { x: number; y: number; width?: number; height?: number }> {
  const architectureSemantic = ir.version === 5 ? flattenProduct(ir.product).map((entry) => entry.path) : ir.nodes.map((node) => node.id);
  const buildSemantic = ir.version === 5 ? ["waiting_children", "ready", "leased", "verifying", "integration_ready", "integrating", "green", "red", "contract_weak", "infrastructure_blocked", "cancelled"].map((state) => `product-build:${state}`) : ["pending", "ready", "leased", "verifying", "green", "red", "contract_weak", "infrastructure_blocked", "rearchitecture", "cancelled"].map((state) => `build:${state}`);
  const semantic = new Set([...architectureSemantic, ...(ir.deployment?.nodes.map((n) => n.id) ?? []), ...(ir.stateModels ?? []).flatMap((model) => model.states.map((state) => `${model.id}:${state}`)), ...buildSemantic]);
  const relationships = new Set(views(ir).flatMap((view) => view.edges.map((edge) => `${view.id}\u0000${view.kind}\u0000${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`)));
  const elements = (excalidraw as any)?.elements;
  if (!Array.isArray(elements)) throw new Error("INVALID_EXCALIDRAW");
  const positions: Record<string, { x: number; y: number; width?: number; height?: number }> = {};
  for (const element of elements) {
    const id = element?.customData?.semanticId;
    const from = element?.customData?.fromSemanticId, to = element?.customData?.toSemanticId;
    if (from || to) { const key = `${element?.customData?.viewId ?? ""}\u0000${element?.customData?.relationshipKind ?? ""}\u0000${from ?? ""}\u0000${to ?? ""}\u0000${element?.customData?.label ?? ""}`; if (!relationships.has(key)) throw new Error(`PHANTOM_SEMANTIC_RELATIONSHIP:${from ?? ""}->${to ?? ""}`); }
    if (!id) continue;
    if (!semantic.has(id)) throw new Error(`PHANTOM_SEMANTIC_ELEMENT:${id}`);
    positions[id] = { x: Number(element.x), y: Number(element.y), width: Number(element.width), height: Number(element.height) };
  }
  return positions;
}

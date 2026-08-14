import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FoundryProductNodeV5, FoundryTarget } from "../../src/core/types.ts";
import type { ProductApplyRequest, ProductAssemblyRequest, ProductAssemblyResult, ProductIntegrationRequest, ProductVerificationResult } from "./contract.ts";
import type { TesterConfig } from "./tester.ts";
import { resolvePistonVersion } from "./tester.ts";

const RUNTIME = "foundry-product";
const RESULT_PREFIX = "FOUNDRY_PRODUCT_RESULT=";
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const digest = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function targets(node: FoundryProductNodeV5): FoundryTarget[] { return node.kind === "leaf" ? node.implementation?.targets ?? [] : node.integration?.glue?.targets ?? []; }
function walk(node: FoundryProductNodeV5, out: FoundryProductNodeV5[] = []): FoundryProductNodeV5[] { out.push(node); for (const child of node.children ?? []) walk(child, out); return out; }
function safePath(workspace: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "")) throw new Error(`UNSAFE_PRODUCT_TARGET: ${path}`);
  const root = realpathSync(workspace), candidate = resolve(root, path), rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error(`WORKSPACE_ESCAPE: ${path}`);
  if (existsSync(candidate)) { if (lstatSync(candidate).isSymbolicLink()) throw new Error(`SYMLINK_TARGET_FORBIDDEN: ${path}`); const actual = realpathSync(candidate); if (relative(root, actual).startsWith("..")) throw new Error(`WORKSPACE_ESCAPE: ${path}`); }
  return candidate;
}

function repositoryFiles(workspace: string, root: FoundryProductNodeV5, proposed: Array<{ path: string; content: string }> = []): Array<{ name: string; content: string }> {
  const overrides = new Map(proposed.map((file) => [file.path, file.content]));
  const declared = walk(root).flatMap(targets), seen = new Set<string>(), files: Array<{ name: string; content: string }> = [];
  for (const target of declared) {
    if (seen.has(target.path)) continue; seen.add(target.path);
    if (overrides.has(target.path)) { const content = overrides.get(target.path)!; if (Buffer.byteLength(content) > MAX_INPUT_BYTES) throw new Error(`PRODUCT_TARGET_TOO_LARGE: ${target.targetId}`); files.push({ name: target.path, content }); continue; }
    const path = safePath(workspace, target.path); if (!existsSync(path)) continue;
    const content = readFileSync(path); if (content.length > MAX_INPUT_BYTES) throw new Error(`PRODUCT_TARGET_TOO_LARGE: ${target.targetId}`);
    files.push({ name: target.path, content: content.toString("utf8") });
  }
  if (Buffer.byteLength(JSON.stringify(files)) > MAX_INPUT_BYTES) throw new Error("PRODUCT_INPUT_TOO_LARGE");
  return files;
}

function requireProduction(config: TesterConfig): string {
  if (config.mode !== "piston") throw new Error("PRODUCTION_VERIFIER_REQUIRED: IR v5 verification is Piston-only");
  return config.pistonUrl ?? "http://127.0.0.1:2000";
}

async function execute(config: TesterConfig, request: unknown, files: Array<{ name: string; content: string }>): Promise<any> {
  const url = requireProduction(config), version = await resolvePistonVersion(url, RUNTIME, "1");
  const payload = JSON.stringify(request); if (Buffer.byteLength(payload) > MAX_INPUT_BYTES) throw new Error("PRODUCT_REQUEST_TOO_LARGE");
  const response = await fetch(`${url}/api/v2/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language: RUNTIME, version, files: [{ name: "foundry-product-request.json", content: payload }, ...files], run_timeout: 180_000, run_memory_limit: 512_000_000, output_max_size: 16_777_216 }) });
  if (!response.ok) throw new Error(`PISTON_HTTP_${response.status}`);
  const body = await response.json() as any; if (!body.run) throw new Error(`PISTON_PROTOCOL_ERROR: ${body.message ?? "missing run stage"}`);
  if (body.run.code !== 0) throw new Error(`PISTON_PRODUCT_RUNTIME_FAILED: ${(body.run.stderr ?? body.run.output ?? "").slice(0, 1000)}`);
  const line = String(body.run.stdout ?? "").split(/\r?\n/).findLast((entry) => entry.startsWith(RESULT_PREFIX)); if (!line) throw new Error("PISTON_PRODUCT_RESULT_MISSING");
  let result: any; try { result = JSON.parse(Buffer.from(line.slice(RESULT_PREFIX.length), "base64").toString("utf8")); } catch { throw new Error("PISTON_PRODUCT_RESULT_MALFORMED"); }
  return { result, runtime: { language: RUNTIME, version }, execution: { code: body.run.code, stdoutDigest: digest(body.run.stdout ?? ""), stderr: String(body.run.stderr ?? "").slice(0, 4000) } };
}

export async function applyAndTestProduct(request: ProductApplyRequest, config: TesterConfig): Promise<ProductVerificationResult> {
  const declared = new Map(targets(request.node).map((target) => [target.targetId, target]));
  if (!declared.size || request.files.length !== declared.size || request.files.some((file) => declared.get(file.targetId)?.path !== file.path)) throw new Error("PRODUCT_TARGET_SET_MISMATCH");
  for (const file of request.files) safePath(request.workspace, file.path);
  const source = repositoryFiles(request.workspace, request.architecture.product, request.files), executed = await execute(config, { protocol: 1, operation: "verify-work", workId: request.workId, nodePath: request.nodePath, node: request.node, architectureDigest: digest(JSON.stringify(request.architecture)), allowedTargetIds: [...declared.keys()].sort() }, source);
  const value = executed.result; if (!["green", "red"].includes(value?.verdict) || !["accepted_green", "authored_red", "contract_weak"].includes(value?.outcome)) throw new Error("PISTON_PRODUCT_VERDICT_INVALID");
  return { verdict: value.verdict, outcome: value.outcome, diagnostics: value.diagnostics ?? {}, digest: digest(JSON.stringify(value)), evidence: { runtime: executed.runtime, execution: executed.execution, result: value.evidence ?? null } };
}

export async function integrateProduct(request: ProductIntegrationRequest, config: TesterConfig): Promise<{ verdict: "green" | "red"; diagnostics: unknown; evidence: unknown }> {
  if (request.node.kind !== "composite" || !request.node.integration?.scenarios.length) throw new Error("COMPOSITE_INTEGRATION_REQUIRED");
  const expectedChildren = (request.node.children ?? []).map((child) => `${request.nodePath}/${child.id}`).sort(), evidenced = Object.keys(request.childEvidenceDigests).sort(); if (JSON.stringify(expectedChildren) !== JSON.stringify(evidenced)) throw new Error("CHILD_EVIDENCE_INCOMPLETE");
  const executed = await execute(config, { protocol: 1, operation: "integrate", nodePath: request.nodePath, node: request.node, architecture: request.architecture, childEvidenceDigests: request.childEvidenceDigests, architectureDigest: digest(JSON.stringify(request.architecture)) }, repositoryFiles(request.workspace, request.architecture.product));
  if (!["green", "red"].includes(executed.result?.verdict)) throw new Error("PISTON_PRODUCT_VERDICT_INVALID");
  return { verdict: executed.result.verdict, diagnostics: executed.result.diagnostics ?? {}, evidence: { runtime: executed.runtime, execution: executed.execution, result: executed.result.evidence ?? null } };
}

export async function assembleProduct(request: ProductAssemblyRequest, config: TesterConfig): Promise<ProductAssemblyResult> {
  const executed = await execute(config, { protocol: 1, operation: "assemble", buildId: request.buildId, revisionId: request.revisionId, architecture: request.architecture, architectureDigest: digest(JSON.stringify(request.architecture)), deliverables: request.deliverables }, repositoryFiles(request.workspace, request.architecture.product));
  const outputs = Array.isArray(executed.result?.deliverables) ? executed.result.deliverables : [], declared = new Map(request.deliverables.map((item) => [item.deliverableId, item])), outputIds = outputs.map((item: any) => item.deliverableId); if (outputs.length > declared.size || new Set(outputIds).size !== outputIds.length || outputs.some((item: any) => !declared.has(item.deliverableId))) throw new Error("UNDECLARED_ARTIFACT_EGRESS");
  for (const output of outputs) { const declaration = declared.get(output.deliverableId)!; if (typeof output.artifactBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(output.artifactBase64) || output.artifactBase64.length % 4 !== 0) throw new Error("ARTIFACT_EGRESS_MALFORMED"); const bytes = Buffer.from(output.artifactBase64, "base64"); if (bytes.length > (declaration.output?.maxBytes ?? 128 * 1024 * 1024)) throw new Error("ARTIFACT_EGRESS_TOO_LARGE"); if (output.mediaType && declaration.output?.mediaType && output.mediaType !== declaration.output.mediaType) throw new Error("ARTIFACT_MEDIA_TYPE_MISMATCH"); }
  if (!["green", "red"].includes(executed.result?.verdict)) throw new Error("PISTON_PRODUCT_VERDICT_INVALID");
  return { verdict: executed.result.verdict, deliverables: outputs, evidence: { runtime: executed.runtime, execution: executed.execution, result: executed.result.evidence ?? null } };
}

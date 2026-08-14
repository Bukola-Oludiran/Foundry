import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ApplyAndTestRequest, ApplyAndTestResult, TestRequest } from "./contract.ts";
import { runSandboxed } from "./sandbox.ts";
import { executeTest, type TesterConfig } from "./tester.ts";

function confined(workspace: string, target: string): string {
  if (isAbsolute(target) || target.split(/[\\/]/).includes("..")) throw new Error("invalid compiler write target");
  const root = realpathSync(workspace), full = resolve(root, target), rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("write target escapes workspace");
  try { const stat = lstatSync(full); if (stat.isSymbolicLink()) throw new Error("workspace target is a symbolic link"); if (stat.isFile() && stat.nlink > 1) throw new Error("workspace target is a hard link"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let existing = full;
  while (true) { try { existing = realpathSync(existing); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = dirname(existing); if (parent === existing) throw new Error("workspace target has no confined ancestor"); existing = parent; } }
  const existingRel = relative(root, existing); if (existingRel.startsWith("..") || isAbsolute(existingRel)) throw new Error("workspace symlink escapes workspace");
  return full;
}

export async function applyAndTest(req: ApplyAndTestRequest, tester: TesterConfig): Promise<ApplyAndTestResult> {
  const declared = (req.node.implementation.targets?.length ? req.node.implementation.targets : [{ targetId: req.node.id, path: req.node.implementation.write_target }]) as Array<{ targetId: string; path: string }>;
  const files = req.files ?? (req.content !== undefined ? [{ targetId: declared[0]!.targetId, path: declared[0]!.path, content: req.content }] : []);
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 2 * 1024 * 1024) throw new Error("change set exceeds 2 MB");
  if (files.length !== declared.length || files.some((file) => !declared.some((target) => target.targetId === file.targetId && target.path === file.path))) throw new Error("change set does not match compiler targets");
  // Validate the durable targets before copying. cpSync materializes hard links as
  // ordinary files, so checking only the private attempt overlay would erase the
  // evidence of a host-file alias before the confinement decision is made.
  for (const file of files) confined(req.workspace, file.path);
  // Verification happens in a private overlay. A worker crash, timeout, or red verdict
  // therefore cannot leave partially accepted files in the durable build overlay.
  const attemptWorkspace = mkdtempSync(join(tmpdir(), "foundry-attempt-"));
  cpSync(req.workspace, attemptWorkspace, { recursive: true, verbatimSymlinks: true });
  const readPaths = (req.plan.read_sets[req.node.id] ?? []).map((path) => confined(attemptWorkspace, path));
  try { for (const file of files) { const target = confined(attemptWorkspace, file.path); mkdirSync(dirname(target), { recursive: true }); if (!existsSync(target)) writeFileSync(target, ""); const write = runSandboxed({ workspace: attemptWorkspace, readPaths, writeTarget: target, allowNetwork: false }, "/usr/bin/tee", [target], { input: file.content }); if (write.status !== 0) throw new Error(write.stderr.trim() || `sandboxed write exited ${write.status}`); } }
  catch (error) { rmSync(attemptWorkspace, { recursive: true, force: true }); throw error; }
  const byId = new Map(req.architecture.nodes.map((n) => [n.id, n]));
  const primary = (req.node.implementation.targets?.find((target: any) => target.targetId === req.node.implementation.primaryTargetId) ?? req.node.implementation.targets?.[0])?.path ?? req.node.implementation.write_target;
  const test: TestRequest = {
    node_id: req.node.id,
    language: req.node.implementation.language ?? req.architecture.spec.language ?? "python",
    workspace: attemptWorkspace,
    write_target: primary!,
    provides: req.node.provides,
    acceptance: req.node.acceptance,
    deps: (req.node.requires ?? []).map((dependency) => { const dep: any = byId.get(dependency.node)!; return { import_name: req.plan.import_names[dependency.node]!, read_path: dep.implementation.targets?.[0]?.path ?? dep.implementation.write_target }; }),
    repository_layout: req.node.kind === "integrator" && (req.architecture.version === 3 || req.architecture.version === 4),
    module_import_name: req.node.kind === "integrator" && req.architecture.delivery?.profile === "python-library" ? req.architecture.delivery.publicModule : undefined,
    runtime_version_range: req.architecture.delivery?.runtime.versionRange,
    repository_files: req.node.kind === "integrator" ? req.architecture.nodes.flatMap((node: any) => (node.implementation.targets ?? [{ path: node.implementation.write_target }]).map((target: any) => target.path)) : undefined,
    architecture_version: req.architecture.version,
  };
  let diagnostics;
  try { diagnostics = await executeTest(test, tester); } catch (error) { rmSync(attemptWorkspace, { recursive: true, force: true }); throw error; }
  if (diagnostics.verdict === "green") {
    const originals = new Map<string, Buffer | null>(), staged: Array<{ temp: string; target: string }> = [];
    try {
      for (const file of files) { const target = confined(req.workspace, file.path), source = confined(attemptWorkspace, file.path); originals.set(target, existsSync(target) ? readFileSync(target) : null); mkdirSync(dirname(target), { recursive: true }); const temp = `${target}.foundry-attempt.tmp`; writeFileSync(temp, readFileSync(source), { flag: "wx" }); staged.push({ temp, target }); }
      for (const entry of staged) renameSync(entry.temp, entry.target);
    } catch (error) {
      for (const entry of staged) rmSync(entry.temp, { force: true });
      for (const [target, original] of originals) { if (original === null) rmSync(target, { force: true }); else writeFileSync(target, original); }
      rmSync(attemptWorkspace, { recursive: true, force: true }); throw error;
    }
  }
  rmSync(attemptWorkspace, { recursive: true, force: true });
  return { verdict: diagnostics.verdict, outcome: diagnostics.verdict === "green" ? "accepted_green" : "authored_red", diagnostics: { ...diagnostics, evidenceKind: req.node.kind === "integrator" ? "repository-integration" : "isolated-unit" }, digest: `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}` };
}

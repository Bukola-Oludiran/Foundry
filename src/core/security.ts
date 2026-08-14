import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { FoundryAuthorizationContext, FoundryScope } from "./types.ts";
import { FoundryCommandError } from "./types.ts";

export function requireScope(auth: FoundryAuthorizationContext, scope: FoundryScope): void {
  if (!auth.scopes.includes(scope) && !auth.scopes.includes("foundry:admin")) {
    throw new FoundryCommandError("FORBIDDEN", `Missing required scope ${scope}`);
  }
}

export function requireProject(auth: FoundryAuthorizationContext, projectId: string): void {
  if (auth.projectIds && !auth.projectIds.includes(projectId) && !auth.scopes.includes("foundry:admin")) {
    throw new FoundryCommandError("PROJECT_FORBIDDEN", "Project is outside the authorization context");
  }
}

export function resolveBoundPath(root: string, child = "."): string {
  if (isAbsolute(child)) throw new FoundryCommandError("ABSOLUTE_PATH_FORBIDDEN", "Only root-relative paths are accepted");
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, child);
  const rel = relative(canonicalRoot, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new FoundryCommandError("WORKSPACE_ESCAPE", "Path leaves its configured root");
  try { if (lstatSync(candidate).isSymbolicLink()) throw new FoundryCommandError("WORKSPACE_ESCAPE", "A workspace target cannot be a symbolic link"); } catch (error) { if (error instanceof FoundryCommandError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let existing = candidate;
  while (true) {
    try { existing = realpathSync(existing); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = dirname(existing); if (parent === existing) throw new FoundryCommandError("WORKSPACE_ESCAPE", "Workspace target has no confined ancestor"); existing = parent; }
  }
  const existingRel = relative(canonicalRoot, existing);
  if (existingRel.startsWith("..") || isAbsolute(existingRel)) throw new FoundryCommandError("WORKSPACE_ESCAPE", "A workspace symlink leaves its configured root");
  return candidate;
}

export function assertRepoRelative(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new FoundryCommandError("INVALID_TARGET", "Compiler write targets must be normalized repository-relative paths");
  }
}

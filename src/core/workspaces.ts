import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

export class WorkspaceRegistry {
  private readonly roots: ReadonlyMap<string, string>;

  constructor(roots: Record<string, string>) {
    const normalized = new Map<string, string>();
    for (const [id, root] of Object.entries(roots)) {
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new WorkspaceError("INVALID_WORKSPACE_ID", `Invalid workspace id ${id}`);
      if (!existsSync(root)) throw new WorkspaceError("WORKSPACE_NOT_FOUND", `Configured workspace ${id} does not exist`);
      normalized.set(id, realpathSync(root));
    }
    this.roots = normalized;
  }

  static fromEnvironment(value = process.env.FOUNDRY_WORKSPACE_ROOTS ?? ""): WorkspaceRegistry {
    const roots: Record<string, string> = {};
    for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
      const separator = entry.indexOf("=");
      if (separator < 1 || separator === entry.length - 1) throw new WorkspaceError("INVALID_WORKSPACE_CONFIG", "FOUNDRY_WORKSPACE_ROOTS must contain id=/absolute/path entries");
      roots[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return new WorkspaceRegistry(roots);
  }

  ids(): string[] {
    return [...this.roots.keys()].sort();
  }

  root(id: string): string {
    const root = this.roots.get(id);
    if (!root) throw new WorkspaceError("WORKSPACE_NOT_FOUND", `Unknown workspace id ${id}`);
    return root;
  }

  resolve(id: string, child: string, options: { output?: boolean } = {}): string {
    if (!child || isAbsolute(child) || child.includes("\0")) throw new WorkspaceError("INVALID_PATH", "Paths must be non-empty and relative to a configured workspace");
    const root = this.root(id);
    const candidate = resolve(root, child);
    if (!contained(root, candidate)) throw new WorkspaceError("PATH_ESCAPE", "Path escapes the configured workspace");

    if (existsSync(candidate)) {
      const actual = realpathSync(candidate);
      if (!contained(root, actual)) throw new WorkspaceError("SYMLINK_ESCAPE", "Path resolves outside the configured workspace");
      return actual;
    }
    if (!options.output) throw new WorkspaceError("PATH_NOT_FOUND", `Workspace path does not exist: ${child}`);

    let ancestor = dirname(candidate);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new WorkspaceError("PATH_NOT_FOUND", `No existing parent for output path: ${child}`);
      ancestor = parent;
    }
    const actualParent = realpathSync(ancestor);
    if (!contained(root, actualParent) || lstatSync(ancestor).isSymbolicLink()) throw new WorkspaceError("SYMLINK_ESCAPE", "Output parent resolves outside the configured workspace");
    return candidate;
  }
}

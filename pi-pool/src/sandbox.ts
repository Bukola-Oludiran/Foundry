// OS-sandbox adapter — scopes a worker process to a read-set + a single write-target,
// kernel-enforced. This is the FS half of a doer's single-responsibility guarantee
// (GraphReact's message-permissions are the communication half). We depend on the OS
// primitive the industry standardized on rather than a VFS: Seatbelt on macOS, Landlock
// on Linux (see Foundry/docs/contract.md · sandbox research in the plan file).
//
// macOS: `sandbox-exec -f <profile>` with an SBPL profile. SBPL evaluates rules top-to-
// bottom, LAST match wins — so we `(allow default)`, then deny a whole class, then
// re-allow the narrow exceptions. Writes are scoped to the exact write-target FILE (not
// its directory) so a doer cannot clobber a sibling node's code in the same folder.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxScope {
  workspace: string; // repo root — reads within it are default-denied
  readPaths: string[]; // declared read-set (dependency interfaces), read-only
  writeTarget: string; // the ONE file the worker may write
  allowNetwork?: boolean; // a doer needs the LLM; defaults true
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const esc = (p: string): string => p.replace(/"/g, '\\"');

/** Generate a macOS Seatbelt (SBPL) profile for the given scope. */
export function buildSeatbeltProfile(scope: SandboxScope): string {
  const ws = real(scope.workspace);
  const wt = real(scope.writeTarget);
  const reads = scope.readPaths.map(real);
  const readAllows = [wt, ...reads].map((p) => `    (literal "${esc(p)}")`).join("\n");
  const net = scope.allowNetwork === false ? "\n(deny network*)" : "";
  return `(version 1)
(allow default)

; writes: deny all, then re-allow the ephemeral scratch the runtime needs
(deny file-write*)
(allow file-write*
    (subpath "/private/tmp")
    (subpath "/private/var/folders")
    (subpath "/private/var/tmp")
    (literal "/dev/null")
    (literal "/dev/stdout")
    (literal "/dev/stderr")
    (literal "/dev/dtracehelper"))
; protect the workspace LAST (even if it sits under a scratch dir), then carve out ONLY the target
(deny file-write* (subpath "${esc(ws)}"))
(allow file-write* (literal "${esc(wt)}"))

; reads inside the workspace: deny, then re-allow ONLY the declared read-set + own target
; (system paths outside the workspace stay readable via allow-default, so the runtime works)
(deny file-read* (subpath "${esc(ws)}"))
(allow file-read*
${readAllows})${net}
`;
}

/** Run `command args` under the sandbox scope. macOS only for now; Linux → Landlock (TODO). */
export function runSandboxed(
  scope: SandboxScope,
  command: string,
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): SpawnSyncReturns<string> {
  if (process.platform !== "darwin") {
    throw new Error("runSandboxed: only macOS/Seatbelt implemented; Linux Landlock adapter is TODO");
  }
  const dir = mkdtempSync(join(tmpdir(), "foundry-sb-"));
  const profilePath = join(dir, "profile.sb");
  try {
    writeFileSync(profilePath, buildSeatbeltProfile(scope));
    return spawnSync("sandbox-exec", ["-f", profilePath, command, ...args], {
      cwd: opts.cwd,
      input: opts.input,
      encoding: "utf-8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

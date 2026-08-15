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
import {
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ResourcePolicy } from "./contract.ts";

const DEFAULT_OCI_IMAGE =
  "docker.io/library/alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1";

export interface SandboxScope {
  workspace: string; // repo root — reads within it are default-denied
  readPaths: string[]; // declared read-set (dependency interfaces), read-only
  writeTarget: string; // the ONE file the worker may write
  allowNetwork?: boolean; // a doer needs the LLM; defaults true
  resourcePolicy?: ResourcePolicy;
  ociImage?: string;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const esc = (p: string): string => p.replace(/"/g, '\\"');

export function sandboxAvailability(): {
  available: boolean;
  reason: string | null;
} {
  const mode =
    process.env.FOUNDRY_SANDBOX ??
    (process.platform === "darwin" ? "seatbelt" : "oci");
  if (mode === "oci") {
    const probe = spawnSync(
      "docker",
      ["info", "--format", "{{json .SecurityOptions}}"],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) {
      return {
        available: false,
        reason: (probe.stderr ?? "").trim() || "Docker daemon unavailable",
      };
    }
    if (
      process.platform === "linux" &&
      !probe.stdout.includes("rootless") &&
      process.env.FOUNDRY_ALLOW_ROOTFUL_OCI !== "1"
    ) {
      return {
        available: false,
        reason: "Linux production requires a rootless Docker daemon",
      };
    }
    return { available: true, reason: null };
  }
  if (mode !== "seatbelt" || process.platform !== "darwin") {
    return {
      available: false,
      reason: `sandbox mode '${mode}' is unavailable on ${process.platform}`,
    };
  }
  const probe = spawnSync(
    "sandbox-exec",
    ["-p", "(version 1) (allow default)", "/usr/bin/true"],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    return {
      available: false,
      reason:
        (probe.stderr ?? "").trim() || `sandbox-exec exited ${probe.status}`,
    };
  }
  return { available: true, reason: null };
}

function stagePath(
  workspace: string,
  stage: string,
  path: string,
): { relativePath: string; staged: string } {
  const absolute = real(resolve(workspace, path));
  const relativePath = relative(workspace, absolute);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`sandbox path escapes workspace: ${path}`);
  }
  return { relativePath, staged: join(stage, relativePath) };
}

function runOci(
  scope: SandboxScope,
  command: string,
  args: string[],
  opts: { cwd?: string; input?: string },
): SpawnSyncReturns<string> {
  const workspace = real(scope.workspace);
  const stage = mkdtempSync(join(tmpdir(), "foundry-oci-"));
  const target = stagePath(workspace, stage, scope.writeTarget);
  const promotesTarget = args.some(
    (arg) => real(resolve(arg)) === real(resolve(scope.writeTarget)),
  );
  try {
    for (const source of [scope.writeTarget, ...scope.readPaths]) {
      const item = stagePath(workspace, stage, source);
      mkdirSync(dirname(item.staged), { recursive: true });
      copyFileSync(resolve(workspace, source), item.staged);
    }
    const containerTarget = `/workspace/${target.relativePath}`;
    const translatedArgs = args.map((arg) => {
      const absolute = real(resolve(arg));
      const pathFromWorkspace = relative(workspace, absolute);
      if (
        pathFromWorkspace !== ".." &&
        !pathFromWorkspace.startsWith(`..${sep}`)
      ) {
        return `/workspace/${pathFromWorkspace}`;
      }
      return arg;
    });
    const policy = scope.resourcePolicy ?? {
      timeout_ms: 300_000,
      memory_mb: 1024,
      cpu_count: 2,
      pids: 256,
      network: "none",
    };
    const uid = process.getuid?.() ?? 65532;
    const gid = process.getgid?.() ?? 65532;
    const dockerArgs = [
      "run",
      "--rm",
      "--interactive",
      "--read-only",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(policy.pids),
      "--ulimit",
      "nofile=1024:1024",
      "--memory",
      `${policy.memory_mb}m`,
      "--cpus",
      String(policy.cpu_count),
      "--user",
      `${uid}:${gid}`,
      "--mount",
      `type=bind,src=${stage},dst=/workspace`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      scope.ociImage ?? process.env.FOUNDRY_OCI_IMAGE ?? DEFAULT_OCI_IMAGE,
      command,
      ...translatedArgs,
    ];
    const result = spawnSync("docker", dockerArgs, {
      input: opts.input,
      encoding: "utf8",
      timeout: policy.timeout_ms,
    });
    if (result.status === 0 && promotesTarget)
      copyFileSync(target.staged, resolve(scope.writeTarget));
    return result;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Generate a macOS Seatbelt (SBPL) profile for the given scope. */
export function buildSeatbeltProfile(scope: SandboxScope): string {
  const ws = real(scope.workspace);
  const wt = real(scope.writeTarget);
  const reads = scope.readPaths.map(real);
  const readAllows = [wt, ...reads]
    .map((p) => `    (literal "${esc(p)}")`)
    .join("\n");
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
  const mode =
    process.env.FOUNDRY_SANDBOX ??
    (process.platform === "darwin" ? "seatbelt" : "oci");
  if (mode === "oci") return runOci(scope, command, args, opts);
  if (mode !== "seatbelt" || process.platform !== "darwin") {
    throw new Error(
      `runSandboxed: sandbox mode '${mode}' is unavailable on ${process.platform}`,
    );
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

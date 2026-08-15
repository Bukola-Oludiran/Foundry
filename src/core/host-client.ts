import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { WorkspaceRegistry } from "./workspaces.ts";

export interface CommandExecution {
  code: number;
  stdout: string;
  stderr: string;
  state?: Record<string, unknown>;
}

export interface CommandRunner {
  run(args: string[], options?: { cwd?: string; signal?: AbortSignal }): Promise<CommandExecution>;
  close?(): Promise<void>;
}

export interface FoundryResult {
  accepted: boolean;
  state: Record<string, unknown>;
  diagnostics: Array<{ code: string; message: string }>;
  provenance: { operationId: string; at: string };
}

export class HostCommandError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export class SubprocessRunner implements CommandRunner {
  constructor(private readonly binary: string) {}

  run(args: string[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<CommandExecution> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(this.binary, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8").trim(), stderr: Buffer.concat(stderr).toString("utf8").trim() }));
    });
  }
}

interface SidecarResponse {
  protocol_version: number;
  id: string;
  result?: { exitCode: number; stdout: string; stderr: string; state: Record<string, unknown> };
  error?: { code: string; message: string };
}

const SIDECAR_OPERATIONS = new Set(["validate", "architect", "build", "status", "cancel", "rearchitect", "publish"]);

export class RustSidecarRunner implements CommandRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, { resolve: (value: CommandExecution) => void; reject: (error: Error) => void }>();
  private closing = false;

  constructor(private readonly binary: string, private readonly sidecarArgs = ["sidecar"]) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.closing) throw new HostCommandError("SIDECAR_CLOSED", "Foundry sidecar is closed");
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(this.binary, this.sidecarArgs, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[foundry-sidecar] ${chunk.toString("utf8")}`));
    const unavailable = (message: string): void => {
      if (this.child !== child) return;
      this.child = null;
      const error = new HostCommandError("SIDECAR_UNAVAILABLE", message);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    child.once("error", (error) => unavailable(error.message));
    child.once("exit", (code, signal) => unavailable(`Foundry sidecar exited (${code ?? signal ?? "unknown"})`));
    return child;
  }

  private onLine(line: string): void {
    let response: SidecarResponse;
    try {
      response = JSON.parse(line) as SidecarResponse;
    } catch {
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    if (response.protocol_version !== 1) request.reject(new HostCommandError("SIDECAR_PROTOCOL_ERROR", "Foundry sidecar returned an unsupported protocol version"));
    else if (response.error) request.reject(new HostCommandError(response.error.code, response.error.message));
    else if (!response.result) request.reject(new HostCommandError("SIDECAR_PROTOCOL_ERROR", "Foundry sidecar response has no result"));
    else request.resolve({ code: response.result.exitCode, stdout: response.result.stdout, stderr: response.result.stderr, state: response.result.state });
  }

  run(args: string[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<CommandExecution> {
    const [operation, ...parameters] = args;
    if (!operation || !SIDECAR_OPERATIONS.has(operation)) return Promise.reject(new HostCommandError("INVALID_OPERATION", "Foundry sidecar operation is not allowed"));
    if (!options.cwd) return Promise.reject(new HostCommandError("INVALID_CWD", "Foundry sidecar requires a working directory"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("operation aborted"));
    const id = randomUUID();
    const child = this.start();
    return new Promise<CommandExecution>((resolveRequest, reject) => {
      const abort = (): void => {
        this.pending.delete(id);
        reject(options.signal?.reason ?? new Error("operation aborted"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { options.signal?.removeEventListener("abort", abort); resolveRequest(value); },
        reject: (error) => { options.signal?.removeEventListener("abort", abort); reject(error); },
      });
      const request = JSON.stringify({ protocol_version: 1, id, method: "execute", params: { operation, arguments: parameters, cwd: options.cwd } });
      child.stdin.write(`${request}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
      child.stdin.end();
    });
  }
}

type CommonPath = { workspaceId: string };

export class FoundryHostClient {
  constructor(readonly workspaces: WorkspaceRegistry, private readonly runner: CommandRunner) {}

  static configured(workspaces: WorkspaceRegistry): FoundryHostClient {
    const binary = resolve(process.env.FOUNDRY_HOST_BIN ?? "gr-host/target/debug/foundry-host");
    if (!existsSync(binary)) throw new HostCommandError("HOST_NOT_BUILT", `Foundry host not found at ${binary}; run cargo build --manifest-path gr-host/Cargo.toml --locked`);
    const runner = process.env.FOUNDRY_HOST_TRANSPORT === "direct" ? new SubprocessRunner(binary) : new RustSidecarRunner(binary);
    return new FoundryHostClient(workspaces, runner);
  }

  async close(): Promise<void> {
    await this.runner.close?.();
  }

  private async execute(args: string[], cwd: string, signal?: AbortSignal): Promise<FoundryResult> {
    const operationId = randomUUID();
    let execution: CommandExecution;
    try {
      execution = await this.runner.run(args, { cwd, signal });
    } catch (error) {
      if (error instanceof HostCommandError) throw error;
      throw new HostCommandError("HOST_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
    if (execution.code !== 0) throw new HostCommandError("HOST_COMMAND_FAILED", execution.stderr || execution.stdout || `Foundry exited with ${execution.code}`, { exitCode: execution.code });
    const runId = execution.stdout.match(/durable run:\s*([^\s]+)/)?.[1];
    const status = execution.stdout.match(/^([^:\n]+):\s*([A-Za-z_]+)$/m);
    return {
      accepted: true,
      state: execution.state ?? { command: args[0], stdout: execution.stdout, ...(runId ? { runId } : {}), ...(status ? { runId: status[1], status: status[2].toLowerCase() } : {}) },
      diagnostics: [],
      provenance: { operationId, at: new Date().toISOString() },
    };
  }

  validate(input: CommonPath & { ir: string }, signal?: AbortSignal): Promise<FoundryResult> {
    const root = this.workspaces.root(input.workspaceId);
    return this.execute(["validate", "--ir", this.workspaces.resolve(input.workspaceId, input.ir)], root, signal);
  }

  architect(input: CommonPath & { spec: string; output: string; base?: string; languages?: string[] }, signal?: AbortSignal): Promise<FoundryResult> {
    const root = this.workspaces.root(input.workspaceId);
    const args = ["architect", "--spec", this.workspaces.resolve(input.workspaceId, input.spec), "--output", this.workspaces.resolve(input.workspaceId, input.output, { output: true }), "--repo", root, "--base", input.base ?? "HEAD"];
    if (input.languages?.length) args.push("--languages", input.languages.join(","));
    return this.execute(args, root, signal);
  }

  build(input: CommonPath & { ir: string; base?: string; durabilityDir: string; dryRun?: boolean }, signal?: AbortSignal): Promise<FoundryResult> {
    const root = this.workspaces.root(input.workspaceId);
    const args = ["build", "--ir", this.workspaces.resolve(input.workspaceId, input.ir), "--repo", root, "--workspace", root, "--base", input.base ?? "HEAD", "--durability", "local", "--durability-dir", this.workspaces.resolve(input.workspaceId, input.durabilityDir, { output: true })];
    if (input.dryRun) args.push("--dry-run");
    return this.execute(args, root, signal);
  }

  status(input: CommonPath & { runId: string; durabilityDir: string }, signal?: AbortSignal): Promise<FoundryResult> {
    const root = this.workspaces.root(input.workspaceId);
    return this.execute(["status", "--run", input.runId, "--durability-dir", this.workspaces.resolve(input.workspaceId, input.durabilityDir)], root, signal);
  }

  cancel(input: CommonPath & { runId: string; durabilityDir: string }, signal?: AbortSignal): Promise<FoundryResult> {
    const root = this.workspaces.root(input.workspaceId);
    return this.execute(["cancel", "--run", input.runId, "--durability-dir", this.workspaces.resolve(input.workspaceId, input.durabilityDir)], root, signal);
  }

  rearchitect(input: CommonPath & { ir: string; proposal: string; node: string; reason: string; output: string }, signal?: AbortSignal): Promise<FoundryResult> {
    const root = this.workspaces.root(input.workspaceId);
    return this.execute(["rearchitect", "--ir", this.workspaces.resolve(input.workspaceId, input.ir), "--proposal", this.workspaces.resolve(input.workspaceId, input.proposal), "--node", input.node, "--reason", input.reason, "--output", this.workspaces.resolve(input.workspaceId, input.output, { output: true })], root, signal);
  }

  publish(input: CommonPath & { runId: string; durabilityDir: string; ir: string; base?: string; summary?: string; draftPr: true }, signal?: AbortSignal): Promise<FoundryResult> {
    const root = this.workspaces.root(input.workspaceId);
    const args = ["publish", "--run", input.runId, "--durability-dir", this.workspaces.resolve(input.workspaceId, input.durabilityDir), "--repo", root, "--base", input.base ?? "main", "--ir", this.workspaces.resolve(input.workspaceId, input.ir), "--draft-pr"];
    if (input.summary) args.push("--summary", this.workspaces.resolve(input.workspaceId, input.summary));
    return this.execute(args, root, signal);
  }
}

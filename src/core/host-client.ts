import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { WorkspaceRegistry } from "./workspaces.ts";

export interface CommandExecution {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(args: string[], options?: { cwd?: string; signal?: AbortSignal }): Promise<CommandExecution>;
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

type CommonPath = { workspaceId: string };

export class FoundryHostClient {
  constructor(readonly workspaces: WorkspaceRegistry, private readonly runner: CommandRunner) {}

  static configured(workspaces: WorkspaceRegistry): FoundryHostClient {
    const binary = resolve(process.env.FOUNDRY_HOST_BIN ?? "gr-host/target/debug/foundry-host");
    if (!existsSync(binary)) throw new HostCommandError("HOST_NOT_BUILT", `Foundry host not found at ${binary}; run cargo build --manifest-path gr-host/Cargo.toml --locked`);
    return new FoundryHostClient(workspaces, new SubprocessRunner(binary));
  }

  private async execute(args: string[], cwd: string, signal?: AbortSignal): Promise<FoundryResult> {
    const operationId = randomUUID();
    let execution: CommandExecution;
    try {
      execution = await this.runner.run(args, { cwd, signal });
    } catch (error) {
      throw new HostCommandError("HOST_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
    if (execution.code !== 0) throw new HostCommandError("HOST_COMMAND_FAILED", execution.stderr || execution.stdout || `Foundry exited with ${execution.code}`, { exitCode: execution.code });
    const runId = execution.stdout.match(/durable run:\s*([^\s]+)/)?.[1];
    const status = execution.stdout.match(/^([^:\n]+):\s*([A-Za-z_]+)$/m);
    return {
      accepted: true,
      state: { command: args[0], stdout: execution.stdout, ...(runId ? { runId } : {}), ...(status ? { runId: status[1], status: status[2].toLowerCase() } : {}) },
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

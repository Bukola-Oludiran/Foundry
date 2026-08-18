import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    options: {
      input?: string;
      timeoutMs: number;
      maxOutputBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<ProcessResult>;
}

/** Shell-free, bounded child-process runner used by OCI adapters. */
export class BoundedProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: string[],
    options: {
      input?: string;
      timeoutMs: number;
      maxOutputBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: { PATH: process.env.PATH ?? "" },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let overflow = false;
      const collect = (destination: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > options.maxOutputBytes) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        destination.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", reject);
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      const abort = () => child.kill("SIGTERM");
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (overflow) {
          reject(new Error("child process exceeded its output limit"));
          return;
        }
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
        });
      });
      child.stdin.end(options.input ?? "");
    });
  }
}

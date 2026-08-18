import { createHash } from "node:crypto";
import {
  lstatSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { TestRequestV2, TestResultV2 } from "../contract.ts";
import { languageBackend } from "../language-backend.ts";
import { BoundedProcessRunner, type ProcessRunner } from "../process-runner.ts";
import { assembleTestFiles, testResultFromExecution } from "../tester.ts";

export interface OciProjectRunnerServiceOptions {
  jobDirectory: string;
  hostJobDirectory: string;
  dependencyArtifactDirectory: string;
  resultArtifactDirectory: string;
  dockerCommand?: string;
  runner?: ProcessRunner;
}

const safeDirectory = (path: string): string => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
};

export class OciProjectRunnerService {
  private readonly jobs: string;
  private readonly hostJobs: string;
  private readonly dependencies: string;
  private readonly artifacts: string;
  private readonly docker: string;
  private readonly runner: ProcessRunner;

  constructor(options: OciProjectRunnerServiceOptions) {
    this.jobs = safeDirectory(options.jobDirectory);
    this.hostJobs = resolve(options.hostJobDirectory);
    this.dependencies = safeDirectory(options.dependencyArtifactDirectory);
    this.artifacts = safeDirectory(options.resultArtifactDirectory);
    this.docker = options.dockerCommand ?? "docker";
    this.runner = options.runner ?? new BoundedProcessRunner();
  }

  async readiness(): Promise<{ ready: boolean }> {
    const result = await this.runner.run(
      this.docker,
      ["version", "--format", "{{.Server.Version}}"],
      { timeoutMs: 10_000, maxOutputBytes: 4096 },
    );
    return { ready: result.code === 0 };
  }

  async test(
    request: TestRequestV2,
    signal?: AbortSignal,
  ): Promise<TestResultV2> {
    const backend = languageBackend(request.language);
    const identity = createHash("sha256")
      .update(request.job_id)
      .digest("hex")
      .slice(0, 24);
    const job = join(this.jobs, identity);
    const hostJob = join(this.hostJobs, identity);
    rmSync(job, { recursive: true, force: true });
    mkdirSync(job, { recursive: false, mode: 0o755 });
    try {
      const files = assembleTestFiles(request, backend);
      for (const file of files) {
        if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(file.name))
          throw new Error("unsafe runner file");
        writeFileSync(join(job, file.name), file.content, {
          mode: 0o444,
          flag: "wx",
        });
      }
      const args = [
        "run",
        "--rm",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(request.resource_policy.pids),
        "--memory",
        `${request.resource_policy.memory_mb}m`,
        "--cpus",
        String(request.resource_policy.cpu_count),
        "--user",
        "65532:65532",
        "--workdir",
        "/job",
        "--mount",
        `type=bind,src=${hostJob},dst=/job,readonly`,
        "--tmpfs",
        "/tmp:rw,exec,nosuid,size=256m",
        "--network",
        request.resource_policy.network === "none"
          ? "none"
          : (request.test_environment?.network_id ?? "none"),
        "--label",
        `foundry.run_id=${request.run_id}`,
        "--label",
        `foundry.job_id=${identity}`,
      ];
      if (request.dependency_layer) {
        const artifact = join(
          this.dependencies,
          request.dependency_layer.sha256,
        );
        if (
          createHash("sha256").update(readFileSync(artifact)).digest("hex") !==
          request.dependency_layer.sha256
        ) {
          throw new Error("dependency layer checksum mismatch");
        }
        const extracted = join(job, "dependencies");
        mkdirSync(extracted, { mode: 0o700 });
        const listing = await this.runner.run(
          "tar",
          ["--list", "--file", artifact],
          {
            timeoutMs: 30_000,
            maxOutputBytes: 4 * 1024 * 1024,
            signal,
          },
        );
        const listed = listing.stdout.split("\n").filter(Boolean);
        if (
          listing.code !== 0 ||
          listed.length > 100_000 ||
          listed.some(
            (path) =>
              path.startsWith("/") ||
              path.includes("\\") ||
              path.split("/").some((segment) => segment === ".."),
          )
        ) {
          throw new Error("dependency layer archive contains unsafe paths");
        }
        const extraction = await this.runner.run(
          "tar",
          [
            "--extract",
            "--file",
            artifact,
            "--directory",
            extracted,
            "--no-same-owner",
            "--no-same-permissions",
          ],
          { timeoutMs: 60_000, maxOutputBytes: 64 * 1024, signal },
        );
        if (extraction.code !== 0)
          throw new Error("dependency layer extraction failed");
        this.verifyExtractedLayer(extracted);
        args.push(
          "--mount",
          `type=bind,src=${join(hostJob, "dependencies")},dst=/dependencies,readonly`,
        );
        if (request.language === "python")
          args.push("--env", "PYTHONPATH=/dependencies/python");
        if (request.language === "typescript")
          args.push("--env", "NODE_PATH=/dependencies/node_modules");
        if (request.language === "go")
          args.push("--env", "GOMODCACHE=/dependencies/gomodcache");
      }
      if (request.language === "go") {
        args.push("--env", "GOCACHE=/tmp/go-build", "--env", "GOPATH=/tmp/go");
      }
      if (request.language === "python") {
        args.push("--env", "PYTHONDONTWRITEBYTECODE=1");
      }
      const invocation = backend.localCommand(files.map((file) => file.name));
      args.push(backend.ociImage, invocation.command, ...invocation.args);
      const started = Date.now();
      const execution = await this.runner.run(this.docker, args, {
        timeoutMs: Math.min(
          request.resource_policy.timeout_ms,
          (request.acceptance.perf?.time_ms ??
            request.resource_policy.timeout_ms) + 2_000,
        ),
        maxOutputBytes: 1024 * 1024,
        signal,
      });
      const core = testResultFromExecution(
        request,
        execution.stdout,
        {
          code: execution.code ?? -1,
          signal: execution.signal,
          stdout: execution.stdout,
          stderr: execution.stderr,
        },
        Math.max(0, Date.now() - started),
      );
      const sanitizedCore = {
        ...core,
        piston: { ...core.piston, stdout: "", stderr: "" },
      };
      const { artifact: originalArtifact, ...acceptedEvidence } = sanitizedCore;
      const encoded = Buffer.from(JSON.stringify(acceptedEvidence));
      const acceptedArtifact = {
        sha256: createHash("sha256").update(encoded).digest("hex"),
        size: encoded.byteLength,
        media_type: originalArtifact.media_type,
      };
      const result: TestResultV2 = {
        ...acceptedEvidence,
        artifact: acceptedArtifact,
        protocol_version: 2,
        job_id: request.job_id,
        run_id: request.run_id,
        dependency_layer_sha256: request.dependency_layer?.sha256 ?? null,
        environment_snapshot_digest:
          request.test_environment?.snapshot_digest ?? null,
      };
      if (
        /bearer\s+|authorization|cookie|password|private[_ -]?key|nsec1|ghp_|github_pat_/i.test(
          JSON.stringify(result),
        )
      ) {
        throw new Error("project result contains secret-shaped material");
      }
      const artifactPath = join(this.artifacts, acceptedArtifact.sha256);
      try {
        writeFileSync(artifactPath, encoded, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return result;
    } finally {
      rmSync(job, { recursive: true, force: true });
    }
  }

  private verifyExtractedLayer(root: string): void {
    let entries = 0;
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        entries++;
        if (entries > 100_000)
          throw new Error("dependency layer has too many entries");
        const path = join(directory, name);
        const metadata = lstatSync(path);
        if (
          metadata.isSymbolicLink() ||
          (!metadata.isFile() && !metadata.isDirectory())
        ) {
          throw new Error("dependency layer contains an unsafe entry");
        }
        if (metadata.isFile() && metadata.size > 64 * 1024 * 1024) {
          throw new Error("dependency layer entry is oversized");
        }
        if (metadata.isDirectory()) {
          chmodSync(path, 0o555);
          visit(path);
        } else {
          chmodSync(path, 0o444);
        }
      }
    };
    visit(root);
    chmodSync(root, 0o555);
  }
}

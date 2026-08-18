import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FilesystemDependencyArtifactStore } from "../src/dependency-artifacts.ts";
import { OciDependencyResolver } from "../src/dependency-resolver.ts";
import { StubLlm } from "../src/llm.ts";
import type { EnvironmentManager } from "../src/environment-manager.ts";
import type { ProjectRunner } from "../src/project-runner.ts";
import { createFoundryServer } from "../src/server.ts";
import { DockerEnvironmentController } from "../src/runtime/environment-controller.ts";
import { OciProjectRunnerService } from "../src/runtime/project-runner-service.ts";
import type {
  DependencyResolutionPlanV1,
  ResolveDependenciesResultV2,
} from "../src/contract.ts";

const requireDocker = process.env.FOUNDRY_REQUIRE_LIVE_DOCKER === "1";
const repositoryRoot = resolve("..");
const fixture = join(repositoryRoot, "ir/examples/polyglot-live.ir-v2.json");
const host = join(repositoryRoot, "gr-host/target/debug/foundry-host");
const root = mkdtempSync(join(tmpdir(), "foundry-live-polyglot-"));
const network = `foundry-resolver-live-${process.pid}`;
const cleanupRunIds: string[] = [];
const token = "foundry-live-worker-token-0000000000000000";
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function command(
  command: string,
  args: string[],
  cwd = repositoryRoot,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function run(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function dockerReady(): boolean {
  return spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
}

function imageReference(tag: string, dockerfile: string): string {
  execFileSync("docker", ["build", "--tag", tag, "--file", dockerfile, "."], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  const reference = command("docker", [
    "image",
    "inspect",
    tag,
    "--format",
    "{{index .RepoDigests 0}}",
  ]);
  if (!/^[a-zA-Z0-9_.\/-]+@sha256:[a-f0-9]{64}$/.test(reference))
    throw new Error("image is not digest-addressable");
  return reference;
}

function artifact(directory: string, bytes: Buffer, mediaType: string) {
  const digest = sha256(bytes);
  writeFileSync(join(directory, digest), bytes);
  return { sha256: digest, size: bytes.byteLength, media_type: mediaType };
}

function bundle(
  kind: "manifest" | "lockfile",
  path: string,
  content: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      bundle_version: 1,
      kind,
      files: [
        {
          path,
          sha256: sha256(content),
          content_base64: Buffer.from(content).toString("base64"),
        },
      ],
    }),
  );
}

function prepareCatalog(
  directory: string,
  plan: DependencyResolutionPlanV1,
  resolverImage: string,
  platform: string,
): void {
  const artifacts = join(directory, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const packageJson = `${JSON.stringify(
    {
      name: "foundry-live-fixture",
      private: true,
      dependencies: { "fast-json-stable-stringify": "2.1.0" },
    },
    null,
    2,
  )}\n`;
  const packageLock = `${JSON.stringify(
    {
      name: "foundry-live-fixture",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "foundry-live-fixture",
          dependencies: { "fast-json-stable-stringify": "2.1.0" },
        },
      },
    },
    null,
    2,
  )}\n`;
  const empty = join(directory, "empty");
  mkdirSync(empty);
  const layerPath = join(directory, "layer.tar");
  execFileSync("tar", ["-cf", layerPath, "-C", empty, "."]);
  const refs = [
    artifact(
      artifacts,
      bundle("manifest", "package.json", packageJson),
      "application/vnd.foundry.package-manifests.v1+json",
    ),
    artifact(
      artifacts,
      bundle("lockfile", "package-lock.json", packageLock),
      "application/vnd.foundry.package-lockfiles.v1+json",
    ),
    artifact(
      artifacts,
      readFileSync(layerPath),
      "application/vnd.foundry.dependency-layer.v1+tar",
    ),
    artifact(
      artifacts,
      Buffer.from(
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          components: [],
        }),
      ),
      "application/vnd.cyclonedx+json",
    ),
    artifact(
      artifacts,
      Buffer.from(
        JSON.stringify({
          packages: [{ name: "fast-json-stable-stringify", license: "MIT" }],
        }),
      ),
      "application/vnd.foundry.license-report.v1+json",
    ),
    artifact(
      artifacts,
      Buffer.from(JSON.stringify({ vulnerabilities: [] })),
      "application/vnd.foundry.vulnerability-report.v1+json",
    ),
  ];
  const result: ResolveDependenciesResultV2 = {
    ok: true,
    evidence: {
      resolution_version: 1,
      plan_digest: plan.plan_digest,
      resolver_image: resolverImage,
      platform,
      manifest_sha256: refs[0]!.sha256,
      lockfile_sha256: refs[1]!.sha256,
      dependency_layer_sha256: refs[2]!.sha256,
      sbom_sha256: refs[3]!.sha256,
      packages: [
        {
          package_id: "stable-json",
          name: "fast-json-stable-stringify",
          version: "2.1.0",
          integrity: "sha512-livefixtureintegrity",
          licenses: ["MIT"],
        },
      ],
      vulnerabilities: [],
    },
    manifest: refs[0]!,
    lockfile: refs[1]!,
    dependency_layer: refs[2]!,
    sbom: refs[3]!,
    license_report: refs[4]!,
    vulnerability_report: refs[5]!,
    error: null,
    failure_code: null,
  };
  writeFileSync(
    join(directory, "index.json"),
    JSON.stringify({ [plan.plan_digest]: result }),
  );
}

function repository(directory: string): string {
  mkdirSync(join(directory, "migrations"), { recursive: true });
  mkdirSync(join(directory, "contracts"), { recursive: true });
  writeFileSync(
    join(directory, "migrations/001_create_payments.sql"),
    "CREATE TABLE IF NOT EXISTS payments (id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL);\n",
  );
  writeFileSync(join(directory, "contracts/payments.json"), "{}\n");
  writeFileSync(join(directory, "README.md"), "# Foundry live fixture\n");
  command("git", ["init", "--initial-branch=main"], directory);
  command("git", ["config", "user.name", "Foundry Acceptance"], directory);
  command(
    "git",
    ["config", "user.email", "acceptance@foundry.invalid"],
    directory,
  );
  command("git", ["add", "."], directory);
  command("git", ["commit", "-m", "Initial fixture"], directory);
  return command("git", ["rev-parse", "HEAD"], directory);
}

function implementations(node: string): string {
  const values: Record<string, string> = {
    system: 'export function start(): string { return "ready"; }\n',
    normalizer: 'def normalize():\n    return "ready"\n',
    payments: `export async function charge(): Promise<string> {
  const response = await fetch("http://payments-api:8080/v1/payment_intents", {
    method: "POST",
    headers: { "content-type": "application/json", "x-foundry-operation": "create-payment" },
    body: JSON.stringify({ amount: 1000 }),
  });
  if (!response.ok) throw new Error("payment contract rejected");
  return (await response.json() as { status: string }).status;
}\n`,
    counter: "package main\n\nfunc Count() int { return 3 }\n",
  };
  return values[node] ?? "";
}

async function main(): Promise<void> {
  if (!dockerReady()) {
    if (requireDocker)
      throw new Error("Docker is required for live polyglot acceptance");
    console.log(
      "SKIP — Docker is unavailable (set FOUNDRY_REQUIRE_LIVE_DOCKER=1 to require it)",
    );
    return;
  }
  execFileSync("cargo", ["build", "-q", "-p", "foundry-host"], {
    cwd: join(repositoryRoot, "gr-host"),
    stdio: "inherit",
  });
  const resolverImage = imageReference(
    "foundry-dependency-resolver:acceptance",
    "pi-pool/runtime/images/Dockerfile.dependency-resolver",
  );
  const emulatorImage = imageReference(
    "foundry-integration-emulator:acceptance",
    "pi-pool/runtime/images/Dockerfile.integration-emulator",
  );
  execFileSync("docker", ["pull", "postgres:17.2-alpine"], {
    stdio: "inherit",
  });
  const postgresDigest = command("docker", [
    "image",
    "inspect",
    "postgres:17.2-alpine",
    "--format",
    "{{index .RepoDigests 0}}",
  ]);
  const dockerArch = command("docker", [
    "info",
    "--format",
    "{{.Architecture}}",
  ]);
  const arch = ["arm64", "aarch64"].includes(dockerArch) ? "arm64" : "amd64";
  const platform = `linux/${arch}`;
  execFileSync("docker", ["network", "create", "--internal", network]);

  const plan = JSON.parse(
    command(host, ["deps", "resolve", "--ir", fixture, "--dry-run"]),
  ) as DependencyResolutionPlanV1;
  const catalog = join(root, "catalog");
  mkdirSync(catalog);
  prepareCatalog(catalog, plan, resolverImage, platform);
  const dependencyArtifacts = join(root, "dependency-artifacts");
  const workspaceRoot = join(root, "workspaces");
  const runnerJobs = join(root, "runner-jobs");
  const runnerResults = join(root, "runner-results");
  const controllerState = join(root, "controller-state");
  const controllerArtifacts = join(root, "controller-artifacts");
  for (const directory of [
    dependencyArtifacts,
    workspaceRoot,
    runnerJobs,
    runnerResults,
    controllerState,
    controllerArtifacts,
  ])
    mkdirSync(directory, { recursive: true });

  const controller = new DockerEnvironmentController({
    stateDirectory: controllerState,
    artifactDirectory: controllerArtifacts,
    workspaceRoot,
  });
  const runner = new OciProjectRunnerService({
    jobDirectory: runnerJobs,
    hostJobDirectory: runnerJobs,
    dependencyArtifactDirectory: dependencyArtifacts,
    resultArtifactDirectory: runnerResults,
  });
  const environmentManager: EnvironmentManager = {
    readiness: async () => ({
      ...(await controller.readiness()),
      reason: null,
    }),
    start: (request, signal) => controller.start(request, signal),
    health: (request, signal) => controller.health(request, signal),
    migrate: (request, signal) => controller.migrate(request, signal),
    snapshot: async (request) => controller.snapshot(request),
    evidence: (request, signal) => controller.evidence(request, signal),
    teardown: (request, signal) => controller.teardown(request, signal),
  };
  const projectRunner: ProjectRunner = {
    readiness: async () => ({ ...(await runner.readiness()), reason: null }),
    test: (request, signal) => runner.test(request, signal),
  };
  const server = createFoundryServer({
    llm: new StubLlm((request) =>
      implementations(String(request.meta?.node_id ?? "")),
    ),
    authToken: token,
    workspaceRoot,
    idempotencyDir: join(root, "worker-idempotency"),
    dependencyResolver: new OciDependencyResolver({
      network,
      proxyUrl: "http://registry-proxy.invalid:8080",
      artifactDirectory: dependencyArtifacts,
      catalogDirectory: catalog,
    }),
    dependencyArtifactStore: new FilesystemDependencyArtifactStore(
      dependencyArtifacts,
    ),
    environmentManager,
    projectRunner,
    requireProtocolV2: true,
    requireSandbox: true,
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const worker = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.FOUNDRY_SANDBOX = "oci";
  process.env.FOUNDRY_ALLOW_ROOTFUL_OCI = "1";

  try {
    for (const crashPoint of [
      "after_environment_evidence_dispatch",
      "after_environment_evidence_commit",
    ]) {
      const scope = join(root, crashPoint);
      const repo = join(scope, "repo");
      const workspaces = join(workspaceRoot, crashPoint);
      const persistence = join(scope, "persistence");
      mkdirSync(repo, { recursive: true });
      mkdirSync(workspaces, { recursive: true });
      const base = repository(repo);
      const runDigest = sha256(`${sha256(readFileSync(fixture))}:${base}:all`);
      const runId = `run-${runDigest.slice(0, 16)}`;
      cleanupRunIds.push(runId);
      const args = [
        "build",
        "--ir",
        fixture,
        "--pi-pool",
        worker,
        "--workspace",
        workspaces,
        "--repo",
        repo,
        "--base",
        base,
        "--durability",
        "local",
        "--durability-dir",
        persistence,
      ];
      const env = {
        ...process.env,
        FOUNDRY_WORKER_TOKEN: token,
        FOUNDRY_RESOLVER_IMAGE: resolverImage,
        FOUNDRY_RESOLVER_PLATFORM: platform,
        FOUNDRY_RESOURCE_IMAGES_JSON: JSON.stringify({
          postgresql: postgresDigest,
        }),
        FOUNDRY_EMULATOR_IMAGE: emulatorImage,
        FOUNDRY_CRASH_AT: crashPoint,
        FOUNDRY_CRASH_MARKER: join(scope, `${crashPoint}.marker`),
      };
      const crashed = await run(host, args, {
        cwd: repositoryRoot,
        env,
      });
      if (crashed.status !== 86) {
        throw new Error(
          `${crashPoint} did not inject a crash: ${crashed.stderr || crashed.stdout}`,
        );
      }
      const recovered = await run(host, args, {
        cwd: repositoryRoot,
        env,
      });
      if (recovered.status !== 0 || !recovered.stdout.includes("ALL GREEN")) {
        throw new Error(
          `${crashPoint} did not recover: ${recovered.stderr || recovered.stdout}`,
        );
      }
      const worktree = join(workspaces, ".foundry", "attempts", runId);
      for (const path of [
        "src/system.ts",
        "src/normalizer.py",
        "src/payments.ts",
        "src/counter.go",
        "package.json",
        "package-lock.json",
        ".foundry/dependencies/resolution.json",
        ".foundry/resources/evidence.json",
      ]) {
        if (!existsSync(join(worktree, path)))
          throw new Error(`${crashPoint} omitted ${path}`);
      }
      const evidence = JSON.parse(
        readFileSync(
          join(worktree, ".foundry/resources/evidence.json"),
          "utf8",
        ),
      ) as {
        evidence_version: number;
        migrations: {
          green: boolean;
          outcomes: Array<{ applied: boolean; repeatable_verified: boolean }>;
        };
        test_evidence: {
          green: boolean;
          unexpected_requests: number;
          contracts: Array<{ observed_count: number; matched: boolean }>;
          resource_usage: Array<{ resource_id: string }>;
        };
        teardown: { cleanup_complete: boolean };
      };
      if (
        evidence.evidence_version !== 2 ||
        !evidence.migrations.green ||
        evidence.migrations.outcomes.some(
          (value) => !value.applied || !value.repeatable_verified,
        ) ||
        !evidence.test_evidence.green ||
        evidence.test_evidence.unexpected_requests !== 0 ||
        evidence.test_evidence.contracts.length !== 1 ||
        evidence.test_evidence.contracts[0]?.observed_count !== 1 ||
        evidence.test_evidence.contracts[0]?.matched !== true ||
        !evidence.test_evidence.resource_usage.some(
          (value) => value.resource_id === "primary-db",
        ) ||
        !evidence.teardown.cleanup_complete
      )
        throw new Error(
          `${crashPoint} produced incomplete environment evidence`,
        );
      const commits = Number(
        command("git", ["rev-list", "--count", "HEAD"], worktree),
      );
      if (commits !== 2)
        throw new Error(`${crashPoint} produced duplicate delivery commits`);
      const containers = command("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=foundry.run_id=${runId}`,
      ]);
      if (containers) throw new Error(`${crashPoint} leaked build containers`);
      if (readdirSync(controllerState).length !== 0)
        throw new Error(
          `${crashPoint} retained controller state after teardown`,
        );
      console.log(
        `OK  ${crashPoint} resumes once with complete evidence and cleanup`,
      );
    }
    console.log(
      "OK  live IR v2 polyglot supply-chain/resource/integration acceptance passed",
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

try {
  await main();
} finally {
  if (dockerReady()) {
    for (const runId of cleanupRunIds) {
      for (const [kind, listArgs, remove] of [
        [
          "container",
          ["ps", "-aq", "--filter", `label=foundry.run_id=${runId}`],
          ["rm", "-f"],
        ],
        [
          "network",
          ["network", "ls", "-q", "--filter", `label=foundry.run_id=${runId}`],
          ["network", "rm"],
        ],
      ] as const) {
        const listed = spawnSync("docker", listArgs, { encoding: "utf8" });
        const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
        if (ids.length > 0) {
          const removed = spawnSync("docker", [...remove, ...ids], {
            stdio: "ignore",
          });
          if (removed.status !== 0)
            console.error(`could not clean ${kind} fixtures`);
        }
      }
    }
    spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  }
  rmSync(root, { recursive: true, force: true });
}

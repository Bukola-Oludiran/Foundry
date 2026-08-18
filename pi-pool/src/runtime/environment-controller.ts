import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  ApplyMigrationsRequestV2,
  CollectEnvironmentEvidenceRequestV2,
  ContentArtifact,
  EnvironmentActionRequestV2,
  EnvironmentHandleV2,
  EnvironmentHealthV2,
  EnvironmentSnapshotV2,
  EnvironmentTestEvidenceV2,
  EnvironmentTeardownV2,
  MigrationOutcomeV2,
  StartEnvironmentRequestV2,
} from "../contract.ts";
import { BoundedProcessRunner, type ProcessRunner } from "../process-runner.ts";

interface PersistedEnvironmentV1 {
  state_version: 1;
  environment_id: string;
  run_id: string;
  plan_digest: string;
  network_id: string;
  aliases: Record<string, string>;
  secret_handles: string[];
  containers: Array<{ id: string; name: string; kind: string }>;
}

export interface DockerEnvironmentControllerOptions {
  stateDirectory: string;
  artifactDirectory: string;
  workspaceRoot: string;
  dockerCommand?: string;
  runner?: ProcessRunner;
}

const safeName = (value: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const digest = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const stableName = (prefix: string, value: string): string =>
  `foundry-${prefix}-${digest(value).slice(0, 20)}`;

function safeDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a regular directory`);
  }
  return realpathSync(path);
}

function exactState(value: unknown): PersistedEnvironmentV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("environment state is invalid");
  }
  const state = value as PersistedEnvironmentV1;
  const allowed = new Set([
    "state_version",
    "environment_id",
    "run_id",
    "plan_digest",
    "network_id",
    "aliases",
    "secret_handles",
    "containers",
  ]);
  if (
    Object.keys(state).some((key) => !allowed.has(key)) ||
    state.state_version !== 1 ||
    !safeName(state.environment_id) ||
    !safeName(state.network_id) ||
    !/^[a-f0-9]{64}$/.test(state.plan_digest) ||
    !Array.isArray(state.containers) ||
    !Array.isArray(state.secret_handles)
  ) {
    throw new Error("environment state is invalid");
  }
  return state;
}

export class DockerEnvironmentController {
  private readonly stateDirectory: string;
  private readonly artifactDirectory: string;
  private readonly workspaceRoot: string;
  private readonly docker: string;
  private readonly runner: ProcessRunner;

  constructor(options: DockerEnvironmentControllerOptions) {
    this.stateDirectory = safeDirectory(options.stateDirectory);
    this.artifactDirectory = safeDirectory(options.artifactDirectory);
    this.workspaceRoot = safeDirectory(options.workspaceRoot);
    this.docker = options.dockerCommand ?? "docker";
    this.runner = options.runner ?? new BoundedProcessRunner();
  }

  async readiness(): Promise<{ ready: boolean }> {
    const result = await this.run(
      ["version", "--format", "{{.Server.Version}}"],
      10_000,
    );
    return { ready: result.code === 0 && result.stdout.trim().length > 0 };
  }

  async start(
    request: StartEnvironmentRequestV2,
    signal?: AbortSignal,
  ): Promise<EnvironmentHandleV2> {
    const environmentId = stableName(
      "environment",
      `${request.run_id}:${request.plan.plan_digest}`,
    );
    const networkId = stableName("network", environmentId);
    const existing = this.load(environmentId);
    if (existing) {
      this.assertIdentity(existing, request.run_id, request.plan.plan_digest);
      return this.handle(existing, "ready");
    }
    await this.ensureNetwork(networkId, environmentId, request, signal);
    const containers: PersistedEnvironmentV1["containers"] = [];
    const aliases: Record<string, string> = {};
    const secretHandles: string[] = [];

    for (const resource of request.plan.resources) {
      const image = request.resource_images[resource.image_key];
      if (!image) throw new Error("resource image is missing");
      const name = stableName(
        "resource",
        `${environmentId}:${resource.resource_id}`,
      );
      const credentials = this.resourceCredentials(resource.kind);
      const handles = Object.keys(credentials).map(
        (key) =>
          `secret:${environmentId}:${resource.resource_id}:${key.toLowerCase()}`,
      );
      secretHandles.push(...handles);
      await this.ensureContainer(
        name,
        environmentId,
        resource.resource_id,
        resource.kind,
        resource.private_alias,
        image,
        networkId,
        credentials,
        this.resourceCommand(resource.kind),
        this.resourceTmpfs(resource.kind),
        request,
        signal,
      );
      aliases[resource.private_alias] = resource.private_alias;
      containers.push({ id: resource.resource_id, name, kind: resource.kind });
    }
    for (const integration of request.plan.integrations) {
      const name = stableName(
        "integration",
        `${environmentId}:${integration.integration_id}`,
      );
      await this.ensureContainer(
        name,
        environmentId,
        integration.integration_id,
        `integration:${integration.kind}`,
        integration.private_alias,
        request.emulator_image,
        networkId,
        {
          FOUNDRY_INTEGRATION_ID: integration.integration_id,
          FOUNDRY_INTEGRATION_KIND: integration.kind,
          FOUNDRY_INTEGRATION_OPERATIONS: JSON.stringify(
            integration.operations,
          ),
          FOUNDRY_INTEGRATION_EXPECTATIONS: JSON.stringify(
            request.plan.integration_expectations.filter(
              (expectation) =>
                expectation.integration_id === integration.integration_id,
            ),
          ),
        },
        ["serve", "--integration", integration.integration_id],
        ["/tmp:rw,noexec,nosuid,size=32m"],
        request,
        signal,
      );
      aliases[integration.private_alias] = integration.private_alias;
      containers.push({
        id: integration.integration_id,
        name,
        kind: `integration:${integration.kind}`,
      });
    }
    const state: PersistedEnvironmentV1 = {
      state_version: 1,
      environment_id: environmentId,
      run_id: request.run_id,
      plan_digest: request.plan.plan_digest,
      network_id: networkId,
      aliases,
      secret_handles: [...new Set(secretHandles)].sort(),
      containers,
    };
    this.persist(state);
    return this.handle(state, "ready");
  }

  async health(
    request: EnvironmentActionRequestV2,
    signal?: AbortSignal,
  ): Promise<EnvironmentHealthV2> {
    const state = this.require(request);
    const services = [];
    for (const container of state.containers) {
      let healthy = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const inspection = await this.run(
          ["inspect", "--format", "{{.State.Running}}", container.name],
          10_000,
          undefined,
          signal,
        );
        healthy = inspection.code === 0 && inspection.stdout.trim() === "true";
        if (healthy && container.kind === "postgresql") {
          const ready = await this.run(
            [
              "exec",
              container.name,
              "pg_isready",
              "-U",
              "foundry",
              "-d",
              "foundry",
            ],
            10_000,
            undefined,
            signal,
          );
          healthy = ready.code === 0;
        }
        if (healthy && container.kind.startsWith("integration:")) {
          const ready = await this.run(
            [
              "exec",
              container.name,
              "node",
              "--input-type=module",
              "--eval",
              "const r=await fetch('http://127.0.0.1:8080/ready');if(!r.ok)process.exit(2)",
            ],
            10_000,
            undefined,
            signal,
          );
          healthy = ready.code === 0;
        }
        if (healthy) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      services.push({
        id: container.id,
        healthy,
        detail: null,
      });
    }
    return {
      environment_id: state.environment_id,
      plan_digest: state.plan_digest,
      healthy: services.every((service) => service.healthy),
      services,
    };
  }

  async migrate(
    request: ApplyMigrationsRequestV2,
    signal?: AbortSignal,
  ): Promise<{
    environment_id: string;
    plan_digest: string;
    green: boolean;
    outcomes: MigrationOutcomeV2[];
    artifact: ContentArtifact;
  }> {
    const state = this.require(request);
    const workspace = realpathSync(request.workspace);
    if (
      !workspace.startsWith(`${this.workspaceRoot}/`) &&
      workspace !== this.workspaceRoot
    ) {
      throw new Error("migration workspace escaped the configured root");
    }
    const outcomes: MigrationOutcomeV2[] = [];
    for (const migration of request.migrations) {
      const container = state.containers.find(
        (candidate) => candidate.id === migration.resource_id,
      );
      if (!container || container.kind !== "postgresql") {
        throw new Error("only declared PostgreSQL resources accept migrations");
      }
      const directory = realpathSync(
        resolve(workspace, migration.migration_path),
      );
      if (!directory.startsWith(`${workspace}/`)) {
        throw new Error("migration directory escaped the workspace");
      }
      const files = this.migrationFiles(directory);
      const migrationDigest = digest(
        files
          .map(
            (file) =>
              `${relative(directory, file)}\0${digest(readFileSync(file))}`,
          )
          .join("\n"),
      );
      const started = Date.now();
      let applied = true;
      let repeatable = true;
      for (const file of files) {
        const sql = readFileSync(file, "utf8");
        const result = await this.run(
          [
            "exec",
            "--interactive",
            "--user",
            "postgres",
            container.name,
            "psql",
            "--set",
            "ON_ERROR_STOP=1",
            "--username",
            "foundry",
            "--dbname",
            "foundry",
          ],
          120_000,
          sql,
          signal,
        );
        applied &&= result.code === 0;
        if (migration.require_repeatable && result.code === 0) {
          const repeated = await this.run(
            [
              "exec",
              "--interactive",
              "--user",
              "postgres",
              container.name,
              "psql",
              "--set",
              "ON_ERROR_STOP=1",
              "--username",
              "foundry",
              "--dbname",
              "foundry",
            ],
            120_000,
            sql,
            signal,
          );
          repeatable &&= repeated.code === 0;
        }
      }
      outcomes.push({
        resource_id: migration.resource_id,
        owner_node: migration.owner_node,
        migration_digest: migrationDigest,
        applied,
        repeatable_verified: migration.require_repeatable ? repeatable : false,
        duration_ms: Date.now() - started,
        diagnostic: applied && repeatable ? null : "migration command failed",
      });
    }
    const payload = {
      environment_id: state.environment_id,
      plan_digest: state.plan_digest,
      green: outcomes.every(
        (outcome, index) =>
          outcome.applied &&
          (!request.migrations[index]?.require_repeatable ||
            outcome.repeatable_verified),
      ),
      outcomes,
    };
    return { ...payload, artifact: this.artifact("migration", payload) };
  }

  snapshot(request: EnvironmentActionRequestV2): EnvironmentSnapshotV2 {
    const state = this.require(request);
    const projection = {
      environment_id: state.environment_id,
      plan_digest: state.plan_digest,
      network_id: state.network_id,
      services: state.containers.map(({ id, kind }) => ({ id, kind })),
    };
    return {
      environment_id: state.environment_id,
      plan_digest: state.plan_digest,
      snapshot_digest: digest(JSON.stringify(projection)),
      artifact: this.artifact("snapshot", projection),
    };
  }

  async evidence(
    request: CollectEnvironmentEvidenceRequestV2,
    signal?: AbortSignal,
  ): Promise<EnvironmentTestEvidenceV2> {
    const state = this.require(request);
    const contracts: EnvironmentTestEvidenceV2["contracts"] = [];
    let unexpectedRequests = 0;
    for (const container of state.containers.filter((candidate) =>
      candidate.kind.startsWith("integration:"),
    )) {
      const result = await this.run(
        [
          "exec",
          container.name,
          "node",
          "--input-type=module",
          "--eval",
          "const r=await fetch('http://127.0.0.1:8080/__foundry/evidence');if(!r.ok)process.exit(2);process.stdout.write(await r.text())",
        ],
        30_000,
        undefined,
        signal,
      );
      if (result.code !== 0)
        throw new Error("integration evidence unavailable");
      const value = JSON.parse(result.stdout) as {
        contracts?: EnvironmentTestEvidenceV2["contracts"];
        unexpected_requests?: number;
      };
      if (!Array.isArray(value.contracts)) {
        throw new Error("integration evidence is malformed");
      }
      contracts.push(...value.contracts);
      unexpectedRequests += value.unexpected_requests ?? 0;
    }
    const resourceContainers = state.containers.filter(
      (candidate) => !candidate.kind.startsWith("integration:"),
    );
    const usage: EnvironmentTestEvidenceV2["resource_usage"] = [];
    if (resourceContainers.length > 0) {
      const stats = await this.run(
        [
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          ...resourceContainers.map((container) => container.name),
        ],
        30_000,
        undefined,
        signal,
      );
      if (stats.code !== 0) throw new Error("resource usage unavailable");
      const lines = stats.stdout.trim().split("\n").filter(Boolean);
      if (lines.length !== resourceContainers.length) {
        throw new Error("resource usage coverage is incomplete");
      }
      for (const [index, line] of lines.entries()) {
        const value = JSON.parse(line) as {
          CPUPerc?: string;
          MemUsage?: string;
          PIDs?: string;
        };
        usage.push({
          resource_id: resourceContainers[index]!.id,
          cpu_percent: this.percentage(value.CPUPerc),
          memory_bytes: this.memoryBytes(value.MemUsage),
          pids: this.integer(value.PIDs),
        });
      }
    }
    contracts.sort((left, right) =>
      `${left.integration_id}\0${left.operation}\0${left.node}`.localeCompare(
        `${right.integration_id}\0${right.operation}\0${right.node}`,
      ),
    );
    const payload = {
      environment_id: state.environment_id,
      run_id: state.run_id,
      plan_digest: state.plan_digest,
      green:
        unexpectedRequests === 0 &&
        contracts.every((contract) => contract.matched),
      contracts,
      unexpected_requests: unexpectedRequests,
      resource_usage: usage,
    };
    return { ...payload, artifact: this.artifact("test-evidence", payload) };
  }

  async teardown(
    request: EnvironmentActionRequestV2,
    signal?: AbortSignal,
  ): Promise<EnvironmentTeardownV2> {
    const state = this.load(request.environment_id);
    if (state) this.assertIdentity(state, request.run_id, request.plan_digest);
    if (state) {
      for (const container of state.containers) {
        await this.run(
          ["rm", "--force", container.name],
          30_000,
          undefined,
          signal,
        );
      }
      await this.run(
        ["network", "rm", state.network_id],
        30_000,
        undefined,
        signal,
      );
    }
    const remaining = await this.run(
      [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=foundry.environment_id=${request.environment_id}`,
      ],
      10_000,
      undefined,
      signal,
    );
    const complete = remaining.code === 0 && remaining.stdout.trim() === "";
    if (complete && state) {
      try {
        unlinkSync(this.statePath(request.environment_id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const evidence = {
      environment_id: request.environment_id,
      plan_digest: request.plan_digest,
      stopped: complete,
      cleanup_complete: complete,
    };
    return {
      ...evidence,
      diagnostic_artifact: complete
        ? this.artifact("teardown", evidence)
        : null,
    };
  }

  private async ensureNetwork(
    network: string,
    environment: string,
    request: StartEnvironmentRequestV2,
    signal?: AbortSignal,
  ): Promise<void> {
    const inspected = await this.run(["network", "inspect", network], 10_000);
    if (inspected.code === 0) return;
    const result = await this.run(
      [
        "network",
        "create",
        "--internal",
        "--label",
        `foundry.environment_id=${environment}`,
        "--label",
        `foundry.run_id=${request.run_id}`,
        "--label",
        `foundry.plan_digest=${request.plan.plan_digest}`,
        network,
      ],
      30_000,
      undefined,
      signal,
    );
    if (result.code !== 0)
      throw new Error("private Docker network creation failed");
  }

  private async ensureContainer(
    name: string,
    environment: string,
    id: string,
    kind: string,
    alias: string,
    image: string,
    network: string,
    environmentVariables: Record<string, string>,
    command: string[],
    tmpfs: string[],
    request: StartEnvironmentRequestV2,
    signal?: AbortSignal,
  ): Promise<void> {
    if (![name, environment, id, alias, network].every(safeName)) {
      throw new Error("unsafe Docker identity");
    }
    const inspected = await this.run(["inspect", name], 10_000);
    if (inspected.code === 0) return;
    const args = [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      network,
      "--network-alias",
      alias,
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
      "--label",
      `foundry.environment_id=${environment}`,
      "--label",
      `foundry.component_id=${id}`,
      "--label",
      `foundry.component_kind=${kind}`,
      "--label",
      `foundry.run_id=${request.run_id}`,
      "--label",
      `foundry.plan_digest=${request.plan.plan_digest}`,
    ];
    if (kind === "postgresql") {
      args.push("--user", "70:70");
    }
    for (const [key, value] of Object.entries(environmentVariables)) {
      args.push("--env", `${key}=${value}`);
    }
    for (const mount of tmpfs) args.push("--tmpfs", mount);
    args.push(image, ...command);
    const result = await this.run(
      args,
      request.resource_policy.timeout_ms,
      undefined,
      signal,
    );
    if (result.code !== 0)
      throw new Error("private service container creation failed");
  }

  private resourceCredentials(kind: string): Record<string, string> {
    const secret = randomBytes(32).toString("base64url");
    if (kind === "postgresql") {
      return {
        POSTGRES_USER: "foundry",
        POSTGRES_DB: "foundry",
        POSTGRES_PASSWORD: secret,
      };
    }
    if (kind === "s3") {
      return { MINIO_ROOT_USER: "foundry", MINIO_ROOT_PASSWORD: secret };
    }
    if (kind === "oidc") {
      return { KEYCLOAK_ADMIN: "foundry", KEYCLOAK_ADMIN_PASSWORD: secret };
    }
    return {};
  }

  private resourceCommand(kind: string): string[] {
    if (kind === "s3") return ["server", "/data", "--address", ":9000"];
    if (kind === "oidc") return ["start-dev", "--http-port=8080"];
    return [];
  }

  private percentage(value: string | undefined): number {
    const parsed = Number(value?.replace("%", ""));
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) {
      throw new Error("resource CPU measurement is invalid");
    }
    return parsed;
  }

  private integer(value: string | undefined): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
      throw new Error("resource process measurement is invalid");
    }
    return parsed;
  }

  private memoryBytes(value: string | undefined): number {
    const used = value?.split("/")[0]?.trim() ?? "";
    const match = used.match(/^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)$/);
    if (!match) throw new Error("resource memory measurement is invalid");
    const scale = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[
      match[2]!
    ];
    const bytes = Math.round(Number(match[1]) * scale!);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("resource memory measurement is invalid");
    }
    return bytes;
  }

  private resourceTmpfs(kind: string): string[] {
    const common = ["/tmp:rw,noexec,nosuid,size=64m"];
    if (kind === "postgresql")
      return [
        ...common,
        "/var/run/postgresql:rw,nosuid,size=16m,uid=70,gid=70,mode=0770",
        "/var/lib/postgresql/data:rw,nosuid,size=512m,uid=70,gid=70,mode=0700",
      ];
    if (kind === "s3") return [...common, "/data:rw,nosuid,size=512m"];
    if (kind === "oidc")
      return [...common, "/opt/keycloak/data:rw,nosuid,size=256m"];
    return common;
  }

  private migrationFiles(directory: string): string[] {
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => join(directory, name));
    if (!files.length || files.length > 256)
      throw new Error("migration set is empty or oversized");
    for (const file of files) {
      const metadata = statSync(file);
      if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) {
        throw new Error("migration file is invalid or oversized");
      }
    }
    return files;
  }

  private statePath(environmentId: string): string {
    if (!safeName(environmentId))
      throw new Error("unsafe environment identity");
    return join(this.stateDirectory, `${environmentId}.json`);
  }

  private load(environmentId: string): PersistedEnvironmentV1 | null {
    try {
      return exactState(
        JSON.parse(readFileSync(this.statePath(environmentId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private persist(state: PersistedEnvironmentV1): void {
    const path = this.statePath(state.environment_id);
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  }

  private require(request: EnvironmentActionRequestV2): PersistedEnvironmentV1 {
    const state = this.load(request.environment_id);
    if (!state) throw new Error("environment does not exist");
    this.assertIdentity(state, request.run_id, request.plan_digest);
    return state;
  }

  private assertIdentity(
    state: PersistedEnvironmentV1,
    runId: string,
    planDigest: string,
  ): void {
    if (state.run_id !== runId || state.plan_digest !== planDigest) {
      throw new Error(
        "environment identity does not match the durable request",
      );
    }
  }

  private handle(
    state: PersistedEnvironmentV1,
    status: EnvironmentHandleV2["state"],
  ): EnvironmentHandleV2 {
    return {
      environment_id: state.environment_id,
      run_id: state.run_id,
      plan_digest: state.plan_digest,
      network_id: state.network_id,
      state: status,
      aliases: state.aliases,
      secret_handles: state.secret_handles,
    };
  }

  private artifact(label: string, value: unknown): ContentArtifact {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const sha256 = digest(bytes);
    const path = join(this.artifactDirectory, sha256);
    try {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (digest(readFileSync(path)) !== sha256)
        throw new Error("artifact checksum conflict");
    }
    return { sha256, size: bytes.length, media_type: "application/json" };
  }

  private run(
    args: string[],
    timeoutMs: number,
    input?: string,
    signal?: AbortSignal,
  ) {
    return this.runner.run(this.docker, args, {
      input,
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
      signal,
    });
  }
}

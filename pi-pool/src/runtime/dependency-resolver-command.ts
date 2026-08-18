import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  ContentArtifact,
  ResolveDependenciesRequestV2,
  ResolveDependenciesResultV2,
} from "../contract.ts";
import { verifyDependencyResolutionResult } from "../dependency-resolver.ts";
import { validateResolveDependenciesRequest } from "../validation.ts";

const failure = (code: string): ResolveDependenciesResultV2 => ({
  ok: false,
  evidence: null,
  manifest: null,
  lockfile: null,
  dependency_layer: null,
  sbom: null,
  license_report: null,
  vulnerability_report: null,
  error:
    "dependency resolution failed under the configured supply-chain policy",
  failure_code: code,
});
const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

async function stdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4 * 1024 * 1024) throw new Error("request exceeds its bound");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

try {
  const raw = (await stdin()) as ResolveDependenciesRequestV2;
  const workspace = realpathSync(
    resolve(process.env.FOUNDRY_RESOLVER_WORKSPACE ?? "/workspace"),
  );
  const request = validateResolveDependenciesRequest(
    { ...raw, workspace },
    workspace,
  );
  const catalogPath = resolve(
    process.env.FOUNDRY_RESOLUTION_CATALOG ?? "/catalog/index.json",
  );
  const artifactRoot = realpathSync(
    resolve(
      process.env.FOUNDRY_RESOLUTION_CATALOG_ARTIFACTS ?? "/catalog/artifacts",
    ),
  );
  const outputRoot = realpathSync(
    resolve(process.env.FOUNDRY_ARTIFACT_DIR ?? "/artifacts"),
  );
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("resolver catalog is invalid");
  }
  const result = (catalog as Record<string, unknown>)[
    request.plan.plan_digest
  ] as ResolveDependenciesResultV2 | undefined;
  if (!result) {
    process.stdout.write(JSON.stringify(failure("VERSION_UNAVAILABLE")));
    process.exit(0);
  }
  verifyDependencyResolutionResult(request, result);
  const artifacts = [
    result.manifest,
    result.lockfile,
    result.dependency_layer,
    result.sbom,
    result.license_report,
    result.vulnerability_report,
  ] as ContentArtifact[];
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  for (const artifact of artifacts) {
    const source = join(artifactRoot, artifact.sha256);
    const metadata = lstatSync(source);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== artifact.size
    ) {
      throw new Error("catalog artifact metadata is invalid");
    }
    const bytes = readFileSync(source);
    if (sha256(bytes) !== artifact.sha256)
      throw new Error("catalog artifact checksum mismatch");
    const destination = join(outputRoot, artifact.sha256);
    try {
      copyFileSync(source, destination, 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (sha256(readFileSync(destination)) !== artifact.sha256) {
        throw new Error("output artifact checksum conflict");
      }
    }
  }
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stdout.write(JSON.stringify(failure("UNSUPPORTED_SOURCE")));
}

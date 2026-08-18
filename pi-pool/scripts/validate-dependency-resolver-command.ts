import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  ResolveDependenciesRequestV2,
  ResolveDependenciesResultV2,
} from "../src/contract.ts";

const root = mkdtempSync(join(tmpdir(), "foundry-resolver-command-"));
const catalogArtifacts = join(root, "catalog-artifacts");
const output = join(root, "output");
const workspace = join(root, "workspace");
mkdirSync(catalogArtifacts);
mkdirSync(output);
mkdirSync(workspace);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const irDigest = "a".repeat(64);
const planDigest = "b".repeat(64);
const resolverImage = `example.invalid/resolver@sha256:${"c".repeat(64)}`;
const request: ResolveDependenciesRequestV2 = {
  protocol_version: 2,
  job_id: "run:dependencies",
  run_id: "run-one",
  ir_digest: irDigest,
  base_commit: "d".repeat(64),
  workspace,
  resolver_image: resolverImage,
  platform: "linux/amd64",
  existing_repository: false,
  resource_policy: {
    timeout_ms: 30_000,
    memory_mb: 512,
    cpu_count: 1,
    pids: 64,
    network: "registry-egress",
  },
  plan: {
    resolution_version: 1,
    ir_digest: irDigest,
    plan_digest: planDigest,
    roots: [],
  },
  policy: { allowed_licenses: ["MIT"], deny_at_or_above: "high" },
};
const contents = [
  "manifest",
  "lockfile",
  "layer",
  "sbom",
  "licenses",
  "vulnerabilities",
];
const mediaTypes = [
  "application/vnd.foundry.package-manifests.v1+json",
  "application/vnd.foundry.package-lockfiles.v1+json",
  "application/vnd.foundry.dependency-layer.v1+tar",
  "application/vnd.cyclonedx+json",
  "application/vnd.foundry.license-report.v1+json",
  "application/vnd.foundry.vulnerability-report.v1+json",
];
const refs = contents.map((content, index) => {
  const sha256 = digest(content);
  writeFileSync(join(catalogArtifacts, sha256), content);
  return {
    sha256,
    size: Buffer.byteLength(content),
    media_type: mediaTypes[index]!,
  };
});
const result: ResolveDependenciesResultV2 = {
  ok: true,
  evidence: {
    resolution_version: 1,
    plan_digest: planDigest,
    resolver_image: resolverImage,
    platform: "linux/amd64",
    manifest_sha256: refs[0]!.sha256,
    lockfile_sha256: refs[1]!.sha256,
    dependency_layer_sha256: refs[2]!.sha256,
    sbom_sha256: refs[3]!.sha256,
    packages: [],
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
const catalog = join(root, "index.json");
writeFileSync(catalog, JSON.stringify({ [planDigest]: result }));
try {
  const execution = spawnSync(
    process.execPath,
    [resolve("src/runtime/dependency-resolver-command.ts")],
    {
      input: JSON.stringify(request),
      encoding: "utf8",
      env: {
        ...process.env,
        FOUNDRY_RESOLUTION_CATALOG: catalog,
        FOUNDRY_RESOLUTION_CATALOG_ARTIFACTS: catalogArtifacts,
        FOUNDRY_ARTIFACT_DIR: output,
        FOUNDRY_RESOLVER_WORKSPACE: workspace,
      },
    },
  );
  const resolved = JSON.parse(execution.stdout) as ResolveDependenciesResultV2;
  const copied = refs.every(
    (artifact) =>
      createHash("sha256")
        .update(readFileSync(join(output, artifact.sha256)))
        .digest("hex") === artifact.sha256,
  );
  if (execution.status !== 0 || !resolved.ok || !copied) {
    throw new Error("catalog resolution did not produce verified artifacts");
  }
  console.log("OK  resolves an exact pre-vetted polyglot catalog entry");
  const missing = spawnSync(
    process.execPath,
    [resolve("src/runtime/dependency-resolver-command.ts")],
    {
      input: JSON.stringify({
        ...request,
        plan: { ...request.plan, plan_digest: "e".repeat(64) },
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        FOUNDRY_RESOLUTION_CATALOG: catalog,
        FOUNDRY_RESOLUTION_CATALOG_ARTIFACTS: catalogArtifacts,
        FOUNDRY_ARTIFACT_DIR: output,
        FOUNDRY_RESOLVER_WORKSPACE: workspace,
      },
    },
  );
  const rejected = JSON.parse(missing.stdout) as ResolveDependenciesResultV2;
  if (rejected.ok || rejected.failure_code !== "VERSION_UNAVAILABLE") {
    throw new Error("missing catalog entry did not fail closed");
  }
  console.log(
    "OK  fails closed when the accepted plan is absent from the catalog",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

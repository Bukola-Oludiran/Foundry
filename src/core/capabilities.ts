import type { Diagnostic, FoundryCapabilityDefinition, FoundryCapabilityRef } from "./types.ts";

type CapabilityCore = Omit<FoundryCapabilityDefinition, "toolchain" | "recipes" | "evidenceSchemaVersion">;

const cores: CapabilityCore[] = [
  { id: "python-library", version: "1.0.0", appliesTo: ["leaf", "composite", "deliverable"], targetRoles: ["source", "entrypoint", "metadata", "documentation"], artifactKinds: ["library", "package"], runtime: { language: "python", version: ">=3.11", pistonRuntime: "python" }, configKeys: ["publicModule", "distributionName", "versionRange"], limits: { maxTargets: 64, maxArtifactBytes: 16 * 1024 * 1024, maxArtifacts: 16 } },
  { id: "python-service", version: "1.0.0", appliesTo: ["composite", "deliverable"], targetRoles: ["source", "entrypoint", "metadata", "documentation", "lockfile", "service-entrypoint", "migration"], artifactKinds: ["service", "package"], runtime: { language: "python", version: ">=3.11", pistonRuntime: "python" }, configKeys: ["publicModule", "entrypoint", "healthRoute", "versionRange"], limits: { maxTargets: 128, maxArtifactBytes: 32 * 1024 * 1024, maxArtifacts: 32 } },
  { id: "rust-library", version: "1.0.0", appliesTo: ["leaf", "composite", "deliverable"], targetRoles: ["source", "entrypoint", "metadata", "documentation", "lockfile"], artifactKinds: ["library", "package"], runtime: { language: "rust", version: "1.80", pistonRuntime: "rust" }, configKeys: ["crateName", "edition"], limits: { maxTargets: 128, maxArtifactBytes: 32 * 1024 * 1024, maxArtifacts: 32 } },
  { id: "rust-binary", version: "1.0.0", appliesTo: ["leaf", "composite", "deliverable"], targetRoles: ["source", "entrypoint", "metadata", "documentation", "lockfile"], artifactKinds: ["binary", "package"], runtime: { language: "rust", version: "1.80", pistonRuntime: "rust" }, configKeys: ["crateName", "binaryName", "edition"], limits: { maxTargets: 128, maxArtifactBytes: 64 * 1024 * 1024, maxArtifacts: 32 } },
  { id: "typescript-package", version: "1.0.0", appliesTo: ["leaf", "composite", "deliverable"], targetRoles: ["source", "entrypoint", "metadata", "documentation", "lockfile"], artifactKinds: ["library", "package"], runtime: { language: "typescript", version: "5.9", pistonRuntime: "typescript" }, configKeys: ["packageName", "moduleType", "nodeVersion"], limits: { maxTargets: 128, maxArtifactBytes: 32 * 1024 * 1024, maxArtifacts: 32 } },
  { id: "node-service", version: "1.0.0", appliesTo: ["leaf", "composite", "deliverable"], targetRoles: ["source", "entrypoint", "metadata", "documentation", "lockfile", "service-entrypoint", "migration"], artifactKinds: ["service", "package"], runtime: { language: "javascript", version: "22", pistonRuntime: "javascript" }, configKeys: ["packageName", "entrypoint", "healthRoute", "nodeVersion"], limits: { maxTargets: 256, maxArtifactBytes: 64 * 1024 * 1024, maxArtifacts: 64 } },
  { id: "process-contract", version: "1.0.0", appliesTo: ["composite"], targetRoles: [], artifactKinds: ["binary", "service"], runtime: { language: "contract", version: "1", pistonRuntime: "foundry-product" }, configKeys: ["protocol", "timeoutMs"], limits: { maxTargets: 0, maxArtifactBytes: 64 * 1024 * 1024, maxArtifacts: 32 } },
  { id: "http-contract", version: "1.0.0", appliesTo: ["composite"], targetRoles: [], artifactKinds: ["service"], runtime: { language: "http", version: "1.1", pistonRuntime: "foundry-product" }, configKeys: ["healthRoute", "timeoutMs"], limits: { maxTargets: 0, maxArtifactBytes: 64 * 1024 * 1024, maxArtifacts: 32 } },
  { id: "artifact-bundle", version: "1.0.0", appliesTo: ["composite", "deliverable"], targetRoles: ["metadata", "documentation"], artifactKinds: ["bundle", "manifest", "architecture", "conformance"], runtime: { language: "artifact", version: "1", pistonRuntime: "foundry-product" }, configKeys: ["format"], limits: { maxTargets: 16, maxArtifactBytes: 128 * 1024 * 1024, maxArtifacts: 128 } },
  { id: "mixed-rust-node-product", version: "1.0.0", appliesTo: ["composite", "deliverable"], targetRoles: ["source", "entrypoint", "metadata", "documentation", "lockfile", "service-entrypoint"], artifactKinds: ["bundle", "service", "binary", "manifest"], runtime: { language: "mixed", version: "1", pistonRuntime: "foundry-product" }, configKeys: ["rustBinary", "nodeEntrypoint", "healthRoute"], limits: { maxTargets: 256, maxArtifactBytes: 128 * 1024 * 1024, maxArtifacts: 128 } },
];

const definitions: FoundryCapabilityDefinition[] = cores.map((entry) => {
  const contractOnly = entry.targetRoles.length === 0 || entry.runtime.language === "artifact";
  return { ...entry, toolchain: { offline: true, components: [entry.runtime.pistonRuntime, `${entry.runtime.language}@${entry.runtime.version}`], dependencyLock: contractOnly ? "not-applicable" : "required" }, recipes: { verification: `${entry.id}/verify-v1`, mutation: contractOnly ? "not-applicable" : `${entry.id}/mutate-v1`, integration: `${entry.id}/integrate-v1`, packaging: `${entry.id}/package-v1`, reproducibility: `${entry.id}/reproduce-v1` }, evidenceSchemaVersion: 3 };
});

export class FoundryCapabilityRegistry {
  private readonly entries = new Map(definitions.map((entry) => [`${entry.id}@${entry.version}`, Object.freeze(structuredClone(entry))]));

  list(): FoundryCapabilityDefinition[] { return [...this.entries.values()].map((entry) => structuredClone(entry)); }
  get(id: string, version: string): FoundryCapabilityDefinition | undefined { const entry = this.entries.get(`${id}@${version}`); return entry && structuredClone(entry); }
  validate(ref: FoundryCapabilityRef, appliesTo: FoundryCapabilityDefinition["appliesTo"][number], path: string): Diagnostic[] {
    const definition = this.get(ref.id, ref.version);
    if (!definition) return [{ code: "CAPABILITY_NOT_FOUND", severity: "error", message: `Unknown capability ${ref.id}@${ref.version}`, path }];
    if (!definition.appliesTo.includes(appliesTo)) return [{ code: "CAPABILITY_SCOPE_MISMATCH", severity: "error", message: `${ref.id}@${ref.version} does not apply to ${appliesTo}`, path }];
    const unknown = Object.keys(ref.config ?? {}).filter((key) => !definition.configKeys.includes(key));
    return unknown.map((key) => ({ code: "CAPABILITY_CONFIG_UNKNOWN", severity: "error" as const, message: `${ref.id}@${ref.version} does not allow config key ${key}`, path: `${path}/config/${key}` }));
  }
}

export const builtInCapabilities = new FoundryCapabilityRegistry();

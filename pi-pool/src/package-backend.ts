import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  PackageDependencyResolutionV2,
  PackageResolutionRootV2,
} from "./contract.ts";

export interface GeneratedPackageManifestV2 {
  path: string;
  media_type: string;
  content: string;
  sha256: string;
}

export interface PackageBackendV2 {
  generateManifest(root: PackageResolutionRootV2): GeneratedPackageManifestV2;
  lockedInstall(root: PackageResolutionRootV2): {
    command: string;
    args: string[];
    network: "none";
  };
  projectTest(): { command: string; args: string[] };
}

const finish = (
  path: string,
  mediaType: string,
  content: string,
): GeneratedPackageManifestV2 => {
  const normalized = `${content.trimEnd()}\n`;
  return {
    path,
    media_type: mediaType,
    content: normalized,
    sha256: createHash("sha256").update(normalized).digest("hex"),
  };
};

const byName = (
  left: PackageDependencyResolutionV2,
  right: PackageDependencyResolutionV2,
) => left.name.localeCompare(right.name);

const npmManifest = (
  root: PackageResolutionRootV2,
): GeneratedPackageManifestV2 => {
  const runtime: Record<string, string> = {};
  const development: Record<string, string> = {};
  for (const dependency of [...root.packages].sort(byName)) {
    const destination = dependency.scope === "runtime" ? runtime : development;
    destination[dependency.name] = dependency.version;
  }
  return finish(
    root.manifest_path,
    "application/json",
    JSON.stringify(
      {
        name: `foundry-${root.package_root}`,
        private: true,
        version: "0.0.0",
        dependencies: runtime,
        devDependencies: development,
      },
      null,
      2,
    ),
  );
};

const pythonRequirement = (
  dependency: PackageDependencyResolutionV2,
): string => {
  const extras = dependency.features.length
    ? `[${[...dependency.features].sort().join(",")}]`
    : "";
  return `${dependency.name}${extras}==${dependency.version}`;
};

const pythonManifest = (
  root: PackageResolutionRootV2,
): GeneratedPackageManifestV2 => {
  const dependencies = root.packages
    .filter((dependency) => dependency.scope === "runtime")
    .sort(byName)
    .map((dependency) => `  ${JSON.stringify(pythonRequirement(dependency))},`)
    .join("\n");
  return finish(
    root.manifest_path,
    "application/toml",
    `[project]\nname = ${JSON.stringify(`foundry-${root.package_root}`)}\nversion = "0.0.0"\nrequires-python = ">=3.12"\ndependencies = [\n${dependencies}\n]\n`,
  );
};

const goManifest = (
  root: PackageResolutionRootV2,
): GeneratedPackageManifestV2 => {
  const dependencies = [...root.packages]
    .sort(byName)
    .map((dependency) => `\t${dependency.name} ${dependency.version}`)
    .join("\n");
  return finish(
    root.manifest_path,
    "text/plain; charset=utf-8",
    `module foundry.local/${root.package_root}\n\ngo 1.24\n\nrequire (\n${dependencies}\n)\n`,
  );
};

const BACKENDS: Record<PackageResolutionRootV2["ecosystem"], PackageBackendV2> =
  {
    npm: {
      generateManifest: npmManifest,
      lockedInstall: (root) => ({
        command: "npm",
        args: [
          "ci",
          "--ignore-scripts",
          "--offline",
          `--prefix=${dirname(root.manifest_path)}`,
        ],
        network: "none",
      }),
      projectTest: () => ({
        command: "npm",
        args: ["test", "--", "--runInBand"],
      }),
    },
    pypi: {
      generateManifest: pythonManifest,
      lockedInstall: (root) => ({
        command: "python3",
        args: [
          "-m",
          "pip",
          "install",
          "--require-hashes",
          "--no-index",
          "-r",
          root.lockfile_path,
        ],
        network: "none",
      }),
      projectTest: () => ({ command: "python3", args: ["-m", "pytest"] }),
    },
    go: {
      generateManifest: goManifest,
      lockedInstall: () => ({
        command: "go",
        args: ["mod", "download"],
        network: "none",
      }),
      projectTest: () => ({ command: "go", args: ["test", "./..."] }),
    },
  };

export function packageBackend(
  ecosystem: PackageResolutionRootV2["ecosystem"],
): PackageBackendV2 {
  return BACKENDS[ecosystem];
}

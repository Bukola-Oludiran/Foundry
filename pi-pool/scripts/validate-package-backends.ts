import type { PackageResolutionRootV2 } from "../src/contract.ts";
import { packageBackend } from "../src/package-backend.ts";

const roots: PackageResolutionRootV2[] = [
  {
    package_root: "web",
    ecosystem: "npm",
    language: "typescript",
    manifest_path: "package.json",
    lockfile_path: "package-lock.json",
    resolver: { mode: "locked", allow_prereleases: false },
    registry_allowlist: ["https://registry.npmjs.org"],
    packages: [
      {
        id: "zod",
        ecosystem: "npm",
        name: "zod",
        version: "4.1.0",
        integrity: "sha512-fixture-value",
        features: [],
        extras: [],
        scope: "runtime",
        owner_node: "web",
        package_root: "web",
      },
    ],
  },
  {
    package_root: "worker",
    ecosystem: "pypi",
    language: "python",
    manifest_path: "pyproject.toml",
    lockfile_path: "requirements.lock",
    resolver: { mode: "locked", allow_prereleases: false },
    registry_allowlist: ["https://pypi.org"],
    packages: [
      {
        id: "httpx",
        ecosystem: "pypi",
        name: "httpx",
        version: "0.28.1",
        integrity: "sha256-fixture-value",
        features: ["http2"],
        extras: [],
        scope: "runtime",
        owner_node: "worker",
        package_root: "worker",
      },
    ],
  },
  {
    package_root: "api",
    ecosystem: "go",
    language: "go",
    manifest_path: "go.mod",
    lockfile_path: "go.sum",
    resolver: { mode: "locked", allow_prereleases: false },
    registry_allowlist: ["https://proxy.golang.org"],
    packages: [
      {
        id: "uuid",
        ecosystem: "go",
        name: "github.com/google/uuid",
        version: "v1.6.0",
        integrity: "h1:fixture-value",
        features: [],
        extras: [],
        scope: "runtime",
        owner_node: "api",
        package_root: "api",
      },
    ],
  },
];

let failed = false;
for (const root of roots) {
  const backend = packageBackend(root.ecosystem);
  const left = backend.generateManifest(root);
  const right = backend.generateManifest(root);
  const exactVersion = left.content.includes(root.packages[0]!.version);
  const deterministic =
    left.content === right.content && left.sha256 === right.sha256;
  const offlineInstall = backend.lockedInstall(root).network === "none";
  const ok = exactVersion && deterministic && offlineInstall;
  if (!ok) failed = true;
  console.log(
    `${ok ? "GREEN" : "RED  "} ${root.ecosystem} native manifest + locked install`,
  );
}

process.exitCode = failed ? 1 : 0;

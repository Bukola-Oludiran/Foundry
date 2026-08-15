import {
  runSandboxed,
  sandboxAvailability,
  type SandboxScope,
} from "../src/sandbox.ts";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDRY_SANDBOX = "oci";
const availability = sandboxAvailability();
if (!availability.available) {
  console.log(`SKIP — OCI sandbox unavailable (${availability.reason})`);
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "foundry-oci-test-"));
mkdirSync(join(workspace, "src"));
const target = join(workspace, "src/target.txt");
const dependency = join(workspace, "src/dependency.txt");
const secret = join(workspace, "src/secret.txt");
writeFileSync(target, "old\n");
writeFileSync(dependency, "declared\n");
writeFileSync(secret, "secret\n");

const scope: SandboxScope = {
  workspace,
  readPaths: [dependency],
  writeTarget: target,
  allowNetwork: false,
  resourcePolicy: {
    timeout_ms: 30_000,
    memory_mb: 64,
    cpu_count: 0.5,
    pids: 16,
    network: "none",
  },
};

let failures = 0;
function check(
  label: string,
  allowed: boolean,
  command: string,
  args: string[],
  input?: string,
): void {
  const result = runSandboxed(scope, command, args, { input });
  const observed = result.status === 0;
  const ok = observed === allowed;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK " : "BAD"} ${label}: ${observed ? "allowed" : "denied"}`,
  );
  if (!ok) console.error((result.stderr ?? "").trim());
}

try {
  check("write exact target", true, "tee", [target], "new\n");
  console.log(
    `  promoted target: ${JSON.stringify(readFileSync(target, "utf8"))}`,
  );
  check("read declared dependency", true, "cat", [dependency]);
  check("read undeclared sibling", false, "cat", [secret]);
  check(
    "write undeclared sibling is discarded",
    true,
    "tee",
    [secret],
    "hacked\n",
  );
  check("network disabled", false, "wget", [
    "-q",
    "-O",
    "-",
    "https://example.com",
  ]);
  const targetContent = readFileSync(target, "utf8");
  const secretContent = readFileSync(secret, "utf8");
  if (targetContent !== "new\n") {
    failures++;
    console.error(`target content mismatch: ${JSON.stringify(targetContent)}`);
  }
  if (secretContent !== "secret\n") {
    failures++;
    console.error(`secret content mismatch: ${JSON.stringify(secretContent)}`);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.exitCode = failures === 0 ? 0 : 1;

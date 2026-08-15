// Proves the OS-sandbox enforces a doer's scope: write ONLY the write-target, read ONLY
// the declared read-set. Builds a temp workspace with a target file, a declared dep, and
// an UNDECLARED sibling ("secret"), then checks all four quadrants under the sandbox.
//
// Run: node Foundry/pi-pool/scripts/validate-sandbox.ts   (macOS)

import { runSandboxed, sandboxAvailability } from "../src/sandbox.ts";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const sandbox = sandboxAvailability();
if (!sandbox.available) {
  console.log(`SKIP — sandbox unavailable (${sandbox.reason})`);
  process.exit(0);
}

const SCRATCH = tmpdir();

const ws = mkdtempSync(join(SCRATCH, "foundry-ws-"));
const srcDir = join(ws, "src");
mkdirSync(srcDir);
const writeTarget = join(srcDir, "hyphenate.py"); // the node's own file
const dep = join(srcDir, "lowercase.py"); // declared dependency (read-set)
const secret = join(srcDir, "secret.py"); // sibling NOT in the read-set
writeFileSync(writeTarget, "# to be written by the doer\n");
writeFileSync(dep, "def lower(s): return s.lower()\n");
writeFileSync(secret, "SECRET = 'sibling node code the doer must not touch'\n");

const scope = { workspace: ws, readPaths: [dep], writeTarget };

let bad = 0;
function check(desc: string, cmd: string, expectAllow: boolean): void {
  const r = runSandboxed(scope, "/bin/sh", ["-c", cmd]);
  const allowed = r.status === 0;
  const ok = allowed === expectAllow;
  if (!ok) bad++;
  const tag = expectAllow ? "ALLOW" : "DENY ";
  console.log(
    `  ${ok ? "OK " : "✗  "} [${tag}] ${desc}  →  ${allowed ? "allowed" : "denied"}${ok ? "" : "  ← UNEXPECTED"}`,
  );
}

console.log(
  "== sandbox scope enforcement (write-target = src/hyphenate.py, read-set = [src/lowercase.py]) ==",
);
check(
  "write own target       (echo > hyphenate.py)",
  `echo 'def hyphenate(s): return s' > '${writeTarget}'`,
  true,
);
check(
  "write sibling code      (echo > secret.py)   ",
  `echo 'HACKED' > '${secret}'`,
  false,
);
check(
  "read declared dep       (cat lowercase.py)   ",
  `cat '${dep}' >/dev/null`,
  true,
);
check(
  "read undeclared sibling (cat secret.py)      ",
  `cat '${secret}' >/dev/null`,
  false,
);

// prove the effects: target changed, secret untouched
const targetContent = readFileSync(writeTarget, "utf-8").trim();
const secretContent = readFileSync(secret, "utf-8").trim();
const targetWritten = targetContent === "def hyphenate(s): return s";
const secretIntact =
  secretContent === "SECRET = 'sibling node code the doer must not touch'";
if (!targetWritten) bad++;
if (!secretIntact) bad++;
console.log(
  `\n  ${targetWritten ? "OK " : "✗  "} write-target actually received the write`,
);
console.log(
  `  ${secretIntact ? "OK " : "✗  "} sibling code left byte-intact (write never happened)`,
);

rmSync(ws, { recursive: true, force: true });
console.log(
  `\n${bad === 0 ? "✅ sandbox scope enforced" : `❌ ${bad} enforcement failure(s)`}`,
);
process.exit(bad === 0 ? 0 : 1);

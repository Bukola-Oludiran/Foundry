import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBoundPath } from "./security.ts";

test("workspace resolution rejects direct and intermediate symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-root-")), outside = mkdtempSync(join(tmpdir(), "foundry-outside-"));
  mkdirSync(join(root, "safe")); symlinkSync(outside, join(root, "escape")); symlinkSync(join(outside, "missing.ts"), join(root, "dangling.ts"));
  assert.equal(resolveBoundPath(root, "safe/new.ts"), join(realpathSync(root), "safe/new.ts"));
  assert.throws(() => resolveBoundPath(root, "escape/file.ts"), /symlink leaves/);
  assert.throws(() => resolveBoundPath(root, "dangling.ts"), /symbolic link/);
});

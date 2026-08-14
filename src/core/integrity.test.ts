import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "./artifacts.ts";
import { FoundryStore } from "./store.ts";

test("artifact writes are digest-verified and unreachable data is quarantined", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-artifact-integrity-")), store = new ArtifactStore(root), retained = store.put("retained"), orphan = store.put("orphan");
  assert.deepEqual(store.scrub(), { checked: 2, corrupt: [], bytes: 14 }); assert.deepEqual(store.collect(new Set([retained.digest]), true).candidates, [orphan.digest]);
  const collected = store.collect(new Set([retained.digest]), false); assert.deepEqual(collected.quarantined, [orphan.digest]); assert.equal(existsSync(orphan.path), false); assert.equal(readFileSync(retained.path, "utf8"), "retained");
  writeFileSync(retained.path, "corrupt"); assert.deepEqual(store.scrub().corrupt, [retained.digest]); assert.throws(() => store.get(retained.digest), /digest mismatch/);
});

test("ordered migration checksums and SQLite backup survive restoration", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-backup-")), path = join(root, "foundry.sqlite"), copy = join(root, "backup.sqlite"), store = new FoundryStore(path); const project = store.createProject("tenant", "Backup");
  const migrations = store.db.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all() as any[]; assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4]); assert.ok(migrations.every((row) => typeof row.checksum === "string" && row.checksum.length > 0)); const result = await store.backup(copy); assert.equal(result.integrity, "ok"); store.close();
  const restored = new FoundryStore(copy); assert.equal(restored.project(project.id as string).name, "Backup"); restored.close();
});

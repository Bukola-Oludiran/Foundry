import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("LedgerForge trustworthy-delivery control remains frozen", () => {
  const control = JSON.parse(readFileSync(new URL("../../docs/evidence/ledgerforge-control.json", import.meta.url), "utf8"));
  assert.equal(control.gitHead, "8f5e6c522875bbca433147226042898df249d312");
  assert.equal(control.nodeCount, 16);
  assert.equal(control.nodeAcceptanceCaseCount, 31);
  assert.equal(control.assembly.passed, 12);
  assert.equal(control.assembly.failed, 0);
  assert.equal(Object.keys(control.targetDigests).length, 21);
  assert.match(control.wheelDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(control.observedWorkerFailure, { code: "WORKER_UNAVAILABLE", rejectedSubmissions: 6, committedEffects: 0 });
});

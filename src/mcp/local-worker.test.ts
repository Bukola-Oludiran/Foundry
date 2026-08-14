import test from "node:test";
import assert from "node:assert/strict";
import { closeLocalWorker, ensureLocalWorker } from "./local-worker.ts";

test("local MCP sessions receive independent workers", async () => {
  const configuredUrl = "http://127.0.0.1:8787";
  const first = await ensureLocalWorker(configuredUrl);
  const second = await ensureLocalWorker(configuredUrl);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.url, second.url);
  assert.equal((await fetch(`${first.url}/health`).then((response) => response.json()) as any).ready, true);
  assert.equal((await fetch(`${second.url}/health`).then((response) => response.json()) as any).ready, true);

  await closeLocalWorker(first);
  await assert.rejects(fetch(`${first.url}/health`), /fetch failed/);
  assert.equal((await fetch(`${second.url}/health`).then((response) => response.json()) as any).ready, true);
  await closeLocalWorker(second);
});

test("remote and disabled workers are not locally managed", async () => {
  assert.equal(await ensureLocalWorker("disabled"), null);
  assert.equal(await ensureLocalWorker("https://worker.example.test"), null);
});

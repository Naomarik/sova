// Run: pnpm test -- server/chat-runtime/inflight.test.ts. A chat process's run in flight on disk:
// written at a run's start, gone at its settle, marked `auto` when the run is a resume, taken once.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { InflightRecorder, readInflight, takeInflight } from "./inflight";

const dir = mkdtempSync(join(tmpdir(), "inflight-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a run's marker: written at start, removed at settle", () => {
  const r = new InflightRecorder(() => "s1", dir, () => 42);
  assert.equal(readInflight("s1", dir), null);
  r.started("/p/s1.jsonl");
  assert.deepEqual(readInflight("s1", dir), { v: 1, path: "/p/s1.jsonl", since: 42 });
  r.settled("/p/s1.jsonl");
  assert.equal(readInflight("s1", dir), null);
});

test("a resume's run is marked auto, only that run", () => {
  const r = new InflightRecorder(() => "s2", dir, () => 7);
  r.markResuming("/p/s2.jsonl");
  r.started("/p/s2.jsonl");
  assert.equal(readInflight("s2", dir)?.auto, true);
  r.settled("/p/s2.jsonl");
  r.started("/p/s2.jsonl");
  assert.equal(readInflight("s2", dir)?.auto, undefined);
});

test("taken once (a death is resumed once); cleared on purpose", () => {
  const r = new InflightRecorder(() => "s3", dir);
  r.started("/p/s3.jsonl");
  assert.equal(takeInflight("s3", dir)?.path, "/p/s3.jsonl");
  assert.equal(takeInflight("s3", dir), null);
  r.started("/p/s3.jsonl");
  r.clear();
  assert.equal(readInflight("s3", dir), null);
});

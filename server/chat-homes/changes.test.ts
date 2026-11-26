// The homes' change log and index (server/chat-homes/changes.ts): lines appended by several processes are all read,
// whatever the rolls and the compactor do; a torn line waits for its end; a bad index is no index.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { appendChange, ChangeTail, INDEX_NAME, isDeviceLocalHomesFile, readIndex, segmentFile, segments, setChangeLogLimitsForTest, writeIndex, type ChangeLine } from "./changes";

const scratch = mkdtempSync(join(tmpdir(), "sova-home-changes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const freshRoot = (): string => {
  const r = join(scratch, `homes-${++n}`);
  mkdirSync(r, { recursive: true });
  return r;
};

test("a line is read once, from the cursor on; a torn last line waits for its end", () => {
  const root = freshRoot();
  const tail = new ChangeTail(root);
  appendChange(root, "a", "meta");
  appendChange(root, "b", "seen");
  assert.deepEqual(
    tail.read().lines.map((l) => [l.h, l.d]),
    [
      ["a", "meta"],
      ["b", "seen"],
    ],
  );
  assert.deepEqual(tail.read().lines, []);
  const file = segmentFile(root, segments(root).at(-1)!);
  appendFileSync(file, `{"h":"c","d":"meta","g":9,"p":1`);
  assert.deepEqual(tail.read().lines, [], "half a line is not a line yet");
  appendFileSync(file, "}\n");
  assert.deepEqual(
    tail.read().lines.map((l) => l.h),
    ["c"],
  );
});

test("a root that isn't there is never made by a line", () => {
  const root = join(scratch, "never-made");
  appendChange(root, "a", "meta");
  assert.equal(existsSync(root), false);
});

test("a reader whose segment was removed before it read it to the end is told it has a gap", () => {
  const root = freshRoot();
  setChangeLogLimitsForTest({ segmentBytes: 64, graceMs: 0 });
  after(() => setChangeLogLimitsForTest({ segmentBytes: 1 << 20, graceMs: 10 * 60_000 }));
  const behind = new ChangeTail(root);
  appendChange(root, "a", "meta");
  assert.equal(behind.read().lines.length, 1);
  for (let i = 0; i < 6; i++) appendChange(root, "b", "meta");
  const ahead = new ChangeTail(root);
  ahead.read();
  assert.ok(segments(root).length >= 3, `rolled: ${segments(root)}`);
  writeIndex(root, { v: 1, cursor: ahead.cursor, homes: {} });
  assert.ok(!existsSync(segmentFile(root, 1)), "the compactor removed the first segment");
  assert.equal(behind.read().gap, true);
});

test("a missing, torn or unknown index is no index; the log and index are this device's own files", () => {
  const root = freshRoot();
  assert.equal(readIndex(root), null);
  writeFileSync(join(root, INDEX_NAME), '{"v":1,"cursor":');
  assert.equal(readIndex(root), null);
  writeFileSync(join(root, INDEX_NAME), JSON.stringify({ v: 99, cursor: { seg: 1, off: 0 }, homes: {} }));
  assert.equal(readIndex(root), null);
  writeIndex(root, { v: 1, cursor: { seg: 1, off: 0 }, homes: { x: { files: ["a.jsonl"], st: "1:2" } } });
  assert.deepEqual(readIndex(root)?.homes, { x: { files: ["a.jsonl"], st: "1:2" } });
  for (const name of [".changes.1.log", ".changes.12.log", INDEX_NAME, `${INDEX_NAME}.123.tmp`]) assert.equal(isDeviceLocalHomesFile(name), true, name);
  for (const name of ["019a0000-0000-7000-8000-000000000001", "019a.tar.gz", "changes.1.log"]) assert.equal(isDeviceLocalHomesFile(name), false, name);
});

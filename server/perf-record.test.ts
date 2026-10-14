// The reply-timing store's record and writer (§app.insights/reply-timing): strict parse, one line per
// record in its producer's day file, never a throw.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";
import { appendPerfRecord, formatPerfRecord, normalizePerfRecord, parsePerfRecordLine, perfFilePath, perfWriteFailures, replyTimingOf, type PerfRecord } from "./perf-record";

const root = scratchRoot("perf-record-");
after(() => rmSync(root, { recursive: true, force: true }));

const rec = (o: Partial<PerfRecord> = {}): PerfRecord => ({
  v: 1,
  key: "s1:e1",
  ts: Date.UTC(2026, 9, 13, 23, 59, 59),
  device: "h_abcdefgh",
  producer: "prod-1",
  sid: "s1",
  entryId: "e1",
  kind: "main",
  provider: "zai",
  model: "glm-5.3",
  effort: "high",
  stop: "stop",
  sentAt: Date.UTC(2026, 9, 13, 23, 59, 50),
  ttftMs: 800,
  thinkingMs: 3000,
  replyMs: 5000,
  thinking: { ms: 3000, n: 1 },
  text: { ms: 5000, n: 1 },
  tool: { ms: 0, n: 0 },
  endMs: 9000,
  output: 900,
  reasoning: 400,
  ...o,
});

describe("perf record (§app.insights/reply-timing)", () => {
  test("a record parses back exactly; unknown fields are dropped, the canonical order kept", () => {
    const r = rec();
    assert.deepEqual(normalizePerfRecord({ ...r, extra: 1 }), r);
    const line = formatPerfRecord(r)!;
    assert.ok(line.endsWith("\n"));
    assert.deepEqual(parsePerfRecordLine(line), r);
    assert.equal(Object.keys(JSON.parse(line))[0], "v");
  });

  test("a wrong field refuses the whole record", () => {
    for (const bad of [
      { v: 2 },
      { stop: "error" },
      { stop: "aborted" },
      { kind: "oneshot" },
      { ttftMs: -1 },
      { ttftMs: 1.5 },
      { output: "9" },
      { reasoning: 901 },
      { thinking: { ms: 1 } },
      { producer: "../x" },
      { provider: "" },
      { key: "a\nb" },
    ] as Partial<PerfRecord>[])
      assert.equal(normalizePerfRecord({ ...rec(), ...bad }), null, JSON.stringify(bad));
    assert.equal(parsePerfRecordLine("{not json"), null);
    assert.equal(parsePerfRecordLine(""), null);
  });

  test("optional fields: reasoning absent stays absent (never a 0)", () => {
    const { reasoning: _r, effort: _e, kind: _k, ...bare } = rec();
    const n = normalizePerfRecord(bare)!;
    assert.ok(n);
    assert.equal("reasoning" in n, false);
    assert.equal("effort" in n, false);
  });

  test("append: one line in the producer's file for the record's UTC day; a refused record writes nothing and never throws", () => {
    const before = perfWriteFailures();
    assert.equal(appendPerfRecord(rec(), root), true);
    assert.equal(appendPerfRecord(rec({ key: "s1:e2", entryId: "e2" }), root), true);
    const file = perfFilePath(root, rec().ts, "prod-1");
    assert.ok(file.endsWith(join("usage", "perf", "v1", "2026-10-13", "prod-1.jsonl")));
    const lines = readFileSync(file, "utf8").split("\n");
    assert.equal(lines.length, 3);
    assert.equal(parsePerfRecordLine(lines[1]!)!.entryId, "e2");
    assert.equal(appendPerfRecord(rec({ stop: "error" as never }), root), false);
    assert.equal(perfWriteFailures(), before + 1);
    // An unwritable store (a file where the day directory goes) fails quietly.
    const blocked = join(root, "blocked");
    mkdirSync(join(blocked, "usage", "perf"), { recursive: true });
    writeFileSync(join(blocked, "usage", "perf", "v1"), "");
    assert.doesNotThrow(() => assert.equal(appendPerfRecord(rec(), blocked), false));
  });

  test("a record's timing for the card: thinking and tool-call parts counted, absent when none", () => {
    assert.deepEqual(replyTimingOf(rec({ thinkingMs: 0, thinking: { ms: 0, n: 1 }, tool: { ms: 10, n: 2 } })), {
      effort: "high", ttftMs: 800, thinkingMs: 0, replyMs: 5000, toolCalls: 2, thinkingParts: 1, output: 900, reasoning: 400,
    });
    const bare = replyTimingOf(rec({ thinkingMs: 0, thinking: { ms: 0, n: 0 } }));
    assert.equal("thinkingParts" in bare, false);
    assert.equal("toolCalls" in bare, false);
  });
});

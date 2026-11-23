// The tool-run store's record, writer and timer: strict parse, one line per call in its producer's day
// file written the moment the call ends, worker waits tagged as their own kind, and a call a stopped turn
// left open still counted up to the stop.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";
import {
  appendToolRunRecord,
  formatToolRunRecord,
  parseToolRunLine,
  toolRunFilePath,
  toolRunKindOf,
  ToolRunTimer,
  toolRunWriteFailures,
  type ToolRunRecord,
} from "./tool-run-record";

const root = scratchRoot("tool-run-record-");
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const rec = (o: Partial<ToolRunRecord> = {}): ToolRunRecord => ({
  v: 1,
  key: "s1:c1",
  sid: "s1",
  start: T0,
  end: T0 + 30_000,
  kind: "tool",
  producer: "prod-1",
  device: "h_abcdefgh",
  sk: "main",
  tool: "bash",
  ...o,
});

/** A timer on a hand-moved clock, its records kept. */
function timer(who: Partial<ReturnType<ConstructorParameters<typeof ToolRunTimer>[0]["who"]>> = {}) {
  let now = T0;
  const written: ToolRunRecord[] = [];
  const t = new ToolRunTimer({ who: () => ({ sid: "s1", sk: "main", device: null, producer: "prod-1", ...who }), write: (r) => written.push(r) }, () => now);
  return { t, written, advance: (ms: number) => (now += ms) };
}

describe("tool-run record", () => {
  test("parse round-trips a record, canonical order, unknown fields dropped", () => {
    const line = formatToolRunRecord(rec())!;
    assert.ok(line.endsWith("\n"));
    assert.deepEqual(parseToolRunLine(line), rec());
    assert.deepEqual(parseToolRunLine(JSON.stringify({ ...rec(), extra: 1 })), rec());
    const bare = rec();
    delete bare.sk;
    delete bare.tool;
    assert.deepEqual(parseToolRunLine(JSON.stringify(bare)), bare);
    assert.deepEqual(parseToolRunLine(JSON.stringify(rec({ kind: "worker-wait", device: null }))), rec({ kind: "worker-wait", device: null }));
  });

  test("a wrong field refuses the whole record", () => {
    for (const bad of [
      { v: 2 },
      { kind: "wait" },
      { sk: "oneshot" },
      { start: 0 },
      { end: T0 - 1 },
      { end: T0 + 8 * 86_400_000 },
      { producer: "../x" },
      { device: 3 },
      { sid: "" },
      { tool: "a\nb" },
    ])
      assert.equal(parseToolRunLine(JSON.stringify({ ...rec(), ...bad })), null, JSON.stringify(bad));
    assert.equal(parseToolRunLine("{not json"), null);
    assert.equal(parseToolRunLine(""), null);
  });

  test("worker waits are their own kind; every other tool is a tool", () => {
    assert.equal(toolRunKindOf("agent_wait"), "worker-wait");
    assert.equal(toolRunKindOf("mcp__x__agent_wait"), "worker-wait");
    for (const name of ["bash", "agent_spawn", "team_create", "mcp__sova__team_inbox", undefined]) assert.equal(toolRunKindOf(name), "tool", String(name));
  });

  test("append writes one line to the producer's file for the end's UTC day; a refused record writes nothing", () => {
    const r = rec({ start: Date.UTC(2026, 10, 18, 23, 59, 50), end: Date.UTC(2026, 10, 19, 0, 0, 10), key: "s1:day" });
    assert.equal(appendToolRunRecord(r, root), true);
    const file = toolRunFilePath(root, r.end, r.producer);
    assert.match(file, /usage\/tools\/v1\/2026-11-19\/prod-1\.jsonl$/);
    assert.deepEqual(readFileSync(file, "utf8").split("\n").filter(Boolean).map(parseToolRunLine), [r]);
    const failures = toolRunWriteFailures();
    assert.equal(appendToolRunRecord(rec({ kind: "nope" as never }), root), false);
    assert.equal(toolRunWriteFailures(), failures + 1);
  });
});

describe("tool-run timer", () => {
  test("a call's record is written the moment it ends, start to end", () => {
    const { t, written, advance } = timer();
    t.start("c1", "bash");
    advance(1200);
    assert.equal(written.length, 0);
    t.end("c1");
    assert.deepEqual(written, [rec({ end: T0 + 1200, device: null, key: "s1:c1" })]);
    t.settle();
    assert.equal(written.length, 1, "an ended call is never written again");
  });

  test("a 30 s tool and then a stop before the next reply: 30 s recorded", () => {
    // Ended by the stop: the call's end arrives (aborted), then the run settles.
    const a = timer();
    a.t.start("c1", "bash");
    a.advance(30_000);
    a.t.end("c1");
    a.advance(5);
    a.t.settle();
    assert.equal(a.written.length, 1);
    assert.equal(a.written[0]!.end - a.written[0]!.start, 30_000);
    // Stopped with no end for the call at all: the run's settle closes it at the stop.
    const b = timer();
    b.t.start("c1", "bash");
    b.advance(30_000);
    assert.equal(b.t.openCount, 1);
    b.t.settle();
    assert.equal(b.t.openCount, 0);
    assert.equal(b.written.length, 1);
    assert.equal(b.written[0]!.end - b.written[0]!.start, 30_000);
    assert.equal(b.written[0]!.kind, "tool");
  });

  test("a wait on workers is tagged worker-wait; parallel calls each get their own record", () => {
    const { t, written, advance } = timer({ sk: undefined });
    t.start("w", "agent_wait");
    t.start("b", "bash");
    advance(2 * 3_600_000);
    t.end("b");
    t.end("w");
    assert.deepEqual(
      written.map((r) => [r.key, r.kind, r.end - r.start, "sk" in r]),
      [
        ["s1:b", "tool", 7_200_000, false],
        ["s1:w", "worker-wait", 7_200_000, false],
      ],
    );
  });

  test("who a record names is taken when its call starts; an unknown or repeated call id writes nothing more", () => {
    let sid = "s1";
    const written: ToolRunRecord[] = [];
    const t = new ToolRunTimer({ who: () => ({ sid, device: null, producer: "p" }), write: (r) => written.push(r) }, () => T0);
    t.start("c1", "read");
    t.start("c1", "read");
    sid = "s2";
    t.end("c1");
    t.end("c1");
    t.end("nope");
    t.start("", "read");
    assert.deepEqual(written.map((r) => r.key), ["s1:c1"]);
  });

  test("a failing sink never throws out of the timer", () => {
    const t = new ToolRunTimer({ who: () => { throw new Error("no"); }, write: () => {} });
    const quiet = console.error;
    console.error = () => {};
    try {
      t.start("c1", "bash");
      t.end("c1");
      const u = new ToolRunTimer({ who: () => ({ sid: "s", device: null, producer: "p" }), write: () => { throw new Error("disk"); } });
      u.start("c1", "bash");
      u.end("c1");
      u.start("c2", "bash");
      u.settle();
    } finally {
      console.error = quiet;
    }
  });
});

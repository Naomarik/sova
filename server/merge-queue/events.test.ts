import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { MergeEventInput } from "../../shared/merge-queue";
import { EVENT_READ_MAX, EVENT_TEXT_MAX, MergeEventLog } from "./events";

const note = (why: string, extra: Partial<MergeEventInput> = {}): MergeEventInput => ({ kind: "note", by: "queue", note: "t", why, ...extra }) as MergeEventInput;

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mq-events-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the event memory's order of record", () => {
  test("seq goes on from the newest good line across a restart and a new month; nothing is renumbered", () => {
    withDir((dir) => {
      let now = Date.parse("2026-10-30T10:00:00.000Z");
      const a = new MergeEventLog(dir, () => now);
      a.record(note("one"));
      a.record(note("two"));
      now = Date.parse("2026-11-01T10:00:00.000Z");
      const b = new MergeEventLog(dir, () => now);
      const third = b.record(note("three"));
      assert.equal(third.seq, 3);
      assert.deepEqual(b.months(), ["2026-10", "2026-11"]);
      assert.deepEqual(
        b.read().events.map((e) => [e.seq, e.why]),
        [
          [3, "three"],
          [2, "two"],
          [1, "one"],
        ],
      );
    });
  });

  test("an event that happened last month but is recorded this month is filed this month: seqs stay unique after a restart", () => {
    withDir((dir) => {
      let now = Date.parse("2027-01-31T23:59:59.000Z");
      new MergeEventLog(dir, () => now).record(note("run ended"));
      now = Date.parse("2027-02-01T00:00:01.000Z");
      const log = new MergeEventLog(dir, () => now);
      log.record(note("held from January", { at: "2027-01-31T23:59:58.000Z" }));
      const next = new MergeEventLog(dir, () => now).record(note("after a restart"));
      assert.equal(next.seq, 3);
      assert.deepEqual(new MergeEventLog(dir).read().events.map((e) => e.seq), [3, 2, 1]);
      assert.equal(new MergeEventLog(dir).read().events[1]!.at, "2027-01-31T23:59:58.000Z", "its own time is kept");
    });
  });

  test("a line torn by a stop mid-append is skipped, and the next event starts on a line of its own", () => {
    withDir((dir) => {
      const now = () => Date.parse("2026-11-02T10:00:00.000Z");
      new MergeEventLog(dir, now).record(note("kept"));
      appendFileSync(join(dir, "events", "2026-11.jsonl"), '{"seq":2,"kind":"no');
      const ev = new MergeEventLog(dir, now).record(note("after"));
      assert.equal(ev.seq, 2, "the torn line never counted");
      const lines = readFileSync(join(dir, "events", "2026-11.jsonl"), "utf8").trimEnd().split("\n");
      assert.equal(JSON.parse(lines.at(-1)!).why, "after", "not glued to the torn line");
      assert.deepEqual(new MergeEventLog(dir).read().events.map((e) => e.why), ["after", "kept"]);
    });
  });

  test("an empty newest month falls back to the month before for the next seq", () => {
    withDir((dir) => {
      new MergeEventLog(dir, () => Date.parse("2026-10-15T10:00:00.000Z")).record(note("october"));
      writeFileSync(join(dir, "events", "2026-11.jsonl"), "");
      assert.equal(new MergeEventLog(dir, () => Date.parse("2026-11-15T10:00:00.000Z")).record(note("november")).seq, 2);
    });
  });
});

describe("reading the event memory", () => {
  test("by entry, run, branch, actor and kind; newest first; `before` pages back and `more` says there is more", () => {
    withDir((dir) => {
      const log = new MergeEventLog(dir);
      for (let i = 1; i <= 5; i++) log.record(note(`a${i}`, { entry: "mq_a", branch: "feat/a", run: i <= 2 ? "mr_1" : "mr_2" }));
      log.record({ kind: "ruled", by: "thread", act: "note", read: [], entry: "mq_b", branch: "feat/b", why: "b" });
      assert.deepEqual(log.read({ entry: "mq_a", limit: 2 }).events.map((e) => e.why), ["a5", "a4"]);
      assert.equal(log.read({ entry: "mq_a", limit: 2 }).more, true);
      const older = log.read({ entry: "mq_a", limit: 10, before: 4 });
      assert.deepEqual(older.events.map((e) => e.why), ["a3", "a2", "a1"]);
      assert.equal(older.more, false);
      assert.deepEqual(log.read({ run: "mr_1" }).events.map((e) => e.why), ["a2", "a1"]);
      assert.deepEqual(log.read({ branch: "feat/b" }).events.map((e) => e.why), ["b"]);
      assert.deepEqual(log.read({ by: "thread" }).events.map((e) => e.kind), ["ruled"]);
      assert.deepEqual(log.read({ kind: "ruled" }).events.map((e) => e.entry), ["mq_b"]);
      assert.deepEqual(log.newest().map((e) => e.seq), [6, 5, 4, 3, 2, 1], "the memory tail holds each event once");
    });
  });

  test("text from the merge thread is kept capped: the line, the whole text and what it read", () => {
    withDir((dir) => {
      const log = new MergeEventLog(dir);
      const ev = log.record({ kind: "ruled", by: "thread", act: "rule", why: "w".repeat(EVENT_TEXT_MAX + 50), text: "t".repeat(5000), read: Array.from({ length: 30 }, (_, i) => `log ${i} ${"x".repeat(400)}`) });
      const kept = new MergeEventLog(dir).read().events[0]! as typeof ev & { read: string[]; text: string };
      assert.ok(kept.why.length <= EVENT_TEXT_MAX);
      assert.ok(kept.text.length <= 2000);
      assert.equal(kept.read.length, EVENT_READ_MAX);
      assert.ok(kept.read.every((r) => r.length <= EVENT_TEXT_MAX));
    });
  });

  test("an unwritable folder never throws: the event still answers and the warning names it", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "events"), "a file where the folder should be");
      const warnings: string[] = [];
      const ev = new MergeEventLog(dir).record(note("x"), (l) => warnings.push(l));
      assert.equal(ev.seq, 1);
      assert.match(warnings[0] ?? "", /not written/);
    });
  });
});

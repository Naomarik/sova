// The reply-timing store as the helper reads it: day files followed from where a read stopped, gzipped
// days, duplicates once, a session's timings by entry, the Performance answer's range, filter and facets.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, test } from "node:test";
import { parsePerfLine, PerfStore } from "./perf-store";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const NOW = Date.parse("2026-10-13T12:00:00Z");

function store() {
  const root = mkdtempSync(join(tmpdir(), "perf-store-"));
  dirs.push(root);
  return { root, s: new PerfStore({ root, now: () => NOW, device: () => "dev1" }) };
}
let n = 0;
const rec = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1, key: `k${++n}`, ts: NOW - 3600_000, device: null, producer: "p1", sid: "s1", entryId: `e${n}`, provider: "zai", model: "glm-5.3", effort: "high", stop: "stop",
    sentAt: NOW - 3700_000, ttftMs: 800, thinkingMs: 2000, replyMs: 3000, thinking: { ms: 2000, n: 1 }, text: { ms: 3000, n: 1 }, tool: { ms: 0, n: 0 }, endMs: 5800, output: 900, reasoning: 300, ...o,
  });
const put = (root: string, day: string, file: string, lines: string[]) => {
  mkdirSync(join(root, day), { recursive: true });
  appendFileSync(join(root, day, file), lines.map((l) => `${l}\n`).join(""));
};

test("a line that isn't a finished reply's record is skipped", () => {
  assert.equal(parsePerfLine("not json"), null);
  assert.equal(parsePerfLine(rec({ entryId: undefined })), null);
  assert.equal(parsePerfLine(rec({ stop: "error" })), null);
  assert.equal(parsePerfLine(rec({ v: 2 })), null);
  assert.equal(parsePerfLine(rec({ output: "x" })), null);
  assert.equal(parsePerfLine(rec({ stop: "aborted" })), null);
  assert.equal(parsePerfLine(rec({ reasoning: 0 }))!.timing.reasoning, undefined, "a 0 count with a thinking window is not reported");
  assert.equal(parsePerfLine(rec())!.timing.reasoning, 300);
  assert.equal(parsePerfLine(rec({ tool: { ms: 4000, n: 2 } }))!.timing.toolCalls, 2);
  assert.equal(parsePerfLine(rec())!.timing.toolCalls, undefined);
});

test("files are followed from where a read stopped; a torn tail waits for its newline; a key counts once", () => {
  const { root, s } = store();
  const a = rec();
  put(root, "2026-10-13", "p1.jsonl", [a]);
  writeFileSync(join(root, "2026-10-13", "p1.jsonl"), `${a}\n${rec().slice(0, 20)}`);
  s.refresh(true);
  assert.equal(s.size, 1);
  put(root, "2026-10-13", "p2.jsonl", [a, rec()]);
  s.refresh(true);
  assert.equal(s.size, 2);
});

test("a gzipped day file is read whole", () => {
  const { root, s } = store();
  mkdirSync(join(root, "2026-10-01"), { recursive: true });
  writeFileSync(join(root, "2026-10-01", "p1.jsonl.gz"), gzipSync(`${rec({ ts: Date.parse("2026-10-01T10:00:00Z") })}\n${rec({ ts: Date.parse("2026-10-01T11:00:00Z") })}`));
  s.refresh(true);
  assert.equal(s.size, 2);
  assert.equal(s.performance({ range: "all", providers: [], models: [], tz: "UTC" }).since, "2026-10-01T10:00:00.000Z");
});

test("session-timings: one session's replies by entry, versioned", () => {
  const { root, s } = store();
  put(root, "2026-10-13", "p1.jsonl", [rec({ entryId: "a1" }), rec({ sid: "s2", entryId: "b1" })]);
  const one = s.sessionTimings("s1");
  assert.deepEqual(Object.keys(one.timings), ["a1"]);
  assert.equal(one.timings.a1!.effort, "high");
  assert.deepEqual(s.sessionTimings("nobody").timings, {});
  put(root, "2026-10-13", "p1.jsonl", [rec({ entryId: "a2" })]);
  const two = s.sessionTimings("s1");
  assert.notEqual(two.v, one.v);
  assert.deepEqual(Object.keys(two.timings).sort(), ["a1", "a2"]);
});

test("performance: local-day range, provider and model filters, facets ignore the filter", () => {
  const { root, s } = store();
  const day = (iso: string) => Date.parse(iso);
  put(root, "2026-10-13", "p1.jsonl", [rec(), rec({ provider: "openai", model: "gpt-5.5" })]);
  put(root, "2026-09-20", "p1.jsonl", [rec({ ts: day("2026-09-20T12:00:00Z") })]);
  put(root, "2026-08-01", "p1.jsonl", [rec({ ts: day("2026-08-01T12:00:00Z") })]);
  const all = s.performance({ range: "all", providers: [], models: [], tz: "UTC" });
  assert.equal(all.rows.find((r) => r.provider === "zai")!.replies, 3);
  assert.equal(all.device.id, "dev1");
  const d30 = s.performance({ range: "30d", providers: [], models: [], tz: "UTC" });
  assert.equal(d30.rows.find((r) => r.provider === "zai")!.replies, 2);
  const d7 = s.performance({ range: "7d", providers: ["zai"], models: [], tz: "Asia/Tokyo" });
  assert.deepEqual(d7.rows.map((r) => `${r.provider}/${r.model}:${r.replies}`), ["zai/glm-5.3:1"]);
  assert.deepEqual(d7.facets.providers, ["openai", "zai"]);
  const m = s.performance({ range: "7d", providers: [], models: ["openai/gpt-5.5"], tz: "UTC" });
  assert.deepEqual(m.rows.map((r) => r.model), ["gpt-5.5"]);
  assert.equal(m.rows[0]!.efforts[0]!.effort, "high");
});

test("nothing measured yet: no rows, no since", () => {
  const { s } = store();
  const p = s.performance({ range: "30d", providers: [], models: [], tz: "UTC" });
  assert.deepEqual(p.rows, []);
  assert.equal(p.since, null);
});

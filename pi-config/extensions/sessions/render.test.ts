import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ageLabel, detailLines, frame, groupHeader, rowLines, sparkline, stateGlyph, workerGlyph, workerLine, type RenderTokens } from "./render.ts";
import type { SessionView } from "./state.ts";
import type { WorkerEntry } from "./schema.ts";

const NOW = 10_000_000;
const echo: RenderTokens = { fg: (_, text) => text, bg: (_, text) => text };
const ansi: RenderTokens = { fg: (_, text) => `\x1b[35m${text}\x1b[39m`, bg: (_, text) => `\x1b[44m${text}\x1b[49m` };
const tagged: RenderTokens = { fg: (color, text) => `<${color}>${text}</${color}>`, bg: (_, text) => `[${text}]` };
const strip = (line: string) => stripTerminalSequences(line);
const fits = (lines: string[], width: number) => {
  for (const line of lines) assert.ok(visibleWidth(strip(line)) <= width, `${width}: ${visibleWidth(strip(line))} ${strip(line)}`);
};
const counts = { total: 0, working: 0, waiting: 0, done: 0, error: 0, killed: 0 };
const view = (id: string, extra: Partial<SessionView> = {}): SessionView => ({
  id, name: id, cwd: `/work/${id}`, model: "claude-opus-5", pid: 4242, startedAt: 1,
  self: false, legacy: false, stale: false, unseen: false, group: "idle", state: "idle", statusLabel: "Idle",
  since: NOW - 90_000, lastActivity: NOW, attention: "none", workers: [], workerCounts: counts,
  preview: `reply from ${id}`, canFocus: true, ...extra,
});
const workers: WorkerEntry[] = [
  { id: "w1", name: "linter", status: "done", lastActivity: NOW - 60_000 },
  { id: "w2", name: "reviewer", status: "running", model: "haiku", lastActivity: NOW - 3000 },
];
const rich = view("builder", {
  group: "working", state: "working", statusLabel: "Running: bash", tools: ["bash"], toolDetail: "edit · auth.ts",
  outline: { now: "Refactoring auth", overall: "Moving the auth layer to session tokens.", topics: ["auth", "tokens", "tests", "ci", "extra"], lastHeading: "Auth fix" },
  activity: { state: "working", since: NOW - 90_000, buckets: [0, 1, 3, 0, 7], lastToolAt: NOW - 4000, turns: 7 },
  workers, workerCounts: { ...counts, total: 2, working: 1, done: 1 },
});

test("sparkline: empty, all-zero and mixed buckets, newest last", () => {
  assert.equal(sparkline([]), "");
  assert.equal(sparkline([0, 0, 0]), "───");
  assert.equal(sparkline([0, 1, 7, 14]), "─▁▄▇");
  assert.equal(sparkline([5]), "▇");
  assert.equal(sparkline([1, 2, 3, 4], 2), "▆▇", "width keeps the newest buckets");
  assert.equal(sparkline([1, 2], 0), "");
  assert.equal(sparkline([Number.NaN, -3, 2]), "──▇", "junk counts render as zero");
});

test("ageLabel covers every range; future and junk read as now", () => {
  const cases: [number, string][] = [[0, "now"], [999, "now"], [1000, "1s"], [41_000, "41s"], [59_999, "59s"], [60_000, "1m"],
    [150_000, "2m"], [3_599_999, "59m"], [3_600_000, "1h"], [3 * 3_600_000, "3h"], [86_399_999, "23h"], [86_400_000, "1d"], [5 * 86_400_000, "5d"]];
  for (const [ago, label] of cases) assert.equal(ageLabel(NOW - ago, NOW), label, `${ago}`);
  assert.equal(ageLabel(NOW + 60_000, NOW), "now");
  assert.equal(ageLabel(Number.NaN, NOW), "now");
});

test("state and worker glyphs; stale overrides state", () => {
  assert.deepEqual(["working", "idle", "needs-input", "error"].map(s => stateGlyph(s as SessionView["state"])), ["●", "○", "⚑", "✗"]);
  for (const s of ["working", "idle", "needs-input", "error"] as const) assert.equal(stateGlyph(s, { stale: true }), "◌");
  const map: Record<string, string> = {
    running: "●", starting: "●", stopping: "●", busy: "●", waiting: "◇", idle: "◇", done: "✓", finished: "✓",
    error: "✗", failed: "✗", killed: "✗", aborted: "✗", "  Running ": "●", weird: "·", "": "·",
  };
  for (const [status, glyph] of Object.entries(map)) assert.equal(workerGlyph(status), glyph, status);
});

test("group headers name the group, count members, stay within width", () => {
  const views = [view("a", { group: "needs-input" }), view("b", { group: "working" }), view("c"), view("d")];
  assert.match(groupHeader("needs-input", views, 40, echo), /^NEEDS INPUT 1 ─+$/);
  assert.match(groupHeader("working", views, 40, echo), /^WORKING 1 /);
  assert.match(groupHeader("idle", views, 40, echo), /^IDLE 2 /);
  assert.match(groupHeader("unreachable", views, 40, echo), /^UNREACHABLE 0 /);
  assert.equal(visibleWidth(groupHeader("idle", views, 40, echo)), 40);
  assert.match(groupHeader("needs-input", views, 40, tagged), /^<warning>NEEDS INPUT 1 <\/warning>/);
  for (const width of [0, 3, 12, 80]) fits([groupHeader("unreachable", views, width, ansi)], width);
});

test("rowLines: one line below 100, two from 100, never wider than width", () => {
  const all = [rich, view("plain"), view("me", { self: true }), view("old", { legacy: true, statusLabel: "idle · basic" }),
    view("gone", { stale: true, group: "unreachable", statusLabel: "Unknown · stale" }), view("界".repeat(80), { model: "m".repeat(90) })];
  for (const v of all) {
    for (const width of [0, 1, 5, 20, 60, 100, 160]) {
      for (const selected of [false, true]) {
        const lines = rowLines(v, { selected, now: NOW, expanded: true }, width, ansi);
        assert.equal(lines.length, width >= 100 ? 2 : 1);
        fits(lines, width);
      }
    }
  }
  const [line] = rowLines(rich, { now: NOW }, 60, echo);
  assert.match(line, /^ ● builder +1m {2}claude-opus-5 +◆1\/2▸/);
  assert.match(rowLines(rich, { now: NOW, selected: true, expanded: true }, 60, echo)[0], /^>● builder .*◆1\/2▾/);
  const two = rowLines(rich, { now: NOW }, 100, echo);
  assert.match(two[1], /^ {3}▶ Refactoring auth · # Auth fix/);
  assert.match(rowLines(view("plain"), { now: NOW }, 100, echo)[1], /▶ Idle$/, "status label without an outline");
  assert.equal(rowLines(rich, { now: NOW, twoLine: false }, 160, echo).length, 1);
  assert.equal(rowLines(rich, { now: NOW, twoLine: true }, 60, echo).length, 2);
});

test("rowLines: narrow rows drop model, then workers, then age before the name", () => {
  const [narrow] = rowLines(rich, { now: NOW }, 30, echo);
  assert.ok(narrow.includes("builder") && !narrow.includes("claude"));
  const [tiny] = rowLines(rich, { now: NOW }, 14, echo);
  assert.ok(tiny.includes("builder") && !tiny.includes("◆") && !tiny.includes("1m"));
});

test("rowLines: unseen dot, self suffix, stale dims everything, legacy hint", () => {
  assert.ok(rowLines(view("a", { unseen: true }), { now: NOW }, 60, echo)[0].includes("a •"));
  assert.ok(!rowLines(view("a"), { now: NOW }, 60, echo)[0].includes("•"));
  assert.match(rowLines(view("a", { unseen: true }), { now: NOW }, 60, tagged)[0], /<accent> •<\/accent>/);
  const self = rowLines(view("me", { self: true, unseen: true }), { now: NOW }, 60, tagged)[0];
  assert.ok(self.includes("<muted> · you</muted>") && !self.includes("•"), "self never shows the unseen dot");
  const stale = rowLines(view("gone", { stale: true, group: "unreachable", statusLabel: "Unknown · stale" }), { now: NOW }, 120, tagged);
  assert.ok(stale[0].includes("◌"));
  for (const line of stale) {
    const colors = [...line.matchAll(/<(\w+)>/g)].map(m => m[1]);
    assert.ok(colors.length && colors.every(c => c === "dim"), `stale row fully dim: ${line}`);
  }
  const legacy = view("old", { legacy: true, statusLabel: "idle · basic" });
  assert.match(rowLines(legacy, { now: NOW }, 100, echo)[1], /▶ idle · basic {2}\(reload to enrich\)/);
  assert.ok(!rowLines(legacy, { now: NOW, twoLine: true }, 30, echo)[1].includes("reload"), "hint only when it fits");
  assert.ok(!rowLines(legacy, { now: NOW }, 100, echo)[0].includes("reload"), "line 1 appends nothing else");
});

test("rowLines keeps the # heading visible when the outline 'now' is long", () => {
  const long = view("a", { outline: { now: "x".repeat(300), lastHeading: "Auth fix" } });
  const [, second] = rowLines(long, { now: NOW }, 100, echo);
  assert.ok(second.endsWith(" · # Auth fix"));
  assert.equal(visibleWidth(second), 100);
});

test("workerLine glyph map, trimming order and width", () => {
  assert.match(workerLine(workers[1], 60, echo, { now: NOW }), /^● reviewer {2}running {2}haiku {2}3s$/);
  assert.match(workerLine(workers[0], 60, echo, { now: NOW }), /^✓ linter {2}done {2}1m$/);
  assert.match(workerLine({ id: "x", name: "odd", status: "mystery" }, 60, echo), /^· odd {2}mystery$/);
  assert.match(workerLine(workers[1], 60, echo, { indent: ">  └ ", selected: true, now: NOW }), /^>  └ ● reviewer/);
  const narrow = workerLine(workers[1], 26, echo, { now: NOW });
  assert.ok(narrow.includes("reviewer") && !narrow.includes("haiku"), narrow);
  for (const width of [0, 1, 4, 10, 26, 80]) fits([workerLine({ ...workers[1], name: "界".repeat(60) }, width, ansi, { indent: "   └ ", selected: true })], width);
});

test("detailLines: sections in order, absent sections omitted", () => {
  const lines = detailLines(rich, 70, 40, echo, "detail", { now: NOW });
  fits(lines, 70);
  assert.ok(lines.length <= 40);
  const at = (pattern: RegExp) => lines.findIndex(line => pattern.test(line));
  const order = [/^builder · pid 4242 · claude-opus-5 · \/work\/builder$/, /^● Working for 1m · bash · edit · auth\.ts/, /^Summary/,
    /^Workers 1\/2/, /^Activity ─▁▃─▇ · last tool 4s · 7 turns$/, /^Latest reply/];
  const indices = order.map(at);
  assert.ok(indices.every(i => i >= 0), JSON.stringify(indices));
  assert.deepEqual([...indices].sort((a, b) => a - b), indices);
  assert.ok(lines.some(line => line.includes("# auth  # tokens  # tests  # ci")) && !lines.some(line => line.includes("# extra")), "≤4 topic chips");
  // Running workers first, then finished.
  assert.ok(at(/● reviewer/) < at(/✓ linter/));
  assert.ok(lines.includes("reply from builder"));

  const bare = detailLines(view("plain"), 70, 40, echo, "detail", { now: NOW });
  for (const header of [/^Summary/, /^Workers/, /^Activity/]) assert.ok(!bare.some(line => header.test(line)), `${header}`);
  assert.ok(bare.some(line => line.startsWith("Latest reply")));
});

test("detailLines: attention states, preview-only reason, legacy hint, host", () => {
  const needs = detailLines(view("a", { state: "needs-input", attention: "needs-input" }), 70, 20, tagged, "detail", { now: NOW });
  assert.ok(needs.some(line => line.includes("<warning>Needs input</warning>")));
  const error = detailLines(view("a", { state: "error", attention: "error", activity: { state: "error", since: 1, error: "boom" } }), 70, 20, tagged, "detail", { now: NOW });
  assert.ok(error.some(line => line.includes("<error>Errored</error>")) && error.some(line => line.includes("boom")));
  const blocked = detailLines(view("a", { canFocus: false, focusReason: "hidden tab", host: "box" }), 70, 20, echo, "detail", { now: NOW });
  assert.ok(blocked.some(line => line === "preview only · hidden tab"));
  assert.ok(blocked[0].includes(" · box"));
  const legacy = detailLines(view("a", { legacy: true, statusLabel: "idle · basic" }), 70, 20, echo, "detail", { now: NOW });
  assert.ok(legacy.some(line => line.includes("reload to enrich")));
});

test("detailLines: preview mode shows identity + reply; worker preview; budgets", () => {
  const long = { ...rich, preview: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") };
  const preview = detailLines(long, 60, 12, echo, "preview", { now: NOW });
  assert.equal(preview.length, 12);
  assert.ok(!preview.some(line => /^(Summary|Workers)/.test(line)));
  assert.ok(preview.some(line => line.startsWith("Latest reply")) && preview.includes("line 0"));
  assert.match(preview.at(-1)!, /^Activity/);
  const worker = detailLines(rich, 60, 12, echo, "preview", { worker: { ...workers[1], preview: "worker says hi" }, now: NOW });
  assert.ok(worker.some(line => line.startsWith("Worker output · reviewer")) && worker.includes("worker says hi"));
  assert.ok(!worker.includes("reply from builder"));
  for (const height of [0, 1, 2, 3, 5, 8, 30]) {
    for (const width of [0, 1, 10, 33, 90]) {
      for (const mode of ["detail", "preview"] as const) {
        const lines = detailLines(long, width, height, ansi, mode, { now: NOW, worker: workers[0] });
        assert.ok(lines.length <= height, `${width}x${height} ${mode}`);
        fits(lines, width);
      }
    }
  }
  assert.deepEqual(detailLines(rich, 0, 10, echo), []);
});

test("frame: borders at 24/90/160, exact widths, title clip, tiny-width degradation", () => {
  for (const width of [24, 90, 160]) {
    const lines = frame(["hello", "界".repeat(200), ""], width, "Title", ansi);
    assert.equal(lines.length, 5);
    for (const line of lines) assert.equal(visibleWidth(strip(line)), width);
    const plain = lines.map(strip);
    assert.match(plain[0], /^┌─ Title ─*┐$/);
    assert.match(plain[1], /^│ hello +│$/);
    assert.match(plain[4], /^└─+┘$/);
  }
  const clipped = strip(frame([], 24, "A very long title that cannot fit", echo)[0]);
  assert.equal(visibleWidth(clipped), 24);
  assert.match(clipped, /^┌─ A very long title… ─┐$/);
  for (const width of [0, 1, 5, 10, 23]) {
    const lines = frame(["some content here", "x"], width, "Sessions", ansi);
    assert.equal(lines.length, 3, "title rule plus content, no bottom border");
    assert.ok(!lines.some(line => strip(line).includes("│")));
    fits(lines, width);
  }
});

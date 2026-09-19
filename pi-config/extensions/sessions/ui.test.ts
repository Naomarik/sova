import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SessionsOverlay, type SessionsOverlayOptions } from "./ui.ts";
import type { SessionView } from "./state.ts";
import type { WorkerEntry } from "./schema.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
const ansi = { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[39m`, bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m` } as Theme;
const strip = (line: string) => stripTerminalSequences(line);
const counts = (workers: WorkerEntry[]) => ({ total: workers.length, working: workers.filter(w => w.status === "running").length,
  waiting: 0, done: workers.filter(w => w.status !== "running").length, error: 0, killed: 0 });
const view = (id: string, extra: Partial<SessionView> = {}): SessionView => {
  const workers = extra.workers ?? [];
  return {
    id, name: id, cwd: `/work/${id}`, model: "model", pid: 1000, startedAt: 1, self: false, legacy: false, stale: false,
    unseen: false, group: "idle", state: "idle", statusLabel: "Idle", since: Date.now(), lastActivity: Date.now(), attention: "none",
    workerCounts: counts(workers), preview: `preview-${id}`, canFocus: true, ...extra, workers,
  };
};
const up = "\x1b[A", down = "\x1b[B", right = "\x1b[C", left = "\x1b[D", pageUp = "\x1b[5~", pageDown = "\x1b[6~";
function setup(height = 30, selectedTheme = theme, opts?: SessionsOverlayOptions) {
  const results: (string | undefined)[] = [];
  let refreshes = 0;
  const size = { height };
  const ui = new SessionsOverlay(selectedTheme, () => refreshes++, () => size.height, id => results.push(id), undefined, opts);
  const lines = (width = 90) => ui.render(width).map(strip);
  return { ui, results, size, refreshes: () => refreshes, lines, text: (width = 90) => lines(width).join("\n") };
}
/** The list's selected line (frames prefix "│ "). */
const selectedLine = (ui: SessionsOverlay, width = 90) => ui.render(width).map(strip).find(line => /^(│ )?>/.test(line));
const selectedName = (ui: SessionsOverlay, names: string[], width = 90) => {
  const line = selectedLine(ui, width) ?? "";
  return names.find(name => new RegExp(`[●○⚑✗◌◇✓·] ${name}\\b`).test(line));
};

test("Esc and Ctrl+C close once via done(undefined)", () => {
  for (const key of ["\x03", "\x1b"]) {
    const { ui, results } = setup();
    ui.update([view("a")], "connected");
    ui.handleInput(key);
    ui.handleInput(key);
    ui.handleInput("\r");
    ui.update([view("b")], "connected");
    assert.deepEqual(results, [undefined]);
  }
});

test("injected selection keys replace defaults and appear in hints", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+q",
    "tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p",
  });
  const results: (string | undefined)[] = [];
  const done = (id: string | undefined): void => { results.push(id); };
  const ui = new SessionsOverlay(theme, () => {}, () => 20, done, keys);
  ui.update([view("a"), view("b")], "connected");
  const names = ["a", "b"];
  ui.handleInput(down);
  assert.equal(selectedName(ui, names), "a");
  ui.handleInput("\x0e");
  assert.equal(selectedName(ui, names), "b");
  ui.handleInput("\x10");
  assert.equal(selectedName(ui, names), "a");
  ui.handleInput("\r");
  ui.handleInput("\x1b");
  assert.deepEqual(results, []);
  assert.match(ui.render(200).map(strip).join("\n"), /ctrl\+p\/ctrl\+n select .* ctrl\+y focus · ctrl\+q close/);
  ui.handleInput("\x19");
  assert.deepEqual(results, ["a"]);
  const cancel = new SessionsOverlay(theme, () => {}, () => 20, done, keys);
  cancel.handleInput("\x11");
  assert.deepEqual(results, ["a", undefined]);
});

test("default footer hints and title tallies", () => {
  const { ui, lines } = setup();
  ui.update([view("a", { group: "working", state: "working" }), view("b", { group: "needs-input", state: "needs-input" }),
    view("c", { unseen: true }), view("d", { group: "unreachable", stale: true })], "Live · local");
  const out = lines(160);
  assert.equal(out[0], "Sessions · 3 live · ●1 ⚑1 ✦1 unseen · Live · local");
  assert.match(out[1], /^Search: /);
  assert.match(out.at(-1)!, /^↑↓ select · ←→ workers · Tab detail · Enter focus · Esc close · 1\/4$/);
});

test("group headers are never selectable: the arrow walk visits only sessions and workers", () => {
  const { ui, text } = setup(40);
  const workers = [{ id: "w1", name: "wone", status: "running" }, { id: "w2", name: "wtwo", status: "done" }];
  ui.update([view("ask", { group: "needs-input", state: "needs-input" }), view("busy", { group: "working", state: "working", workers }),
    view("rest"), view("lost", { group: "unreachable", stale: true })], "connected");
  for (const header of ["NEEDS INPUT 1", "WORKING 1", "IDLE 1", "UNREACHABLE 1"]) assert.ok(text().includes(header), header);
  const names = ["ask", "busy", "wone", "wtwo", "rest", "lost"];
  const visited = [selectedName(ui, names)];
  ui.handleInput(down);
  visited.push(selectedName(ui, names));
  ui.handleInput(right);
  for (let i = 0; i < 6; i++) { ui.handleInput(down); visited.push(selectedName(ui, names)); }
  assert.deepEqual(visited, ["ask", "busy", "wone", "wtwo", "rest", "lost", "lost", "lost"]);
  for (let i = 0; i < 8; i++) ui.handleInput(up);
  assert.equal(selectedName(ui, names), "ask");
  assert.ok(!selectedLine(ui)!.includes("NEEDS INPUT"));
});

test("selection survives grouped re-sorts across update()", () => {
  const { ui, results, lines } = setup();
  const names = ["a", "b", "c", "z"];
  ui.update([view("a"), view("b"), view("c")], "connected");
  ui.handleInput(down);
  assert.equal(selectedName(ui, names), "b");
  const before = lines().findIndex(line => /^(│ )?>/.test(line));
  // b jumps to the needs-input group at the top; a new working session appears.
  ui.update([view("b", { group: "needs-input", state: "needs-input" }), view("z", { group: "working", state: "working" }), view("c"), view("a")], "connected");
  assert.equal(selectedName(ui, names), "b");
  const after = lines().findIndex(line => /^(│ )?>/.test(line));
  assert.notEqual(after, before, "the row moved");
  // Reordering inside a group also keeps the selection.
  ui.handleInput(down);
  ui.handleInput(down);
  assert.equal(selectedName(ui, names), "c");
  ui.update([view("b", { group: "needs-input", state: "needs-input" }), view("z", { group: "working", state: "working" }), view("a"), view("c")], "connected");
  assert.equal(selectedName(ui, names), "c");
  ui.handleInput("\r");
  assert.deepEqual(results, ["c"]);
});

test("removed worker falls back to parent; removed parent selects nearby row", () => {
  const { ui, text } = setup();
  const names = ["a", "b", "c", "worker"];
  ui.update([view("a"), view("b", { workers: [{ id: "w", name: "worker", status: "running" }] }), view("c")], "connected");
  ui.handleInput(down);
  ui.handleInput(right);
  ui.handleInput(down);
  assert.equal(selectedName(ui, names), "worker");
  ui.update([view("a"), view("b"), view("c")], "connected");
  assert.equal(selectedName(ui, names), "b");
  ui.update([view("a"), view("c")], "connected");
  assert.equal(selectedName(ui, names), "c");
  ui.update([], "disconnected");
  ui.handleInput(up);
  ui.handleInput("\r");
  assert.match(text(), /No live sessions/);
});

test("worker expansion, stable order, Enter on a worker previews without done, collapse", () => {
  const { ui, results, text } = setup(40);
  const workers = [
    { id: "w1", name: "worker-one", status: "running", model: "small", preview: "worker output\nsecond line" },
    { id: "w2", name: "worker-two", status: "done" },
  ];
  const names = ["parent", "worker-one", "worker-two"];
  ui.update([view("parent", { workers })], "connected");
  assert.doesNotMatch(text(), /worker-one/);
  ui.handleInput(right);
  assert.match(text(), /└ ● worker-one/);
  ui.handleInput(down);
  ui.update([view("parent", { workers: [...workers].reverse() })], "connected");
  assert.equal(selectedName(ui, names), "worker-one");
  ui.handleInput("\r");
  assert.deepEqual(results, []);
  const wide = ui.render(120).map(strip).join("\n");
  assert.match(wide, /parent › worker-one · Preview/);
  assert.match(wide, /Worker output · worker-one/);
  assert.match(wide, /│ worker output +│\n│ second line +│/);
  assert.equal(selectedName(ui, names, 120), "worker-one", "Enter keeps the selection");
  assert.equal(selectedLine(ui, 90), undefined, "narrow layout now shows the preview instead of the list");
  ui.handleInput("\t"); // preview → off brings the narrow list back
  ui.handleInput(down);
  assert.equal(selectedName(ui, names), "worker-two");
  ui.handleInput(left);
  assert.equal(selectedName(ui, names), "parent");
  assert.doesNotMatch(text(), /worker-two/);
  ui.handleInput("\r");
  assert.deepEqual(results, ["parent"]);
});

test("→ does nothing for sessions without workers", () => {
  const { ui, text } = setup();
  ui.update([view("a")], "connected");
  const before = text();
  ui.handleInput(right);
  assert.equal(text(), before);
});

test("Enter: focusable (incl. self) closes with the id; preview-only switches to preview", () => {
  const { ui, results, text } = setup();
  ui.update([view("blocked", { canFocus: false, focusReason: "hidden tab" })], "connected");
  ui.handleInput("\r");
  assert.deepEqual(results, []);
  assert.match(ui.render(120).map(strip).join("\n"), /blocked · Preview/);
  assert.match(text(), /Latest reply/, "narrow layouts swap to the preview after Enter");
  const self = setup();
  self.ui.update([view("me", { self: true, canFocus: true })], "connected");
  self.ui.handleInput("\r");
  assert.deepEqual(self.results, ["me"]);
});

test("Tab cycles detail → preview → off → detail", () => {
  const { ui, refreshes } = setup(30);
  ui.update([view("a", { outline: { overall: "Doing the work" } })], "connected");
  const wide = () => ui.render(120).map(strip).join("\n");
  assert.match(wide(), /a · Detail/);
  assert.match(wide(), /Summary/);
  ui.handleInput("\t");
  assert.match(wide(), /a · Preview/);
  assert.doesNotMatch(wide(), /Summary/);
  ui.handleInput("\t");
  assert.doesNotMatch(wide(), /· (Detail|Preview)/);
  ui.handleInput("\t");
  assert.match(wide(), /a · Detail/);
  assert.equal(refreshes(), 4);
});

test("layouts: two panes ≥140, stacked 100–139, narrow swaps list for detail", () => {
  const { ui, lines } = setup(30);
  ui.update([view("a"), view("b")], "connected");
  const two = lines(160);
  assert.ok(two.some(line => /^┌─ Sessions ─+┐┌─ a · Detail ─+┐$/.test(line)));
  assert.ok(two.every(line => visibleWidth(line) <= 160));
  const stacked = lines(120);
  const listTop = stacked.findIndex(line => line.startsWith("┌─ Sessions"));
  const detailTop = stacked.findIndex(line => line.startsWith("┌─ a · Detail"));
  assert.ok(listTop >= 0 && detailTop > listTop);
  // Narrow: the list shows first; Tab swaps it for the detail text entirely.
  assert.ok(selectedLine(ui, 80));
  ui.handleInput("\t");
  const narrow = lines(80).join("\n");
  assert.equal(selectedLine(ui, 80), undefined);
  assert.match(narrow, /Latest reply/);
  ui.handleInput("\t");
  assert.ok(selectedLine(ui, 80), "off restores the list");
});

test("narrow layout hides group headers when the inner height is below 8", () => {
  const { ui, size, text } = setup(8);
  ui.update([view("a", { group: "working", state: "working" }), view("b")], "connected");
  assert.doesNotMatch(text(60), /WORKING|IDLE/);
  size.height = 20;
  assert.match(text(60), /WORKING 1/);
});

test("fuzzy search collapses groups into a flat ranked list; live updates don't re-rank", () => {
  const { ui, text } = setup();
  ui.update([view("a", { name: "alphabet", group: "working", state: "working" }), view("b", { name: "abt" }), view("c", { cwd: "/project/unique" })], "connected");
  ui.handleInput("abt");
  assert.doesNotMatch(text(), /WORKING|IDLE/);
  const rows = () => text().split("\n").filter(line => /alphabet|abt/.test(line) && !line.startsWith("Search"));
  const before = rows().map(line => line.includes("alphabet") ? "a" : "b");
  assert.equal(before.length, 2);
  ui.update([view("b", { name: "alphabet" }), view("a", { name: "abt", group: "working", state: "working" }), view("c")], "connected");
  assert.deepEqual(rows().map(line => line.includes("alphabet") ? "b" : "a"), before);
  ui.handleInput("\x15"); // Without onMarkAllSeen, Ctrl+U stays Input's clear-line.
  assert.match(text(), /WORKING/);
  ui.update([view("a"), view("b"), view("c", { cwd: "/project/unique" })], "connected");
  ui.handleInput("prjunq");
  assert.match(selectedLine(ui)!, / c /);
  assert.doesNotMatch(text(), / a | b /);
});

test("setQuery and initialQuery prefill the Input and narrow the list", () => {
  const { ui, text } = setup();
  ui.setQuery("beta");
  ui.update([view("alpha"), view("beta"), view("gamma")], "connected");
  assert.match(text(), /Search: beta/);
  assert.match(selectedLine(ui)!, /beta/);
  assert.doesNotMatch(text(), /alpha|gamma|IDLE/);
  ui.setQuery("gam");
  assert.match(selectedLine(ui)!, /gamma/);
  ui.setQuery("");
  assert.match(text(), /alpha[\s\S]*beta[\s\S]*gamma/);
  const pre = setup(30, theme, { initialQuery: "gam" });
  pre.ui.update([view("alpha"), view("gamma")], "connected");
  assert.match(pre.text(), /Search: gam/);
  assert.doesNotMatch(pre.text(), /alpha/);
});

test("Ctrl+U marks all seen via the callback; hint only while unseen rows exist", () => {
  let calls = 0;
  const { ui, text, refreshes } = setup(30, theme, { onMarkAllSeen: () => calls++ });
  ui.update([view("a")], "connected");
  assert.doesNotMatch(text(), /Ctrl\+U seen/);
  ui.update([view("a", { unseen: true }), view("b")], "connected");
  assert.match(text(), /Ctrl\+U seen/);
  const before = refreshes();
  ui.handleInput("\x15");
  assert.equal(calls, 1);
  assert.equal(refreshes(), before + 1);
  assert.doesNotMatch(text(), /•|Ctrl\+U seen|unseen/);
});

test("unseen dot is rendered for unseen rows only, never for self", () => {
  const { ui, text } = setup();
  ui.update([view("new", { unseen: true }), view("old"), view("me", { self: true, unseen: true })], "connected");
  const dotted = text().split("\n").filter(line => line.includes("•"));
  assert.equal(dotted.length, 1);
  assert.match(dotted[0], /new •/);
  const accent = setup(30, { fg: (c: string, s: string) => c === "accent" ? `\x1b[35m${s}\x1b[39m` : s, bg: (_: string, s: string) => s } as Theme);
  accent.ui.update([view("new", { unseen: true })], "connected");
  assert.ok(accent.ui.render(90).join("\n").includes("\x1b[35m •\x1b[39m"));
});

test("legacy rows show (reload to enrich) at width ≥100 only", () => {
  const { ui, text } = setup();
  ui.update([view("old", { legacy: true, statusLabel: "idle · basic", canFocus: false })], "connected");
  assert.match(text(120), /▶ idle · basic {2}\(reload to enrich\)/);
  assert.doesNotMatch(text(90), /reload to enrich/);
});

test("height ≤2 falls back to the selected row only", () => {
  const { ui, size } = setup(2);
  assert.deepEqual(ui.render(60).map(strip), ["No matching sessions"]);
  ui.update([view("a"), view("b", { workers: [{ id: "w", name: "wk", status: "running" }] })], "connected");
  ui.handleInput(down);
  for (const height of [1, 2]) {
    size.height = height;
    const out = ui.render(60).map(strip);
    assert.equal(out.length, 1);
    assert.match(out[0], /^>● b|^>○ b/);
  }
  ui.handleInput(right);
  ui.handleInput(down);
  assert.match(strip(ui.render(60)[0]), /^> +└ ● wk/);
  size.height = 0;
  assert.deepEqual(ui.render(60), []);
});

test("no line of any render exceeds its width (ANSI-stripped)", () => {
  const { ui, size } = setup(30, ansi);
  ui.focused = true;
  const workers = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, name: "界".repeat(40), status: i % 2 ? "running" : "done", model: "m".repeat(60), preview: "界".repeat(300) }));
  ui.update([
    view("a", { name: "界👨‍👩‍👦".repeat(60), cwd: "/".repeat(400), model: "x".repeat(200), host: "h".repeat(80), workers,
      group: "working", state: "working", tools: ["t".repeat(50)], toolDetail: "d".repeat(80), unseen: true,
      outline: { now: "n".repeat(300), overall: "o ".repeat(300), topics: ["t".repeat(90)], lastHeading: "界".repeat(90),
        detail: [{ heading: "h".repeat(90), bullets: ["b".repeat(200)] }] },
      activity: { state: "working", since: 1, buckets: Array(16).fill(3), lastToolAt: 1, turns: 99999 }, preview: "界".repeat(2000) }),
    view("b", { legacy: true, statusLabel: "idle · basic", canFocus: false }),
    view("c", { group: "needs-input", state: "needs-input", self: true }),
    view("d", { group: "unreachable", stale: true }),
  ], "connected".repeat(50));
  ui.handleInput(down);
  ui.handleInput(right);
  const widths = [0, 1, 5, 12, 23, 24, 25, 40, 60, 90, 99, 100, 120, 139, 140, 141, 200];
  const heights = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 40];
  for (let step = 0; step < 6; step++) {
    for (const height of heights) {
      size.height = height;
      for (const width of widths) {
        const lines = ui.render(width);
        assert.ok(lines.length <= height, `height ${height} width ${width}: ${lines.length}`);
        for (const line of lines) assert.ok(visibleWidth(strip(line)) <= width, `${width}x${height}: ${visibleWidth(strip(line))}`);
      }
    }
    ui.handleInput(step % 2 ? "\t" : down);
  }
  ui.handleInput("界".repeat(100));
  size.height = 20;
  for (const width of [0, 5, 14, 60, 90, 140]) for (const line of ui.render(width)) assert.ok(visibleWidth(strip(line)) <= width);
});

test("selection scrolls into view with many expanded workers and resize", () => {
  const { ui, size } = setup(10);
  ui.update([view("parent", { workers: Array.from({ length: 80 }, (_, i) => ({ id: `${i}`, name: `worker-${i}`, status: "running" })) })], "connected");
  ui.handleInput(right);
  for (let i = 0; i < 80; i++) ui.handleInput(down);
  assert.match(selectedLine(ui)!, /worker-79\b/);
  size.height = 3;
  assert.match(selectedLine(ui)!, /worker-79\b/);
  size.height = 10;
  for (let i = 0; i < 80; i++) ui.handleInput(up);
  assert.match(selectedLine(ui)!, /parent/);
  assert.ok(ui.render(120).map(strip).some(line => line.includes("IDLE 1")), "scrolling to the top reveals the group header");
});

test("PageUp/PageDown move ten selectable entries", () => {
  const { ui } = setup(40);
  const names = Array.from({ length: 25 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  ui.update(names.map(name => view(name)), "connected");
  ui.handleInput(pageDown);
  assert.equal(selectedName(ui, names), "s10");
  ui.handleInput(pageDown);
  ui.handleInput(pageDown);
  assert.equal(selectedName(ui, names), "s24");
  ui.handleInput(pageUp);
  assert.equal(selectedName(ui, names), "s14");
  assert.match(ui.render(90).map(strip).at(-1)!, / 15\/25$/);
});

test("untrusted fields cannot inject terminal controls or extra label lines", () => {
  const { ui } = setup(40);
  const evil = "bad\x1b[2J\x1b]52;c;secret\x07\x9b31m\r\t\x00" + String.fromCharCode(0x202e, 0x2066) + "\nname";
  const worker = { id: evil, name: evil, status: evil, model: evil, preview: evil };
  ui.update([view(evil, { name: evil, cwd: evil, model: evil, host: evil, statusLabel: evil, preview: evil, tools: [evil], toolDetail: evil,
    focusReason: evil, canFocus: false, unseen: true,
    outline: { now: evil, overall: evil, topics: [evil], lastHeading: evil, detail: [{ heading: evil, bullets: [evil] }] },
    activity: { state: "error", since: 1, error: evil, tools: [evil], toolDetail: evil }, workers: [worker] })], evil);
  ui.handleInput(right);
  const bad = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
  // truncateToWidth appends its own trusted SGR reset; nothing else may survive.
  const check = () => {
    for (const width of [60, 120, 160]) {
      const out = ui.render(width);
      // Input owns a trusted cursor marker and reverse-video cursor.
      for (const line of out) assert.doesNotMatch(line.replace(CURSOR_MARKER, "").replace(/\x1b\[(?:0|7|27)m/g, ""), bad, line);
    }
  };
  check();
  ui.handleInput(down);
  ui.handleInput("\r");
  check();
  ui.handleInput("\t");
  check();
  ui.setQuery(evil);
  check();
});

test("focus propagates to Input, invalidate uses current theme, refresh on changes", () => {
  let color = "\x1b[31m";
  const themed = { fg: (_: string, s: string) => `${color}${s}\x1b[0m`, bg: (_: string, s: string) => s } as Theme;
  const { ui, refreshes } = setup(20, themed);
  ui.update([view("a")], "connected");
  ui.focused = true;
  assert.equal(ui.focused, true);
  assert.ok(ui.render(100).join("").includes(CURSOR_MARKER));
  ui.focused = false;
  assert.ok(!ui.render(100).join("").includes(CURSOR_MARKER));
  color = "\x1b[32m";
  ui.invalidate();
  assert.ok(ui.render(100)[0].includes(color));
  assert.ok(!ui.render(100)[0].includes("\x1b[31m"));
  ui.handleInput("\t");
  assert.equal(refreshes(), 2);
});

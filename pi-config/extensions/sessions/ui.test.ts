import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { SessionsOverlay, type SessionRow } from "./ui.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id, name: id, cwd: `/work/${id}`, model: "model", status: "idle", since: 0,
  self: false, unseen: false, stale: false, preview: `preview-${id}`, workers: [], canFocus: true, ...extra,
});
const up = "\x1b[A", down = "\x1b[B", right = "\x1b[C", left = "\x1b[D";
function setup(height = 20, selectedTheme = theme) {
  const results: (string | undefined)[] = [];
  let refreshes = 0;
  const size = { height };
  const ui = new SessionsOverlay(selectedTheme, () => refreshes++, () => size.height, id => results.push(id));
  return { ui, results, size, refreshes: () => refreshes, text: () => ui.render(200).join("\n") };
}
const selectedLine = (ui: SessionsOverlay) => ui.render(200).find(line => line.startsWith(">"));
const labels = (ui: SessionsOverlay) => ui.render(200).filter(line => /^[ >]  /.test(line));

test("collapsed parents show live running/total worker counts", () => {
  const { ui, text } = setup();
  const workers = [
    { id: "1", name: "child-one", status: "running" },
    { id: "2", name: "child-two", status: "finished" },
    { id: "3", name: "child-three", status: "running" },
  ];
  ui.update([row("parent", { workers })], "connected");
  assert.match(selectedLine(ui)!, /▸ parent \[2\/3 workers running\]/);
  assert.doesNotMatch(text(), /child-one/);
  ui.update([row("parent", { workers: workers.map(worker => ({ ...worker, status: "finished" })) })], "connected");
  assert.match(selectedLine(ui)!, /0\/3 workers running/);
});

test("Ctrl+C closes once with default bindings", () => {
  const { ui, results } = setup();
  ui.handleInput("\x03");
  ui.handleInput("\x03");
  assert.deepEqual(results, [undefined]);
});

test("injected selection keys replace defaults and appear in hints", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+q",
    "tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p",
  });
  const results: (string | undefined)[] = [];
  const done = (id: string | undefined): void => { results.push(id); };
  const ui = new SessionsOverlay(theme, () => {}, () => 20, done, keys);
  ui.update([row("a"), row("b")], "connected");
  ui.handleInput(down);
  assert.match(selectedLine(ui)!, / a /);
  ui.handleInput("\x0e");
  assert.match(selectedLine(ui)!, / b /);
  ui.handleInput("\x10");
  assert.match(selectedLine(ui)!, / a /);
  ui.handleInput("\r");
  ui.handleInput("\x1b");
  assert.deepEqual(results, []);
  assert.match(ui.render(200).join("\n"), /ctrl\+y focus · ctrl\+q close/);
  ui.handleInput("\x19");
  assert.deepEqual(results, ["a"]);
  const cancel = new SessionsOverlay(theme, () => {}, () => 20, done, keys);
  cancel.handleInput("\x11");
  assert.deepEqual(results, ["a", undefined]);
});

test("snapshot order, selection and append order are stable", () => {
  const { ui, results } = setup();
  ui.update([row("alpha"), row("beta")], "connected");
  ui.handleInput(down);
  ui.update([row("gamma"), row("beta", { status: "finished" }), row("alpha")], "connected");
  assert.match(selectedLine(ui)!, /beta/);
  assert.deepEqual(labels(ui).map(line => /alpha|beta|gamma/.exec(line)?.[0]), ["alpha", "beta", "gamma"]);
  ui.handleInput("\r");
  assert.deepEqual(results, ["beta"]);
});

test("fuzzy name and cwd searches; live renames don't re-rank existing matches", () => {
  const { ui } = setup();
  ui.update([row("a", { name: "alphabet" }), row("b", { name: "abt" }), row("c", { cwd: "/project/unique" })], "connected");
  ui.handleInput("abt");
  const before = labels(ui).map(line => line.includes("alphabet") ? "a" : "b");
  assert.equal(before.length, 2);
  ui.update([row("b", { name: "alphabet" }), row("a", { name: "abt" }), row("c")], "connected");
  assert.deepEqual(labels(ui).map(line => line.includes("alphabet") ? "b" : "a"), before);
  ui.handleInput("\x15"); // Input's Ctrl+U clears the query.
  ui.update([row("a"), row("b"), row("c", { cwd: "/project/unique" })], "connected");
  ui.handleInput("prjunq");
  assert.equal(labels(ui).length, 1);
  assert.match(selectedLine(ui)!, /\/project\/unique/);
});

test("worker expansion, selection, stable order, preview-only Enter, collapse", () => {
  const { ui, results, text } = setup();
  const workers = [
    { id: "w1", name: "worker-one", status: "running", model: "small", preview: "worker output\nsecond line" },
    { id: "w2", name: "worker-two", status: "finished" },
  ];
  ui.update([row("parent", { workers })], "connected");
  assert.doesNotMatch(text(), /worker-one/);
  ui.handleInput(right);
  ui.handleInput(down);
  ui.update([row("parent", { workers: [...workers].reverse() })], "connected");
  assert.match(selectedLine(ui)!, /worker-one/);
  ui.handleInput("\r");
  assert.deepEqual(results, []);
  assert.match(text(), /worker output\nsecond line/);
  ui.handleInput(down);
  assert.match(selectedLine(ui)!, /worker-two/);
  ui.handleInput(left);
  assert.match(selectedLine(ui)!, /parent/);
  assert.doesNotMatch(text(), /worker-two/);
  ui.handleInput("\r");
  assert.deepEqual(results, ["parent"]);
});

test("removed worker falls back to parent; removed parent selects nearby row", () => {
  const { ui } = setup();
  ui.update([row("a"), row("b", { workers: [{ id: "w", name: "worker", status: "idle" }] }), row("c")], "connected");
  ui.handleInput(down);
  ui.handleInput(right);
  ui.handleInput(down);
  ui.update([row("a"), row("b"), row("c")], "connected");
  assert.match(selectedLine(ui)!, / b /);
  ui.update([row("a"), row("c")], "connected");
  assert.match(selectedLine(ui)!, / c /);
  ui.update([], "disconnected");
  ui.handleInput(up);
  ui.handleInput("\r");
  assert.match(ui.render(80).join("\n"), /No matching sessions/);
});

test("self, stale, unseen finished and connection indicators; nonfocusable Enter", () => {
  const { ui, results, text } = setup();
  ui.update([row("a", { self: true, stale: true, unseen: true, canFocus: false })], "disconnected");
  for (const marker of ["self", "stale", "unseen finished", "disconnected", "preview only"]) assert.ok(text().includes(marker));
  ui.handleInput("\r");
  assert.deepEqual(results, []);
  ui.handleInput("\x1b");
  ui.handleInput("\x1b");
  assert.deepEqual(results, [undefined]);
});

test("Tab toggles multiline preview, bounded to seven lines including heading", () => {
  const { ui, text } = setup(30);
  ui.update([row("a", { preview: Array.from({ length: 100 }, (_, i) => `output ${i}`).join("\n") })], "connected");
  assert.doesNotMatch(text(), /output 0/);
  ui.handleInput("\t");
  assert.match(text(), /output 0\noutput 1/);
  assert.doesNotMatch(text(), /output 6/);
  ui.handleInput("\t");
  assert.doesNotMatch(text(), /output 0/);
});

test("all lines fit tiny widths and heights, Unicode and long input", () => {
  const { ui, size } = setup();
  ui.focused = true;
  ui.update([row("a", { name: "界👨‍👩‍👦".repeat(100), preview: "界".repeat(1000), workers: Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, name: "界".repeat(100), status: "busy" })) })], "connected".repeat(100));
  ui.handleInput(right);
  ui.handleInput("\t");
  for (let height = 0; height <= 15; height++) {
    size.height = height;
    for (let width = 0; width <= 40; width++) {
      const lines = ui.render(width);
      assert.ok(lines.length <= height, `height ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)}`);
    }
  }
  ui.handleInput("界".repeat(100));
  for (let width = 0; width < 15; width++) for (const line of ui.render(width)) assert.ok(visibleWidth(line) <= width);
});

test("selection scrolls into view even with many expanded workers and resize", () => {
  const { ui, size } = setup(8);
  ui.update([row("parent", { workers: Array.from({ length: 80 }, (_, i) => ({ id: `${i}`, name: `worker-${i}`, status: "running" })) })], "connected");
  ui.handleInput(right);
  for (let i = 0; i < 80; i++) ui.handleInput(down);
  assert.match(selectedLine(ui)!, /worker-79/);
  size.height = 3;
  assert.match(selectedLine(ui)!, /worker-79/);
  for (let i = 0; i < 80; i++) ui.handleInput(up);
  assert.match(selectedLine(ui)!, /parent/);
});

test("untrusted fields cannot inject terminal controls or extra label lines", () => {
  const { ui, text } = setup(30);
  const evil = "bad\x1b[2J\x1b]52;c;secret\x07\x9b31m\r\t\x00\u202e\nname";
  ui.update([row(evil, { name: evil, cwd: evil, status: evil, model: evil, preview: evil, workers: [{ id: evil, name: evil, status: evil, model: evil, preview: evil }] })], evil);
  ui.handleInput(right);
  ui.handleInput(down);
  ui.handleInput("\r");
  // Input owns a trusted reverse-video cursor, even with the identity theme.
  assert.doesNotMatch(text().replace(/\x1b\[(?:7|27)m/g, ""), /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);
  assert.ok(ui.render(200).length <= 12);
});

test("focus propagates to Input, invalidate uses current theme, refresh on changes", () => {
  let color = "\x1b[31m";
  const themed = { fg: (_: string, s: string) => `${color}${s}\x1b[0m`, bg: (_: string, s: string) => s } as Theme;
  const { ui, refreshes } = setup(20, themed);
  ui.update([row("a")], "connected");
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

test("row label appends the latest # heading only when present and fresh", () => {
  const { ui } = setup();
  ui.update([row("a"), row("b", { outline: { now: "Editing" } })], "connected");
  const plain = labels(ui);
  assert.ok(plain.every(line => !line.includes(" · # ")));
  ui.update([row("a", { outline: { lastHeading: "Auth fix" } }), row("b", { outline: { now: "Editing" } })], "connected");
  const [a, b] = labels(ui);
  assert.equal(a, `${plain[0]} · # Auth fix`);
  assert.equal(b, plain[1]);
  ui.update([row("a", { stale: true, outline: { lastHeading: "Auth fix" } })], "connected");
  assert.ok(!labels(ui)[0].includes("Auth fix"));
  // Workers never carry the heading.
  ui.update([row("a", { outline: { lastHeading: "Auth fix" }, workers: [{ id: "w", name: "worker", status: "idle" }] })], "connected");
  ui.handleInput(right);
  assert.ok(labels(ui).filter(line => line.includes("worker")).every(line => !line.includes("Auth fix")));
});

test("long # headings truncate to width and never inject controls", () => {
  const { ui } = setup();
  ui.update([row("a", { outline: { lastHeading: "界".repeat(200) + "\u202e\x1b[2Jend" } })], "connected");
  for (const width of [200, 60, 20, 5, 1]) {
    for (const line of ui.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const line = labels(ui)[0];
  assert.ok(line.includes(" · # 界"));
  // truncateToWidth appends its own trusted SGR reset; nothing else may survive.
  assert.doesNotMatch(line.replace(/\x1b\[0m/g, ""), /[\x00-\x1f\x7f-\x9f\u202e]/);
  ui.update([row("a", { outline: { lastHeading: "a\u202e\x1b[2J\x9b31m\nb" } })], "connected");
  assert.doesNotMatch(labels(ui).join("\n"), /[\x00-\x1f\x7f-\x9f\u202e]/);
});

test("the heading suffix is themed muted, the rest of the label unchanged", () => {
  const tagged = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bg: (_: string, text: string) => text } as Theme;
  const { ui } = setup(20, tagged);
  ui.update([row("a"), row("b", { outline: { lastHeading: "Auth fix" } })], "connected");
  const lines = ui.render(200);
  assert.ok(lines.some(line => line.endsWith("<muted> · # Auth fix</muted>") && line.includes("<text>")));
  assert.ok(lines.some(line => line.startsWith("<accent>>") && !line.includes("muted")));
});

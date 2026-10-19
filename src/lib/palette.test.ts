// Run: pnpm test -- src/lib/palette.test.ts
// The command palette's model (§app/command-palette): nothing acts unless chosen, the reasons a
// row can't act, the list built from the view rows, the open chat and the served list, the filter,
// and a command's form and answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, buildRequest, type CommandEntry } from "../../shared/commands-catalog";
import type { SlashCommand } from "../../shared/protocol";
import {
  answerText,
  buildRows,
  enterTarget,
  filterRows,
  formOf,
  moveActive,
  NO_ROW,
  panelStep,
  REASON,
  UNKNOWN_TEXT,
  valuesOf,
  type PaletteContext,
  type PaletteRow,
  type ViewRowInput,
} from "./palette";

const views: ViewRowInput[] = [
  { id: "overseer", label: "Open Overseer", keys: "Alt+O", disabled: null },
  { id: "sidebar", label: "Collapse Sessions Pane", keys: "Ctrl/⌘+B", disabled: "Only on a wide window." },
];
const slash = (name: string, description = ""): SlashCommand => ({ name, description, source: "extension" }) as SlashCommand;
const session = { path: "/s/a.jsonl", id: "sid-a", title: "Fix the build", terminal: false };
const composer = { commands: [slash("compact", "Compact the context"), slash("tree"), slash("compact")], off: null, hasDraft: false };
const ctx = (over: Partial<PaletteContext> = {}): PaletteContext => ({ session, composer, ...over });
const ext: CommandEntry = {
  id: "ext.tickets.create",
  label: "Create Issue",
  summary: "A ticket.",
  effect: "changes",
  params: { title: { type: "string", description: "Its title", in: "body", required: true } },
  route: { method: "POST", path: "/ext/tickets/api/commands/create" },
  sessionKey: null,
  sessionFile: "never",
  meshNeed: "full",
};
const entry = (id: string) => COMMANDS.find((c) => c.id === id)!;
const none = new Set<string>();
const rowsOf = (c: PaletteContext = ctx(), served: readonly CommandEntry[] | null = [...COMMANDS, ext]) => buildRows(views, served, c, none);

// ---- nothing acts on its own ----

test("no row is active until an arrow makes one so; Enter with none acts on nothing", () => {
  const rows = rowsOf();
  assert.equal(enterTarget(rows, NO_ROW), null);
  // a query that leaves one match still leaves it unchosen
  const lone = filterRows(rows, "open overseer");
  assert.equal(lone.length, 1);
  assert.equal(enterTarget(lone, NO_ROW), null);
  assert.equal(enterTarget([], 0), null);
  // ↓ from none is the first row, ↑ from none the last; both wrap
  assert.equal(moveActive(NO_ROW, 5, 1), 0);
  assert.equal(moveActive(NO_ROW, 5, -1), 4);
  assert.equal(moveActive(4, 5, 1), 0);
  assert.equal(moveActive(0, 5, -1), 4);
  assert.equal(moveActive(NO_ROW, 0, 1), NO_ROW);
  assert.equal(enterTarget(lone, moveActive(NO_ROW, lone.length, 1))?.key, "view:overseer");
});

test("a disabled row can be active (its reason reads) but Enter does nothing with it", () => {
  const rows = rowsOf();
  const i = rows.findIndex((r) => r.key === "view:sidebar");
  assert.ok(i >= 0);
  assert.equal(rows[i]!.disabled, "Only on a wide window.");
  assert.equal(enterTarget(rows, i), null);
});

test("a command's row is never a run: acting on it names the entry, whose panel decides", () => {
  for (const row of rowsOf()) if (row.group === "commands" || row.group === "extensions") assert.equal(row.act.kind, "command");
});

// ---- the list ----

test("the list: the view rows, then the open chat's commands once each, then the served list, extensions last", () => {
  const rows = rowsOf();
  const groups = [...new Set(rows.map((r) => r.group))];
  assert.deepEqual(groups, ["go", "chat", "commands", "extensions"]);
  assert.deepEqual(rows.filter((r) => r.group === "go").map((r) => r.label), ["Open Overseer", "Collapse Sessions Pane"]);
  assert.deepEqual(rows.filter((r) => r.group === "chat").map((r) => r.label), ["/compact", "/tree"]);
  const cmds = rows.filter((r) => r.group === "commands");
  assert.deepEqual(cmds.map((r) => r.detail), COMMANDS.map((c) => c.id)); // every core entry, in the served order
  assert.deepEqual(rows.filter((r) => r.group === "extensions").map((r) => r.key), ["cmd:ext.tickets.create"]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test("the list: no chat rows without a composer; no command rows before the served list arrives", () => {
  const rows = buildRows(views, null, ctx({ composer: null }), none);
  assert.deepEqual(rows.map((r) => r.group), ["go", "go"]);
});

test("the list: one row per id, whatever the server sent", () => {
  const rows = buildRows([], [entry("session.list"), entry("session.list")], ctx(), none);
  assert.equal(rows.filter((r) => r.key === "cmd:session.list").length, 1);
});

// ---- disabled reasons ----

const reasonOf = (rows: PaletteRow[], key: string) => rows.find((r) => r.key === key)!.disabled;

test("disabled: a command naming a session, with none open", () => {
  const rows = rowsOf(ctx({ session: null }));
  assert.equal(reasonOf(rows, "cmd:session.title.set"), REASON.noSession);
  assert.equal(reasonOf(rows, "cmd:session.get"), REASON.noSession); // by id too
  assert.equal(reasonOf(rows, "cmd:session.list"), null); // names none
  for (const c of COMMANDS) assert.equal(reasonOf(rows, `cmd:${c.id}`) === REASON.noSession, c.sessionKey !== null, c.id);
});

test("disabled: what a route refuses while a terminal has the session, exactly those", () => {
  const rows = rowsOf(ctx({ session: { ...session, terminal: true } }));
  for (const c of COMMANDS) {
    const refuses = c.sessionKey !== null && c.sessionFile === "refuses-live";
    assert.equal(reasonOf(rows, `cmd:${c.id}`) === REASON.terminal, refuses, c.id);
  }
  assert.equal(reasonOf(rows, "cmd:session.archive"), REASON.terminal);
  assert.equal(reasonOf(rows, "cmd:session.title.set"), null); // renaming never writes the file
  assert.equal(reasonOf(rowsOf(), "cmd:session.archive"), null); // not held: no reason
});

test("disabled: a required JSON param needs the command line, unless the entry has its own dialog", () => {
  const rich: CommandEntry = { ...ext, id: "ext.x.y", params: { doc: { type: "json", description: "d", in: "body", required: true } } };
  const bare = ctx({ composer: null });
  assert.equal(buildRows([], [rich], bare, none)[0]!.disabled, REASON.cli("ext.x.y"));
  assert.equal(buildRows([], [rich], bare, new Set(["ext.x.y"]))[0]!.disabled, null);
  // an optional JSON param is only left out of the form
  assert.equal(reasonOf(rowsOf(), "cmd:settings.align.set"), null);
});

test("disabled: chat rows while the composer holds a draft, or with the composer's own reason while it's off", () => {
  assert.equal(reasonOf(rowsOf(ctx({ composer: { ...composer, hasDraft: true } })), "chat:compact"), REASON.draft);
  assert.equal(reasonOf(rowsOf(ctx({ composer: { ...composer, off: "Connecting…", hasDraft: true } })), "chat:tree"), "Connecting…");
  assert.equal(reasonOf(rowsOf(), "chat:tree"), null);
});

// ---- filtering ----

test("filter: every group at once, groups kept in order, best match first within a group", () => {
  const rows = rowsOf();
  const got = filterRows(rows, "compact");
  assert.deepEqual([...new Set(got.map((r) => r.group))], ["chat", "commands"]);
  assert.equal(got.find((r) => r.group === "commands")!.key, "cmd:chat.compact");
  // by id
  assert.deepEqual(filterRows(rows, "session.title.reset").map((r) => r.key), ["cmd:session.title.reset"]);
  // a label prefix outranks a word inside a summary
  const rename = filterRows(rows, "rename");
  assert.equal(rename[0]!.key, "cmd:session.title.set");
  // groups keep their order even when a later group matches better: "Overseer Settings" starts with
  // the query, "Open Overseer" only has it as a word, and Go to still comes first
  const overseer = filterRows(rows, "overseer");
  assert.equal(overseer[0]!.key, "view:overseer");
  assert.ok(overseer.some((r) => r.key === "cmd:settings.overseer.get"));
  assert.deepEqual(filterRows(rows, "zzzz-nothing"), []);
  assert.equal(filterRows(rows, "   ").length, rows.length);
});

// ---- a command's panel ----

test("form: one field per param, a session is the open one, JSON is left out", () => {
  const f = formOf(entry("session.configure"));
  assert.deepEqual(f.fields.map((x) => [x.name, x.kind]), [["session", "session"], ["model", "text"], ["thinking", "select"], ["mode", "text"], ["minor-modes", "text"]]);
  assert.equal(f.fields.find((x) => x.name === "thinking")!.options![0], ""); // optional: can stay unset
  assert.equal(f.fields.find((x) => x.name === "minor-modes")!.hint, "Separate with commas");
  assert.deepEqual(formOf(entry("settings.align.set")).leftOut, ["style", "visuals"]);
  assert.deepEqual(formOf(entry("models.favorite")).fields.map((x) => x.kind), ["text", "checkbox"]);
});

test("values: the session by the key its route takes; lists split; numbers checked; empty optionals left out", () => {
  const set = formOf(entry("session.title.set"));
  assert.deepEqual(valuesOf(set, { title: "  New  " }, session, "path"), { values: { session: "/s/a.jsonl", title: "New" } });
  assert.deepEqual(valuesOf(formOf(entry("session.get")), {}, session, "id"), { values: { session: "sid-a" } });
  assert.deepEqual(valuesOf(set, { title: " " }, session, "path"), { error: "Fill in title." });
  assert.deepEqual(valuesOf(set, { title: "x" }, null, "path"), { error: REASON.noSession });
  const cfg = formOf(entry("session.configure"));
  assert.deepEqual(valuesOf(cfg, { "minor-modes": "spec, , vis", thinking: "" }, session, "path"), { values: { session: "/s/a.jsonl", "minor-modes": ["spec", "vis"] } });
  const assign = formOf(entry("session.group.assign"));
  assert.deepEqual(valuesOf(assign, { group: "g", index: "1.5" }, session, "path"), { error: "Give index a whole number." });
  assert.deepEqual(valuesOf(assign, { group: "g", index: "2" }, session, "path"), { values: { session: "/s/a.jsonl", group: "g", index: 2 } });
  // a required checkbox is always sent; an optional one only when checked
  const fav = formOf(entry("models.favorite"));
  assert.deepEqual(valuesOf(fav, { ref: "a/b" }, session, null), { values: { ref: "a/b", favorite: false } });
});

test("values feed the catalogue's own request builder: the same request sova run makes", () => {
  const e = entry("session.title.set");
  const got = valuesOf(formOf(e), { title: "T" }, session, e.sessionKey);
  assert.ok("values" in got);
  assert.deepEqual(buildRequest(e, got.values), { method: "POST", url: "/api/sessions/title", body: { path: "/s/a.jsonl", title: "T" } });
});

test("answer: a refusal is the route's own sentence; 202 unknown is never 'Done'; a body shows as JSON", () => {
  assert.deepEqual(answerText(409, { error: "This session is open in a terminal." }), { state: "refused", text: "This session is open in a terminal." });
  assert.deepEqual(answerText(202, { outcome: "unknown", requestId: "r" }), { state: "unknown", text: UNKNOWN_TEXT });
  assert.deepEqual(answerText(200, { ok: true }), { state: "done", text: '{\n  "ok": true\n}' });
  assert.deepEqual(answerText(204, null), { state: "done", text: "" });
  assert.deepEqual(answerText(500, ""), { state: "refused", text: "The server answered 500." });
  assert.ok(answerText(200, "x".repeat(30_000)).text.length < 20_010);
});

test("two-step: a change arms, any edit disarms, and only a press on an untouched arming runs", () => {
  let armed = false;
  const step = (ev: "press" | "edit") => {
    const s = panelStep(armed, ev, true);
    armed = s.armed;
    return s.run;
  };
  assert.equal(step("press"), false); // arms
  assert.equal(armed, true);
  assert.equal(step("edit"), false); // the values changed under the arming
  assert.equal(armed, false);
  assert.equal(step("press"), false); // arms again over the new values: nothing ran
  assert.equal(step("press"), true); // the confirm runs it
  assert.equal(armed, false);
  // a command that only reads runs on one press, and never stays armed
  assert.deepEqual(panelStep(false, "press", false), { armed: false, run: true });
});

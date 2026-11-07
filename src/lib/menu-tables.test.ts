// Run: pnpm test -- src/lib/menu-tables.test.ts
// Every Sova menu's table, as data (lib/menu-place): each place's rows in their sections and order,
// each row's reason it can't run, and its act — a catalogue command with its exact id and params, a
// local act, or a second screen. A command row builds exactly the request the page's own call made
// before it named the command; around it, the place's `via` keeps its own toasts and refreshes. And
// every menu's extension lane: what an entry is sent, and for whose things it shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequest, findCommand } from "../../shared/commands-catalog";
import { MENU_PLACES } from "../../shared/extension-offers";
import type { WorktreeQueueInfo } from "../../shared/merge-queue";
import type { SessionGroup, SessionSummary } from "../../shared/protocol";
import type { MessageActionItem } from "../components/MessageActions";
import type { CodingRow } from "./coding-worktrees";
import { GROUP_MENU } from "./group-menu";
import { ACTION_CONFIRM, COPY_PLAIN, type MessageStrip } from "./message-actions";
import { SENT_BACK_LINE } from "./merge-queue";
import { focusOnce, joinPlain, MESSAGE_MENU, menuStripOf, type PlainNode, plainReads, repliesByEntry, stripBlocks } from "./message-menu";
import { MENU_NAMES, type MenuAct, type MenuDecl, type MenuScreen } from "./menu-place";
import { notePeerProjects, notePeerSessions } from "./mesh";
import { PANE_MENU, paneEliminate, type PaneMenuWiring } from "./pane-menu";
import { renameValue, SESSION_MENU, sessionArchiveRow, type SessionMenuCtx } from "./session-menu";
import { WORKTREE_MENU, worktreeMenuOffered } from "./worktree-menu";

/** An act as the table says it: `cmd <id> <params>`, `local`, `link <href>`, or `<kind> screen`. */
const act = (a: MenuAct): string =>
  "command" in a ? `cmd ${a.command} ${JSON.stringify(a.params)}` : "screen" in a ? `${a.screen.kind} screen` : "href" in a ? `link ${a.href}` : "local";
/** A table as data: each row's section, label, reason (or "") and act, in order. */
const table = <T>(decl: MenuDecl<T>, subject: T) => decl.table(subject).flatMap((s) => s.rows.map((r) => [s.name ?? "", r.label, r.disabled || "", act(r.act)]));
const find = <T>(decl: MenuDecl<T>, subject: T, label: string) => decl.table(subject).flatMap((s) => s.rows).find((r) => r.label === label)!;
const screenOf = <T>(decl: MenuDecl<T>, subject: T, label: string) => (find(decl, subject, label).act as { screen: MenuScreen }).screen;
/** The request a command act sends: its catalogue entry's, built from the row's params. */
const request = (a: MenuAct) => {
  assert.ok("command" in a, act(a));
  const entry = findCommand(a.command);
  assert.ok(entry, `${a.command} is in the catalogue`);
  return buildRequest(entry, a.params);
};
/** Runs a command act's `via` with a stand-in for its request: what the place does around it. */
const runVia = async (a: MenuAct, answer: unknown = {}) => {
  const sent: number[] = [];
  assert.ok("command" in a);
  await a.via(async () => (sent.push(1), answer));
  return sent.length;
};

// ---- the session menu ----

const P = "/state/sessions/a.jsonl";
const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "s-1", path: P, cwd: "/w", title: "Fix the build", createdAt: "", lastActiveAt: "", model: null, origin: "web", ...over }) as SessionSummary;
const ctx = (calls: string[], detailsPath: string | null = null): SessionMenuCtx => ({
  detailsPath,
  onOpenDetails: (p) => calls.push(`details ${p}`),
  onOpenSubagents: (p) => calls.push(`subagents ${p}`),
  onRefresh: () => calls.push("refresh"),
  onArchiveChanged: (p, a) => calls.push(`archived ${p} ${a}`),
});
const sub = (s: SessionSummary, calls: string[] = []) => ({ session: s, ctx: ctx(calls), archive: sessionArchiveRow(s, {}) });

test("the session menu: its rows, reasons and acts, every command the catalogue's", () => {
  const p = JSON.stringify({ session: P });
  assert.deepEqual(table(SESSION_MENU, sub(session())), [
    ["Open", "Session Details", "", "local"],
    ["Open", "Open Subagents", "", "local"],
    ["Title", "Rename…", "", "name screen"],
    ["Title", "Use Gist as Title", "No gist yet.", `cmd session.title.set ${JSON.stringify({ session: P, title: "" })}`],
    ["Title", "Reset to Original Title", "Not renamed.", `cmd session.title.reset ${p}`],
    ["Organize", "Move to Group…", "", "rows screen"],
    ["Organize", "Archive", "", `cmd session.archive ${p}`],
    ["Organize", "Copy Path", "", "local"],
  ]);
  const renamed = sub(session({ title: "Mine", originalTitle: "Fix the build", outlineGist: "Repairs CI", archived: true }));
  assert.deepEqual(table(SESSION_MENU, renamed).slice(3, 7), [
    ["Title", "Use Gist as Title", "", `cmd session.title.set ${JSON.stringify({ session: P, title: "Repairs CI" })}`],
    ["Title", "Reset to Original Title", "", `cmd session.title.reset ${p}`],
    ["Organize", "Move to Group…", "", "rows screen"],
    ["Organize", "Unarchive", "", `cmd session.unarchive ${p}`],
  ]);
  // A chat Sova names itself has no title rows; one started outside Sova has no Archive.
  assert.deepEqual(table(SESSION_MENU, sub(session({ fixedName: "project-overseer" } as Partial<SessionSummary>))).map((r) => r[1]), ["Session Details", "Open Subagents", "Move to Group…", "Archive", "Copy Path"]);
  assert.deepEqual(table(SESSION_MENU, sub(session({ origin: "external" } as Partial<SessionSummary>))).map((r) => r[1]).slice(-2), ["Move to Group…", "Copy Path"]);
  // An organization's session stays with its project: the drag's own reason.
  const org = session({ org: { id: "o-1", name: "Acme", project: "p-1" } } as unknown as Partial<SessionSummary>);
  assert.match(find(SESSION_MENU, sub(org), "Move to Group…").disabled!, /\S/);
  // Session Details names the pane it would close; Busy archives say why first.
  assert.equal(SESSION_MENU.table({ ...sub(session()), ctx: ctx([], P) })[0]!.rows[0]!.label, "Close Session Details");
  assert.match(find(SESSION_MENU, { ...sub(session()), archive: sessionArchiveRow(session(), { [P]: true }) }, "Archive").disabled!, /^Can't archive: /);
});

test("the session menu's commands send the request the page's own calls sent", () => {
  const s = sub(session({ title: "Mine", originalTitle: "Fix the build", outlineGist: "Repairs CI" }));
  assert.deepEqual(request(find(SESSION_MENU, s, "Use Gist as Title").act), { method: "POST", url: "/api/sessions/title", body: { path: P, title: "Repairs CI" } });
  assert.deepEqual(request(find(SESSION_MENU, s, "Reset to Original Title").act), { method: "POST", url: "/api/sessions/title", body: { path: P, title: null } });
  assert.deepEqual(request(find(SESSION_MENU, s, "Archive").act), { method: "POST", url: "/api/sessions/archive", body: { path: P, archived: true } });
  const groups = screenOf(SESSION_MENU, s, "Move to Group…");
  assert.equal(groups.kind, "rows");
  const none = groups.kind === "rows" ? groups.sections[0]!.rows[0]! : null;
  assert.deepEqual([none!.label, none!.aria], ["No group", "Take “Mine” out of its group"]);
  assert.deepEqual(request(none!.act), { method: "POST", url: "/api/session-groups/assign", body: { path: P, groupId: null } });
});

test("the session menu's acts keep their follow-ups: a write, then the refresh or the app told", async () => {
  const calls: string[] = [];
  const s = sub(session({ title: "Mine", originalTitle: "Fix the build", outlineGist: "Repairs CI" }), calls);
  assert.equal(await runVia(find(SESSION_MENU, s, "Use Gist as Title").act), 1);
  assert.equal(await runVia(find(SESSION_MENU, s, "Archive").act), 1);
  assert.deepEqual(calls, ["refresh", `archived ${P} true`]);
  // The current group is no move: nothing is sent.
  const groups = screenOf(SESSION_MENU, s, "Move to Group…");
  assert.equal(groups.kind === "rows" && (await runVia(groups.sections[0]!.rows[0]!.act)), 0);
});

test("the session's name box: empty restores, the title it opened with is a cancel, a new one is set", () => {
  const box = screenOf(SESSION_MENU, sub(session({ title: "Mine", originalTitle: "Fix the build" })), "Rename…");
  assert.ok(box.kind === "name" && !box.leaveSaves, "a click outside saves nothing");
  assert.deepEqual([box.label, box.initial, box.placeholder, box.hint], ["Rename “Mine”", "Mine", "Session title", "Kept in Sova only. Empty restores “Fix the build”."]);
  assert.equal(box.save("Mine", "Mine"), null);
  assert.equal(box.save("Old", "Old"), null, "the title moved under the box: still a cancel");
  assert.equal(act(box.save("  ", "Mine")!), `cmd session.title.reset ${JSON.stringify({ session: P })}`);
  assert.equal(act(box.save(" New ", "Mine")!), `cmd session.title.set ${JSON.stringify({ session: P, title: "New" })}`);
  assert.deepEqual([renameValue("A", null), renameValue("A", " A "), renameValue("A", "B ")], [null, undefined, "B"]);
});

// ---- the group menu ----

const group = (over: Partial<SessionGroup> = {}) => ({ id: "g-1", name: "Work", ...over }) as SessionGroup;

test("the group menu: bare rows, Rename… saves on leaving, Delete group… asks, both name commands", async () => {
  let changed = 0;
  const g = { group: group(), count: 2, onChanged: () => changed++ };
  assert.deepEqual(table(GROUP_MENU, g), [
    ["", "Open workspace", "", "link #/g/g-1"],
    ["", "Rename…", "", "name screen"],
    ["", "Delete group…", "", "confirm screen"],
  ]);
  assert.match(find(GROUP_MENU, { ...g, count: 0 }, "Open workspace").disabled!, /\S/);
  const box = screenOf(GROUP_MENU, g, "Rename…");
  assert.ok(box.kind === "name" && box.leaveSaves);
  assert.deepEqual([box.save("  ", "Work"), box.save("Work", "Work")], [null, null], "empty, or the name it has: nothing to write");
  assert.deepEqual(request(box.save(" Home ", "Work")!), { method: "PATCH", url: "/api/session-groups/g-1", body: { name: "Home" } });
  const ask = screenOf(GROUP_MENU, g, "Delete group…");
  assert.ok(ask.kind === "confirm");
  assert.deepEqual([ask.note, ask.confirm], ["Delete “Work”? Its 2 sessions stay in the list.", "Delete group"]);
  assert.equal(screenOf(GROUP_MENU, { ...g, count: 0 }, "Delete group…").kind === "confirm" && (screenOf(GROUP_MENU, { ...g, count: 0 }, "Delete group…") as { note: string }).note, "Delete “Work”? Nothing is in it.");
  assert.deepEqual(request(ask.act), { method: "DELETE", url: "/api/session-groups/g-1" });
  assert.equal(await runVia(ask.act), 1);
  assert.equal(changed, 1, "the list is told: its rows carry a group that is gone");
});

// ---- the pane menu ----

const paneWiring = (calls: string[], over: Partial<PaneMenuWiring> = {}): PaneMenuWiring => ({
  nameOf: () => "Tests",
  groupName: () => "Work",
  split: () => true,
  panes: () => ["/a", P, "/c"],
  labelOf: () => "Tests",
  running: () => false,
  href: (p) => `#/s${p}`,
  resize: (p, d) => calls.push(`resize ${d}`),
  move: (p, d) => calls.push(`move ${d}`),
  focusPane: () => calls.push("focus"),
  rename: (p, l) => calls.push(`rename ${l}`),
  detach: (p, archive, send) => calls.push(`detach ${archive} ${!!send}`),
  promote: (p, send) => calls.push(`promote ${!!send}`),
  ...over,
});

test("the pane menu: three groups, membership by command, width, order and Eliminate local", () => {
  const calls: string[] = [];
  const out = `cmd session.group.assign ${JSON.stringify({ session: P, group: null })}`;
  const pane = { path: P, summary: session(), w: paneWiring(calls) };
  assert.deepEqual(table(PANE_MENU, pane), [
    ["This member", "Rename…", "", "name screen"],
    ["This pane", "Open", "", "local"],
    ["This pane", "Wider", "", "local"],
    ["This pane", "Narrower", "", "local"],
    ["This pane", "Move Left", "", "local"],
    ["This pane", "Move Right", "", "local"],
    ["This pane", "Focus", "", "local"],
    ["This session's membership", "Promote", "", out],
    ["This session's membership", "Remove From Group", "", out],
    ["This session's membership", "Eliminate", "", "local"],
  ]);
  assert.deepEqual(request(find(PANE_MENU, pane, "Promote").act), { method: "POST", url: "/api/session-groups/assign", body: { path: P, groupId: null } });
  // Stacked: no width or order; first and last say why; not started in Sova: no Eliminate; mid-turn: why not.
  const rows = (w: Partial<PaneMenuWiring>, s = session()) => table(PANE_MENU, { path: P, summary: s, w: paneWiring([], w) });
  assert.deepEqual(rows({ split: () => false }).map((r) => r[1]).slice(1, 3), ["Open", "Focus"]);
  assert.equal(rows({ panes: () => [P, "/c"] })[4]![2], "It's already first.");
  assert.equal(rows({ panes: () => ["/a", P] })[5]![2], "It's already last.");
  assert.equal(rows({}, session({ origin: "external" } as Partial<SessionSummary>)).at(-1)![1], "Remove From Group");
  assert.equal(rows({ running: () => true }).at(-1)![2], "It's mid-turn. Stop it or wait, then eliminate it.");
  assert.deepEqual([paneEliminate(session({ live: true } as unknown as Partial<SessionSummary>), false), paneEliminate(session(), false)], ["This session is open in a terminal.", ""]);
  // Each row runs the workspace's own gesture on this pane; membership rows hand it the command's request.
  for (const label of ["Wider", "Narrower", "Move Left", "Move Right", "Focus", "Eliminate"]) {
    const a = find(PANE_MENU, pane, label).act;
    if ("local" in a) a.local();
  }
  for (const label of ["Promote", "Remove From Group"]) void runVia(find(PANE_MENU, pane, label).act);
  assert.deepEqual(calls, ["resize 1", "resize -1", "move -1", "move 1", "focus", "detach true false", "promote true", "detach false true"]);
  // The name box: starts from the label, empty clears it, and keeps focus where the pane puts it.
  const box = screenOf(PANE_MENU, pane, "Rename…");
  assert.ok(box.kind === "name" && !box.leaveSaves);
  assert.deepEqual([box.label, box.initial, box.placeholder, box.max], ["Name Tests", "Tests", "Tests", 40]);
  const clear = box.save("  ", "Tests")!;
  assert.ok("local" in clear && clear.keepFocus);
  clear.local();
  assert.equal(calls.at(-1), "rename null");
});

// ---- the worktree menu ----

const coding = (over: Partial<CodingRow> = {}) => ({ sessionId: "c-1", branch: "sova/x", target: "master", worktree: "/wt/x", head: "abcdef1234", ...over }) as CodingRow;
const facts = (over: Record<string, unknown> = {}) => ({ project: "p-1", row: coding(), title: "Fix it", gestures: { merge: "" as const, remove: "" as const }, queued: false, queue: undefined, working: false, ...over });
const wt = (f = facts(), calls: string[] = []) => ({ facts: f, acts: { merge: () => calls.push("merge"), land: () => calls.push("land"), remove: () => calls.push("remove") } });

test("the worktree menu: Merge Branch or Land by command, Remove Worktree… asks under the row", () => {
  assert.deepEqual(table(WORKTREE_MENU, wt()), [
    ["", "Merge Branch", "", `cmd project.worktree.merge ${JSON.stringify({ pid: "p-1", "session-id": "c-1" })}`],
    ["", "Remove Worktree…", "", "local"],
  ]);
  assert.deepEqual(request(find(WORKTREE_MENU, wt(), "Merge Branch").act), { method: "POST", url: "/api/projects/p-1/overseer/worktrees/merge", body: { sessionId: "c-1" } });
  const land = `cmd project.verb.merge.add ${JSON.stringify({ checkout: "/wt/x", commit: "abcdef1234" })}`;
  assert.deepEqual(table(WORKTREE_MENU, wt(facts({ queued: true }))), [["", "Land", "", land], ["", "Remove Worktree…", "", "local"]]);
  assert.deepEqual(request(find(WORKTREE_MENU, wt(facts({ queued: true })), "Land").act), { method: "POST", url: "/api/project-services/merge.add", body: { checkout: "/wt/x", commit: "abcdef1234" } });
  // A sent-back entry: Land alone, with the queue's reason, as the row's ⋯ draws it; its fix redrafted, Land runs.
  for (const state of ["needs-fix", "with-chat"]) {
    const sentBack = { state, commit: "abcdef1234" } as WorktreeQueueInfo;
    assert.deepEqual(table(WORKTREE_MENU, wt(facts({ queued: true, queue: sentBack }))), [["", "Land", SENT_BACK_LINE, land], ["", "Remove Worktree…", "", "local"]], state);
  }
  assert.equal(table(WORKTREE_MENU, wt(facts({ queued: true, queue: { state: "needs-fix", commit: "abcdef1234", redrafted: true } as WorktreeQueueInfo })))[0]![2], "");
  // Reasons before the press; none offered: no menu at all.
  assert.deepEqual(table(WORKTREE_MENU, wt(facts({ working: true }))).map((r) => r[2]), ["Working", "Working"]);
  assert.equal(table(WORKTREE_MENU, wt(facts({ queued: true, row: coding({ worktree: undefined }) })))[0]![2], "Its folder is gone: land it from its chat.");
  assert.deepEqual(table(WORKTREE_MENU, wt(facts({ gestures: { merge: false, remove: "" } }))).map((r) => r[1]), ["Remove Worktree…"]);
  assert.equal(worktreeMenuOffered({ merge: false, remove: false }), false);
});

// ---- the message menu ----

const mine: MessageStrip = { index: 1, entryId: "u1", role: "user", text: "q" };
const reply: MessageStrip = { index: 3, entryId: "e1", role: "assistant", text: "hi" };
const item = (kind: MessageActionItem["kind"], reason: string | null = null): MessageActionItem => ({ kind, reason, run() {} });

const msg = (strip: MessageStrip, items: MessageActionItem[], session: string | null = null) => ({ strip, items, copyPlain() {}, session });

test("the message menu: the strip's items in order, Copy as Plain Text after Copy, Rewind… and Regenerate… ask, nothing a command", () => {
  assert.deepEqual(table(MESSAGE_MENU, msg(reply, [item("copy"), item("share"), item("regenerate"), item("fork")])), [
    ["Copy and share", "Copy", "", "local"],
    ["Copy and share", COPY_PLAIN.label, "", "local"],
    ["Copy and share", "Share From Here", "", "local"],
    ["Branch", "Regenerate…", "", "confirm screen"],
    ["Branch", "Fork From Here", "", "local"],
  ]);
  const yours = msg(mine, [item("share", "Wait a moment."), item("rewind", "Stop the current turn first."), item("remove")]);
  assert.deepEqual(table(MESSAGE_MENU, yours), [["Copy and share", "Share From Here", "Wait a moment.", "local"], ["Branch", "Rewind…", "Stop the current turn first.", "confirm screen"]]);
  assert.equal(MESSAGE_MENU.label(yours), "Actions for your message");
  // The confirm is the strip's own, and runs the strip's own act; Copy as Plain Text is off exactly when Copy is.
  const ask = screenOf(MESSAGE_MENU, msg(mine, [item("rewind")]), "Rewind…");
  assert.ok(ask.kind === "confirm" && "local" in ask.act);
  assert.deepEqual([ask.note, ask.confirm], [ACTION_CONFIRM.rewind!.note, ACTION_CONFIRM.rewind!.label]);
  assert.deepEqual(table(MESSAGE_MENU, msg(reply, [item("copy", "Nothing to copy.")])).map((r) => r[2]), ["Nothing to copy.", "Nothing to copy."]);
});

test("a reply's menu opens from any of its text blocks; Copy as Plain Text reads the message's own rows", () => {
  const replies = repliesByEntry([mine, reply]);
  const row = (kind: string, id: string) => ({ kind, id }) as never;
  assert.equal(menuStripOf(row("assistant-text", "e1:2"), undefined, replies), reply);
  assert.equal(menuStripOf(row("tool-call", "e1:1"), undefined, replies), undefined);
  assert.equal(menuStripOf(row("user", "u1"), mine, replies), mine);
  const rows = [row("user", "u1"), row("assistant-text", "e1:0"), row("tool-call", "e1:1"), row("assistant-text", "e1:2")].map((r: { kind: string; id: string }) => ({ ...r, text: r.id }));
  assert.deepEqual(stripBlocks(rows as never, reply).map((b) => [b.id, b.markdown]), [["e1:0", true], ["e1:2", true]]);
  assert.deepEqual(stripBlocks(rows as never, mine).map((b) => [b.id, b.markdown]), [["u1", false]]);
});

test("after a pointer-opened menu, focus can land on the message row, never a Tab stop, until it leaves for anything but the menu", () => {
  const attrs = new Map<string, string>();
  let blur: ((e: { relatedTarget: unknown }) => void) | null = null;
  const el = {
    hasAttribute: (n: string) => attrs.has(n),
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    removeAttribute: (n: string) => void attrs.delete(n),
    addEventListener: (_: "blur", fn: typeof blur) => void (blur = fn),
    removeEventListener: () => void (blur = null),
  };
  focusOnce(el, (to) => to === "menu");
  assert.equal(attrs.get("tabindex"), "-1");
  blur!({ relatedTarget: "menu" });
  assert.equal(attrs.get("tabindex"), "-1", "into the menu: kept");
  blur!({ relatedTarget: null });
  assert.equal(attrs.has("tabindex"), false);
});

test("Copy as Plain Text reads a body's blocks one by one, working notes' too, and joins them by a blank line", () => {
  type Node = PlainNode & { name: string; innerText: string; children: Node[] };
  const el = (name: string, innerText: string, children: Node[] = [], cls = ""): Node => ({ name, innerText, children, classList: { contains: (c) => cls.split(" ").includes(c) } });
  const list = el("ul", "• one\n• two");
  const code = el("div.md-code", "x = 1");
  const notes = el("details.md-working-notes", "Working notes\nstep\nrun it", [el("summary", "Working notes"), el("div.disclosure-body", "", [el("div.message-body", "", [el("ul", "• step"), el("pre", "run it")], "message-body md")])], "disclosure md-working-notes");
  const body = el("div.message-body", "• one\n• two\nx = 1", [list, code, el("p", "  ")], "message-body md");
  const yours = el("div.message-body", "just words", [], "message-body message-text");
  assert.deepEqual([body, notes, yours].flatMap(plainReads).map((n) => n.name), ["ul", "div.md-code", "p", "summary", "ul", "pre", "div.message-body"]);
  assert.equal(joinPlain([body, notes].flatMap(plainReads).map((n) => n.innerText)), "• one\n• two\n\nx = 1\n\nWorking notes\n\n• step\n\nrun it");
});

// ---- what extensions add, in every menu ----

const FAR = "/far/sessions/b.jsonl";
notePeerSessions("far", [FAR]);
notePeerProjects("far", ["p-far"]);
/** A menu's extension lane for one subject: its place, the payload an entry is sent (null: none show), and how its rows name the subject. */
const lane = <T>(decl: MenuDecl<T>, subject: T) => [decl.extensions!.place, decl.extensions!.payload(subject), decl.extensions!.name(subject)];

test("every menu takes extension entries: each sends what it is about, for this computer's things only, a group's always", () => {
  const far = session({ id: "s-far", path: FAR });
  assert.deepEqual(
    [
      lane(SESSION_MENU, sub(session())),
      lane(SESSION_MENU, sub(far)),
      lane(GROUP_MENU, { group: group(), count: 2, onChanged() {} }),
      lane(PANE_MENU, { path: P, summary: session(), w: paneWiring([]) }),
      lane(PANE_MENU, { path: FAR, summary: far, w: paneWiring([]) }),
      lane(MESSAGE_MENU, msg(reply, [], "s-1")),
      lane(MESSAGE_MENU, msg(mine, [], "s-1")),
      lane(MESSAGE_MENU, msg(reply, [], null)),
      lane(WORKTREE_MENU, wt()),
      lane(WORKTREE_MENU, wt(facts({ project: "p-far" }))),
      lane(WORKTREE_MENU, wt(facts({ row: coding({ branch: null }) }))),
    ],
    [
      ["session", { session: "s-1" }, "“Fix the build”"],
      ["session", null, "“Fix the build”"],
      // A group is this computer's own: its id only, whatever computers its sessions are on.
      ["group", { group: "g-1" }, "“Work”"],
      ["pane", { session: "s-1" }, "“Tests”"],
      ["pane", null, "“Tests”"],
      ["message", { session: "s-1", entry: "e1" }, "this reply"],
      ["message", { session: "s-1", entry: "u1" }, "your message"],
      // Another host's chat, or one whose session id isn't known yet (the reply place's menuSession).
      ["message", null, "this reply"],
      ["worktree", { project: "p-1", branch: "sova/x", session: "c-1" }, "“Fix it”"],
      ["worktree", null, "“Fix it”"],
      ["worktree", null, "“Fix it”"],
    ],
  );
  // One declaration per menu place, in the list's order.
  assert.deepEqual([SESSION_MENU, GROUP_MENU, PANE_MENU, MESSAGE_MENU, WORKTREE_MENU].map((d) => d.extensions!.place), [...MENU_PLACES]);
});

test("the reserved names are exactly every label Sova's own rows show in the five menus", () => {
  const labels = <T>(decl: MenuDecl<T>, subject: T) => decl.table(subject).flatMap((s) => s.rows.map((r) => r.label));
  const sentBack = { state: "needs-fix", commit: "abcdef1234" } as WorktreeQueueInfo;
  const drawn = new Set([
    ...labels(SESSION_MENU, sub(session())),
    ...labels(SESSION_MENU, { ...sub(session({ archived: true })), ctx: ctx([], P) }),
    ...labels(GROUP_MENU, { group: group(), count: 2, onChanged() {} }),
    ...labels(PANE_MENU, { path: P, summary: session(), w: paneWiring([]) }),
    ...labels(MESSAGE_MENU, msg(reply, [item("copy"), item("share"), item("regenerate"), item("fork")])),
    ...labels(MESSAGE_MENU, msg(mine, [item("share"), item("rewind")])),
    ...labels(WORKTREE_MENU, wt()),
    ...labels(WORKTREE_MENU, wt(facts({ queued: true, queue: sentBack }))),
    ...labels(WORKTREE_MENU, wt(facts({ queued: true, queue: sentBack, row: coding({ head: "fffffff999" }) }))),
  ]);
  // Open Session stays reserved, though no menu draws it now (the row's title link opens the session).
  assert.deepEqual([...drawn].sort(), MENU_NAMES.filter((n) => n !== "Open Session").sort());
  assert.equal(new Set(MENU_NAMES).size, MENU_NAMES.length);
});

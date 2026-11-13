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
import type { CodingRow } from "./coding-worktrees";
import { GROUP_MENU } from "./group-menu";
import { SENT_BACK_LINE } from "./merge-queue";
import { MENU_NAMES, type MenuAct, type MenuDecl, type MenuScreen } from "./menu-place";
import { notePeerProjects, notePeerSessions } from "./mesh";
import { PANE_MENU, type PaneMenuWiring } from "./pane-menu";
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
  onRefresh: () => calls.push("refresh"),
  onArchiveChanged: (p, a) => calls.push(`archived ${p} ${a}`),
});
const sub = (s: SessionSummary, calls: string[] = []) => ({ session: s, ctx: ctx(calls), archive: sessionArchiveRow(s, {}) });

test("the session menu: its rows, reasons and acts, every command the catalogue's", () => {
  const p = JSON.stringify({ session: P });
  assert.deepEqual(table(SESSION_MENU, sub(session())), [
    ["Open", "Session Details", "", "local"],
    ["Title", "Rename…", "", "name screen"],
    ["Title", "Use Gist as Title", "No gist yet.", `cmd session.title.set ${JSON.stringify({ session: P, title: "" })}`],
    ["Title", "Reset to Original Title", "Not renamed.", `cmd session.title.reset ${p}`],
    ["Organize", "Move to Group…", "", "rows screen"],
    ["Organize", "Archive", "", `cmd session.archive ${p}`],
    ["Organize", "Copy Path", "", "local"],
  ]);
  const renamed = sub(session({ title: "Mine", originalTitle: "Fix the build", outlineGist: "Repairs CI", archived: true }));
  assert.deepEqual(table(SESSION_MENU, renamed).slice(2, 6), [
    ["Title", "Use Gist as Title", "", `cmd session.title.set ${JSON.stringify({ session: P, title: "Repairs CI" })}`],
    ["Title", "Reset to Original Title", "", `cmd session.title.reset ${p}`],
    ["Organize", "Move to Group…", "", "rows screen"],
    ["Organize", "Unarchive", "", `cmd session.unarchive ${p}`],
  ]);
  // A chat Sova names itself has no title rows; one started outside Sova has no Archive.
  assert.deepEqual(table(SESSION_MENU, sub(session({ fixedName: "project-overseer" } as Partial<SessionSummary>))).map((r) => r[1]), ["Session Details", "Move to Group…", "Archive", "Copy Path"]);
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

test("the session's name box: leaving saves a typed title, empty leaving cancels, and unchanged never writes", () => {
  const box = screenOf(SESSION_MENU, sub(session({ title: "Mine", originalTitle: "Fix the build" })), "Rename…");
  assert.ok(box.kind === "name" && box.leaveSaves, "a click outside saves a typed title");
  assert.deepEqual([box.label, box.initial, box.placeholder, box.hint], ["Rename “Mine”", "Mine", "Session title", "Kept in Sova only. Empty restores “Fix the build”."]);
  assert.equal(box.save("Mine", "Mine", "enter"), null);
  assert.equal(box.save("Old", "Old", "leave"), null, "the title moved under the box: still a cancel");
  assert.equal(box.save("  ", "Mine", "leave"), null, "an empty box cancels on click-away, as the old board field did");
  assert.equal(act(box.save("  ", "Mine", "enter")!), `cmd session.title.reset ${JSON.stringify({ session: P })}`);
  assert.equal(act(box.save(" New ", "Mine", "leave")!), `cmd session.title.set ${JSON.stringify({ session: P, title: "New" })}`);
  assert.deepEqual([renameValue("A", null), renameValue("A", " A "), renameValue("A", "B "), renameValue("A", " ", "leave"), renameValue(" A ", "A", "leave")], [null, undefined, "B", undefined, undefined]);
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
  assert.deepEqual([box.save("  ", "Work", "enter"), box.save("Work", "Work", "enter")], [null, null], "empty, or the name it has: nothing to write");
  assert.deepEqual(request(box.save(" Home ", "Work", "enter")!), { method: "PATCH", url: "/api/session-groups/g-1", body: { name: "Home" } });
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
  href: (p) => `#/s${p}`,
  resize: (p, d) => calls.push(`resize ${d}`),
  move: (p, d) => calls.push(`move ${d}`),
  focusPane: () => calls.push("focus"),
  rename: (p, l) => calls.push(`rename ${l}`),
  detach: (p, send) => calls.push(`detach ${!!send}`),
  promote: (p, send) => calls.push(`promote ${!!send}`),
  ...over,
});

test("the pane menu: three groups, membership by command, width and order, and no Archive", () => {
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
  ]);
  assert.deepEqual(request(find(PANE_MENU, pane, "Promote").act), { method: "POST", url: "/api/session-groups/assign", body: { path: P, groupId: null } });
  // Stacked: no width or order; first and last say why. No member state adds an Archive row.
  const rows = (w: Partial<PaneMenuWiring>, s = session()) => table(PANE_MENU, { path: P, summary: s, w: paneWiring([], w) });
  assert.deepEqual(rows({ split: () => false }).map((r) => r[1]).slice(1, 3), ["Open", "Focus"]);
  assert.equal(rows({ panes: () => [P, "/c"] })[4]![2], "It's already first.");
  assert.equal(rows({ panes: () => ["/a", P] })[5]![2], "It's already last.");
  for (const s of [session({ origin: "external" } as Partial<SessionSummary>), session({ live: { pid: 7, status: "idle" } } as Partial<SessionSummary>), session({ busy: true })])
    assert.equal(rows({}, s).some((r) => r[1] === "Archive"), false);
  // Each row runs the workspace's own gesture on this pane; membership rows hand it the command's request.
  for (const label of ["Wider", "Narrower", "Move Left", "Move Right", "Focus"]) {
    const a = find(PANE_MENU, pane, label).act;
    if ("local" in a) a.local();
  }
  for (const label of ["Promote", "Remove From Group"]) void runVia(find(PANE_MENU, pane, label).act);
  assert.deepEqual(calls, ["resize 1", "resize -1", "move -1", "move 1", "focus", "promote true", "detach true"]);
  // The name box: starts from the label, empty clears it, and keeps focus where the pane puts it.
  const box = screenOf(PANE_MENU, pane, "Rename…");
  assert.ok(box.kind === "name" && !box.leaveSaves);
  assert.deepEqual([box.label, box.initial, box.placeholder, box.max], ["Name Tests", "Tests", "Tests", 40]);
  const clear = box.save("  ", "Tests", "enter")!;
  assert.ok("local" in clear && clear.keepFocus);
  clear.local();
  assert.equal(calls.at(-1), "rename null");
});

// ---- the worktree menu ----

const coding = (over: Partial<CodingRow> = {}) => ({ sessionId: "c-1", branch: "sova/x", target: "master", worktree: "/wt/x", head: "abcdef1234", ...over }) as CodingRow;
const facts = (over: Record<string, unknown> = {}) => ({
  project: "p-1",
  row: coding(),
  title: "Fix it",
  gestures: { merge: "" as const, remove: "" as const },
  queued: false,
  queue: undefined,
  removal: { folder: "/wt/x", home: "/home/me", hold: undefined, loading: false, listing: false },
  working: false,
  ...over,
});
const wt = (f = facts(), calls: string[] = []) => ({
  facts: f,
  acts: {
    merge: () => calls.push("merge"),
    land: () => calls.push("land"),
    remove: () => calls.push("remove"),
    removeAnyway: (digest: string) => calls.push(`anyway ${digest}`),
    loadRemove: () => calls.push("load"),
    unloadRemove: () => calls.push("unload"),
    showRemoveListing: (show: boolean) => calls.push(`listing ${show}`),
  },
});

test("the worktree menu: Merge Branch or Land by command, Remove Worktree… asks in the menu", () => {
  assert.deepEqual(table(WORKTREE_MENU, wt()), [
    ["", "Merge Branch", "", `cmd project.worktree.merge ${JSON.stringify({ pid: "p-1", "session-id": "c-1" })}`],
    ["", "Remove Worktree…", "", "worktree-remove screen"],
  ]);
  assert.deepEqual(request(find(WORKTREE_MENU, wt(), "Merge Branch").act), { method: "POST", url: "/api/projects/p-1/overseer/worktrees/merge", body: { sessionId: "c-1" } });
  const land = `cmd project.verb.merge.add ${JSON.stringify({ checkout: "/wt/x", commit: "abcdef1234" })}`;
  assert.deepEqual(table(WORKTREE_MENU, wt(facts({ queued: true }))), [["", "Land", "", land], ["", "Remove Worktree…", "", "worktree-remove screen"]]);
  assert.deepEqual(request(find(WORKTREE_MENU, wt(facts({ queued: true })), "Land").act), { method: "POST", url: "/api/project-services/merge.add", body: { checkout: "/wt/x", commit: "abcdef1234" } });
  // A sent-back entry: Land alone, with the queue's reason, as the row's menu draws it; its fix redrafted, Land runs.
  for (const state of ["needs-fix", "with-chat"]) {
    const sentBack = { state, commit: "abcdef1234" } as WorktreeQueueInfo;
    assert.deepEqual(table(WORKTREE_MENU, wt(facts({ queued: true, queue: sentBack }))), [["", "Land", SENT_BACK_LINE, land], ["", "Remove Worktree…", "", "worktree-remove screen"]], state);
  }
  assert.equal(table(WORKTREE_MENU, wt(facts({ queued: true, queue: { state: "needs-fix", commit: "abcdef1234", redrafted: true } as WorktreeQueueInfo })))[0]![2], "");
  // Reasons before the press; none offered: no menu at all.
  assert.deepEqual(table(WORKTREE_MENU, wt(facts({ working: true }))).map((r) => r[2]), ["Working", "Working"]);
  assert.equal(table(WORKTREE_MENU, wt(facts({ queued: true, row: coding({ worktree: undefined }) })))[0]![2], "Its folder is gone: land it from its chat.");
  assert.deepEqual(table(WORKTREE_MENU, wt(facts({ gestures: { merge: false, remove: "" } }))).map((r) => r[1]), ["Remove Worktree…"]);
  assert.equal(worktreeMenuOffered({ merge: false, remove: false }), false);
});

test("Remove Worktree's menu screen: dry run, hard hold, exact listing, Delete and Back", async () => {
  const ordinary = screenOf(WORKTREE_MENU, wt(), "Remove Worktree…");
  assert.ok(ordinary.kind === "worktree-remove");
  assert.equal(ordinary.note, "The folder /wt/x goes away. The branch sova/x keeps its commits, and the session and its transcript stay.");
  assert.ok(ordinary.confirm && "act" in ordinary.confirm);
  assert.equal(ordinary.confirm.label, "Remove Worktree");
  assert.deepEqual(request(ordinary.confirm.act), { method: "POST", url: "/api/projects/p-1/overseer/worktrees/remove", body: { sessionId: "c-1" } });
  ordinary.load?.();
  ordinary.unload?.();
  const merged = screenOf(WORKTREE_MENU, wt(facts({ row: coding({ merged: true }) })), "Remove Worktree…");
  assert.ok(merged.kind === "worktree-remove");
  assert.equal(merged.note, "The folder /wt/x and the merged branch sova/x go away. The session and its transcript stay.");

  const hard = screenOf(WORKTREE_MENU, wt(facts({ removal: { folder: "/wt/x", home: null, hold: { reason: "Its session is working." }, loading: false, listing: false } })), "Remove Worktree…");
  assert.ok(hard.kind === "worktree-remove");
  assert.equal(hard.note, "Its session is working.");
  assert.equal(hard.confirm, undefined, "a hard hold has no destructive button");

  const data = { uncommitted: ["src/a.ts"], ignored: [], nested: [], rebuildable: ["dist/"], counts: { uncommitted: 1, ignored: 0, nested: 0, rebuildable: 1 }, digest: "digest-1" };
  const removal = { folder: "/wt/x", home: "/home/me", hold: { reason: "It holds uncommitted work.", removeAnyway: data }, loading: false, listing: false };
  const calls: string[] = [];
  const ask = screenOf(WORKTREE_MENU, wt(facts({ removal }), calls), "Remove Worktree…");
  assert.ok(ask.kind === "worktree-remove" && ask.confirm && "show" in ask.confirm);
  assert.equal(ask.confirm.label, "Remove Anyway");
  ask.confirm.show();
  const pending = screenOf(WORKTREE_MENU, wt(facts({ removal: { ...removal, loading: true } }), calls), "Remove Worktree…");
  assert.ok(pending.kind === "worktree-remove");
  assert.equal(pending.note, "The folder /wt/x goes away. The branch sova/x keeps its commits, and the session and its transcript stay.", "a retained reason is not the pending run's answer");
  assert.equal(pending.listing, undefined, "a retained exact listing is not shown while loading");
  assert.ok(pending.confirm && "act" in pending.confirm);
  assert.equal(pending.confirm.label, "Remove Worktree");
  assert.equal(pending.confirm.disabled, true, "the only removal action waits for the fresh dry run");
  const confirmed = screenOf(WORKTREE_MENU, wt(facts({ removal: { ...removal, listing: true } }), calls), "Remove Worktree…");
  assert.ok(confirmed.kind === "worktree-remove" && confirmed.listing);
  assert.deepEqual(confirmed.listing, { data, home: "/home/me" });
  assert.ok(confirmed.confirm && "act" in confirmed.confirm && "local" in confirmed.confirm.act);
  assert.equal(confirmed.confirm.label, "Delete and Remove Worktree");
  confirmed.confirm.act.local();
  confirmed.back?.();
  assert.deepEqual(calls, ["listing true", "anyway digest-1", "listing false"]);
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
      ["worktree", { project: "p-1", branch: "sova/x", session: "c-1" }, "“Fix it”"],
      ["worktree", null, "“Fix it”"],
      ["worktree", null, "“Fix it”"],
    ],
  );
  // One declaration per menu place, in the list's order.
  assert.deepEqual([SESSION_MENU, GROUP_MENU, PANE_MENU, WORKTREE_MENU].map((d) => d.extensions!.place), [...MENU_PLACES]);
});

test("the reserved names are exactly every label Sova's own rows show in the four menus", () => {
  const labels = <T>(decl: MenuDecl<T>, subject: T) => decl.table(subject).flatMap((s) => s.rows.map((r) => r.label));
  const sentBack = { state: "needs-fix", commit: "abcdef1234" } as WorktreeQueueInfo;
  const drawn = new Set([
    ...labels(SESSION_MENU, sub(session())),
    ...labels(SESSION_MENU, { ...sub(session({ archived: true })), ctx: ctx([], P) }),
    ...labels(GROUP_MENU, { group: group(), count: 2, onChanged() {} }),
    ...labels(PANE_MENU, { path: P, summary: session(), w: paneWiring([]) }),
    ...labels(WORKTREE_MENU, wt()),
    ...labels(WORKTREE_MENU, wt(facts({ queued: true, queue: sentBack }))),
    ...labels(WORKTREE_MENU, wt(facts({ queued: true, queue: sentBack, row: coding({ head: "fffffff999" }) }))),
  ]);
  // Open Session stays reserved, though no menu draws it now (the row's title link opens the session).
  assert.deepEqual([...drawn].sort(), MENU_NAMES.filter((n) => n !== "Open Session").sort());
  assert.equal(new Set(MENU_NAMES).size, MENU_NAMES.length);
});

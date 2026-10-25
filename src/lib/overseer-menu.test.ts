// Run: pnpm test -- src/lib/overseer-menu.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectSummary } from "../../shared/projects";
import type { SessionSummary } from "../../shared/protocol";
import { hasOverseerRows, overseerMenu, overseerMenuDot, overseerMenuLabel, rowEnd, rowLabel } from "./overseer-menu";

const project = (id: string, name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name,
  root: `/w/${id}`,
  origin: "folder",
  createdAt: "2026-01-01T00:00:00Z",
  space: { kind: "standalone" },
  ...extra,
});
const inOrg = (orgName: string) => ({ space: { kind: "org" as const, orgId: `o-${orgName}`, orgName } });

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/w/ws",
    title: id,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    model: null,
    live: null,
    busy: false,
    origin: "web",
    archived: false,
    ...extra,
  }) as SessionSummary;
const standaloneOverseer = (id: string, pid: string, extra: Partial<SessionSummary> = {}) =>
  session(id, { project: { projectId: pid, projectName: pid, kind: "overseer" }, ...extra });
const orgOverseer = (id: string, pid: string, extra: Partial<SessionSummary> = {}) =>
  session(id, { org: { orgId: "o", orgName: "Org", projectId: pid, projectName: pid, kind: "overseer" }, ...extra });

const idle = { selected: null, busy: () => false };
const err = { at: 1, message: "boom" } as unknown as SessionSummary["turnError"];

test("one row per project whose overseer started, by project name; unstarted, archived and foreign projects are not listed", () => {
  const projects = [
    project("p1", "Zeta"),
    project("p2", "alpha", inOrg("Mamluk Arabia")),
    project("p3", "Beta"), // no overseer yet
    project("p4", "Archived", { archived: { at: "2026-01-02T00:00:00Z" } }),
  ];
  const sessions = [
    standaloneOverseer("z", "p1"),
    orgOverseer("a", "p2"),
    standaloneOverseer("x", "p4"),
    standaloneOverseer("peer", "p-elsewhere"), // a project not on this computer's list
    session("coding", { project: { projectId: "p3", projectName: "Beta", kind: "coding" } }),
    standaloneOverseer("cleared", "p3", { project: { projectId: "p3", projectName: "Beta", kind: "overseer", finished: true } }),
    session("plain"),
  ];
  const m = overseerMenu(sessions, projects, idle);
  assert.deepEqual(
    m.rows.map((r) => [r.name, r.org, r.path]),
    [
      ["alpha", "Mamluk Arabia", "/s/a.jsonl"],
      ["Zeta", null, "/s/z.jsonl"],
    ],
  );
  assert.equal(hasOverseerRows(m), true);
});

test("no rows (and so no ▾) with no projects, no project list, or no started overseer", () => {
  assert.equal(hasOverseerRows(overseerMenu([standaloneOverseer("z", "p1")], [], idle)), false);
  assert.equal(hasOverseerRows(overseerMenu([standaloneOverseer("z", "p1")], null, idle)), false);
  assert.equal(hasOverseerRows(overseerMenu([session("plain")], [project("p1", "Zeta"), project("p2", "Beta")], idle)), false);
});

test("at most one state, in this order: Working, then Last turn failed, then the new-reply count", () => {
  const projects = [project("w", "A"), project("e", "B"), project("u", "C"), project("n", "D")];
  const sessions = [
    standaloneOverseer("w", "w", { unread: true, unreadReplies: 4, turnError: err }),
    standaloneOverseer("e", "e", { unread: true, unreadReplies: 4, turnError: err }),
    standaloneOverseer("u", "u", { unread: true, unreadReplies: 3 }),
    standaloneOverseer("n", "n"),
  ];
  const m = overseerMenu(sessions, projects, { selected: null, busy: (s) => s.id === "w" });
  assert.deepEqual(
    m.rows.map((r) => rowEnd(r)),
    [{ words: "Working" }, { words: "Last turn failed" }, { pill: "3" }, {}],
  );
  // Only an unread row carries a count.
  assert.deepEqual(m.rows.map((r) => r.replies), [null, null, 3, null]);
  // The dot and the name count new replies and failures, never Working.
  assert.deepEqual([m.unread, m.failed], [1, 1]);
  assert.equal(overseerMenuDot(m), true);
  assert.equal(overseerMenuLabel(m), "Project overseers · 1 overseer with new replies · 1 with a failed last turn");
});

test("the new-reply count: a pill and words in the row's name; New reply in words with no count or 0, never \"0\"", () => {
  const projects = [project("a", "AmalMoney", inOrg("Amal")), project("b", "B"), project("c", "C"), project("d", "D"), project("e", "E")];
  const sessions = [
    orgOverseer("a", "a", { unread: true, unreadReplies: 3 }),
    standaloneOverseer("b", "b", { unread: true, unreadReplies: 1 }),
    standaloneOverseer("c", "c", { unread: true, unreadReplies: 0 }),
    standaloneOverseer("d", "d", { unread: true }),
    standaloneOverseer("e", "e", { unread: true, unreadReplies: 250 }),
  ];
  const m = overseerMenu(sessions, projects, idle);
  assert.deepEqual(
    m.rows.map((r) => [rowEnd(r), rowLabel(r)]),
    [
      [{ pill: "3" }, "AmalMoney · in Amal · 3 new replies"],
      [{ pill: "1" }, "B · 1 new reply"],
      [{ words: "New reply" }, "C · New reply"],
      [{ words: "New reply" }, "D · New reply"],
      [{ pill: "99+" }, "E · 250 new replies"],
    ],
  );
  // Unread is decided by `unread` alone: a 0 or missing count still reads as unread, never as read.
  assert.ok(m.rows.every((r) => r.state === "unread"));
  for (const r of m.rows) assert.notEqual(rowEnd(r).pill, "0");
  assert.equal(m.unread, 5);
  // A count without `unread` labels nothing: the row is read.
  const read = overseerMenu([standaloneOverseer("a", "a", { unreadReplies: 3 })], [project("a", "A")], idle);
  assert.deepEqual([read.rows[0]!.state, read.rows[0]!.replies, rowEnd(read.rows[0]!), rowLabel(read.rows[0]!)], [null, null, {}, "A"]);
});

test("the open overseer is current and shows no failed or new-reply word; Working stays", () => {
  const projects = [project("a", "A"), project("b", "B")];
  const sessions = [standaloneOverseer("a", "a", { unread: true, unreadReplies: 2, turnError: err }), orgOverseer("b", "b")];
  const open = overseerMenu(sessions, projects, { selected: "/s/a.jsonl", busy: () => false });
  assert.deepEqual(
    open.rows.map((r) => [r.name, r.current, r.state]),
    [
      ["A", true, null],
      ["B", false, null],
    ],
  );
  assert.deepEqual([open.rows[0]!.replies, rowEnd(open.rows[0]!), rowLabel(open.rows[0]!)], [null, {}, "A"]);
  assert.equal(overseerMenuDot(open), false);
  assert.equal(overseerMenuLabel(open), "Project overseers");
  const working = overseerMenu(sessions, projects, { selected: "/s/a.jsonl", busy: (s) => s.id === "a" });
  assert.deepEqual([working.rows[0]!.current, working.rows[0]!.state], [true, "working"]);
  assert.equal(overseerMenuDot(working), false);
});

test("▾'s name says the counts in words, plural and singular, counting overseers", () => {
  assert.equal(overseerMenuLabel({ unread: 1, failed: 0 }), "Project overseers · 1 overseer with new replies");
  assert.equal(overseerMenuLabel({ unread: 2, failed: 0 }), "Project overseers · 2 overseers with new replies");
  assert.equal(overseerMenuLabel({ unread: 0, failed: 3 }), "Project overseers · 3 with failed last turns");
  assert.equal(overseerMenuDot({ unread: 0, failed: 0 }), false);
});

test("two current conversations for one project: the newest is its row", () => {
  const m = overseerMenu(
    [standaloneOverseer("old", "p1", { lastActiveAt: "2026-01-01T00:00:00Z" }), standaloneOverseer("new", "p1", { lastActiveAt: "2026-01-05T00:00:00Z" })],
    [project("p1", "Zeta")],
    idle,
  );
  assert.deepEqual(m.rows.map((r) => r.path), ["/s/new.jsonl"]);
});

test("unaffected by the search: it takes no query, and a project no query would match is still listed", () => {
  // The sidebar hands it the whole list (all()), never the search hits; the helper has no query input.
  assert.equal(overseerMenu.length, 3);
  const m = overseerMenu([standaloneOverseer("z", "p1", { title: "nothing like the query" })], [project("p1", "Zeta")], idle);
  assert.deepEqual(m.rows.map((r) => r.name), ["Zeta"]);
});

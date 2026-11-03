// Run: npx tsx --test src/lib/regions.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { archiveDateOpen, archiveOpen, canJoinGroup, foldersOpen, groupMembersOf, groupRefusal, inFolders, isMainThread, isOrdinarySession, isOrgSession, isOwnedSession, isProjectOwned, isTopSession, listedWithLocalProject, ORG_GROUP_REASON, sidebarRegion, storedFoldersOpen } from "./regions";
import { groupSections } from "./session-groups";
import { groupByCreation } from "./session-order";
import { FOLDERS_KEY } from "./storage-keys";

const live: SessionSummary["live"] = { pid: 1, status: "idle" };
const row = (over: Partial<SessionSummary>) =>
  ({ live: null, origin: "external", archived: false, ...over }) as Pick<SessionSummary, "live" | "origin" | "archived">;

test("web sessions stay on top until archived", () => {
  assert.equal(isTopSession(row({ origin: "web" })), true);
  assert.equal(isTopSession(row({ origin: "web", archived: true })), false);
});

test("live sessions stay on top, archived or not", () => {
  assert.equal(isTopSession(row({ live })), true);
  assert.equal(isTopSession(row({ live, origin: "web", archived: true })), true);
});

test("external sessions go to the archive", () => {
  assert.equal(isTopSession(row({})), false);
});

test("fields missing from older servers count as external and not archived", () => {
  assert.equal(isTopSession({ live: null } as Pick<SessionSummary, "live" | "origin" | "archived">), false);
  assert.equal(isTopSession({ live: null, origin: "web" } as Pick<SessionSummary, "live" | "origin" | "archived">), true);
});

test("a worker session is not a main thread; an unmarked one (older server) is", () => {
  assert.equal(isMainThread({}), true);
  assert.equal(isMainThread({ workerSession: undefined }), true);
  assert.equal(isMainThread({ workerSession: true }), false);
  assert.equal(isMainThread({ overseer: true }), false, "an Overseer file is never a sidebar row");
});

test("org sessions: their own region, whatever else is true; never an ordinary session", () => {
  const org = { orgId: "o", orgName: "O", kind: "gathering" } as SessionSummary["org"];
  const base = { live: null, origin: "external", archived: false } as Pick<SessionSummary, "live" | "origin" | "archived">;
  assert.equal(sidebarRegion({ ...base, org }), "org");
  assert.equal(sidebarRegion({ ...base, org, live }), "org", "org beats live");
  assert.equal(sidebarRegion({ ...base, org, origin: "web" }), "org", "org beats web");
  assert.equal(sidebarRegion({ ...base, org, archived: true }), "org", "org beats archived");
  assert.equal(sidebarRegion({ ...base, origin: "web" }), "top");
  assert.equal(sidebarRegion(base), "archive");
  assert.equal(isOrgSession({ org }), true);
  assert.equal(isOrgSession({}), false, "an older server sends none: ordinary");
  assert.equal(isOrdinarySession({ org }), false);
  assert.equal(isOrdinarySession({}), true);
  assert.equal(isOrdinarySession({ overseer: true }), false);
  assert.equal(isMainThread({ org } as Pick<SessionSummary, "workerSession" | "overseer">), true, "still a main thread: the region and the board read it");
});

test("a session only in a project's folder is ordinary: its usual region, and groupable; a build or overseer is the project's", () => {
  const folder = { projectId: "p", projectName: "P", kind: "folder" } as SessionSummary["project"];
  const coding = { projectId: "p", projectName: "P", kind: "coding" } as SessionSummary["project"];
  const base = { live: null, origin: "external", archived: false } as Pick<SessionSummary, "live" | "origin" | "archived">;
  assert.equal(isOrdinarySession({ project: folder }), true);
  assert.equal(isOrdinarySession({ project: coding }), false);
  assert.equal(isProjectOwned({ project: folder }), false, "the drag lock and the archive toasts read this: no lock");
  assert.equal(isProjectOwned({ project: coding }), true);
  assert.equal(sidebarRegion({ ...base, project: folder }), "archive");
  assert.equal(sidebarRegion({ ...base, project: folder, live }), "top");
  assert.equal(sidebarRegion({ ...base, project: folder, origin: "web" }), "top");
  assert.equal(sidebarRegion({ ...base, project: coding, live }), "projects");
  // A placed project's folder session: `folderOrg`, never `org`, so still ordinary.
  const placed: Pick<SessionSummary, "project" | "folderOrg" | "org"> = { project: folder, folderOrg: { orgId: "o", orgName: "O", projectId: "p", projectName: "P" } };
  assert.equal(isOrdinarySession(placed), true);
  assert.equal(isOrgSession(placed), false);
  // The groups read canJoinGroup: the folder session and the project's build both sit in their group.
  const rows = [{ id: "f", groupId: "g1", project: folder }, { id: "c", groupId: "g1", project: coding }] as SessionSummary[];
  const [g] = groupSections(rows.filter(canJoinGroup), [{ id: "g1", name: "G" } as never], false);
  assert.deepEqual(g!.sessions.map((x) => x.id), ["f", "c"], "the folder session and the overseer's build both sit in their group");
});

test("groups admit every main thread but an org's, and only the groups: a project's sessions stay out of Folders and keep its place", () => {
  const p = (kind: "folder" | "coding" | "overseer", operator?: true) => ({ projectId: "p", projectName: "P", kind, ...(operator ? { operator } : {}) }) as SessionSummary["project"];
  const web = { live: null, origin: "web", archived: false } as Pick<SessionSummary, "live" | "origin" | "archived">;
  const mine = { ...web, id: "mine", groupId: "g1", project: p("coding", true) } as SessionSummary;
  const theirs = { ...web, id: "theirs", groupId: "g1", project: p("coding") } as SessionSummary;
  const overseer = { ...web, id: "po", groupId: "g1", project: p("overseer") } as SessionSummary;
  const org = { ...web, id: "org", groupId: "g1", org: { orgId: "o", orgName: "O", kind: "coding" }, project: p("coding", true) } as SessionSummary;
  const plain = { ...web, id: "plain", groupId: "g1" } as SessionSummary;
  const worker = { ...web, id: "w", groupId: "g1", workerSession: true } as SessionSummary;
  // Unchanged: a project's own sessions are no ordinary sessions, so Folders, Needs you and the Archive never list them.
  for (const s of [mine, theirs, overseer]) {
    assert.equal(isOrdinarySession(s), false, s.id);
    assert.equal(isProjectOwned(s), true, s.id);
    assert.equal(inFolders(s, true), false, s.id);
    assert.equal(sidebarRegion(s), "projects", s.id);
  }
  // The groups take them: the operator's build, the overseer's own build, the overseer's conversation, a plain session.
  for (const s of [mine, theirs, overseer, plain]) {
    assert.equal(canJoinGroup(s), true, s.id);
    assert.equal(groupRefusal(s), null, s.id);
  }
  // Only an org session is refused, in its own words; a worker is no main thread, so no group draws it.
  assert.equal(canJoinGroup(org), false);
  assert.equal(groupRefusal(org), ORG_GROUP_REASON);
  assert.equal(canJoinGroup(worker), false);
  // Its group holds and counts them; the org row is kept on the server but not drawn.
  const all = [mine, theirs, overseer, org, plain, worker];
  const [g] = groupSections(all.filter(canJoinGroup), [{ id: "g1", name: "G" } as never], false);
  assert.deepEqual(g!.sessions.map((x) => x.id), ["mine", "theirs", "po", "plain"]);
  assert.equal(g!.sessions.length, 4, "the count a group shows and its drop tile says");
  assert.deepEqual(groupMembersOf(all, "g1").map((x) => x.id), g!.sessions.map((x) => x.id), "the workspace lists what the sidebar's group lists");
});

test("groupMembersOf: a group's members never include an org session or another group's rows", () => {
  const rows = [
    { id: "a", groupId: "g1" },
    { id: "org", groupId: "g1", org: { orgId: "o", orgName: "O", kind: "coding" } },
    { id: "b", groupId: "g2" },
    { id: "c", groupId: "g1", project: { projectId: "p", projectName: "P", kind: "overseer" } },
  ] as SessionSummary[];
  assert.deepEqual(groupMembersOf(rows, "g1").map((x) => x.id), ["a", "c"]);
  assert.deepEqual(groupMembersOf(rows, "g2").map((x) => x.id), ["b"]);
});

test("the group workspace and the sidebar's group read the one membership rule, groupMembersOf", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", f), "utf8");
  // The body of App's `groupMembers` memo, and the Sidebar's `rowsOf`, from their declaration to the next line at the component's own indent.
  const body = (text: string, decl: string) => {
    const at = text.indexOf(decl);
    assert.ok(at >= 0, `${decl} is declared`);
    const rest = text.slice(at + decl.length);
    return rest.slice(0, rest.search(/\n  \S/));
  };
  for (const [file, decl] of [["App.tsx", "const groupMembers = createMemo("], ["components/Sidebar.tsx", "const rowsOf = "]] as const) {
    const b = body(src(file), decl);
    assert.match(b, /groupMembersOf\(/, `${file}: ${decl} reads groupMembersOf`);
    assert.doesNotMatch(b, /\.groupId\s*===/, `${file}: ${decl} never filters by groupId alone (that lets an org session in)`);
  }
});

test("owned (no group, the selection skips it): an org row and a project's build or overseer; never a folder session", () => {
  const project = (kind: "folder" | "coding" | "overseer") => ({ projectId: "p", projectName: "P", kind }) as SessionSummary["project"];
  assert.equal(isOwnedSession({ project: project("folder") }), false);
  assert.equal(isOwnedSession({ project: project("coding") }), true);
  assert.equal(isOwnedSession({ project: project("overseer") }), true);
  assert.equal(isOwnedSession({ org: { orgId: "o", orgName: "O", kind: "gathering" } }), true);
  assert.equal(isOwnedSession({}), false);
});

test("Folders leaves out a session this computer's project lists, standalone or placed; a peer's stays", () => {
  const folder = { projectId: "p", projectName: "P", kind: "folder" } as SessionSummary["project"];
  const web = { live: null, origin: "web", archived: false } as Pick<SessionSummary, "live" | "origin" | "archived">;
  const standalone = { ...web, project: folder };
  const placed = { ...standalone, folderOrg: { orgId: "o", orgName: "O", projectId: "p", projectName: "P" } };
  // This computer's rows: the project's block is their place.
  assert.equal(inFolders(standalone, true), false, "a standalone project's folder session is its project's");
  assert.equal(inFolders(placed, true), false, "a placed project's too");
  assert.equal(inFolders({ ...standalone, origin: "external", live }, true), false, "a live terminal session in the folder too");
  // A mesh peer's row carries the peer's own project: it stays in Folders.
  assert.equal(inFolders(standalone, false), true, "a peer's session with a project stays in Folders");
  assert.equal(inFolders(placed, false), true);
  // An archived project lists nothing, and an archived session (live keeps it on top) is in no block.
  assert.equal(inFolders({ ...standalone, project: { ...folder!, archived: true } }, true), true);
  assert.equal(inFolders({ ...placed, folderOrg: { ...placed.folderOrg, projectArchived: true } }, true), true);
  assert.equal(inFolders({ ...standalone, live, archived: true }, true), true, "archived but live: no block lists it, Folders does");
  // Unchanged: no project, the top rule, the special sessions.
  assert.equal(inFolders(web, true), true);
  assert.equal(inFolders({ ...web, origin: "external" }, true), false, "an ended external session is the Archive's");
  assert.equal(inFolders({ ...web, org: { orgId: "o", orgName: "O", kind: "gathering" } }, true), false);
  assert.equal(inFolders({ ...web, project: { ...folder!, kind: "coding" } }, true), false, "a build is the project's anyway");
  // The project-folder session stays ordinary: the shortcuts and the Archive still read it.
  assert.equal(isOrdinarySession(standalone), true);
  assert.equal(listedWithLocalProject(standalone, true), true);
  assert.equal(listedWithLocalProject({ ...standalone, archived: true }, true), false);
  // The overview's live count still counts it (sidebarRegion is unchanged).
  assert.equal(sidebarRegion(standalone), "top");
});

test("Folders: open by default, a collapse kept for the tab, forced open by a search with hits in it, opened for the open session", () => {
  assert.equal(FOLDERS_KEY, "sova:top-open");
  assert.equal(storedFoldersOpen(null), true, "open by default");
  assert.equal(storedFoldersOpen("1"), true);
  assert.equal(storedFoldersOpen("0"), false, "the user collapsed it");
  const closed = { stored: false, searching: false, hits: 3, holdsSelected: false, dismissed: false };
  assert.equal(foldersOpen(closed), false);
  assert.equal(foldersOpen({ ...closed, searching: true }), true, "a search with matches in it");
  assert.equal(foldersOpen({ ...closed, searching: true, hits: 0 }), false, "a search with none here leaves it as chosen");
  assert.equal(foldersOpen({ ...closed, holdsSelected: true }), true, "moved to a session inside it: it opens for it");
  assert.equal(foldersOpen({ ...closed, holdsSelected: true, dismissed: true }), false, "collapsed on this visit: it stays shut");
  assert.equal(foldersOpen({ ...closed, holdsSelected: true, dismissed: true, searching: true }), true, "a search still opens it");
  assert.equal(foldersOpen({ ...closed, stored: true }), true);
});

test("Archive and its date sections: opened for the open session once, a collapse on that visit sticks", () => {
  const closed = { stored: false, searching: false, topEmpty: false, holdsSelected: false, dismissed: false };
  assert.equal(archiveOpen(closed), false, "collapsed by default");
  assert.equal(archiveOpen({ ...closed, searching: true }), true);
  assert.equal(archiveOpen({ ...closed, topEmpty: true }), true, "Folders empty (case 1)");
  assert.equal(archiveOpen({ ...closed, holdsSelected: true }), true, "moved to an archived session (case 2)");
  assert.equal(archiveOpen({ ...closed, holdsSelected: true, dismissed: true }), false, "collapsed on this visit: it stays shut");
  assert.equal(archiveOpen({ ...closed, stored: true, holdsSelected: true, dismissed: true }), true, "opened again by hand");
  const date = { stored: false, searching: false, holdsSelected: false, dismissed: false };
  assert.equal(archiveDateOpen(date), false);
  assert.equal(archiveDateOpen({ ...date, holdsSelected: true }), true);
  assert.equal(archiveDateOpen({ ...date, holdsSelected: true, dismissed: true }), false);
  assert.equal(archiveDateOpen({ ...date, holdsSelected: true, dismissed: true, searching: true }), true);
});

test("Folders counts folders: a folder that only held this computer's project sessions is gone, a peer's stays", () => {
  const folder = { projectId: "p", projectName: "P", kind: "folder" } as SessionSummary["project"];
  const at = "2026-01-01T00:00:00Z";
  const s = (id: string, cwd: string, extra: Partial<SessionSummary> = {}) =>
    ({ id, path: `/s/${id}.jsonl`, cwd, title: id, createdAt: at, lastActiveAt: at, live: null, origin: "web", archived: false, ...extra }) as SessionSummary;
  const rows = [
    s("a", "/w/app", { project: folder }),
    s("b", "/w/.worktrees/app-x", { project: folder }),
    s("c", "/w/other"),
    s("d", "/w/other"),
    s("peer", "/Users/me/app", { project: folder }),
  ];
  const peer = new Set(["peer"]);
  const shown = rows.filter((r) => inFolders(r, !peer.has(r.id)));
  assert.deepEqual(shown.map((r) => r.id), ["c", "d", "peer"]);
  assert.deepEqual(groupByCreation(shown).map((g) => [g.cwd, g.sessions.length]).sort(), [["/Users/me/app", 1], ["/w/other", 2]], "2 folders, each with its own session count");
});

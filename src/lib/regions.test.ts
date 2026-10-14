// Run: npx tsx --test src/lib/regions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { foldersOpen, inFolders, isMainThread, isOrdinarySession, isOrgSession, isOwnedSession, isProjectOwned, isTopSession, listedWithLocalProject, sidebarRegion, storedFoldersOpen } from "./regions";
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
  const rows = [{ id: "f", groupId: "g1", project: folder }, { id: "c", groupId: "g1", project: coding }] as SessionSummary[];
  const [g] = groupSections(rows.filter(isOrdinarySession), [{ id: "g1", name: "G" } as never], false);
  assert.deepEqual(g!.sessions.map((x) => x.id), ["f"], "the folder session sits in its group");
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

test("Folders: open by default, a collapse kept for the tab, forced open by a search with hits in it or the open session", () => {
  assert.equal(FOLDERS_KEY, "sova:top-open");
  assert.equal(storedFoldersOpen(null), true, "open by default");
  assert.equal(storedFoldersOpen("1"), true);
  assert.equal(storedFoldersOpen("0"), false, "the user collapsed it");
  const closed = { stored: false, searching: false, hits: 3, holdsSelected: false };
  assert.equal(foldersOpen(closed), false);
  assert.equal(foldersOpen({ ...closed, searching: true }), true, "a search with matches in it");
  assert.equal(foldersOpen({ ...closed, searching: true, hits: 0 }), false, "a search with none here leaves it as chosen");
  assert.equal(foldersOpen({ ...closed, holdsSelected: true }), true, "it holds the open session");
  assert.equal(foldersOpen({ ...closed, stored: true }), true);
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

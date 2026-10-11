// Run: npx tsx --test src/lib/regions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { isMainThread, isOrdinarySession, isOrgSession, isOwnedSession, isProjectOwned, isTopSession, sidebarRegion } from "./regions";
import { groupSections } from "./session-groups";

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

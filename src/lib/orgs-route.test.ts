import assert from "node:assert/strict";
import { test } from "node:test";
import { ORG_TABS, orgHref, orgsRouteFromHash, orgTabHref, personHref, startForHref } from "./orgs-route";

test("the list, one org, a start", () => {
  assert.deepEqual(orgsRouteFromHash("#/orgs"), { kind: "list" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/"), { kind: "list" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12"), { kind: "org", id: "org_ab12" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/start/p_x1"), { kind: "org", id: "org_ab12", start: "p_x1" });
});

test("one person's page; the bare People tab stays a tab", () => {
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/people/p_x1"), { kind: "person", id: "org_ab12", personId: "p_x1" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/people/p_x1/"), { kind: "person", id: "org_ab12", personId: "p_x1" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/people"), { kind: "org", id: "org_ab12", tab: "people" });
});

test("a tab: sessions, people, projects, workspace; the bare org is Sessions by default (no tab key)", () => {
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/people"), { kind: "org", id: "org_ab12", tab: "people" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/projects"), { kind: "org", id: "org_ab12", tab: "projects" }, "no project id: the tab");
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/workspace/"), { kind: "org", id: "org_ab12", tab: "workspace" });
  for (const tab of ORG_TABS)
    assert.deepEqual(orgsRouteFromHash(orgTabHref("org_x", tab)), { kind: "org", id: "org_x", tab, ...(tab === "history" ? { history: { filters: { projects: [] } } } : {}) });
  assert.deepEqual(ORG_TABS, ["sessions", "people", "projects", "history", "workspace"], "History after Projects, before Workspace");
});

test("a project inside an org is no route: projects live at #/projects/<id>", () => {
  for (const h of ["#/orgs/org_ab12/projects/prj_1", "#/orgs/org_ab12/projects/prj_1/overseer", "#/orgs/org_ab12/projects/prj_1/cost", "#/orgs/org_ab12/projects/prj_1?host=vps"])
    assert.equal(orgsRouteFromHash(h), null, h);
});

test("anything else is not this route", () => {
  for (const h of [
    "",
    "#/",
    "#/orgsx",
    "#/orgs/a b",
    "#/orgs/../x",
    "#/orgs/org_1/replay/s1",
    "#/orgs/org_1/other/x",
    "#/orgs/org_1/start/p_1/overseer",
    "#/orgs/org_1/sessions/x",
    "#/orgs/a b/people",
    "#/orgs/org_1/Workspace",
    "#/orgs/org_1/projects/a b",
    "#/orgs/org_1/projects/p/overseer/x",
    "#/orgs/org_1/people/a b",
    "#/orgs/a b/people/p_1",
    "#/orgs/org_1/people/p_1/x",
    "#/s/orgs",
  ])
    assert.equal(orgsRouteFromHash(h), null, h);
});

test("hrefs round-trip", () => {
  assert.deepEqual(orgsRouteFromHash(orgHref("org_x")), { kind: "org", id: "org_x" });
  assert.deepEqual(orgsRouteFromHash(startForHref("org_x", "p_1")), { kind: "org", id: "org_x", start: "p_1" });
  assert.deepEqual(orgsRouteFromHash(personHref("org_x", "p_1")), { kind: "person", id: "org_x", personId: "p_1" });
});

test("a remembered parent is read once, and only for the same org and person", async () => {
  const { rememberStartParent, takeStartParent } = await import("./orgs-route");
  rememberStartParent("org_1", "p_1", "s1");
  assert.equal(takeStartParent("org_1", "p_2"), undefined, "another person");
  rememberStartParent("org_1", "p_1", "s1");
  assert.equal(takeStartParent("org_1", "p_1"), "s1");
  assert.equal(takeStartParent("org_1", "p_1"), undefined, "cleared on read");
});

test("an org on a peer (§mesh.remote-sessions/org-pages): every href of it carries its host, and parses back; a local org's are unchanged", async () => {
  const { notePeerOrgs, resetHosts } = await import("./mesh");
  resetHosts();
  notePeerOrgs("vps", ["org_far"]);
  try {
    assert.equal(orgHref("org_far"), "#/orgs/org_far?host=vps");
    assert.equal(orgTabHref("org_far", "people"), "#/orgs/org_far/people?host=vps");
    assert.equal(startForHref("org_far", "p_1"), "#/orgs/org_far/start/p_1?host=vps");
    assert.equal(personHref("org_far", "p_1"), "#/orgs/org_far/people/p_1?host=vps");
    assert.deepEqual(orgsRouteFromHash(orgHref("org_far")), { kind: "org", id: "org_far", host: "vps" });
    assert.deepEqual(orgsRouteFromHash(orgTabHref("org_far", "workspace")), { kind: "org", id: "org_far", tab: "workspace", host: "vps" });
    assert.deepEqual(orgsRouteFromHash(personHref("org_far", "p_1")), { kind: "person", id: "org_far", personId: "p_1", host: "vps" });
    assert.equal(orgHref("org_here"), "#/orgs/org_here");
    assert.equal(orgsRouteFromHash("#/orgs/org_x?host="), null);
    assert.equal(orgsRouteFromHash("#/orgs?host=vps"), null);
  } finally {
    resetHosts();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ORG_TABS, orgHref, orgsRouteFromHash, orgTabHref, personHref, projectHref, projectOverseerHref, startForHref } from "./orgs-route";

test("the list, one org, a start, a project and its overseer", () => {
  assert.deepEqual(orgsRouteFromHash("#/orgs"), { kind: "list" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/"), { kind: "list" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12"), { kind: "org", id: "org_ab12" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/start/p_x1"), { kind: "org", id: "org_ab12", start: "p_x1" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/projects/prj_1"), { kind: "project", id: "org_ab12", projectId: "prj_1" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/projects/prj_1/overseer"), { kind: "overseer", id: "org_ab12", projectId: "prj_1" });
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
  for (const tab of ORG_TABS) assert.deepEqual(orgsRouteFromHash(orgTabHref("org_x", tab)), { kind: "org", id: "org_x", tab });
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
  assert.deepEqual(orgsRouteFromHash(projectHref("org_x", "j1")), { kind: "project", id: "org_x", projectId: "j1" });
  assert.deepEqual(orgsRouteFromHash(projectOverseerHref("org_x", "j1")), { kind: "overseer", id: "org_x", projectId: "j1" });
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

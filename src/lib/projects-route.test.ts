import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_TABS, projectHref, projectOverseerHref, projectsRouteFromHash, projectTabHref } from "./projects-route";

test("the list, one project, its tabs and its overseer", () => {
  assert.deepEqual(projectsRouteFromHash("#/projects"), { kind: "list" });
  assert.deepEqual(projectsRouteFromHash("#/projects/"), { kind: "list" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1"), { kind: "project", projectId: "prj_1" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/requirements"), { kind: "project", projectId: "prj_1", tab: "requirements" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/cost/"), { kind: "project", projectId: "prj_1", tab: "cost" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/settings"), { kind: "project", projectId: "prj_1", tab: "settings" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/overseer"), { kind: "overseer", projectId: "prj_1" });
  for (const tab of PROJECT_TABS) {
    const want = tab === "overview" ? { kind: "project", projectId: "j1" } : { kind: "project", projectId: "j1", tab };
    assert.deepEqual(projectsRouteFromHash(projectTabHref("j1", tab)), want, tab);
  }
  assert.equal(projectTabHref("j1", "overview"), projectHref("j1"));
  assert.deepEqual(projectsRouteFromHash(projectOverseerHref("j1")), { kind: "overseer", projectId: "j1" });
});

test("anything else is not this route", () => {
  for (const h of [
    "",
    "#/",
    "#/projectsx",
    "#/projects/a b",
    "#/projects/../x",
    "#/projects/prj_1/overview",
    "#/projects/prj_1/Settings",
    "#/projects/prj_1/cost/x",
    "#/projects/prj_1/overseer/x",
    "#/projects/prj_1/cost/overseer",
    "#/projects?host=vps",
    "#/projects/prj_1?host=",
    "#/orgs/org_1/projects/prj_1",
  ])
    assert.equal(projectsRouteFromHash(h), null, h);
});

test("a project on a peer: every href of it carries its host, and parses back; a local project's are unchanged", async () => {
  const { notePeerProjects, resetHosts } = await import("./mesh");
  resetHosts();
  notePeerProjects("vps", ["prj_far"]);
  try {
    assert.equal(projectHref("prj_far"), "#/projects/prj_far?host=vps");
    assert.equal(projectTabHref("prj_far", "cost"), "#/projects/prj_far/cost?host=vps");
    assert.equal(projectOverseerHref("prj_far"), "#/projects/prj_far/overseer?host=vps");
    assert.deepEqual(projectsRouteFromHash(projectTabHref("prj_far", "settings")), { kind: "project", projectId: "prj_far", tab: "settings", host: "vps" });
    assert.deepEqual(projectsRouteFromHash(projectOverseerHref("prj_far")), { kind: "overseer", projectId: "prj_far", host: "vps" });
    assert.equal(projectHref("prj_here"), "#/projects/prj_here");
  } finally {
    resetHosts();
  }
});

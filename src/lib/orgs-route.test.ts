import assert from "node:assert/strict";
import { test } from "node:test";
import { orgHref, orgsRouteFromHash, projectHref, projectOverseerHref, replayHref, startForHref } from "./orgs-route";

test("the list, one org, a replay, a start, a project and its overseer", () => {
  assert.deepEqual(orgsRouteFromHash("#/orgs"), { kind: "list" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/"), { kind: "list" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12"), { kind: "org", id: "org_ab12" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/replay/01a0-ff"), { kind: "replay", id: "org_ab12", sessionId: "01a0-ff" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/start/p_x1"), { kind: "org", id: "org_ab12", start: "p_x1" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/projects/prj_1"), { kind: "project", id: "org_ab12", projectId: "prj_1" });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_ab12/projects/prj_1/overseer"), { kind: "overseer", id: "org_ab12", projectId: "prj_1" });
});

test("anything else is not this route", () => {
  for (const h of [
    "",
    "#/",
    "#/orgsx",
    "#/orgs/a b",
    "#/orgs/../x",
    "#/orgs/org_1/replay",
    "#/orgs/org_1/replay/a%2Fb",
    "#/orgs/org_1/other/x",
    "#/orgs/org_1/replay/s1/overseer",
    "#/orgs/org_1/start/p_1/overseer",
    "#/orgs/org_1/projects",
    "#/orgs/org_1/projects/a b",
    "#/orgs/org_1/projects/p/overseer/x",
    "#/s/orgs",
  ])
    assert.equal(orgsRouteFromHash(h), null, h);
});

test("hrefs round-trip", () => {
  assert.deepEqual(orgsRouteFromHash(orgHref("org_x")), { kind: "org", id: "org_x" });
  assert.deepEqual(orgsRouteFromHash(replayHref("org_x", "s1")), { kind: "replay", id: "org_x", sessionId: "s1" });
  assert.deepEqual(orgsRouteFromHash(startForHref("org_x", "p_1")), { kind: "org", id: "org_x", start: "p_1" });
  assert.deepEqual(orgsRouteFromHash(projectHref("org_x", "j1")), { kind: "project", id: "org_x", projectId: "j1" });
  assert.deepEqual(orgsRouteFromHash(projectOverseerHref("org_x", "j1")), { kind: "overseer", id: "org_x", projectId: "j1" });
});

test("a remembered parent is read once, and only for the same org and person", async () => {
  const { rememberStartParent, takeStartParent } = await import("./orgs-route");
  rememberStartParent("org_1", "p_1", "s1");
  assert.equal(takeStartParent("org_1", "p_2"), undefined, "another person");
  rememberStartParent("org_1", "p_1", "s1");
  assert.equal(takeStartParent("org_1", "p_1"), "s1");
  assert.equal(takeStartParent("org_1", "p_1"), undefined, "cleared on read");
});

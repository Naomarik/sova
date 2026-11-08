import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalQueueHash, PROJECT_TABS, projectHref, projectOverseerHref, projectsRouteFromHash, projectTabHref } from "./projects-route";

test("the list, one project, its tabs and its overseer", () => {
  assert.deepEqual(projectsRouteFromHash("#/projects"), { kind: "list" });
  assert.deepEqual(projectsRouteFromHash("#/projects/"), { kind: "list" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1"), { kind: "project", projectId: "prj_1" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/requirements"), { kind: "project", projectId: "prj_1", tab: "requirements" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/cost/"), { kind: "project", projectId: "prj_1", tab: "cost" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/settings"), { kind: "project", projectId: "prj_1", tab: "settings" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/branches"), { kind: "project", projectId: "prj_1", tab: "branches" });
  // The tab was Services once: that address is no alias of Branches, and no route.
  assert.equal(projectsRouteFromHash("#/projects/prj_1/services"), null);
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

test("the Merge Queue tab, and one run under it; nothing else takes a page under a tab", async () => {
  const { projectsRouteFromHash, mergeRunHref, projectTabHref } = await import("./projects-route");
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/merge-queue"), { kind: "project", projectId: "prj_1", tab: "merge-queue" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/merge-queue/mr_42"), { kind: "project", projectId: "prj_1", tab: "merge-queue", run: "mr_42" });
  assert.equal(projectsRouteFromHash("#/projects/prj_1/branches/mr_42"), null);
  assert.equal(projectsRouteFromHash("#/projects/prj_1/merge-queue/a%20b"), null);
  assert.equal(projectTabHref("prj_1", "merge-queue"), "#/projects/prj_1/merge-queue");
  assert.equal(mergeRunHref("prj_1", "mr_42"), "#/projects/prj_1/merge-queue/mr_42");
});

test("the Merge Queue tab's own tabs: Ready to land is the bare address, each other a fixed word, a run keeps the tab it opened from", async () => {
  const { QUEUE_TABS, projectsRouteFromHash, mergeQueueTabHref, mergeRunHref } = await import("./projects-route");
  assert.equal(QUEUE_TABS[0], "ready");
  assert.equal(mergeQueueTabHref("prj_1"), "#/projects/prj_1/merge-queue");
  assert.equal(mergeQueueTabHref("prj_1", "ready"), "#/projects/prj_1/merge-queue");
  assert.equal(mergeRunHref("prj_1", "mr_42", "ready"), "#/projects/prj_1/merge-queue/mr_42");
  for (const t of QUEUE_TABS) {
    const tab = t === "ready" ? {} : { queueTab: t };
    // Every tab's address and every run opened from it parse back to exactly that tab (and run).
    assert.deepEqual(projectsRouteFromHash(mergeQueueTabHref("prj_1", t)), { kind: "project", projectId: "prj_1", tab: "merge-queue", ...tab }, t);
    assert.deepEqual(projectsRouteFromHash(mergeRunHref("prj_1", "mr_42", t)), { kind: "project", projectId: "prj_1", tab: "merge-queue", ...tab, run: "mr_42" }, t);
    // A word is never a run's id (ids are `mr_…`), and never takes one.
    assert.ok(!t.includes("_"), t);
  }
  assert.equal(new Set(QUEUE_TABS).size, QUEUE_TABS.length);
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/merge-queue/needs-you/"), { kind: "project", projectId: "prj_1", tab: "merge-queue", queueTab: "needs-you" });
  // Ready to land has one address, the bare one: a typed `…/ready` opens it and is put back as the bare one.
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/merge-queue/ready"), { kind: "project", projectId: "prj_1", tab: "merge-queue" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/merge-queue/ready/"), { kind: "project", projectId: "prj_1", tab: "merge-queue" });
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/merge-queue/ready/mr_42"), { kind: "project", projectId: "prj_1", tab: "merge-queue", run: "mr_42" });
  assert.equal(canonicalQueueHash("#/projects/prj_1/merge-queue/ready"), "#/projects/prj_1/merge-queue");
  assert.equal(canonicalQueueHash("#/projects/prj_1/merge-queue/ready/mr_42"), "#/projects/prj_1/merge-queue/mr_42");
  assert.equal(canonicalQueueHash("#/projects/prj_1/merge-queue/ready?host=vps"), "#/projects/prj_1/merge-queue?host=vps");
  for (const h of ["#/projects/prj_1/merge-queue", "#/projects/prj_1/merge-queue/needs-you", "#/projects/prj_1/merge-queue/readyish", "#/projects/prj_1/branches/ready"]) assert.equal(canonicalQueueHash(h), null, h);
  for (const h of [
    "#/projects/prj_1/merge-queue/ready/needs-you",
    "#/projects/prj_1/merge-queue/ready/mr_1/x",
    "#/projects/prj_1/merge-queue/mr_42/needs-you",
    "#/projects/prj_1/merge-queue/mr_1/mr_2",
    "#/projects/prj_1/merge-queue/needs-you/landed",
    "#/projects/prj_1/merge-queue/needs-you/a%20b",
    "#/projects/prj_1/merge-queue/Needs-You/mr_1",
    "#/projects/prj_1/merge-queue/needs-you/mr_1/x",
    "#/projects/prj_1/releases/needs-you",
    "#/projects/prj_1/branches/needs-you/mr_1",
    "#/projects/prj_1/needs-you",
  ])
    assert.equal(projectsRouteFromHash(h), null, h);
});

test("a project on a peer: a queue tab and a run opened from it carry its host, and parse back", async () => {
  const { notePeerProjects, resetHosts } = await import("./mesh");
  const { projectsRouteFromHash, mergeQueueTabHref, mergeRunHref } = await import("./projects-route");
  resetHosts();
  notePeerProjects("vps", ["prj_far"]);
  try {
    assert.equal(mergeQueueTabHref("prj_far", "landed"), "#/projects/prj_far/merge-queue/landed?host=vps");
    assert.deepEqual(projectsRouteFromHash(mergeRunHref("prj_far", "mr_9", "needs-you")), { kind: "project", projectId: "prj_far", tab: "merge-queue", queueTab: "needs-you", run: "mr_9", host: "vps" });
  } finally {
    resetHosts();
  }
});

test("the Releases tab sits right after Merge Queue, with no page under it", async () => {
  const { PROJECT_TABS, projectsRouteFromHash, projectTabHref } = await import("./projects-route");
  assert.equal(PROJECT_TABS.indexOf("releases"), PROJECT_TABS.indexOf("merge-queue") + 1);
  assert.deepEqual(projectsRouteFromHash("#/projects/prj_1/releases"), { kind: "project", projectId: "prj_1", tab: "releases" });
  assert.equal(projectsRouteFromHash("#/projects/prj_1/releases/rel_1"), null);
  assert.equal(projectTabHref("prj_1", "releases"), "#/projects/prj_1/releases");
});

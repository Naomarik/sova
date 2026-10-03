// Run: pnpm exec tsx --test src/lib/projects.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectSummary } from "../../shared/projects";
import { cloneFolder, cloneUrl, placementOf, projectAt, sortProjects } from "./projects";

const p = (id: string, name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, name, root: `/w/${id}`, origin: "folder", createdAt: "2026-01-01T00:00:00Z", space: { kind: "standalone" }, ...extra });

test("placement: an org's space names the org; a standalone project has none", () => {
  assert.equal(placementOf(p("a", "A")), null);
  assert.deepEqual(placementOf(p("a", "A", { space: { kind: "org", orgId: "org_1", orgName: "Acme" } })), { orgId: "org_1", orgName: "Acme" });
});

test("the list: live ones by name, archived apart", () => {
  const r = sortProjects([p("c", "beta"), p("a", "Alpha"), p("b", "Old", { archived: { at: "2026-01-02T00:00:00Z" } })]);
  assert.deepEqual(r.live.map((x) => x.id), ["a", "c"]);
  assert.deepEqual(r.archived.map((x) => x.id), ["b"]);
});

test("clone addresses: owner/name becomes GitHub's https URL; URLs pass as typed; anything else is refused", () => {
  assert.equal(cloneUrl("acme/app"), "https://github.com/acme/app.git");
  assert.equal(cloneUrl(" acme/app.git "), "https://github.com/acme/app.git");
  assert.equal(cloneUrl("https://github.com/acme/app"), "https://github.com/acme/app");
  assert.equal(cloneUrl("git@github.com:acme/app.git"), "git@github.com:acme/app.git");
  assert.equal(cloneUrl("file:///tmp/repo"), "file:///tmp/repo");
  for (const bad of ["", "acme", "a b/c", "--upload-pack=x", "acme/app; rm -rf /"]) assert.equal(cloneUrl(bad), null, bad);
  assert.equal(cloneFolder("https://github.com/acme/app.git"), "app");
  assert.equal(cloneFolder("git@github.com:acme/tool"), "tool");
  assert.equal(cloneFolder("file:///tmp/repo/"), "repo");
});

test("projectAt: the project a folder is in, the deepest root first, never a sibling sharing a prefix", () => {
  const list = [{ root: "/w/app" }, { root: "/w/app/packages/ui" }, { root: "/w/application" }];
  assert.deepEqual(projectAt("/w/app", list), { root: "/w/app" });
  assert.deepEqual(projectAt("/w/app/src", list), { root: "/w/app" });
  assert.deepEqual(projectAt("/w/app/packages/ui/x", list), { root: "/w/app/packages/ui" });
  assert.deepEqual(projectAt("/w/application/x", list), { root: "/w/application" });
  assert.equal(projectAt("/w/ap", list), null);
});

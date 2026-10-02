// Run: pnpm exec tsx --test src/lib/project-region.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectSummary } from "../../shared/projects";
import type { SessionSummary } from "../../shared/protocol";
import { inProjectsRegion, isStandaloneProjectSession, projectBlocks, projectRowCount } from "./project-region";
import { isOrdinarySession, sidebarRegion } from "./regions";

const at = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/w/app",
    title: id,
    createdAt: at(1),
    lastActiveAt: at(1),
    model: null,
    live: null,
    busy: false,
    origin: "web",
    archived: false,
    ...extra,
  }) as SessionSummary;
const proj = (projectId: string, kind: "overseer" | "coding", extra: Record<string, unknown> = {}) => ({ project: { projectId, projectName: projectId.toUpperCase(), kind, ...extra } }) as Partial<SessionSummary>;
const registered = (id: string, name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, name, root: `/w/${id}`, origin: "folder", createdAt: at(1), space: { kind: "standalone" }, ...extra });
const placedOrg = { orgId: "o1", orgName: "Org", projectId: "pb", projectName: "PB", kind: "coding" as const };

test("a standalone project's sessions are the Projects region's, never an ordinary surface's; a placed one's stay the org's", () => {
  const own = session("c1", proj("pa", "coding"));
  const placed = session("c2", { ...proj("pb", "coding"), org: placedOrg });
  const plain = session("x");
  assert.equal(isStandaloneProjectSession(own), true);
  assert.equal(isStandaloneProjectSession(placed), false);
  assert.equal(isOrdinarySession(own), false);
  assert.equal(isOrdinarySession(placed), false);
  assert.equal(isOrdinarySession(plain), true);
  assert.equal(sidebarRegion(own), "projects");
  assert.equal(sidebarRegion(placed), "org");
  assert.equal(sidebarRegion({ ...own, live: { pid: 1, status: "idle" } }), "projects", "a project beats live");
  assert.equal(inProjectsRegion(session("o1", proj("pa", "overseer", { finished: true }))), false, "a cleared conversation is in its History, not the region");
});

test("blocks: every registered standalone project by name, its overseer as the eye, builds active then Done", () => {
  const blocks = projectBlocks(
    [
      session("ov", proj("pa", "overseer")),
      session("old", proj("pa", "overseer", { finished: true })),
      session("b1", { ...proj("pa", "coding"), lastActiveAt: at(2) }),
      session("b2", { ...proj("pa", "coding"), lastActiveAt: at(5) }),
      session("b3", { ...proj("pa", "coding", { finished: true }) }),
      session("b4", { ...proj("pa", "coding"), archived: true }),
      session("pl", { ...proj("pb", "coding"), org: placedOrg }),
      session("x"),
    ],
    [registered("pa", "Zeta"), registered("pc", "Alpha"), registered("pd", "Gone", { archived: { at: at(3) } }), registered("pb", "Placed", { space: { kind: "org", orgId: "o1", orgName: "Org" } })],
  );
  assert.deepEqual(
    blocks.map((b) => [b.name, b.overseer?.id ?? null, b.builds.active.map((s) => s.id), b.builds.done.map((s) => s.id)]),
    [
      ["Alpha", null, [], []],
      ["Zeta", "ov", ["b2", "b1"], ["b3", "b4"]],
    ],
  );
  assert.equal(projectRowCount(blocks), 4, "the eye is not a row");
});

test("before the project list is read, a session still names its project", () => {
  const blocks = projectBlocks([session("b1", proj("pz", "coding"))]);
  assert.deepEqual(blocks.map((b) => [b.id, b.name]), [["pz", "PZ"]]);
});

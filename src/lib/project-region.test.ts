// Run: pnpm exec tsx --test src/lib/project-region.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectSummary } from "../../shared/projects";
import type { SessionSummary } from "../../shared/protocol";
import { inLocalProjectsRegion, inProjectsRegion, isStandaloneProjectSession, projectBlocks, projectOpenCount } from "./project-region";
import { isOrdinarySession, sidebarRegion } from "./regions";
import { listedOrgProjects, orgSections } from "./org-region";

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
const proj = (projectId: string, kind: "overseer" | "coding" | "folder", extra: Record<string, unknown> = {}) => ({ project: { projectId, projectName: projectId.toUpperCase(), kind, ...extra } }) as Partial<SessionSummary>;
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

test("an archived standalone build leaves the Projects region for the Archive; a placed project's stays the org's", () => {
  const archivedBuild = session("c1", { ...proj("pa", "coding"), archived: true });
  assert.equal(inProjectsRegion(archivedBuild), false);
  assert.equal(isOrdinarySession(archivedBuild), true, "the Archive and its cleanup list it");
  assert.equal(sidebarRegion(archivedBuild), "archive");
  assert.equal(sidebarRegion({ ...archivedBuild, live: { pid: 1, status: "idle" } as SessionSummary["live"] }), "top", "live, it stays on top like any archived session");
  const placedArchived = session("c2", { ...proj("pb", "coding"), org: placedOrg, archived: true });
  assert.equal(isOrdinarySession(placedArchived), false, "an org build goes to its group's Done, never the Archive");
  assert.equal(sidebarRegion(placedArchived), "org");
  assert.equal(inProjectsRegion(session("ov", { ...proj("pa", "overseer"), archived: true })), true, "the overseer's eye stays");
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
      ["Zeta", "ov", ["b2", "b1"], ["b3"]],
    ],
  );
  assert.equal(blocks.length, 2, "the region head counts projects, Alpha with no session included");
  assert.deepEqual(blocks.map(projectOpenCount), [0, 2], "each heading counts its open rows: Done and the eye aren't counted");
});

test("one project list, two regions: every unarchived project is listed exactly once — standalone in Projects, placed under its org — sessions or none", () => {
  const list = [
    registered("pa", "Zeta"),
    registered("pc", "Alpha"),
    registered("pd", "Gone", { archived: { at: at(3) } }),
    registered("pb", "Placed", { space: { kind: "org", orgId: "o1", orgName: "Org" } }),
    registered("pe", "Placed quiet", { space: { kind: "org", orgId: "o2", orgName: "Other org" } }),
  ];
  const sessions = [session("b1", proj("pa", "coding")), session("pl", { ...proj("pb", "coding"), org: placedOrg })];
  const inProjects = projectBlocks(sessions.filter(inProjectsRegion), list).map((b) => b.id);
  const inOrgs = orgSections(sessions, listedOrgProjects(list, { query: "", here: true })).flatMap((o) => o.projects.map((p) => p.id));
  assert.deepEqual([...inProjects, ...inOrgs].sort(), ["pa", "pb", "pc", "pe"], "each once, the archived one nowhere");
});

test("before the project list is read, a session still names its project", () => {
  const blocks = projectBlocks([session("b1", proj("pz", "coding"))]);
  assert.deepEqual(blocks.map((b) => [b.id, b.name]), [["pz", "PZ"]]);
  assert.deepEqual(projectBlocks([session("b2", { ...proj("py", "coding"), archived: true })]), [], "an archived session makes no block");
});

test("a folder session is in its project's Sessions too: active while live or a web session, Done once ended, gone once archived", () => {
  const liveOne = session("f-live", { ...proj("pa", "folder"), origin: "external", live: { pid: 1, status: "idle" } as SessionSummary["live"], lastActiveAt: at(5) });
  const web = session("f-web", { ...proj("pa", "folder"), origin: "web", lastActiveAt: at(4) });
  const ended = session("f-ended", { ...proj("pa", "folder"), origin: "external", lastActiveAt: at(3) });
  const archivedWeb = session("f-arch", { ...proj("pa", "folder"), origin: "web", archived: true, lastActiveAt: at(2) });
  const build = session("c1", { ...proj("pa", "coding"), lastActiveAt: at(1) });
  const placed = session("f-placed", { ...proj("pb", "folder"), folderOrg: { orgId: "o1", orgName: "Org", projectId: "pb", projectName: "PB" } });
  for (const s of [liveOne, web, ended]) assert.equal(inProjectsRegion(s), true, s.id);
  for (const s of [liveOne, web, ended, archivedWeb]) assert.equal(isOrdinarySession(s), true, `${s.id}: still on the ordinary surfaces`);
  assert.equal(inProjectsRegion(placed), false, "a placed project's folder session goes to the Organizations region");
  const [b, ...rest] = projectBlocks([liveOne, web, ended, archivedWeb, build, placed], [registered("pa", "A"), registered("pb", "B", { space: { kind: "org", orgId: "o1", orgName: "Org" } })]);
  assert.equal(rest.length, 0, "the placed project has no block here");
  assert.deepEqual(b!.builds.active.map((s) => s.id), ["f-live", "f-web", "c1"]);
  assert.deepEqual(b!.builds.done.map((s) => s.id), ["f-ended"], "an archived folder session is the Archive's only");
  assert.equal(projectOpenCount(b!), 3, "open rows only");
  assert.equal(inProjectsRegion(archivedWeb), false);
  // Without the projects read, a placed folder session still makes no block.
  assert.deepEqual(projectBlocks([placed]).length, 0);
});

test("a mesh peer's folder session is never a Projects row (it stays in Folders), so it makes no block; this computer's is", () => {
  const peerFolder = session("pf", proj("peer-p", "folder"));
  const peerBuild = session("pb", proj("peer-p", "coding"));
  const mine = session("mf", proj("pa", "folder"));
  assert.equal(inLocalProjectsRegion(peerFolder, false), false);
  assert.equal(inLocalProjectsRegion(mine, true), true);
  assert.equal(inLocalProjectsRegion(peerBuild, false), true, "a peer project's own build has no other place: unchanged");
  const rows = [peerFolder, mine].filter((s) => inLocalProjectsRegion(s, s.id !== "pf"));
  assert.deepEqual(projectBlocks(rows, [registered("pa", "Mine")]).map((b) => b.id), ["pa"], "the peer's project id adds no block");
});

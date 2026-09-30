// Run: pnpm exec tsx --test server/org-sessions.test.ts. A throwaway PI_CODING_AGENT_DIR, org
// workspace and project root in the OS temp dir, deleted after; ~/.pi is never read or written.
//
// Which sessions are organizational (SessionSummary.org, server/org-sessions.ts): from the org's own
// records — workspace files and the builds' charts — never from a folder.
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, test } from "node:test";
import { PROJECT_OVERSEER_ENTRY } from "../shared/project-overseer";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-sessions-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const store = await import("./project-overseer-store");
const { isOrgSession, orgLookup } = await import("./org-sessions");
const { getSessionSummary, listSessions, recentCwds } = await import("./sessions-index");
const { sessionItems } = await import("./attention");
const { canonicalPath } = await import("./paths");
const { settled } = await import("./workspace-git");
const { seedBuild, seedPoState } = await import("./org-test-fixtures");
const { readBuilds } = await import("./build-loadout");

after(async () => {
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const uuid = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;

/** A session file with a user message (listed, not a husk); `extra` lines go after the header. */
function sessionFile(dir: string, cwd: string, title: string, extra: object[] = [], id = uuid()): { id: string; path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-09-27T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd },
    ...extra,
    { type: "message", id: "m1", parentId: null, timestamp: "2026-09-27T00:00:01.000Z", message: { role: "user", content: title } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { id, path: canonicalPath(path) };
}

describe("SessionSummary.org", async () => {
  const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
  const ws = orgs.orgDir(org.id);
  const wsSessions = join(ws, "sessions");
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Rakiba site", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
  const maria = await orgs.addPerson(org.id, { name: "Maria", role: "Payroll" });

  const gathering = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "g" });
  const offer = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id], publicTitle: "Payroll", goal: "g" });
  const done = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Budget", goal: "g" });
  await baton.markDone(done.sessionId);

  const marker = { type: "custom", id: "c1", parentId: null, timestamp: "2026-09-27T00:00:00.500Z", customType: PROJECT_OVERSEER_ENTRY, data: { v: 1, orgId: org.id, projectId: project.id } };
  const cleared = sessionFile(wsSessions, join(root, "proj"), "Overseer before the clear", [marker]);
  const current = sessionFile(wsSessions, join(root, "proj"), "Overseer now", [marker]);
  await seedPoState(org.id, project.id, { current: current.id, history: [cleared.id] });
  const stray = sessionFile(wsSessions, ws, "Unregistered file in the workspace");

  const userSessions = join(agentDir, "sessions", "--proj--");
  const coding = sessionFile(userSessions, join(root, "proj"), "Coding session the overseer started");
  const operatorCoding = sessionFile(userSessions, join(root, "proj"), "Start coding session on a to-do");
  const byHand = sessionFile(userSessions, join(root, "proj"), "The operator's own session in the project root");
  // The overseer's build in its worktree; the operator's in the project root.
  await seedBuild(org.id, project.id, { sessionId: coding.id, kind: "coding", path: coding.path, worktree: { path: join(root, "wt"), branch: "sova/x", base: "abc", target: "main" } });
  await seedBuild(org.id, project.id, { sessionId: operatorCoding.id, kind: "operator-coding", path: operatorCoding.path });
  // A copy of a baton transcript outside the workspace (same id), and a fork of the coding session (new id).
  const copyPath = join(userSessions, basename(gathering.path));
  copyFileSync(gathering.path, copyPath);
  appendFileSync(copyPath, `${JSON.stringify({ type: "message", id: "m9", parentId: null, timestamp: "2026-09-27T00:00:02.000Z", message: { role: "user", content: "a copy" } })}\n`);
  const fork = sessionFile(userSessions, join(root, "proj"), "Fork of the coding session");

  const ref = { orgId: org.id, orgName: "Mamluk Arabia", projectId: project.id, projectName: "Rakiba site" };
  const byPath = async () => new Map((await listSessions()).map((s) => [s.path, s] as const));

  test("workspace files: baton kinds, done = finished, current overseer vs cleared, unregistered = other", async () => {
    const list = await byPath();
    assert.deepEqual(list.get(canonicalPath(gathering.path))?.org, { ...ref, kind: "gathering" });
    assert.deepEqual(list.get(canonicalPath(offer.path))?.org, { ...ref, kind: "offer" });
    assert.deepEqual(list.get(canonicalPath(done.path))?.org, { ...ref, kind: "gathering", finished: true });
    assert.deepEqual(list.get(current.path)?.org, { ...ref, kind: "overseer" });
    assert.deepEqual(list.get(cleared.path)?.org, { ...ref, kind: "overseer", finished: true });
    assert.deepEqual(list.get(stray.path)?.org, { orgId: org.id, orgName: "Mamluk Arabia", kind: "other" });
  });

  test("builds of both kinds are the project's coding sessions; the list and the single summary agree", async () => {
    const list = await byPath();
    assert.deepEqual(list.get(coding.path)?.org, { ...ref, kind: "coding" });
    assert.deepEqual(list.get(operatorCoding.path)?.org, { ...ref, kind: "coding" });
    for (const f of [coding, operatorCoding, current, cleared]) assert.deepEqual((await getSessionSummary(f.path))?.org, list.get(f.path)?.org);
  });

  test("ordinary: the operator's own session in the project root, a copy of a baton file, a fork", async () => {
    const list = await byPath();
    for (const path of [byHand.path, canonicalPath(copyPath), fork.path]) {
      assert.ok(list.has(path), `${path} is listed`);
      assert.equal(list.get(path)?.org, undefined, path);
      assert.equal(isOrgSession(path, basename(path, ".jsonl").split("_")[1] ?? ""), false);
    }
    assert.equal(isOrgSession(coding.path, coding.id), true, "the group routes refuse it");
  });

  test("names follow renames at the next read; a project gone from projects.json keeps its id, loses its name", async () => {
    await orgs.patchOrg(org.id, { name: "Mamluk" });
    await orgs.patchProject(org.id, project.id, { name: "Rakiba" });
    assert.deepEqual(orgLookup().of(coding.path, coding.id), { orgId: org.id, orgName: "Mamluk", projectId: project.id, projectName: "Rakiba", kind: "coding" });
    const other = orgLookup().of(coding.path, "not-started");
    assert.equal(other, undefined);
  });

  test("a build merged per git is finished; the others are not", async () => {
    const { noteBuildMerged, resetBuildMerged } = await import("./build-merged");
    // The overseer's build is in its worktree; the operator's stays in the project root.
    try {
      noteBuildMerged(coding.id, true);
      assert.equal(orgLookup().of(coding.path, coding.id)?.finished, true);
      assert.equal(orgLookup().of(operatorCoding.path, operatorCoding.id)?.finished, undefined, "no worktree: never merged");
      noteBuildMerged(coding.id, false);
      assert.equal(orgLookup().of(coding.path, coding.id)?.finished, undefined, "new commits since: not merged");
    } finally {
      resetBuildMerged();
    }
  });

  test("the overseer's budget and caps read only its own coding rows", () => {
    const rows = readBuilds(org.id, project.id);
    assert.deepEqual(rows.map((r) => r.kind).sort(), ["coding", "operator-coding"]);
    // codingOf (project-overseer.ts) filters `kind === "coding"`: the one row the overseer started.
    assert.deepEqual(rows.filter((r) => r.kind === "coding").map((r) => r.sessionId), [coding.id]);
  });

  test("attention items carry the org (the sidebar's Organizations Needs you), ordinary ones don't", async () => {
    const s = (await getSessionSummary(canonicalPath(gathering.path)))!;
    const row = (summary: SessionSummary) => ({ summary, dialogs: ["Continue?"], queued: 0, failedWorkers: 0, activitySince: 1 });
    const orgItems = sessionItems(row(s), Date.now());
    assert.ok(orgItems.length > 0);
    for (const it of orgItems) assert.deepEqual(it.org, { orgId: org.id, orgName: "Mamluk", projectId: project.id, projectName: "Rakiba" });
    const plain = sessionItems(row((await getSessionSummary(byHand.path))!), Date.now());
    assert.ok(plain.length > 0);
    for (const it of plain) assert.equal(it.org, undefined);
  });

  test("recent folders never offer the workspace or its conversations' cwd; a coding session keeps the project root", () => {
    const list = [
      { cwd: ws, org: { ...ref, kind: "gathering" as const } },
      { cwd: "/elsewhere", org: { ...ref, kind: "overseer" as const } },
      { cwd: join(root, "proj"), org: { ...ref, kind: "coding" as const } },
      { cwd: ws },
      { cwd: "/mine" },
    ];
    assert.deepEqual(recentCwds(list, "/ov", () => true, [ws]), [join(root, "proj"), "/mine"]);
  });

  test("a detached org classifies nothing: its files and coding sessions read as they did before", async () => {
    await orgs.detachOrg(org.id);
    const list = await byPath();
    for (const f of [coding.path, operatorCoding.path]) assert.equal(list.get(f)?.org, undefined);
    assert.equal(list.has(current.path), false, "the workspace is no longer a session root");
    assert.equal(orgLookup().of(current.path, current.id), undefined);
  });
});

// Run: pnpm exec tsx --test server/org-portable.test.ts. A throwaway PI_CODING_AGENT_DIR, workspace
// repos, clones and project roots in the OS temp dir, deleted after; ~/.pi is never touched. No
// model is called: runtimes are opened, never prompted.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-portable-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const { editProject, overseerPausedSince, watchSid } = await import("./projects/spaces");
const baton = await import("./baton");
await import("./baton-loadout"); // registers the baton kind (its loadout and its cwd), as the server does
const links = await import("./baton-links");
const visits = await import("./visits");
const { personPage } = await import("./person-page");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { acquireChat, cwdOverride, disposeAllChats } = await import("./chat-manager");
const { commitAll, settled } = await import("./workspace-git");
const { readSessionTitles, setSessionTitle } = await import("./session-titles");
const { isWebSession, removeWebSession } = await import("./web-sessions");
const { stateRoot } = await import("./state-root");
const { getSessionSummary } = await import("./sessions-index");
const { hostOf } = await import("./org-engine");
const { seedBuild, seedConflicts } = await import("./org-test-fixtures");
const { readBuilds } = await import("./build-loadout");

after(async () => {
  await disposeAllChats();
  for (const d of ["ws-a", "ws-b"]) await settled(join(root, d));
  rmSync(root, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

describe("the sessions it started are the statecharts' (q1: no started.json; C13: no legacy list)", async () => {
  const org = await orgs.createOrg({ name: "Migrate", dir: join(root, "ws-m") });
  mkdirSync(join(root, "proj-m"));
  const project = await orgs.addProject(org.id, { name: "M", root: join(root, "proj-m") });
  const p = store.projectOverseerPaths(project.id);
  const started = join(p.dir, "started.json");

  test("the paths: no turn counters (the watch statechart's ledgers), no started.json, no watch memo", () => {
    assert.equal("turn" in p, false);
    assert.equal("started" in p, false);
    assert.equal("memo" in p, false);
  });

  test("an old memo's started list is never read nor moved (C13)", () => {
    const memo = join(stateRoot(), "project-overseers", `${org.id}-${project.id}`, "watch.json");
    mkdirSync(join(memo, ".."), { recursive: true });
    const legacy = [{ sessionId: "s-code", kind: "coding", createdAt: "2026-09-02T00:00:00.000Z", path: "/nowhere/s-code.jsonl" }];
    writeFileSync(memo, JSON.stringify({ version: 1, pending: ["a reason"], lastRunAt: null, lastRun: null, perDay: { "2026-09-01": 2 }, started: legacy }));
    assert.deepEqual(readBuilds(project.id), []);
    assert.deepEqual(store.readMemo(p).pending, [], "nor its reasons: the watch statechart's are the loop's");
    assert.equal(existsSync(started), false, "nothing moved into the repo");
  });
});

describe("clone + attach = the whole organization", async () => {
  const a = await orgs.createOrg({ name: "Northwind Traders", dir: join(root, "ws-a") });
  const aDir = orgs.orgDir(a.id);
  const tony = await orgs.addPerson(a.id, { name: "Tony Reyes", role: "Finance", contact: { email: "tony@example.com" }, decides: ["payroll"] });
  await orgs.applyChange(a.id, tony.id, { skills: ["SAP"] }, { kind: "wrapup", sessionId: "s", quote: "I run SAP" });
  mkdirSync(join(root, "proj-a"));
  const project = await orgs.addProject(a.id, { name: "Portal", root: join(root, "proj-a") });
  const c1 = await baton.createBaton({ orgId: a.id, projectId: project.id, to: tony.id, publicTitle: "Payroll day", goal: "Find the payroll day" });
  const again = baton.rotateLink(c1.sessionId);
  const overseer = await po.ensureProjectOverseer(project.id);
  // A build of the project, merged (its worktree's folder was this host's).
  await seedBuild(a.id, project.id, { sessionId: "code-moved", kind: "coding", title: "Moved build", worktree: { path: join(root, "wt-a"), branch: "sova/moved-abc123", base: "abc", target: "main" }, merged: { commit: "c0ffee" } });
  await po.patchProjectOverseer(project.id, { autonomy: "L2" });
  // A conflict asking Tony in its settle session (the conflict statechart starts it).
  const seeded = await seedConflicts(a.id, project.id, [{ id: "cf_moved", orgId: a.id, projectId: project.id, areaKey: "payroll", a: "x", b: "y", p: 0.9, state: "open", routedTo: tony.id, routeReason: "owner", batonSessionId: randomUUID(), createdAt: "2026-09-27T00:00:00.000Z" }]);
  await orgs.patchOrg(a.id, { about: "Northwind closes its books on the 5th." });
  const tokens = [c1.token!, again.token];
  // Tony opened his link once (§app.baton/visits): the log is in the repo and moves with it.
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1";
  visits.recordOpen(links.findLink(again.token)!, { tab: "T".repeat(22), userAgent: UA });

  // Committed as the hourly commit would, then cloned elsewhere; this host forgets the original.
  assert.equal((await commitAll(aDir, "test commit")).committed, true);
  const bDir = join(root, "ws-b");
  execFileSync("git", ["clone", "-q", aDir, bDir]);
  await orgs.detachOrg(a.id);
  // The old host's copy is gone: the headers' cwds (ws-a, proj-a) no longer exist here.
  renameSync(aDir, join(root, "ws-a-gone"));
  mkdirSync(join(root, "proj-b"));
  rmSync(join(root, "proj-a"), { recursive: true });
  // What this host kept about the sessions outside the repo is lost too (another host never had it).
  for (const id of [c1.sessionId, overseer.id]) {
    setSessionTitle(id, null);
    removeWebSession(id);
  }

  const b = await orgs.attachOrg({ dir: bDir });
  await editProject(project.id, { root: join(root, "proj-b") });

  test("the repo holds every file of the org's state", () => {
    const files = git(bDir, "ls-files").split("\n");
    // The statecharts' snapshots and transition log hold the state (q1): no projection file is written.
    const want = ["about.md", "org-history.jsonl", "roster-history.jsonl", "visits.jsonl", `sessions/${c1.path.split("/").pop()}`];
    for (const f of want) assert.ok(files.includes(f), f);
    const snapshot = (statechart: string, sid: string) => `statecharts/${statechart}/${encodeURIComponent(sid)}.edn`;
    for (const f of [snapshot("org", `org/${a.id}`), snapshot("person", `person/${a.id}/${tony.id}`), snapshot("project", `project/${project.id}`), snapshot("placement", `placement/${a.id}/${project.id}`)]) assert.ok(files.includes(f), f);
    assert.ok(files.some((f) => /^statecharts\/log\/\d{4}-\d{2}\.jsonl$/.test(f)), "the transition log");
    for (const f of ["org.json", "roster.json", "projects.json", "holder.json"]) assert.ok(!files.includes(f), `no ${f}`);
    // Host-local statecharts (the residence, the watches) stay on the host.
    assert.ok(!files.some((f) => f.startsWith("statecharts/residence/") || f.startsWith("statecharts/watch/")), "nothing host-local");
    assert.ok(files.includes(`projects/${project.id}/overseer/overseer.json`), "overseer.json");
    for (const f of ["started.json", "state.json"]) assert.ok(!files.includes(`projects/${project.id}/overseer/${f}`), `no ${f}`);
    assert.ok(files.includes(snapshot("build", `build/${project.id}/code-moved`)), "the build's snapshot");
    assert.ok(files.some((f) => f.startsWith("sessions/") && f.endsWith(`_${overseer.id}.jsonl`)), "the overseer's transcript");
  });

  test("each project's watch starts on this host, paused, and sees its project at once (F14)", () => {
    const sid = watchSid(project.id);
    const conf = hostOf(b.id).configuration(sid) ?? [];
    assert.ok(conf.includes("paused"), `paused since the attach: ${conf.join(",")}`);
    assert.ok(conf.includes("has-overseer"), "it watches the cloned project: its overseer exists");
    assert.ok(conf.includes("on-shelf"), "not archived");
    assert.equal(hostOf(b.id).data(sid)?.projectName, "Portal");
  });

  test("the same org on the new host: id, roster with history, projects, baton row, overseer state", async () => {
    assert.equal(b.id, a.id);
    assert.deepEqual(orgs.readRoster(b.id).map((p) => p.name), ["Tony Reyes"]);
    assert.deepEqual(orgs.readRoster(b.id)[0]!.skills, ["SAP"]);
    assert.ok(orgs.readHistory(b.id).some((h) => h.field === "skills" && h.by.kind === "wrapup" && h.by.quote === "I run SAP"), "the history came along");
    assert.equal(baton.batonById(c1.sessionId)?.row.publicTitle, "Payroll day");
    assert.equal(orgs.readOrgAbout(b.id), "Northwind closes its books on the 5th.", "the About text came along");
    assert.deepEqual(orgs.readOrgHistory(b.id).map((c) => c.to), ["Northwind closes its books on the 5th."], "and its history");
    assert.match(po.renderProjectOverseerPrompt(project.id, []), /Northwind closes its books on the 5th\./, "its overseer here reads it");
    const info = await po.projectOverseerInfo(project.id);
    assert.equal(info.exists, true);
    assert.equal(info.id, overseer.id);
    assert.equal(info.settings.autonomy, "L2", "its setting came along");
    const moved = readBuilds(project.id).find((r) => r.sessionId === "code-moved");
    assert.deepEqual(moved && [moved.kind, moved.title, moved.worktree?.branch, moved.merged?.commit, moved.path], ["coding", "Moved build", "sova/moved-abc123", "c0ffee", undefined], "the builds it started, merged, with no file on this host");
  });

  test("its project overseers are paused at L0 until the operator sets a level on this host", async () => {
    const info = await po.projectOverseerInfo(project.id);
    assert.ok(info.paused, "paused since the attach");
    assert.equal(info.effective.autonomy, "L0");
    assert.match(info.effective.reason ?? "", /attached on this host/);
    // Setting the SAME level resumes it: the gesture is what counts.
    const resumed = await po.patchProjectOverseer(project.id, { autonomy: "L2" });
    assert.equal(resumed.paused, null);
    assert.equal(resumed.effective.autonomy, "L2");
    // Another settings change does not count as setting the level: only autonomy resumes.
    await orgs.detachOrg(b.id);
    await orgs.attachOrg({ dir: bDir });
    await po.patchProjectOverseer(project.id, { watch: false });
    assert.ok((await po.projectOverseerInfo(project.id)).paused, "a watch toggle leaves it paused");
    await po.patchProjectOverseer(project.id, { autonomy: "L1", watch: true });
  });

  test("an org created on this host is not paused", async () => {
    const fresh = await orgs.createOrg({ name: "Fresh", dir: join(root, "ws-fresh") });
    mkdirSync(join(root, "proj-f"));
    const pr = await orgs.addProject(fresh.id, { name: "F", root: join(root, "proj-f") });
    assert.equal(overseerPausedSince(pr.id), null);
  });

  test("the attach derives this host's titles and web origin again from the repo", () => {
    const titles = readSessionTitles();
    assert.equal(titles[c1.sessionId], "Payroll day");
    assert.equal(titles[overseer.id], "Overseer · Portal");
    assert.ok(isWebSession(c1.sessionId) && isWebSession(overseer.id));
  });

  test("workspace sessions open in this host's dirs, not the dead ones their headers name", async () => {
    const batonPath = baton.sessionPathOf(bDir, baton.batonById(c1.sessionId)!.row);
    const header = JSON.parse(readFileSync(batonPath, "utf8").split("\n")[0]!);
    assert.equal(existsSync(header.cwd), false, "the header's cwd is the old host's");
    assert.equal(cwdOverride(batonPath), orgs.orgDir(b.id));
    const chat = await acquireChat(batonPath);
    assert.equal(chat.session.sessionManager.getCwd(), orgs.orgDir(b.id));
    const poPath = (await po.projectOverseerInfo(project.id)).path!;
    assert.equal(cwdOverride(poPath), join(root, "proj-b"));
    const poChat = await acquireChat(poPath);
    assert.equal(poChat.special, "project-overseer");
    assert.equal(poChat.session.sessionManager.getCwd(), join(root, "proj-b"));
    assert.equal(readFileSync(batonPath, "utf8").split("\n")[0], JSON.stringify(header), "opening rewrote nothing");
    // The session list groups them by the same dirs, not the old host's.
    assert.equal((await getSessionSummary(batonPath))?.cwd, orgs.orgDir(b.id));
    assert.equal((await getSessionSummary(poPath))?.cwd, join(root, "proj-b"));
  });

  test("no link token and no token hash anywhere in the repo's history; the link store is not in it", () => {
    const history = git(bDir, "log", "-p", "--all");
    for (const t of tokens) {
      assert.ok(!history.includes(t), "token");
      assert.ok(!history.includes(links.hashToken(t)), "hash");
    }
    assert.ok(!git(bDir, "ls-files").includes("baton-links"));
    assert.ok(!history.includes(UA) && !history.includes("Mozilla"), "no user agent");
  });

  test("a conflict's settle session is found by its id here; the repo keeps no host path for it", async () => {
    const decisions = await import("./decisions");
    const reconcile = await import("./reconcile");
    const settle = baton.batonById(seeded.cf_moved!)!;
    const here = baton.sessionPathOf(bDir, settle.row);
    const read = decisions.readConflicts(b.id, project.id);
    assert.equal(read.find((c) => c.id === "cf_moved")!.batonPath, here, "this host's file, not the old host's");
    assert.equal(reconcile.listDecisions(b.id, project.id).conflicts.find((c) => c.id === "cf_moved")!.batonPath, here);
    assert.equal(personPage(b.id, tony.id).conflicts.find((c) => c.id === "cf_moved")!.batonPath, here, "the person page too");
    const snapshot = readFileSync(join(bDir, "statecharts", "conflict", `${encodeURIComponent(`conflict/${b.id}/${project.id}/cf_moved`)}.edn`), "utf8");
    assert.doesNotMatch(snapshot, /batonPath|batonpath|baton-path|ws-a|\.jsonl/, "the repo keeps its session's id, never a host path");
  });

  test("the visit log moved: the person's page on the new host shows the visit", () => {
    const page = personPage(b.id, tony.id);
    assert.deepEqual(
      page.visits.map((v) => [v.kind, v.device, v.publicTitle]),
      [["visit", "Safari · iPhone", "Payroll day"]],
    );
    assert.ok(existsSync(join(stateRoot(), "baton-links.json")), "the links live on the host");
  });
});

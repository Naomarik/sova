// Run: pnpm exec tsx --test server/org-portable.test.ts. A throwaway PI_CODING_AGENT_DIR, workspace
// repos, clones and project roots in the OS temp dir, deleted after; ~/.pi is never touched. No
// model is called: runtimes are opened, never prompted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-portable-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
await import("./baton-loadout"); // registers the baton kind (its loadout and its cwd), as the server does
const links = await import("./baton-links");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { acquireChat, cwdOverride, disposeAllChats } = await import("./chat-manager");
const { commitAll, settled } = await import("./workspace-git");
const { readSessionTitles, setSessionTitle } = await import("./session-titles");
const { isWebSession, removeWebSession } = await import("./web-sessions");
const { stateRoot } = await import("./state-root");
const { getSessionSummary } = await import("./sessions-index");

after(async () => {
  await disposeAllChats();
  for (const d of ["ws-a", "ws-b"]) await settled(join(root, d));
  rmSync(root, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

describe("the overseer's started list moves from the host-local memo into the repo", async () => {
  const org = await orgs.createOrg({ name: "Migrate", dir: join(root, "ws-m") });
  mkdirSync(join(root, "proj-m"));
  const project = orgs.addProject(org.id, { name: "M", root: join(root, "proj-m") });
  const p = store.projectOverseerPaths(org.id, project.id);
  const legacy = [
    { sessionId: "s-gather", kind: "gathering", createdAt: "2026-09-01T00:00:00.000Z" },
    { sessionId: "s-code", kind: "coding", createdAt: "2026-09-02T00:00:00.000Z", path: "/nowhere/s-code.jsonl" },
  ];
  const writeLegacy = () => {
    mkdirSync(join(p.memo, ".."), { recursive: true });
    writeFileSync(p.memo, JSON.stringify({ version: 1, pending: ["a reason"], lastRunAt: null, lastRun: null, perDay: { "2026-09-01": 2 }, started: legacy }));
  };

  test("the paths: started.json in the repo, the watch memo and turn counters under the host's state root", () => {
    assert.ok(p.started.startsWith(join(orgs.orgDir(org.id), "projects", project.id, "overseer")));
    assert.ok(p.memo.startsWith(stateRoot()) && p.turn.startsWith(stateRoot()));
  });

  test("read: the old location while the new one is absent, and reading writes nothing", () => {
    writeLegacy();
    assert.deepEqual(store.readStarted(p).map((s) => s.sessionId), ["s-gather", "s-code"]);
    assert.equal(existsSync(p.started), false, "a read never moves it");
    assert.ok("started" in JSON.parse(readFileSync(p.memo, "utf8")));
  });

  test("the first write moves it: started.json has the old rows and the new one; the memo keeps only its own", () => {
    store.noteStarted(p, "s-new", "offer");
    const moved = JSON.parse(readFileSync(p.started, "utf8"));
    assert.deepEqual(moved.sessions.map((s: { sessionId: string }) => s.sessionId), ["s-gather", "s-code", "s-new"]);
    assert.equal(moved.sessions[1].path, "/nowhere/s-code.jsonl");
    const memo = JSON.parse(readFileSync(p.memo, "utf8"));
    assert.equal("started" in memo, false, "moved, not copied");
    assert.deepEqual([memo.pending, memo.perDay], [["a reason"], { "2026-09-01": 2 }], "the memo's own fields stay");
  });

  test("a memo write alone also moves it, and never loses the list", () => {
    rmSync(p.started);
    writeLegacy();
    store.writeMemo(p, { ...store.readMemo(p), pending: [] });
    assert.deepEqual(store.readStarted(p).map((s) => s.sessionId), ["s-gather", "s-code"]);
    assert.equal("started" in JSON.parse(readFileSync(p.memo, "utf8")), false);
    // An old list reappearing beside the new file (an old server wrote it) is dropped, not merged over it.
    writeLegacy();
    store.noteStarted(p, "s-later", "gathering");
    assert.deepEqual(store.readStarted(p).map((s) => s.sessionId), ["s-gather", "s-code", "s-later"]);
  });

  test("a coding session's spend is kept, so the budget still counts it where the file is missing", () => {
    store.recordTokens(p, new Map([["s-code", 1234]]));
    assert.equal(store.readStarted(p).find((s) => s.sessionId === "s-code")?.tokens, 1234);
  });
});

describe("clone + attach = the whole organization", async () => {
  const a = await orgs.createOrg({ name: "Northwind Traders", dir: join(root, "ws-a") });
  const aDir = orgs.orgDir(a.id);
  const tony = orgs.addPerson(a.id, { name: "Tony Reyes", role: "Finance", contact: { email: "tony@example.com" }, decides: ["payroll"] });
  orgs.applyChange(a.id, tony.id, { skills: ["SAP"] }, { kind: "wrapup", sessionId: "s", quote: "I run SAP" });
  mkdirSync(join(root, "proj-a"));
  const project = orgs.addProject(a.id, { name: "Portal", root: join(root, "proj-a") });
  const c1 = baton.createBaton({ orgId: a.id, projectId: project.id, to: tony.id, publicTitle: "Payroll day", goal: "Find the payroll day" });
  const again = baton.rotateLink(c1.sessionId);
  const overseer = await po.ensureProjectOverseer(a.id, project.id);
  const pA = store.projectOverseerPaths(a.id, project.id);
  store.noteStarted(pA, c1.sessionId, "gathering");
  await po.patchProjectOverseer(a.id, project.id, { autonomy: "L2" });
  const tokens = [c1.token!, again.token];

  // Committed as the hourly commit would, then cloned elsewhere; this host forgets the original.
  assert.equal((await commitAll(aDir, "test commit")).committed, true);
  const bDir = join(root, "ws-b");
  execFileSync("git", ["clone", "-q", aDir, bDir]);
  orgs.detachOrg(a.id);
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
  orgs.patchProject(b.id, project.id, { root: join(root, "proj-b") });

  test("the repo holds every file of the org's state", () => {
    const files = git(bDir, "ls-files").split("\n");
    const want = ["org.json", "roster.json", "roster-history.jsonl", "projects.json", "baton.json", `sessions/${c1.path.split("/").pop()}`];
    for (const f of want) assert.ok(files.includes(f), f);
    for (const f of ["overseer.json", "state.json", "started.json"]) assert.ok(files.includes(`projects/${project.id}/overseer/${f}`), f);
    assert.ok(files.some((f) => f.startsWith("sessions/") && f.endsWith(`_${overseer.id}.jsonl`)), "the overseer's transcript");
  });

  test("the same org on the new host: id, roster with history, projects, baton row, overseer state", async () => {
    assert.equal(b.id, a.id);
    assert.deepEqual(orgs.readRoster(b.id).map((p) => p.name), ["Tony Reyes"]);
    assert.deepEqual(orgs.readRoster(b.id)[0]!.skills, ["SAP"]);
    assert.ok(orgs.readHistory(b.id).some((h) => h.field === "skills" && h.by.kind === "wrapup" && h.by.quote === "I run SAP"), "the history came along");
    assert.equal(baton.batonById(c1.sessionId)?.row.publicTitle, "Payroll day");
    const info = await po.projectOverseerInfo(b.id, project.id);
    assert.equal(info.exists, true);
    assert.equal(info.id, overseer.id);
    assert.equal(info.settings.autonomy, "L2", "its setting came along");
    assert.ok(store.readStarted(store.projectOverseerPaths(b.id, project.id)).some((s) => s.sessionId === c1.sessionId), "the sessions it started");
  });

  test("its project overseers are paused at L0 until the operator sets a level on this host", async () => {
    const info = await po.projectOverseerInfo(b.id, project.id);
    assert.ok(info.paused, "paused since the attach");
    assert.equal(info.effective.autonomy, "L0");
    assert.match(info.effective.reason ?? "", /attached on this host/);
    // Setting the SAME level resumes it: the gesture is what counts.
    const resumed = await po.patchProjectOverseer(b.id, project.id, { autonomy: "L2" });
    assert.equal(resumed.paused, null);
    assert.equal(resumed.effective.autonomy, "L2");
    // Another settings change does not count as setting the level: only autonomy resumes.
    orgs.detachOrg(b.id);
    await orgs.attachOrg({ dir: bDir });
    await po.patchProjectOverseer(b.id, project.id, { watch: false });
    assert.ok((await po.projectOverseerInfo(b.id, project.id)).paused, "a watch toggle leaves it paused");
    await po.patchProjectOverseer(b.id, project.id, { autonomy: "L1", watch: true });
  });

  test("an org created on this host is not paused", async () => {
    const fresh = await orgs.createOrg({ name: "Fresh", dir: join(root, "ws-fresh") });
    mkdirSync(join(root, "proj-f"));
    const pr = orgs.addProject(fresh.id, { name: "F", root: join(root, "proj-f") });
    assert.equal(orgs.overseerPausedSince(fresh.id, pr.id), null);
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
    const poPath = (await po.projectOverseerInfo(b.id, project.id)).path!;
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
    assert.ok(existsSync(join(stateRoot(), "baton-links.json")), "the links live on the host");
  });
});

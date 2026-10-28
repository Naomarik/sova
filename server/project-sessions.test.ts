// Run: pnpm test -- server/project-sessions.test.ts
// Which project a session belongs to (server/project-sessions.ts): an overseer's marker, then a build, then the
// session's folder — a project root or inside it, a linked worktree of it (git's `.git` file), a gone worktree folder
// as Sova names them. And the folder a project's coding session may start in (`startCoding`'s `cwd`). A throwaway
// PI_CODING_AGENT_DIR (only the mode extension), git repositories under a scratch root; no model request is made.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(scratchRoot("sova-project-sessions-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
process.env.PI_CODING_AGENT_DIR = agentDir;
await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("./app");
const { app: sova_app } = buildApp({ extensionEntriesOf: async () => [] });
const orgs = await import("./orgs");
const po = await import("./project-overseer");
const { engineOf, registerProjectIn, setProjectArchived } = await import("./projects/spaces");
const { seedBuild } = await import("./org-test-fixtures");
const { projectSessionLookup } = await import("./project-sessions");
const { folderMatcher } = await import("./project-folder");
const { getSessionSummary } = await import("./sessions-index");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { Hono } = await import("hono");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
const { configureSessionFeed } = await import("./session-feed");
const { readAssignments } = await import("./session-groups");

after(async () => {
  await disposeAllChats();
  await settled(join(tmp, "ws"));
  rmSync(tmp, { recursive: true, force: true });
});

const ID = ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const initRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "master");
  writeFileSync(join(dir, "README"), "hello\n");
  git(dir, "add", "README");
  git(dir, ...ID, "commit", "-q", "-m", "README");
};
const dir = (...parts: string[]) => {
  const d = join(tmp, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};
/** A session file listed like any other: a header with its folder, and one user message. */
const sessionIn = (cwd: string, id: string): string => {
  const path = join(agentDir, "sessions", `${id}.jsonl`);
  const at = new Date().toISOString();
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`,
  );
  return path;
};
const nowhere = join(tmp, "no-such-file.jsonl");

// The registered projects: sova (a git repo), Inner (a repo nested inside sova), Old (archived), Site (placed in an org).
const web = dir("web");
const sova = join(web, "sova");
initRepo(sova);
mkdirSync(join(sova, "server"));
const inner = join(sova, "vendor", "inner");
initRepo(inner);
const old = dir("web", "old");
const site = dir("web", "site");
const sovaP = (await registerProjectIn("standalone", sova, { name: "sova", origin: "folder" })).project;
const innerP = (await registerProjectIn("standalone", inner, { name: "Inner", origin: "folder" })).project;
const oldP = (await registerProjectIn("standalone", old, { name: "Old", origin: "folder" })).project;
await setProjectArchived(oldP.id, true);
const org = await orgs.createOrg({ name: "Acme", dir: join(tmp, "ws") });
const siteP = await orgs.addProject(org.id, { name: "Site", root: site });

// A worktree beside the root, as Sova and the worktree tool name them, and one somewhere else.
const besideTree = join(web, ".worktrees", "sova-feat");
git(sova, "worktree", "add", "-q", "-b", "feat/x", "--", besideTree, "HEAD");
mkdirSync(join(besideTree, "server"), { recursive: true });
const farTree = join(tmp, "elsewhere", "wt");
git(sova, "worktree", "add", "-q", "-b", "feat/far", "--", farTree, "HEAD");

describe("a session's folder makes it the project's", () => {
  const of = (cwd: string) => projectSessionLookup().of(nowhere, `s-${Math.random()}`, cwd);
  const folderOf = (p: { id: string; name: string }) => ({ projectId: p.id, projectName: p.name, kind: "folder" });

  test("the root and a folder inside it: kind folder, never finished", () => {
    assert.deepEqual(of(sova), folderOf(sovaP));
    assert.deepEqual(of(join(sova, "server")), folderOf(sovaP));
    assert.deepEqual(of(`${sova}/`), folderOf(sovaP), "a trailing slash is the same folder");
  });

  test("a linked worktree is its main checkout's, beside the root or anywhere", () => {
    assert.deepEqual(of(besideTree), folderOf(sovaP));
    assert.deepEqual(of(join(besideTree, "server")), folderOf(sovaP));
    assert.deepEqual(of(farTree), folderOf(sovaP), "known by its .git file, not by where it is");
  });

  test("a worktree folder that is gone still matches by Sova's naming; another name does not", () => {
    assert.deepEqual(of(join(web, ".worktrees", "sova-gone", "server")), folderOf(sovaP));
    assert.equal(of(join(web, ".worktrees", "other-gone")), undefined);
    assert.equal(of(join(web, ".worktrees", "sova-")), undefined, "the bare prefix is no worktree");
  });

  test("a folder above the root, a sibling sharing its prefix, and a folder elsewhere never match", () => {
    assert.equal(of(web), undefined);
    assert.equal(of(dir("web", "sova-evil")), undefined);
    assert.equal(of(dir("other")), undefined);
    assert.equal(of("relative/path"), undefined);
    assert.equal(of(""), undefined);
  });

  test("nested roots: the deepest wins", () => {
    assert.deepEqual(of(inner), folderOf(innerP));
    assert.deepEqual(of(join(inner, "src")), folderOf(innerP));
    assert.deepEqual(of(join(sova, "vendor")), folderOf(sovaP));
  });

  test("an archived project's folder claims nothing", () => {
    assert.equal(of(old), undefined);
    assert.equal(of(join(old, "x")), undefined);
  });

  test("a placed project's folder is its project's too", () => {
    assert.deepEqual(of(join(site, "app")), folderOf(siteP));
  });

  test("a symlink into the root matches by its real path", () => {
    const link = join(tmp, "link-to-sova");
    symlinkSync(sova, link);
    assert.deepEqual(of(join(link, "server")), folderOf(sovaP));
  });

  test("a remote session's placeholder under the agent dir never matches, even under a root", () => {
    const match = folderMatcher([{ id: "all", root: tmp }], agentDir);
    assert.equal(match(join(agentDir, "sova", "targets", "box", "home", "u")), null);
    assert.equal(match(join(tmp, "web")), "all");
    assert.equal(of(join(agentDir, "sova", "targets", "box", sova)), undefined);
  });

  test("without a cwd only markers and builds count", () => {
    assert.equal(projectSessionLookup().of(nowhere, "x"), undefined);
  });

  test("the listing: a folder session of a standalone project has no org; a placed project's gets folderOrg, never org", async () => {
    const mine = await getSessionSummary(sessionIn(join(sova, "server"), "11111111-1111-4111-8111-111111111111"));
    assert.deepEqual(mine?.project, folderOf(sovaP));
    assert.equal(mine?.org, undefined);
    assert.equal(mine?.folderOrg, undefined);
    const placed = await getSessionSummary(sessionIn(site, "22222222-2222-4222-8222-222222222222"));
    assert.deepEqual(placed?.project, folderOf(siteP));
    assert.equal(placed?.org, undefined, "not organizational: nothing an org session is refused is refused to it");
    assert.deepEqual(placed?.folderOrg, { orgId: org.id, orgName: "Acme", projectId: siteP.id, projectName: "Site" });
    const plain = await getSessionSummary(sessionIn(dir("other"), "33333333-3333-4333-8333-333333333333"));
    assert.deepEqual([plain?.project, plain?.folderOrg, plain?.org], [undefined, undefined, undefined]);
  });

  test("precedence: an overseer's marker, then a build, then the folder", async () => {
    const overseer = await po.ensureProjectOverseer(sovaP.id);
    assert.equal(projectSessionLookup().of(overseer.path, overseer.id, sova)?.kind, "overseer");
    const build = await po.startCoding(sovaP.id, { worktree: "later", cwd: join(sova, "server") });
    const row = projectSessionLookup().of(build.path, build.sessionId, join(sova, "server"));
    assert.deepEqual(row, { projectId: sovaP.id, projectName: "sova", kind: "coding", operator: true });
  });

  test("who started a build: the operator's is marked operator, the overseer's is not", async () => {
    const mine = await po.startCoding(sovaP.id, { worktree: "later", cwd: sova });
    const listedMine = await getSessionSummary(mine.path);
    assert.deepEqual(listedMine?.project, { projectId: sovaP.id, projectName: "sova", kind: "coding", operator: true });
    const path = sessionIn(sova, "44444444-4444-4444-8444-444444444444");
    await seedBuild(engineOf(sovaP.id)!, sovaP.id, { sessionId: "44444444-4444-4444-8444-444444444444", kind: "coding", path });
    const theirs = projectSessionLookup().of(path, "44444444-4444-4444-8444-444444444444", sova);
    assert.deepEqual(theirs, { projectId: sovaP.id, projectName: "sova", kind: "coding" }, "the overseer's build carries no operator");
  });
});

describe("startCoding's cwd: the root, inside it, or inside one of its worktrees", () => {
  const app = new Hono();
  registerProjectOverseerRoutes(app);
  const post = (pid: string, body: unknown) =>
    app.request(`/api/projects/${pid}/overseer/coding`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const headerCwd = (path: string) => (JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as { cwd: string }).cwd;
  const sessionsDir = join(agentDir, "sessions");
  const files = () => readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).length;

  test("a folder inside the root starts there, never moved to the root", async () => {
    const res = await post(sovaP.id, { worktree: "later", cwd: join(sova, "server") });
    assert.equal(res.status, 201);
    const made = (await res.json()) as { path: string; worktree?: unknown };
    assert.equal(headerCwd(made.path), join(sova, "server"));
    assert.equal(made.worktree, undefined);
  });

  test("with no cwd it starts in the root", async () => {
    const made = await po.startCoding(sovaP.id, { worktree: "later" });
    assert.equal(headerCwd(made.path), sova);
  });

  test("a folder inside one of its linked worktrees", async () => {
    const made = await po.startCoding(sovaP.id, { worktree: "later", cwd: join(besideTree, "server") });
    assert.equal(headerCwd(made.path), join(besideTree, "server"));
  });

  test("a placed project's start runs in its org's engine, in the folder given", async () => {
    const made = await po.startCoding(siteP.id, { worktree: "later", cwd: site });
    assert.equal(headerCwd(made.path), site);
    const listed = await getSessionSummary(made.path);
    assert.equal(listed?.org?.kind, "coding", "its build: an org coding session");
    assert.equal(listed?.project?.kind, "coding");
  });

  test("anything else is refused with 400 and starts nothing", async () => {
    const before = files();
    for (const cwd of [web, dir("web", "sova-evil"), join(sova, "missing"), "server", join(sova, "..", "other"), 7, join(tmp, "elsewhere")]) {
      const res = await post(sovaP.id, { worktree: "later", cwd });
      assert.equal(res.status, 400, String(cwd));
      assert.match(((await res.json()) as { error: string }).error, /is not a folder in sova/);
    }
    assert.equal(files(), before);
  });
});

describe("groups: a project's own sessions may join one (its overseer's conversations, every build); an org's may not", () => {
  const assign = async (path: string, groupId: string | null) => {
    const res = await sova_app.request("/api/session-groups/assign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, groupId }) });
    return { status: res.status, body: (await res.json()) as { ok?: true; error?: string } };
  };
  const group = async () => {
    const res = await sova_app.request("/api/session-groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Spec audit" }) });
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: string }).id;
  };

  test("POST /api/session-groups/assign: an operator build, an overseer's build and a project overseer's conversation join; an org build gets 400", async () => {
    const g = await group();
    const mine = await po.startCoding(sovaP.id, { worktree: "later", cwd: sova });
    assert.deepEqual(await assign(mine.path, g), { status: 200, body: { ok: true } });
    assert.equal(readAssignments()[mine.sessionId], g);

    const theirsId = "55555555-5555-4555-8555-555555555555";
    const theirs = sessionIn(sova, theirsId);
    await seedBuild(engineOf(sovaP.id)!, sovaP.id, { sessionId: theirsId, kind: "coding", path: theirs });
    assert.deepEqual(await assign(theirs, g), { status: 200, body: { ok: true } });
    assert.equal(readAssignments()[theirsId], g);

    const overseer = await po.ensureProjectOverseer(sovaP.id);
    assert.deepEqual(await assign(overseer.path, g), { status: 200, body: { ok: true } });
    assert.equal(readAssignments()[overseer.id], g);

    const placed = await po.startCoding(siteP.id, { worktree: "later", cwd: site });
    assert.deepEqual(await assign(placed.path, g), { status: 400, body: { error: "Organization sessions stay with their project." } });
    assert.equal(readAssignments()[placed.sessionId], undefined, "nothing refused was written");

    // Still a project's: none of them leaves its project's place for Folders.
    for (const [path, id, kind] of [[mine.path, mine.sessionId, "coding"], [theirs, theirsId, "coding"], [overseer.path, overseer.id, "overseer"]] as const)
      assert.equal(projectSessionLookup().of(path, id, sova)?.kind, kind, id);
    // Taking one out always works, an org session's included.
    assert.deepEqual(await assign(placed.path, null), { status: 200, body: { ok: true } });
    for (const path of [theirs, overseer.path, mine.path]) assert.deepEqual(await assign(path, null), { status: 200, body: { ok: true } });
  });

  test("every group write is pushed to the feed's listeners as groups_changed", async () => {
    const feed = configureSessionFeed({ list: async () => [], intervalMs: 60_000, debounceMs: 0, minGapMs: 0 });
    const got: string[] = [];
    const remove = feed.add((m) => got.push(m.type));
    await feed.idle();
    try {
      const g = await group();
      const mine = await po.startCoding(sovaP.id, { worktree: "later", cwd: sova });
      await assign(mine.path, g);
      await sova_app.request(`/api/session-groups/${g}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed" }) });
      await sova_app.request(`/api/session-groups/${g}`, { method: "DELETE" });
      assert.equal(got.filter((t) => t === "groups_changed").length, 4, `create, assign, rename, delete; got ${JSON.stringify(got)}`);
      // A refused assignment writes nothing, so it pushes nothing.
      const g2 = await group();
      const placed = await po.startCoding(siteP.id, { worktree: "later", cwd: site });
      const before = got.length;
      assert.equal((await assign(placed.path, g2)).status, 400);
      assert.equal(got.slice(before).filter((t) => t === "groups_changed").length, 0);
    } finally {
      remove();
      feed.stop();
    }
  });
});

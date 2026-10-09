// Run: pnpm test -- server/project-coding-later.test.ts
// New Session's Project tab (`worktree: "later"`): a project coding session started in the project root, whose row
// adopts the first worktree its session makes itself with the `worktree` tool. REAL hosted runtimes in a throwaway
// PI_CODING_AGENT_DIR (only the mode extension), a git client project under a scratch root. The `worktree` tool's
// work is done here by hand, as it does it: `git worktree add -b feat/<name>` beside the repository, then its
// `worktrees` entry in the session file. No model request is made.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";
import { scratchRoot } from "./test-scratch";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(scratchRoot("sova-po-later-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
writeFileSync(join(agentDir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { buildApp } = await import("./app");
buildApp({ extensionEntriesOf: async () => [] });
const orgs = await import("./orgs");
const po = await import("./project-overseer");
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { WORKTREES } = await import("./harness/state-kinds");
const { settled } = await import("./workspace-git");
const { adoptableTree, noteBuildSettled, readBuild, withWorktreePath } = await import("./build-loadout");
const { offersMerge } = await import("../src/lib/coding-worktrees");
const { Hono } = await import("hono");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");

after(async () => {
  await disposeAllChats();
  await settled(join(tmp, "ws"));
  rmSync(tmp, { recursive: true, force: true });
});

const ID = ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, ...ID, "commit", "-q", "-m", file);
};
const initRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "master");
  commit(dir, "README", "hello\n");
};
const lines = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const notes = (path: string) => lines(path).filter((e) => e.type === "custom_message" && e.customType === po.CODING_WORKTREE_NOTE);

/** What the `worktree` tool's `create <name>` does: a branch feat/<name> in a worktree beside the repository. */
const toolCreate = (repo: string, name: string) => {
  const path = join(dirname(repo), ".worktrees", `${repo.split("/").pop()}-${name}`);
  git(repo, "worktree", "add", "-q", "-b", `feat/${name}`, "--", path, "HEAD");
  return { path: realpathSync(path), branch: `feat/${name}`, base: git(repo, "rev-parse", "HEAD") };
};
type Tree = { path: string; branch: string; base: string; baseBranch?: string; status: string; session: string; how: string; at: number };
/** The tool's `worktrees` entry (the whole set), written as the tool writes it: through the session's own runtime. */
async function writeTrees(sessionPath: string, trees: Tree[]): Promise<void> {
  (await acquireChat(sessionPath)).harness.state.append(WORKTREES, { version: 1, trees } as never);
}
/** The same entry written by a pi in a terminal: another process appends it, and no runtime here holds the file. */
async function writeTreesElsewhere(sessionPath: string, trees: Tree[]): Promise<void> {
  await disposeHeldChat(sessionPath, "test: the worktree tool writes");
  const last = lines(sessionPath).at(-1)!;
  const id = `wt${Math.random().toString(16).slice(2, 10)}`;
  appendFileSync(sessionPath, `${JSON.stringify({ type: "custom", customType: "worktrees", id, parentId: last.id ?? null, timestamp: new Date().toISOString(), data: { version: 1, trees } })}\n`);
}
/** The note goes in through the statechart's effect, after its act: wait for it (bounded). */
async function noteIn(path: string, n = 1): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 200 && notes(path).length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return notes(path);
}

describe("New Session's Project tab: a coding session in the root, adopting the worktree it makes", async () => {
  const org = await orgs.createOrg({ name: "Later", dir: join(tmp, "ws") });
  const client = join(tmp, "src", "client");
  initRepo(client);
  const project = await orgs.addProject(org.id, { name: "Portal", root: client });
  const app = new Hono();
  registerProjectOverseerRoutes(app);
  const post = (pid: string, body: unknown) =>
    app.request(`/api/projects/${pid}/overseer/coding`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sovaBranches = () => git(client, "branch", "--list", "sova/*");

  let first: { path: string; sessionId: string } | null = null;

  test('worktree "later" starts in the project root: no worktree, no branch, no note, nothing sent', async () => {
    const res = await post(project.id, { worktree: "later" });
    assert.equal(res.status, 201);
    const made = (await res.json()) as { path: string; sessionId: string; worktree?: unknown; note?: string; modeNotSet?: string };
    first = made;
    assert.deepEqual([made.worktree, made.note, made.modeNotSet], [undefined, undefined, undefined]);
    assert.equal(lines(made.path)[0]!.cwd, client, "its cwd is the project root");
    assert.equal(sovaBranches(), "", "Sova cut and named nothing");
    assert.equal(readdirSync(join(tmp, "src")).includes(".worktrees"), false);
    assert.deepEqual(notes(made.path), [], "no commit paragraph before it has a branch");
    assert.ok(!lines(made.path).some((e) => e.type === "message"), "nothing was sent");
    const row = readBuild(project.id, made.sessionId)!;
    assert.deepEqual([row.kind, row.later, row.worktree, row.inRoot], ["operator-coding", true, undefined, undefined]);
    const info = await po.projectOverseerInfo(project.id);
    const listed = info.worktrees.sessions.find((s) => s.sessionId === made.sessionId)!;
    assert.deepEqual([listed.state, listed.later, listed.branch, listed.inRoot], ["root", true, null, undefined]);
    assert.equal(offersMerge(listed), false);
    // The overseer's listing says the same.
    const list = po.toolsForTest(project.id).find((t) => t.name === "sova_list_sessions")!;
    const out = ((await list.execute("t", {}, undefined, undefined, undefined as never)).content[0] as { text: string }).text;
    assert.match(out, new RegExp(`${made.sessionId} .* in the project root until it makes a worktree`), out);
  });

  test("before it makes one, Merge Branch and Remove Worktree are refused with its own sentence", async () => {
    await assert.rejects(po.mergeCodingWorktree(project.id, first!.sessionId), /It runs in the project root until it makes a worktree\./);
    await assert.rejects(po.removeCodingWorktree(project.id, first!.sessionId), /It runs in the project root until it makes a worktree\./);
  });

  test("worktree is \"now\" or \"later\": anything else is refused and starts nothing", async () => {
    const sessionsDir = dirname(first!.path);
    const before = readdirSync(sessionsDir).length;
    const res = await post(project.id, { worktree: "bogus" });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'worktree is "now" or "later".');
    assert.equal(readdirSync(sessionsDir).length, before);
  });

  test("at its turn's end it adopts the first worktree its session made, as named; never an attached, dropped, other-repo or other session's", async () => {
    const { path, sessionId } = first!;
    const other = join(tmp, "src", "other");
    initRepo(other);
    const foreign = toolCreate(other, "elsewhere");
    const dropped = toolCreate(client, "gone");
    const attached = toolCreate(client, "borrowed");
    const theirs = toolCreate(client, "theirs");
    const mine = toolCreate(client, "pay");
    await writeTrees(path, [
      { ...foreign, baseBranch: "master", status: "active", session: sessionId, how: "created", at: 1 },
      { ...dropped, baseBranch: "master", status: "dropped", session: sessionId, how: "created", at: 2 },
      { ...attached, baseBranch: "master", status: "active", session: sessionId, how: "attached", at: 3 },
      { ...theirs, baseBranch: "master", status: "active", session: "someone-else", how: "created", at: 4 },
      { ...mine, baseBranch: "master", status: "active", session: sessionId, how: "created", at: 5 },
    ]);
    await noteBuildSettled(path, false);
    const row = readBuild(project.id, sessionId)!;
    assert.deepEqual(row.worktree && { branch: row.worktree.branch, base: row.worktree.base, target: row.worktree.target }, { branch: "feat/pay", base: mine.base, target: "master" });
    assert.ok(row.adoptedAt);
    assert.equal(row.later, undefined);
    assert.equal((await withWorktreePath(row, client))?.worktree.path, mine.path, "the tool's own path, never a derived sova/ one");
    assert.equal(sovaBranches(), "", "no sova/ branch, ever");
    const [note] = await noteIn(path);
    assert.equal(note?.content, po.codingWorktreeParagraph({ branch: "feat/pay", target: "master" }), "the commit paragraph names the adopted branch");
    const listed = (await po.projectOverseerInfo(project.id)).worktrees.sessions.find((s) => s.sessionId === sessionId)!;
    assert.deepEqual([listed.state, listed.branch, listed.worktree, listed.later], ["open", "feat/pay", mine.path, undefined]);

    // A later tree, at a later turn's end: the row keeps the one it adopted, and no second note.
    const next = toolCreate(client, "next");
    await writeTrees(path, [
      { ...mine, baseBranch: "master", status: "active", session: sessionId, how: "created", at: 5 },
      { ...next, baseBranch: "master", status: "active", session: sessionId, how: "created", at: 6 },
    ]);
    await noteBuildSettled(path, false);
    assert.equal(readBuild(project.id, sessionId)!.worktree?.branch, "feat/pay");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notes(path).length, 1);
  });

  test("then Merge Branch merges the adopted branch into its target, and Remove Worktree removes the tool's folder", async () => {
    const { sessionId } = first!;
    const wt = (await withWorktreePath(readBuild(project.id, sessionId)!, client))!.worktree;
    await assert.rejects(po.mergeCodingWorktree(project.id, sessionId), /feat\/pay has nothing to merge into master/);
    commit(wt.path, "pay.txt", "pay\n");
    const info = await po.mergeCodingWorktree(project.id, sessionId);
    assert.equal(readFileSync(join(client, "pay.txt"), "utf8"), "pay\n");
    const listed = info.worktrees.sessions.find((s) => s.sessionId === sessionId)!;
    assert.deepEqual([listed.state, listed.merged], ["merged", true]);
    await po.removeCodingWorktree(project.id, sessionId);
    assert.equal(existsSync(wt.path), false);
    assert.equal(git(client, "branch", "--list", "feat/pay"), "", "a merged branch goes with it");
  });

  test("the page's read adopts too (a session run in a terminal); with no base branch recorded, the target is the root's branch then", async () => {
    const res = await post(project.id, { worktree: "later" });
    const made = (await res.json()) as { path: string; sessionId: string };
    git(client, "checkout", "-q", "-b", "trunk");
    const tree = toolCreate(client, "terminal");
    await writeTreesElsewhere(made.path, [{ ...tree, status: "active", session: made.sessionId, how: "created", at: 1 }]);
    const listed = (await po.projectOverseerInfo(project.id)).worktrees.sessions.find((s) => s.sessionId === made.sessionId)!;
    assert.deepEqual([listed.branch, listed.target, listed.worktree, listed.state], ["feat/terminal", "trunk", tree.path, "open"]);
    git(client, "checkout", "-q", "master");
  });

  test("adopted mid-turn by the page's read, its commit note waits for the turn's end (a running turn refuses notes)", async () => {
    const res = await post(project.id, { worktree: "later" });
    const made = (await res.json()) as { path: string; sessionId: string };
    const tree = toolCreate(client, "midturn");
    await writeTrees(made.path, [{ ...tree, baseBranch: "master", status: "active", session: made.sessionId, how: "created", at: 1 }]);
    const session = piSession(await acquireChat(made.path)) as unknown as { _emit(e: unknown): void; isStreaming?: boolean };
    Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
    const listed = (await po.projectOverseerInfo(project.id)).worktrees.sessions.find((s) => s.sessionId === made.sessionId)!;
    assert.equal(listed.branch, "feat/midturn", "adopted on the page's read, mid-turn");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(notes(made.path), [], "no note while its turn runs");
    delete session.isStreaming;
    session._emit({ type: "agent_settled" });
    const [note] = await noteIn(made.path);
    assert.equal(note?.content, po.codingWorktreeParagraph({ branch: "feat/midturn", target: "master" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notes(made.path).length, 1, "once");
  });

  test("a worktree the session merged already is adopted (it offers Remove Worktree); none of its own: nothing", async () => {
    const res = await post(project.id, { worktree: "later" });
    const made = (await res.json()) as { path: string; sessionId: string };
    assert.equal(await adoptableTree(undefined, made.sessionId, client), null);
    assert.equal(await adoptableTree({ version: 1, trees: [] }, made.sessionId, client), null);
    const tree = toolCreate(client, "quick");
    const set = { version: 1 as const, trees: [{ ...tree, baseBranch: "master", status: "merged" as const, session: made.sessionId, how: "created" as const, at: 1 }] };
    assert.equal((await adoptableTree(set, made.sessionId, client))?.branch, "feat/quick");
  });

  test('the project page\'s New Coding Session still cuts its worktree at create ("now")', async () => {
    const res = await post(project.id, { worktree: "now" });
    assert.equal(res.status, 201);
    const made = (await res.json()) as { worktree?: { branch: string } };
    assert.match(made.worktree?.branch ?? "", /^sova\/coding-[0-9a-f]{6}$/);
  });
});

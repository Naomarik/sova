// The Setup chat's lifecycle on real git (main chat rulings, al_1): archived or Start Fresh'd with no commits beyond the
// target, its empty worktree and branch go and a new chat starts; archived with commits, the next press carries on in
// its folder on that branch; never "already running". It is a plain coding build, so a Project verbs run proceeds
// beside it. Merge Branch on its proposal is the user's own page's.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-setup-life-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions"), { recursive: true });

const { createOrg, addProject } = await import("../orgs");
const { closeAllOrgHosts } = await import("../org-engine");
const { openSetup, setupRecordOf, mergeSetup, NO_SETUP_PROPOSAL } = await import("./setup-chat");
const { onboardStamp } = await import("./runtime");
const { SETUP_MERGE_WORDS } = await import("./runtime-routes");
const { pageOnlyRefusal } = await import("../page-only");
after(() => closeAllOrgHosts());

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" }).trim();
const branches = (root: string) => git(root, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

const M = { model: "zai/glm-5.3" };
let n = 0;
async function project(): Promise<{ id: string; root: string }> {
  n++;
  const root = join(tmp, "code", `p${n}`);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "hi\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  const org = await createOrg({ name: `Org ${n}`, dir: join(tmp, "orgs", `o${n}`) });
  const p = await addProject(org.id, { name: `P${n}`, root });
  return { id: p.id, root };
}

/** Stand-ins over real git: a run cuts a real worktree and branch; archive moves the chat's file away. */
function stand(root: string) {
  const calls = { runs: 0, chats: [] as { cwd: string; text: string }[], removed: [] as string[] };
  let k = 0;
  const file = () => {
    const p = join(agentDir, "sessions", `${root.replace(/\W/g, "_")}-${++k}.jsonl`);
    writeFileSync(p, "");
    return p;
  };
  const deps = {
    startRun: async () => {
      calls.runs++;
      const sessionId = `run-${n}-${++k}`;
      const branch = `setup/${sessionId}`;
      const wt = join(tmp, "wt", sessionId);
      git(root, "worktree", "add", "-q", "-b", branch, wt, "main");
      const path = join(agentDir, "sessions", `${sessionId}.jsonl`);
      writeFileSync(path, "");
      return { sessionId, path, worktree: { path: wt, branch } };
    },
    startChat: async (cwd: string, text: string) => {
      calls.chats.push({ cwd, text });
      return { id: `chat-${n}-${k + 1}`, path: file() };
    },
    archive: async (path: string) => {
      rmSync(path);
      return { ok: true as const };
    },
    working: async () => false,
    removeEmpty: async (_pid: string, _sid: string, branch: string) => {
      calls.removed.push(branch);
      const list = git(root, "worktree", "list", "--porcelain");
      const path = list.split("\n\n").find((b) => b.includes(`branch refs/heads/${branch}`))?.match(/^worktree (.+)$/m)?.[1];
      if (path) git(root, "worktree", "remove", "--force", path);
      git(root, "branch", "-D", branch);
    },
  };
  return { deps, calls };
}

describe("the Setup chat's lifecycle", () => {
  test("archived with no commits beyond the target: its empty worktree and branch go, and the next press starts a new chat", async () => {
    const p = await project();
    const s = stand(p.root);
    const first = await openSetup(p.id, M, s.deps);
    const branch = first.worktree!.branch;
    assert.ok(branches(p.root).includes(branch));
    rmSync(first.path); // the user archived it (its file is gone from the list)
    const next = await openSetup(p.id, M, s.deps);
    assert.equal(next.reopened, false);
    assert.deepEqual(s.calls.removed, [branch], "the empty branch was removed by Sova");
    assert.equal(branches(p.root).includes(branch), false);
    assert.equal(existsSync(first.worktree!.path), false, "and its worktree");
    assert.equal(s.calls.runs, 2, "a new chat on a fresh branch");
    assert.notEqual(next.worktree!.branch, branch);
  });

  test("Start Fresh with no commits removes the empty branch too", async () => {
    const p = await project();
    const s = stand(p.root);
    const first = await openSetup(p.id, M, s.deps);
    await openSetup(p.id, { ...M, fresh: true }, s.deps);
    assert.deepEqual(s.calls.removed, [first.worktree!.branch]);
    assert.equal(setupRecordOf(p.id).history.at(-1)?.why, "fresh");
  });

  test("archived with commits: the next press carries on in its folder on that branch, never 'already running'", async () => {
    const p = await project();
    const s = stand(p.root);
    const first = await openSetup(p.id, M, s.deps);
    writeFileSync(join(first.worktree!.path, "setup.txt"), "x\n");
    git(first.worktree!.path, "add", ".");
    git(first.worktree!.path, "commit", "-q", "-m", "propose");
    rmSync(first.path); // archived
    const next = await openSetup(p.id, M, s.deps);
    assert.equal(next.reopened, false);
    assert.deepEqual(s.calls.removed, [], "a branch with commits is kept");
    assert.equal(s.calls.chats.at(-1)?.cwd, first.worktree!.path, "the new chat works in the same folder");
    assert.match(s.calls.chats.at(-1)!.text, /## Carrying on/);
    const rec = setupRecordOf(p.id).current!;
    assert.equal(rec.branch, first.worktree!.branch);
    assert.equal(rec.run, first.sessionId, "the proposal stays the first run's");
  });

  test("a Project verbs run proceeds beside an open Setup chat", async () => {
    const p = await project();
    const s = stand(p.root);
    await openSetup(p.id, M, s.deps);
    const { extra } = await onboardStamp(p.id, { playbook: "project-verbs", model: "zai/glm-5.3" });
    assert.equal((extra as { invalid?: string }).invalid ?? "", "", "no 'already running' from the Setup chat");
  });

  test("Merge Branch on the Setup proposal: nothing proposed is refused; only the user's own page passes", async () => {
    const p = await project();
    const s = stand(p.root);
    await openSetup(p.id, M, s.deps);
    await assert.rejects(mergeSetup(p.id, "sha256:x", undefined, { land: async () => false, merge: async () => {} }), (e: Error) => e.message === NO_SETUP_PROPOSAL);
    const app = new Hono();
    app.post("/x", (c) => c.json({ refused: pageOnlyRefusal(c, SETUP_MERGE_WORDS) }));
    const ask = async (headers: Record<string, string>) => ((await (await app.request("/x", { method: "POST", headers })).json()) as { refused: string | null }).refused;
    assert.equal(await ask({ "x-sova-caller": "k" }), SETUP_MERGE_WORDS.chat, "a chat's script");
    assert.equal(await ask({ "x-sova-token": "t" }), SETUP_MERGE_WORDS.script, "a script holding the token");
  });
});

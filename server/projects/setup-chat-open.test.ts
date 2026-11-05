// The Setup chat's standing chat and its Merge Branch (al_1), on real git: one standing chat per project, reopened by
// every Set Up with a Chat / Change Setup press; Start Fresh refused while the turn runs, and with commits on its branch
// it carries on there with the proposal kept. Merge Branch (mergeSetup): the shown hash and head, a passing trial of
// that exact head, then Land through the queue on a served project or a merge otherwise.
// (Archive/Start Fresh with no commits and the Project verbs run beside it: setup-lifecycle.test.ts.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-setup-open-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
mkdirSync(join(agentDir, "sessions"), { recursive: true });

const { createOrg, addProject } = await import("../orgs");
const { closeAllOrgHosts } = await import("../org-engine");
const { openSetup, setupRecordOf, STILL_WORKING, mergeSetup, readSetup, SETUP_CHANGED_SINCE, SETUP_BRANCH_MOVED, NO_SETUP_PROPOSAL } = await import("./setup-chat");
const { setMergeQueuesForTest, TRIAL_UNREADABLE } = await import("../merge-queue/wire");
const { MergeQueues } = await import("../merge-queue/queue");
const { standInRun } = await import("../merge-queue/testing/queue-kit");
const { definitionAt } = await import("../project-services/deploy-recipe");
const { checksOf } = await import("../merge-queue/checks");
after(() => closeAllOrgHosts());

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" }).trim();
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
  const calls = { runs: 0, chats: [] as { cwd: string; text: string }[], archived: [] as string[], removed: [] as string[] };
  const state = { working: false };
  let k = 0;
  const tag = root.split("/").pop();
  const deps = {
    startRun: async () => {
      calls.runs++;
      const sessionId = `run-${tag}-${++k}`;
      const wt = join(tmp, "wt", sessionId);
      git(root, "worktree", "add", "-q", "-b", `setup/${sessionId}`, wt, "main");
      const path = join(agentDir, "sessions", `${sessionId}.jsonl`);
      writeFileSync(path, "");
      return { sessionId, path, worktree: { path: wt, branch: `setup/${sessionId}` } };
    },
    startChat: async (cwd: string, text: string) => {
      calls.chats.push({ cwd, text });
      const id = `chat-${tag}-${++k}`;
      const path = join(agentDir, "sessions", `${id}.jsonl`);
      writeFileSync(path, "");
      return { id, path };
    },
    archive: async (path: string) => {
      calls.archived.push(path);
      rmSync(path);
      return { ok: true as const };
    },
    working: async () => state.working,
    removeEmpty: async (_pid: string, _sid: string, branch: string) => void calls.removed.push(branch),
  };
  return { deps, calls, state };
}

function commitIn(wt: string, files: Record<string, string>, msg = "propose"): string {
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(wt, f, ".."), { recursive: true });
    writeFileSync(join(wt, f), t);
  }
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", msg);
  return git(wt, "rev-parse", "HEAD");
}
const DEF = (checks: unknown) => `${JSON.stringify({ version: 1, merge: { checks } }, null, 2)}\n`;

describe("one standing Setup chat per project", () => {
  test("a second press reopens the same chat and starts nothing; another project gets its own", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, M, s.deps);
    assert.equal(first.reopened, false);
    for (let i = 0; i < 3; i++) {
      const again = await openSetup(a.id, M, s.deps);
      assert.equal(again.reopened, true, `press ${i + 2}`);
      assert.equal(again.sessionId, first.sessionId);
    }
    assert.equal(s.calls.runs, 1, "only the first press started a run");
    const b = await project();
    const other = await openSetup(b.id, M, stand(b.root).deps);
    assert.equal(other.reopened, false);
    assert.notEqual(other.sessionId, first.sessionId);
    assert.equal(setupRecordOf(a.id).current?.sessionId, first.sessionId, "the other project's press left this one alone");
  });
});

describe("Start Fresh", () => {
  test("refused while the chat's turn runs; nothing archived or started", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, M, s.deps);
    s.state.working = true;
    await assert.rejects(openSetup(a.id, { ...M, fresh: true }, s.deps), (e: Error) => e.message === STILL_WORKING);
    assert.deepEqual(s.calls.archived, []);
    assert.equal(s.calls.runs, 1);
    assert.equal(setupRecordOf(a.id).current?.sessionId, first.sessionId);
  });

  test("with commits on its branch: the old chat archived, its branch and run kept, the new chat carries on in that folder, told so", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, M, s.deps);
    commitIn(first.worktree!.path, { ".sova/project.json": DEF("none") });
    const fresh = await openSetup(a.id, { ...M, fresh: true }, s.deps);
    assert.deepEqual(s.calls.archived, [first.path]);
    assert.deepEqual(s.calls.removed, [], "a branch with commits is never removed");
    assert.equal(s.calls.runs, 1, "no new run (it would cut a new branch)");
    assert.equal(s.calls.chats.at(-1)?.cwd, first.worktree!.path);
    assert.match(s.calls.chats.at(-1)!.text, /## Carrying on/);
    assert.ok(s.calls.chats.at(-1)!.text.includes(first.worktree!.branch), "its first message names the branch");
    assert.deepEqual(fresh.worktree, first.worktree);
    const now = setupRecordOf(a.id);
    assert.equal(now.current?.run, first.sessionId, "the proposal stays the first run's");
    assert.deepEqual(now.history.map((h) => [h.sessionId, h.why, h.branch]), [[first.sessionId, "fresh", first.worktree!.branch]]);
    assert.equal((await openSetup(a.id, M, s.deps)).sessionId, fresh.sessionId, "one standing chat still");
  });
});

describe("Merge Branch on the Setup proposal (mergeSetup)", () => {
  const live = () => {
    const calls = { land: [] as string[], merge: [] as string[] };
    return { calls, deps: { land: async (_p: string, _r: string, _s: string, c: string) => (calls.land.push(c), served), merge: async (_p: string, s: string) => void calls.merge.push(s) } };
  };
  let served = false;

  test("nothing proposed, a changed hash, a moved head, no queue to confirm a trial, no passing trial: each refused, nothing merged; a passing trial of the head merges (unserved) or lands (served)", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, M, s.deps);
    const wt = first.worktree!.path;
    const l = live();
    await assert.rejects(mergeSetup(a.id, "sha256:x", undefined, l.deps), (e: Error) => e.message === NO_SETUP_PROPOSAL);
    const head = commitIn(wt, { ".sova/project.json": DEF([{ id: "t", label: "Tests", run: ["true"] }]) });
    const proposal = (await readSetup(a.id)).chat?.proposal;
    assert.ok(proposal?.hash, "a proposal with its hash");
    assert.equal(proposal.commit, head);
    await assert.rejects(mergeSetup(a.id, "sha256:other", head, l.deps), (e: Error) => e.message === SETUP_CHANGED_SINCE);
    // No queue running here: a setup branch's trial can't be confirmed, so it waits (fail closed).
    await assert.rejects(mergeSetup(a.id, proposal.hash, head, l.deps), (e: Error) => e.message === TRIAL_UNREADABLE);
    const stand2 = standInRun();
    const queues = new MergeQueues({ base: join(tmp, `mq-${n}`), runMerge: stand2.run, checksOf, definitionAt: (r, ref) => definitionAt(r, ref), notify: () => {}, thread: () => false, publish: () => {}, draftsHash: () => undefined, retryDelayMs: 40, watchMs: 25, conflictWaitMs: 60_000, log: () => {} });
    setMergeQueuesForTest(queues);
    try {
      await assert.rejects(mergeSetup(a.id, proposal.hash, head, l.deps), /no passing trial at/);
      const q = await queues.get(a.root);
      await q.trial({ branch: first.worktree!.branch, by: { kind: "operator" } });
      await q.tryingNow();
      assert.equal(q.trials()[0]?.verdict, "passed");
      // A commit after the trial (a script the hash doesn't cover): the page still shows the tried head.
      const newer = commitIn(wt, { "scripts/check.sh": "exit 1\n" }, "after the trial");
      await assert.rejects(mergeSetup(a.id, proposal.hash, head, l.deps), (e: Error) => e.message === SETUP_BRANCH_MOVED);
      await assert.rejects(mergeSetup(a.id, proposal.hash, newer, l.deps), /no passing trial at/, "the new head needs its own trial");
      assert.deepEqual([l.calls.land, l.calls.merge], [[], []], "nothing merged or landed so far");
      await q.trial({ branch: first.worktree!.branch, by: { kind: "operator" } });
      await q.tryingNow();
      served = false;
      assert.deepEqual(await mergeSetup(a.id, proposal.hash, newer, l.deps), { queued: false });
      assert.deepEqual(l.calls.merge, [first.sessionId], "unserved: Merge Branch merges the run's worktree");
      served = true;
      assert.deepEqual(await mergeSetup(a.id, proposal.hash, newer, l.deps), { queued: true });
      assert.deepEqual(l.calls.land, [newer, newer], "served: Land through the queue, pinned to the tried head");
      assert.equal(l.calls.merge.length, 1, "never merged when the queue lands it");
    } finally {
      setMergeQueuesForTest(null);
      await queues.stop();
    }
  });
});

describe("POST /api/projects/:pid/setup/merge: the user's own page only", () => {
  test("the Overseer, a chat's key, a token or no page at all is refused 403 with its words and nothing merged; the page itself reaches the proposal's own checks", async () => {
    const { Hono } = await import("hono");
    const { registerProjectRoutes } = await import("./routes");
    const { SETUP_MERGE_WORDS } = await import("./runtime-routes");
    const app = new Hono();
    registerProjectRoutes(app);
    const a = await project();
    const s = stand(a.root);
    const opened = await openSetup(a.id, M, s.deps);
    const { AUTH_COOKIE, initAuthToken } = await import("../auth");
    const cookie = `${AUTH_COOKIE}=${initAuthToken().token}`;
    /** `page`: the request carries the page's sign-in cookie (what the user's own page sends). */
    const post = async (headers: Record<string, string>, page = false) => {
      const r = await app.request(`/api/projects/${a.id}/setup/merge`, { method: "POST", headers: { "content-type": "application/json", ...(page ? { cookie } : {}), ...headers }, body: JSON.stringify({ hash: "sha256:x" }) });
      return { status: r.status, error: ((await r.json()) as { error?: string }).error };
    };
    const { OVERSEER_SENDER_HEADER, senderSecret } = await import("../overseer-sender");
    assert.deepEqual(await post({ [OVERSEER_SENDER_HEADER]: senderSecret() }, true), { status: 403, error: SETUP_MERGE_WORDS.overseer }, "the Overseer, even with the page cookie");
    assert.deepEqual(await post({ "x-sova-caller": "k" }), { status: 403, error: SETUP_MERGE_WORDS.chat });
    assert.deepEqual(await post({ "x-sova-caller": "k" }, true), { status: 403, error: SETUP_MERGE_WORDS.chat }, "a chat's process holding the cookie is still a chat");
    assert.deepEqual(await post({ "x-sova-token": "t" }, true), { status: 403, error: SETUP_MERGE_WORDS.script });
    assert.deepEqual(await post({}), { status: 403, error: SETUP_MERGE_WORDS.script }, "nothing shows the page");
    assert.deepEqual(await post({}, true), { status: 409, error: NO_SETUP_PROPOSAL }, "the page passes the gate; the proposal's own checks answer");
    // Needs you's Merge Branch posts to /runtime/merge: on a Setup proposal it is the same page-only gate.
    commitIn(opened.worktree!.path, { ".sova/project.json": DEF("none") });
    await readSetup(a.id);
    const viaRuntime = await app.request(`/api/projects/${a.id}/runtime/merge`, { method: "POST", headers: { "content-type": "application/json", "x-sova-caller": "k" }, body: JSON.stringify({ hash: "sha256:x" }) });
    assert.equal(viaRuntime.status, 403);
    assert.equal(((await viaRuntime.json()) as { error?: string }).error, SETUP_MERGE_WORDS.chat);
  });
});

describe("Needs you follows the Setup proposal at once", () => {
  test("a new proposal, and its going after the merge, each drop the attention digest's memo; a read with nothing new drops nothing and keeps its time", async () => {
    const { onAttentionNotified } = await import("../attention-memo");
    const { setupReviewOf } = await import("./setup-chat");
    let drops = 0;
    const off = onAttentionNotified(() => void drops++);
    try {
      const a = await project();
      const s = stand(a.root);
      const first = await openSetup(a.id, M, s.deps);
      await readSetup(a.id);
      assert.equal(setupReviewOf(a.id), null, "nothing proposed yet");
      const d0 = drops;
      commitIn(first.worktree!.path, { ".sova/project.json": DEF("none") });
      await readSetup(a.id);
      const item = setupReviewOf(a.id);
      assert.ok(item, "proposed: Needs you lists it");
      assert.equal(drops, d0 + 1, "the digest's memo dropped once");
      await readSetup(a.id);
      assert.equal(drops, d0 + 1, "read again: nothing changed, no drop");
      assert.equal(setupReviewOf(a.id)?.since, item.since, "its time kept");
      git(a.root, "merge", "-q", "--no-edit", first.worktree!.branch);
      await readSetup(a.id);
      assert.equal(setupReviewOf(a.id), null, "merged: Needs you lists it no more");
      assert.equal(drops, d0 + 2, "and the memo dropped, so the row goes at the next read");
    } finally {
      off();
    }
  });
});

describe("setupChatPaths: every Setup chat, current or replaced", () => {
  test("the current chat and the one Start Fresh replaced are both listed; another chat isn't", async () => {
    const { setupChatPaths } = await import("./setup-chat");
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, M, s.deps);
    commitIn(first.worktree!.path, { ".sova/project.json": DEF("none") });
    const fresh = await openSetup(a.id, { ...M, fresh: true }, s.deps);
    const paths = setupChatPaths();
    assert.ok(paths.has(first.path), "the replaced chat");
    assert.ok(paths.has(fresh.path), "the current chat");
    assert.equal(paths.has(join(agentDir, "sessions", "other.jsonl")), false);
  });
});

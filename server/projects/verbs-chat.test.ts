// The standing Project verbs chat (§app.project-runtime/onboard), on real git with stand-in starts: one chat per
// project, reopened by every press and never refused for having ended with "No change"; one worktree and branch for
// its life; a chat whose worktree or build is gone, or that was archived, is replaced on the next press (carrying on a
// kept branch with commits, else a new run on a new branch after the empty one goes), told the earlier chats; Start
// Fresh refused while working or with edits not committed; an overseer's start delivered to the open idle chat,
// refused while it works, waits on answers or holds a proposal not merged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-verbs-chat-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
mkdirSync(join(agentDir, "sessions"), { recursive: true });

const { createOrg, addProject } = await import("../orgs");
const { closeAllOrgHosts } = await import("../org-engine");
const V = await import("./verbs-chat");
after(() => closeAllOrgHosts());

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" }).trim();
const OVERSEER = { by: "overseer", attended: false } as never;

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
  const calls = { runs: [] as { why?: string; context?: string }[], chats: [] as { cwd: string; text: string; run: string }[], archived: [] as string[], removed: [] as string[], delivered: [] as { path: string; text: string }[], expected: [] as { run: string; startedBy: string; why?: string }[] };
  const state = { working: false, questions: 0, gone: new Set<string>(), may: null as string | null };
  let k = 0;
  const tag = root.split("/").pop();
  const deps: import("./verbs-chat").VerbsDeps = {
    prompt: async (_pid, input) => ({ prompt: `TURN\n---\n${input.context ?? input.why ?? ""}`, title: "Project verbs: P", model: "zai/glm-5.3", thinking: "low" }),
    startRun: async (_pid, input) => {
      calls.runs.push(input);
      const sessionId = `run-${tag}-${++k}`;
      const wt = join(tmp, "wt", sessionId);
      git(root, "worktree", "add", "-q", "-b", `sova/${sessionId}`, wt, "main");
      const path = join(agentDir, "sessions", `${sessionId}.jsonl`);
      writeFileSync(path, "");
      return { sessionId, path, worktree: { path: wt, branch: `sova/${sessionId}` }, target: "main" };
    },
    startChat: async (_pid, run, cwd, text) => {
      calls.chats.push({ cwd, text, run });
      const id = `chat-${tag}-${++k}`;
      const path = join(agentDir, "sessions", `${id}.jsonl`);
      writeFileSync(path, "");
      return { id, path };
    },
    archive: async (path) => {
      calls.archived.push(path);
      rmSync(path);
      return { ok: true as const };
    },
    live: async () => ({ working: state.working, questions: state.questions }),
    dirty: async (wt) => git(wt, "status", "--porcelain").length > 0,
    deliver: async (path, text) => void calls.delivered.push({ path, text }),
    removeEmpty: async (_pid, _sid, branch) => void calls.removed.push(branch),
    buildGone: (_pid, run) => state.gone.has(run),
    adoptable: async () => null,
    expectTurn: (_pid, run, by) => void calls.expected.push({ run, ...by }),
    overseerMay: () => state.may,
  };
  return { deps, calls, state };
}

function commitIn(wt: string, files: Record<string, string>): void {
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(wt, f, ".."), { recursive: true });
    writeFileSync(join(wt, f), t);
  }
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "Project verbs");
}

describe("one standing Project verbs chat per project", () => {
  test("the first press starts it; every press after opens it and starts nothing, whatever it last did", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, {}, s.deps);
    assert.equal(first.reopened, false);
    assert.equal(s.calls.runs.length, 1);
    // Ended with "No change" (no commits), then working, waiting, proposing: the press opens it each time.
    s.state.questions = 2;
    assert.equal((await V.openVerbsChat(a.id, {}, s.deps)).reopened, true);
    s.state.questions = 0;
    s.state.working = true;
    assert.equal((await V.openVerbsChat(a.id, {}, s.deps)).sessionId, first.sessionId);
    s.state.working = false;
    commitIn(first.worktree!.path, { ".sova/project.json": "{}\n" });
    const again = await V.openVerbsChat(a.id, {}, s.deps);
    assert.deepEqual([again.reopened, again.sessionId, again.worktree?.branch], [true, first.sessionId, first.worktree!.branch], "one worktree and branch for its life");
    assert.equal(s.calls.runs.length, 1, "only the first press started a run");
    assert.deepEqual([s.calls.delivered, s.calls.archived], [[], []], "a press sends nothing and archives nothing");
  });

  test("its first run has no earlier chats; a replacement is told them by path", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, { why: "first time" }, s.deps);
    assert.equal(s.calls.runs[0]?.context, undefined, "nothing earlier: the why alone");
    assert.equal(s.calls.runs[0]?.why, "first time");
    // Its worktree removed: it is no longer the project's chat; the next press starts a new chat on a new branch.
    s.state.gone.add(first.sessionId);
    const next = await V.openVerbsChat(a.id, {}, s.deps);
    assert.equal(next.reopened, false);
    assert.notEqual(next.worktree?.branch, first.worktree?.branch, "a new branch");
    assert.match(s.calls.runs[1]?.context ?? "", new RegExp(`## Earlier Project verbs chats[\\s\\S]*${first.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual(V.verbsRecordOf(a.id).history.map((h) => [h.sessionId, h.why]), [[first.sessionId, "ended"]]);
  });

  test("archived another way: with no commits the empty branch goes and a new run starts; with commits a new chat carries on there", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, {}, s.deps);
    rmSync(first.path); // archived (or deleted) outside Start Fresh
    const second = await V.openVerbsChat(a.id, {}, s.deps);
    assert.deepEqual(s.calls.removed, [first.worktree!.branch], "nothing beyond the target: its empty branch went");
    assert.equal(s.calls.runs.length, 2);
    commitIn(second.worktree!.path, { ".sova/project.json": "{}\n" });
    rmSync(second.path);
    const third = await V.openVerbsChat(a.id, {}, s.deps);
    assert.equal(s.calls.runs.length, 2, "no new run: the kept branch carries on");
    assert.deepEqual(s.calls.chats.map((c) => [c.cwd, c.run]), [[second.worktree!.path, second.sessionId]]);
    assert.match(s.calls.chats[0]!.text, /## Carrying on/);
    assert.equal(third.worktree?.branch, second.worktree!.branch);
    const cur = V.verbsRecordOf(a.id).current!;
    assert.deepEqual([cur.sessionId, cur.run], [third.sessionId, second.sessionId], "its proposal stays the earlier run's");
    assert.equal(V.verbsRunOfPath(third.path), second.sessionId, "its turns are that run's");
    assert.equal(V.verbsChatPathOfRun(second.sessionId), third.path);
    assert.equal(V.verbsRunOfPath(join(tmp, "elsewhere.jsonl")), null);
  });

  test("an archived project: the press is refused, nothing starts", async () => {
    const a = await project();
    const s = stand(a.root);
    const { setProjectArchived } = await import("./spaces");
    await setProjectArchived(a.id, true);
    await assert.rejects(V.openVerbsChat(a.id, {}, s.deps), /is archived\. Unarchive it first\.$/);
    assert.equal(s.calls.runs.length, 0);
  });
});

describe("Start Fresh", () => {
  test("refused while the chat works, and with edits not committed in its worktree; nothing archived or started", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, {}, s.deps);
    s.state.working = true;
    await assert.rejects(V.freshVerbsChat(a.id, {}, s.deps), (e: Error) => e.message === V.VERBS_STILL_WORKING);
    s.state.working = false;
    writeFileSync(join(first.worktree!.path, "half-done.txt"), "x\n");
    await assert.rejects(V.freshVerbsChat(a.id, {}, s.deps), (e: Error) => e.message === V.VERBS_DIRTY);
    assert.deepEqual(s.calls.archived, []);
    assert.equal(s.calls.runs.length, 1);
    assert.equal(V.VERBS_STILL_WORKING, "The Project verbs chat is working: wait for its turn to end (or stop it), then Start Fresh.");
    assert.equal(V.VERBS_DIRTY, "The Project verbs chat's worktree has edits not committed: commit or discard them in that chat, then Start Fresh.");
  });

  test("with no commits: archived, its empty branch goes, a new run on a new branch told the earlier chat", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, {}, s.deps);
    const fresh = await V.freshVerbsChat(a.id, {}, s.deps);
    assert.deepEqual(s.calls.archived, [first.path]);
    assert.deepEqual(s.calls.removed, [first.worktree!.branch]);
    assert.notEqual(fresh.sessionId, first.sessionId);
    assert.match(s.calls.runs[1]?.context ?? "", /## Earlier Project verbs chats/);
    assert.deepEqual(V.verbsRecordOf(a.id).history.map((h) => [h.sessionId, h.why]), [[first.sessionId, "fresh"]]);
    assert.equal(V.verbsRecordOf(a.id).current?.sessionId, fresh.sessionId);
  });

  test("with commits beyond the target: the new chat carries on in that worktree, branch and proposal", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, {}, s.deps);
    commitIn(first.worktree!.path, { ".sova/project.json": "{}\n" });
    const fresh = await V.freshVerbsChat(a.id, {}, s.deps);
    assert.deepEqual([s.calls.removed, s.calls.runs.length], [[], 1], "nothing removed, no new run");
    assert.deepEqual(fresh.worktree, first.worktree);
    assert.match(s.calls.chats[0]!.text, new RegExp(`The earlier Project verbs chat \\(${first.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
    assert.equal(V.verbsRecordOf(a.id).current?.run, first.sessionId);
  });

  test("with no open chat it says so", async () => {
    const a = await project();
    await assert.rejects(V.freshVerbsChat(a.id, {}, stand(a.root).deps), (e: Error) => e.message === V.NO_VERBS_CHAT);
  });
});

describe("an overseer's start", () => {
  test("open and idle: the playbook's turn and why are its next message, the run expects that turn; nothing archived", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, {}, s.deps);
    const out = await V.overseerVerbsStart(a.id, "bb.edn gained a worker", s.deps, OVERSEER);
    assert.equal(out.delivered, true);
    assert.deepEqual(s.calls.delivered.map((d) => d.path), [first.path]);
    assert.match(s.calls.delivered[0]!.text, /bb\.edn gained a worker/);
    assert.deepEqual(s.calls.expected, [{ run: first.sessionId, startedBy: "overseer", why: "bb.edn gained a worker" }]);
    assert.deepEqual([s.calls.archived, s.calls.runs.length], [[], 1]);
  });

  test("refused while it works, waits on the user's answers, or holds a proposal not merged; and by its power", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await V.openVerbsChat(a.id, {}, s.deps);
    s.state.working = true;
    await assert.rejects(V.overseerVerbsStart(a.id, "x", s.deps, OVERSEER), (e: Error) => e.message === 'The Project verbs playbook is already running: "Project verbs: P' + n + '".');
    s.state.working = false;
    s.state.questions = 3;
    await assert.rejects(V.overseerVerbsStart(a.id, "x", s.deps, OVERSEER), (e: Error) => e.message === `The Project verbs chat waits on the user's answers in "Project verbs: P${n}": a start reaches it once they are answered.`);
    s.state.questions = 0;
    commitIn(first.worktree!.path, { ".sova/project.json": "{}\n" });
    await assert.rejects(V.overseerVerbsStart(a.id, "x", s.deps, OVERSEER), (e: Error) => e.message === `The Project verbs chat's proposal on ${first.worktree!.branch} waits on the user's review: a start reaches it once it is merged.`);
    // Merged (the target has its commits): the chat is idle again and takes the start.
    git(a.root, "merge", "-q", "--ff-only", first.worktree!.branch);
    s.state.may = "Starting the Project verbs playbook is off for the overseer on its own.";
    await assert.rejects(V.overseerVerbsStart(a.id, "x", s.deps, OVERSEER), /is off for the overseer/);
    s.state.may = null;
    assert.equal((await V.overseerVerbsStart(a.id, "x", s.deps, OVERSEER)).delivered, true);
    assert.deepEqual(s.calls.delivered.length, 1, "only the last one reached it");
    assert.ok(existsSync(first.worktree!.path), "after a merge it carries on in the same worktree");
  });

  test("with no open chat: a new run, as a press starts one", async () => {
    const a = await project();
    const s = stand(a.root);
    const out = await V.overseerVerbsStart(a.id, "first time", s.deps, OVERSEER);
    assert.equal(out.delivered, undefined);
    assert.deepEqual(s.calls.runs, [{ why: "first time" }]);
    assert.equal(V.verbsRecordOf(a.id).current?.sessionId, out.sessionId);
  });
});

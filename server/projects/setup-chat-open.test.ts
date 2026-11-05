// The Setup chat's lifecycle (al_1): one standing chat per project, reopened by every Set Up with a Chat / Change
// Setup press; Start Fresh archives it, keeps its setup branch and open proposal, and the new chat carries on there.
// A throwaway PI_CODING_AGENT_DIR; the chat and run starters are stand-ins that record what they were asked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ProjectRuntimeView } from "../../shared/project-runtime";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-setup-open-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
mkdirSync(join(agentDir, "sessions"), { recursive: true });

const { createOrg, addProject } = await import("../orgs");
const { closeAllOrgHosts } = await import("../org-engine");
const { openSetup, setupRecordOf, STILL_WORKING } = await import("./setup-chat");
const { SETUP_PLAYBOOK_ID } = await import("./onboard");
after(() => closeAllOrgHosts());

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" }).trim();

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

/** Stand-ins: each started chat is a real (empty) file; archive renames it away, as an archive does. */
function stand(root: string) {
  const calls = { runs: [] as { context: string; title: string }[], chats: [] as { cwd: string; text: string; title: string }[], archived: [] as string[] };
  const state = { working: false, playbookState: "proposed" as ProjectRuntimeView["playbookState"], run: "" };
  let k = 0;
  const tag = root.split("/").pop();
  const file = () => {
    const p = join(agentDir, "sessions", `${root.replace(/\W/g, "_")}-${++k}.jsonl`);
    writeFileSync(p, "");
    return p;
  };
  const deps = {
    startRun: async (_pid: string, input: { context: string; title: string }) => {
      calls.runs.push(input);
      const path = file();
      const sessionId = `run-${tag}-${k}`;
      state.run = sessionId;
      return { sessionId, path, worktree: { path: join(tmp, "wt", sessionId), branch: `setup/${sessionId}` } };
    },
    startChat: async (cwd: string, text: string, title: string) => {
      calls.chats.push({ cwd, text, title });
      return { id: `chat-${tag}-${k + 1}`, path: file() };
    },
    archive: async (path: string) => {
      calls.archived.push(path);
      rmSync(path);
      return { ok: true as const };
    },
    working: async () => state.working,
    runtime: async () => ({ playbook: state.run ? { sessionId: state.run, playbookId: SETUP_PLAYBOOK_ID, proposes: "pipeline" } : undefined, playbookState: state.playbookState, can: { onboard: true } }) as unknown as ProjectRuntimeView,
  };
  return { deps, calls, state };
}

describe("one standing Setup chat per project", () => {
  test("a second press reopens the same chat and starts nothing; another project gets its own", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps);
    assert.equal(first.reopened, false);
    for (let i = 0; i < 3; i++) {
      const again = await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps);
      assert.equal(again.reopened, true, `press ${i + 2}`);
      assert.equal(again.sessionId, first.sessionId);
    }
    assert.equal(s.calls.runs.length, 1, "only the first press started a run");
    assert.match(s.calls.runs[0]!.title, /^Setup · p\d+$/);
    const b = await project();
    const sb = stand(b.root);
    const other = await openSetup(b.id, { model: "zai/glm-5.3" }, sb.deps);
    assert.equal(other.reopened, false);
    assert.notEqual(other.sessionId, first.sessionId);
    assert.equal(setupRecordOf(a.id).current?.sessionId, first.sessionId, "the other project's press left this one's record alone");
  });

  test("a chat archived elsewhere is history: the next press starts a new one", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps);
    rmSync(first.path);
    s.state.playbookState = "idle";
    const next = await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps);
    assert.equal(next.reopened, false);
    assert.notEqual(next.sessionId, first.sessionId);
    assert.deepEqual(setupRecordOf(a.id).history.map((h) => [h.sessionId, h.why]), [[first.sessionId, "ended"]]);
  });
});

describe("Start Fresh", () => {
  test("with a proposal open: the old chat is archived, its branch and run are kept, and the new chat carries on in that folder, told so", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps);
    const before = setupRecordOf(a.id).current!;
    s.state.playbookState = "proposed";
    const fresh = await openSetup(a.id, { fresh: true, model: "zai/glm-5.3" }, s.deps);
    assert.deepEqual(s.calls.archived, [first.path], "the old chat archived");
    assert.equal(s.calls.runs.length, 1, "no new run (a new run would cut a new branch)");
    assert.equal(s.calls.chats.length, 1);
    assert.equal(s.calls.chats[0]!.cwd, before.worktree, "the new chat works in the proposal's folder");
    assert.match(s.calls.chats[0]!.text, /## Carrying on/);
    assert.ok(s.calls.chats[0]!.text.includes(before.branch!), "its first message names the branch it carries on");
    assert.ok(s.calls.chats[0]!.text.includes(first.path), "and the earlier chat");
    assert.notEqual(fresh.sessionId, first.sessionId);
    assert.deepEqual(fresh.worktree, { path: before.worktree, branch: before.branch });
    const now = setupRecordOf(a.id);
    assert.equal(now.current?.run, before.run, "the proposal stays the old run's, so Land and Merge Branch still find it");
    assert.equal(now.current?.branch, before.branch);
    assert.deepEqual(now.history.map((h) => [h.sessionId, h.why, h.branch]), [[first.sessionId, "fresh", before.branch]]);
    // One standing chat still: the next press reopens the new one.
    assert.equal((await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps)).sessionId, fresh.sessionId);
  });

  test("with its run ended: the old chat is archived and a new run starts on a fresh branch", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps);
    s.state.playbookState = "idle";
    const fresh = await openSetup(a.id, { fresh: true, model: "zai/glm-5.3" }, s.deps);
    assert.deepEqual(s.calls.archived, [first.path]);
    assert.equal(s.calls.runs.length, 2);
    assert.equal(s.calls.chats.length, 0);
    assert.notEqual(setupRecordOf(a.id).current?.branch, `setup/${first.sessionId}`);
    assert.equal(fresh.reopened, false);
  });

  test("refused while the chat's turn runs; nothing archived or started", async () => {
    const a = await project();
    const s = stand(a.root);
    const first = await openSetup(a.id, { model: "zai/glm-5.3" }, s.deps);
    s.state.working = true;
    await assert.rejects(openSetup(a.id, { fresh: true, model: "zai/glm-5.3" }, s.deps), (e: Error) => e.message === STILL_WORKING);
    assert.deepEqual(s.calls.archived, []);
    assert.equal(s.calls.runs.length + s.calls.chats.length, 1);
    assert.equal(setupRecordOf(a.id).current?.sessionId, first.sessionId);
  });
});

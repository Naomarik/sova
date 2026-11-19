// The standing Project verbs chat on a real host (§app.project-runtime/onboard): after its run ended with "No change",
// a turn starting in it brings the registry's playbook region back to running and its commits propose; after its
// branch merged, its new commits bring it back. The routes: a press reopens the open chat (sending nothing), Start
// Fresh is the user's page only, the head's read names the chat, and the setup line says why before any press (no
// Git). A throwaway PI_CODING_AGENT_DIR; each test has its own project, whose run's build is started through
// `verbs/onboard` with its setup seeded.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { ProjectRuntimeView, VerbsChatStatus } from "../../shared/project-runtime";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-verbs-reattach-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { registerProjectRoutes } = await import("./routes");
const { closeAllOrgHosts, hostOf, onOrgChange } = await import("../org-engine");
const { buildSetupEnded, seedBuildEffectsForTest, noteBuildSettled } = await import("../build-loadout");
const { engineOf, operatorEnvelopeOf, projectSid, buildSid } = await import("./spaces");
const V = await import("./verbs-chat");
const { verbsDeps } = await import("./runtime-routes");
const { setOfferedRefsForTest, onboardModels } = await import("./onboard");
// A host whose model picker lists the playbook's first model, so no-model refuses nothing here.
const offered = async () => [onboardModels()[0]!];
setOfferedRefsForTest(offered);
after(() => {
  setOfferedRefsForTest(null);
  closeAllOrgHosts();
});

const app = new Hono();
registerProjectRoutes(app);
const { AUTH_COOKIE, initAuthToken } = await import("../auth");
const page = { cookie: `${AUTH_COOKIE}=${initAuthToken().token}` };
const json = (method: string, body?: unknown, headers: Record<string, string> = page) => ({ method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim();
const commit = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};
const definition = (port: number) => JSON.stringify({ version: 1, sources: ["index.html"], services: { site: { static: ".", ports: { http: { base: port, stride: 1 } } } } });

const SYSTEM = { by: "system" } as never;

// The registry's playbook region moves on its own org changes (runtime/<p>, build/<p>/…): a wait reads the registry
// again on each, never on a clock.
const waiters = new Set<() => void>();
onOrgChange((_org, change) => {
  if (change.sessions.some((sid) => sid.startsWith("runtime/") || sid.startsWith("build/"))) for (const w of [...waiters]) w();
});

let made = 0;

/** A project of its own with its Project verbs run ready to start: its worktree and session file, its build's setup
    seeded, the deps whose startRun starts it through verbs/onboard. */
async function project() {
  const n = ++made;
  const name = `site${n}`;
  const root = join(tmp, name);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  commit(root, { "index.html": "<p>hi</p>\n" }, "init");
  const res = await app.request("/api/projects", json("POST", { root }));
  assert.equal(res.status, 201);
  const pid = ((await res.json()) as { project: { id: string } }).project.id;
  const host = hostOf(engineOf(pid)!);
  const sessionId = `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const branch = `sova/project-verbs-${n}`;
  const wt = join(tmp, ".worktrees", `${name}-project-verbs`);
  git(root, "worktree", "add", "-q", "-b", branch, wt, "main");
  const sessionPath = join(agentDir, "sessions", `run-${n}.jsonl`);
  writeFileSync(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: wt })}\n`);
  seedBuildEffectsForTest(sessionId, { path: sessionPath, worktreePath: wt, made: { branch, base: git(root, "rev-parse", "HEAD"), target: "main" } });
  const bsid = buildSid(pid, sessionId);
  const deps = {
    ...verbsDeps(),
    startRun: async () => {
      const out = await host.act(projectSid(pid), "verbs/onboard", { sessionId, title: `Project verbs: ${name}`, prompt: "Run it", mode: { mode: "normal", minorModes: [] } }, operatorEnvelopeOf(pid), { settle: true });
      assert.equal(out.taken, true, JSON.stringify(out.refusal));
      await buildSetupEnded(pid, bsid);
      return { sessionId, path: sessionPath, worktree: { path: wt, branch }, target: "main" };
    },
  };
  const read = async (): Promise<ProjectRuntimeView> => (await (await app.request(`/api/projects/${pid}/runtime`)).json()) as ProjectRuntimeView;
  /** The registry once `ok` holds: read now and again on each of its org changes, up to a generous deadline. */
  const until = async (ok: (v: ProjectRuntimeView) => boolean, ms = 20_000): Promise<ProjectRuntimeView> => {
    const deadline = Date.now() + ms;
    for (;;) {
      let wake = () => {};
      const changed = new Promise<void>((r) => (wake = r));
      waiters.add(wake);
      try {
        const v = await read();
        if (ok(v)) return v;
        const left = deadline - Date.now();
        assert.ok(left > 0, JSON.stringify({ playbookState: v.playbookState, playbook: v.playbook }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([changed, new Promise<void>((r) => (timer = setTimeout(r, left)))]);
        clearTimeout(timer);
      } finally {
        waiters.delete(wake);
      }
    }
  };
  /** The first press starts the chat; its turn ends with no change. */
  const endedNoChange = async (): Promise<ProjectRuntimeView> => {
    const first = await V.openVerbsChat(pid, {}, deps);
    assert.deepEqual([first.reopened, first.sessionId], [false, sessionId]);
    await host.act(bsid, "turn/started", {}, SYSTEM);
    await noteBuildSettled(sessionPath, false);
    return until((x) => x.playbookState === "idle" && x.playbook?.result === "no-change");
  };
  /** After No change, a refinement typed: its turn brings the run back, and its commit proposes. */
  const refined = async (port: number): Promise<ProjectRuntimeView> => {
    await endedNoChange();
    await host.act(bsid, "turn/started", {}, SYSTEM);
    await until((x) => x.playbookState === "running");
    commit(wt, { ".sova/project.json": definition(port) }, "Project verbs: a refinement");
    await noteBuildSettled(sessionPath, false);
    return until((x) => x.playbookState === "proposed" && !!x.playbook?.review);
  };
  return { pid, name, root, host, sessionId, branch, wt, sessionPath, bsid, deps, read, until, endedNoChange, refined };
}

test("the first press starts the standing chat; its turn ends with no change", async () => {
  const p = await project();
  const v = await p.endedNoChange();
  assert.equal(v.can.onboard, true, "a chat that ended with no change refuses nothing");
});

test("a press opens it again, starting nothing; the head's read names it", async () => {
  const p = await project();
  await p.endedNoChange();
  // No model on the host refuses only a new start: the open chat is still offered and opened.
  setOfferedRefsForTest(async () => []);
  let r: Response;
  try {
    const line = await p.read();
    assert.deepEqual([line.can.onboard, line.can.onboardWhy], [true, undefined]);
    r = await app.request(`/api/projects/${p.pid}/verbs/onboard`, json("POST", {}));
  } finally {
    setOfferedRefsForTest(offered);
  }
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { sessionId: p.sessionId, path: p.sessionPath, reopened: true, worktree: { path: p.wt, branch: p.branch } });
  const head = (await (await app.request(`/api/projects/${p.pid}/verbs/chat`)).json()) as VerbsChatStatus;
  assert.deepEqual([head.chat?.sessionId, head.chat?.path, head.chat?.title, head.chat?.ahead, head.chat?.dirty, head.chat?.working], [p.sessionId, p.sessionPath, `Project verbs: ${p.name}`, 0, false, false]);
});

test("a refinement typed after No change: the turn starting brings the run back, its commits propose", async () => {
  const p = await project();
  const v = await p.refined(18951);
  assert.equal(v.playbook?.sessionId, p.sessionId, "the same run, the same branch");
  assert.equal(v.playbook?.review?.test, null);
  assert.deepEqual(v.playbook?.review?.setup, []);
});

test("Start Fresh is the user's page only: a script or a chat is refused, nothing archived", async () => {
  const p = await project();
  await p.endedNoChange();
  for (const headers of [{ "x-sova-token": "t" }, { "x-sova-caller": "k" }] as Record<string, string>[]) {
    const r = await app.request(`/api/projects/${p.pid}/verbs/chat/fresh`, json("POST", {}, headers));
    assert.equal(r.status, 403);
  }
  assert.equal(V.verbsRecordOf(p.pid).current?.sessionId, p.sessionId);
});

test("after its branch merged, its new commits bring the run back to proposed", async () => {
  const p = await project();
  await p.refined(18952);
  git(p.root, "merge", "-q", "--ff-only", p.branch);
  await p.host.act(p.bsid, "turn/started", {}, SYSTEM);
  await noteBuildSettled(p.sessionPath, false);
  await p.until((x) => x.playbookState === "idle" && x.playbook?.result === "merged");
  await p.host.act(p.bsid, "turn/started", {}, SYSTEM);
  commit(p.wt, { ".sova/project.json": definition(18953) }, "Project verbs: another refinement");
  await noteBuildSettled(p.sessionPath, false);
  const v = await p.until((x) => x.playbookState === "proposed");
  assert.equal(v.playbook?.sessionId, p.sessionId, "same worktree and branch after the merge");
});

test("a folder without Git: the setup line says why before any press, and a press says the same", async () => {
  const plain = join(tmp, "plain");
  mkdirSync(plain);
  writeFileSync(join(plain, "index.html"), "<p>no git</p>\n");
  const r = await app.request("/api/projects", json("POST", { root: plain }));
  assert.equal(r.status, 201, await r.clone().text());
  const p2 = ((await r.json()) as { project: { id: string; name: string } }).project;
  const v = (await (await app.request(`/api/projects/${p2.id}/runtime`)).json()) as ProjectRuntimeView;
  assert.equal(v.can.onboard, false);
  assert.equal(v.can.onboardWhy, `Running copies are set up on a branch: ${p2.name}'s folder isn't a Git repository.`);
  const press = await app.request(`/api/projects/${p2.id}/verbs/onboard`, json("POST", {}));
  assert.equal(press.status, 409);
  assert.equal(((await press.json()) as { error: string }).error, v.can.onboardWhy);
});

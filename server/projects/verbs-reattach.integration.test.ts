// Integration: a merge of the proposed definition starts the main checkout's copy on its real port.
// The standing Project verbs chat on a real host (§app.project-runtime/onboard): after its run ended with "No change",
// a turn starting in it brings the registry's playbook region back to running and its commits propose; after its
// branch merged, its new commits bring it back. The routes: a press reopens the open chat (sending nothing), Start
// Fresh is the user's page only, the head's read names the chat, and the setup line says why before any press (no
// Git). A throwaway PI_CODING_AGENT_DIR; the run's build is started through `verbs/onboard` with its setup seeded.
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
const { closeAllOrgHosts, hostOf } = await import("../org-engine");
const { buildSetupEnded, seedBuildEffectsForTest, noteBuildSettled } = await import("../build-loadout");
const { engineOf, operatorEnvelopeOf, projectSid, buildSid } = await import("./spaces");
const V = await import("./verbs-chat");
after(() => closeAllOrgHosts());

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

const root = join(tmp, "site");
mkdirSync(root);
git(root, "init", "-q", "-b", "main");
commit(root, { "index.html": "<p>hi</p>\n" }, "init");
const made = await app.request("/api/projects", json("POST", { root }));
assert.equal(made.status, 201);
const pid = ((await made.json()) as { project: { id: string } }).project.id;
const host = hostOf(engineOf(pid)!);
const SYSTEM = { by: "system" } as never;

const read = async (): Promise<ProjectRuntimeView> => (await (await app.request(`/api/projects/${pid}/runtime`)).json()) as ProjectRuntimeView;
async function until(ok: (v: ProjectRuntimeView) => boolean, ms = 5000): Promise<ProjectRuntimeView> {
  const t0 = Date.now();
  let v = await read();
  while (!ok(v) && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  assert.ok(ok(v), JSON.stringify({ playbookState: v.playbookState, playbook: v.playbook }));
  return v;
}

// The run, as the press starts it: its worktree and session file, its build through verbs/onboard with setup seeded.
const sessionId = "0199a000-0000-7000-8000-00000000vc01";
const branch = "sova/project-verbs-vc01";
const wt = join(tmp, ".worktrees", "site-project-verbs");
git(root, "worktree", "add", "-q", "-b", branch, wt, "main");
const sessionPath = join(agentDir, "sessions", "run.jsonl");
writeFileSync(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: wt })}\n`);
seedBuildEffectsForTest(sessionId, { path: sessionPath, worktreePath: wt, made: { branch, base: git(root, "rev-parse", "HEAD"), target: "main" } });
const bsid = buildSid(pid, sessionId);

const { verbsDeps } = await import("./runtime-routes");
const deps = {
  ...verbsDeps(),
  startRun: async () => {
    const out = await host.act(projectSid(pid), "verbs/onboard", { sessionId, title: "Project verbs: site", prompt: "Run it", mode: { mode: "normal", minorModes: [] } }, operatorEnvelopeOf(pid), { settle: true });
    assert.equal(out.taken, true, JSON.stringify(out.refusal));
    await buildSetupEnded(pid, bsid);
    return { sessionId, path: sessionPath, worktree: { path: wt, branch }, target: "main" };
  },
};

test("the first press starts the standing chat; its turn ends with no change", async () => {
  const first = await V.openVerbsChat(pid, {}, deps);
  assert.deepEqual([first.reopened, first.sessionId], [false, sessionId]);
  await host.act(bsid, "turn/started", {}, SYSTEM);
  await noteBuildSettled(sessionPath, false);
  const v = await until((x) => x.playbookState === "idle" && x.playbook?.result === "no-change");
  assert.equal(v.can.onboard, true, "a chat that ended with no change refuses nothing");
});

test("a press opens it again, starting nothing; the head's read names it", async () => {
  const r = await app.request(`/api/projects/${pid}/verbs/onboard`, json("POST", {}));
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { sessionId, path: sessionPath, reopened: true, worktree: { path: wt, branch } });
  const head = (await (await app.request(`/api/projects/${pid}/verbs/chat`)).json()) as VerbsChatStatus;
  assert.deepEqual([head.chat?.sessionId, head.chat?.path, head.chat?.title, head.chat?.ahead, head.chat?.dirty, head.chat?.working], [sessionId, sessionPath, "Project verbs: site", 0, false, false]);
});

test("a refinement typed after No change: the turn starting brings the run back, its commits propose", async () => {
  await host.act(bsid, "turn/started", {}, SYSTEM);
  await until((x) => x.playbookState === "running");
  commit(wt, { ".sova/project.json": definition(18951) }, "Project verbs: a refinement");
  await noteBuildSettled(sessionPath, false);
  const v = await until((x) => x.playbookState === "proposed" && !!x.playbook?.review);
  assert.equal(v.playbook?.sessionId, sessionId, "the same run, the same branch");
  assert.equal(v.playbook?.review?.test, null);
  assert.deepEqual(v.playbook?.review?.setup, []);
});

test("Start Fresh is the user's page only: a script or a chat is refused, nothing archived", async () => {
  for (const headers of [{ "x-sova-token": "t" }, { "x-sova-caller": "k" }] as Record<string, string>[]) {
    const r = await app.request(`/api/projects/${pid}/verbs/chat/fresh`, json("POST", {}, headers));
    assert.equal(r.status, 403);
  }
  assert.equal(V.verbsRecordOf(pid).current?.sessionId, sessionId);
});

test("after its branch merged, its new commits bring the run back to proposed", async () => {
  git(root, "merge", "-q", "--ff-only", branch);
  await host.act(bsid, "turn/started", {}, SYSTEM);
  await noteBuildSettled(sessionPath, false);
  await until((x) => x.playbookState === "idle" && x.playbook?.result === "merged");
  await host.act(bsid, "turn/started", {}, SYSTEM);
  commit(wt, { ".sova/project.json": definition(18952) }, "Project verbs: another refinement");
  await noteBuildSettled(sessionPath, false);
  const v = await until((x) => x.playbookState === "proposed");
  assert.equal(v.playbook?.sessionId, sessionId, "same worktree and branch after the merge");
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

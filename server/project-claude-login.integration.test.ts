// A project's own Claude login reaching the chats Sova starts (§app.claude-logins/project-login), end to end: a real
// server with real chat processes (startHermeticServer: the stand-in `claude`, scripts/fake-claude.mjs, first on PATH),
// a registry of three invented logins, and the login each chat's child starts on, read from its session's
// `claude-login` entry. Every project's login is one this device's order does not put first, so each case fails when
// the hand-over is missing. A chat in the project's folder and in one of its linked worktrees, the overseer, a chat in
// no project (saved logins are a last resort), the project's login limited (a note naming it), and after a server
// restart (each chat process starts again from the supervisor, which hands the context over again). Then a worker a
// project chat spawns, a team member and a /btw hidden chat, each a chat process the server starts from its loadout (the parent of the first two on the trial's scripted model, which calls
// agent_spawn and team_create). Processes: hence this tier.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
// This device's order is [B, A, C]: Acme and Beta are on A, Zeta on B. A child that missed the hand-over starts on B, so
// every case below tells the two apart: a project chat expects A, a chat in no project C (B saved for Zeta).
const A = "l-0000000a", B = "l-0000000b", C = "l-0000000c";
let acme = "";
let pid = "";
// Beta: a second project on A, for the workers, team member and hidden chat.
let beta = "";
// The trial's scripted model (scripts/chat-runtime-trial/mock-llm.mjs): a parent on it calls agent_spawn and
// team_create as its message's [call …] tags say, so its workers and team members start as a model starts them.
let trialMock: ChildProcess | undefined;
const TRIAL_MODEL = "trial/m1";
const CLAUDE_MODEL = "claude-code-cli/claude-opus-5-5";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${s.base}${path}`, { method, headers: { "x-sova-token": s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}
async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
type LoginEntry = { login: string; from?: string; reason?: string; text?: string };
const loginEntries = (path: string): LoginEntry[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === "claude-login")
    .map((e) => e.data as LoginEntry);

/** A new chat in `cwd` on the stand-in Claude model, one message sent, and its first `claude-login` entry. */
async function chatIn(cwd: string, model = CLAUDE_MODEL, text = "hello"): Promise<{ path: string; first: LoginEntry }> {
  const path = await sendIn(cwd, model, text);
  const first = await until(`a claude-login entry in ${path}\n${s.log().slice(-3000)}`, () => loginEntries(path)[0]);
  return { path, first };
}

/** A new chat in `cwd` on `model`, `text` sent; its session file. */
async function sendIn(cwd: string, model: string, text: string): Promise<string> {
  const made = await api("POST", "/api/sessions", { cwd });
  assert.ok(made.status === 200 || made.status === 201, JSON.stringify(made.body));
  const path = String(made.body.path);
  const conf = await api("POST", "/api/sessions/configure", { path, model });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const sent = await api("POST", "/api/sessions/prompt", { path, text });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  return path;
}

type WorkerRec = { kind: string; path: string; parent?: { path?: string; workerId?: string }; spec?: { cwd?: string } };
/** The server's worker records (§app.chat-processes/workers) whose parent is `parentPath`. */
function workersOf(parentPath: string): WorkerRec[] {
  const dir = join(s.agentDir, "sova", "chats", "workers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), "utf8")) as WorkerRec];
      } catch {
        return [];
      }
    })
    .filter((r) => r.parent?.path === parentPath);
}

/** The login a child chat ran on: the stand-in names it in its answer ("Fake answer from login <id>."), read only
    after the user message holding `asked` (a /btw thread is seeded with its parent's messages, its answers included). */
function answeredOn(path: string, asked: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const msgs = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message")
    .map((e) => e.message as { role?: string; content?: unknown });
  let at = -1;
  msgs.forEach((m, i) => {
    if (m.role === "user" && JSON.stringify(m.content ?? "").includes(asked)) at = i;
  });
  if (at < 0) return undefined;
  for (const m of msgs.slice(at + 1)) {
    const hit = m.role === "assistant" ? /Fake answer from login (\S+?)\./.exec(JSON.stringify(m.content ?? ""))?.[1] : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** A worker chat of `parentPath` that `pred` accepts, and the login it answered `asked` on (its first `claude-login`
    entry, when it keeps one, must agree). */
async function childLogin(parentPath: string, pred: (r: WorkerRec) => boolean, asked: string): Promise<{ rec: WorkerRec; login: string }> {
  const rec = await until(`a worker of ${parentPath}\n${s.log().slice(-3000)}`, () => workersOf(parentPath).find(pred), 60_000);
  const said = await until(`an answer in ${rec.path}\n${s.log().slice(-3000)}`, () => answeredOn(rec.path, asked), 60_000);
  const first = loginEntries(rec.path)[0];
  if (first) assert.equal(first.login, said, "its first claude-login entry names the login it answered on");
  return { rec, login: said };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

before(async () => {
  s = await startHermeticServer({ bootTimeoutMs: 60_000 });
  trialMock = spawn("node", [join(import.meta.dirname, "..", "scripts", "chat-runtime-trial", "mock-llm.mjs"), "--port", "0", "--log", join(s.scratch, "trial-mock.jsonl")], { stdio: ["ignore", "pipe", "inherit"] });
  const trialPort = await new Promise<number>((res, rej) => {
    let out = "";
    trialMock!.stdout!.on("data", (d) => {
      out += String(d);
      const m = /"port":(\d+)/.exec(out);
      if (m) res(Number(m[1]));
    });
    trialMock!.on("exit", (c) => rej(new Error(`the trial model exited (${c})`)));
  });
  const modelsFile = join(s.agentDir, "models.json");
  const models = JSON.parse(readFileSync(modelsFile, "utf8"));
  models.providers.trial = { baseUrl: `http://127.0.0.1:${trialPort}/v1`, api: "openai-completions", apiKey: "trial", models: [{ id: "m1", contextWindow: 100000, maxTokens: 4000 }] };
  writeFileSync(modelsFile, JSON.stringify(models, null, 2));
  // The Claude Code provider is pi-config's: linked in, then the server boots again so its runtime has it too.
  linkPiConfigExtensions(s.agentDir);
  await s.restart();
  // Three invented logins on this device, B first: a chat that got no hand-over starts on B.
  const login = (id: string) => ({ id, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: `acct-${id}`, email: `${id}@example.com` } });
  // Each signed in (the stand-in refuses a turn on a login directory with no credentials).
  for (const id of [A, B, C]) {
    mkdirSync(join(s.agentDir, "claude-accounts", id), { recursive: true, mode: 0o700 });
    writeFileSync(join(s.agentDir, "claude-accounts", id, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }));
  }
  writeFileSync(join(s.agentDir, "claude-accounts.json"), JSON.stringify({ version: 1, logins: [login(A), login(B), login(C)], devices: { local: { order: [B, A, C, "default"] } } }));
  acme = join(s.work, "acme");
  mkdirSync(acme);
  git(acme, "init", "-q", "-b", "main");
  writeFileSync(join(acme, "README.md"), "acme\n");
  git(acme, "add", "README.md");
  git(acme, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  git(acme, "worktree", "add", "-q", join(s.work, ".worktrees", "acme-feat"), "-b", "feat");
  const reg = await api("POST", "/api/projects", { root: acme, name: "Acme" });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  pid = reg.body.project.id;
  const put = await api("PUT", `/api/projects/${pid}/claude-login`, { login: A });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const project = async (name: string, login: string): Promise<string> => {
    const root = join(s.work, name.toLowerCase());
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "README.md"), `${name}\n`);
    git(root, "add", "README.md");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const r = await api("POST", "/api/projects", { root, name });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const put = await api("PUT", `/api/projects/${r.body.project.id}/claude-login`, { login });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    return root;
  };
  // Beta: the workers', team's and hidden chat's project. Zeta: holds B, this device's first, saved for it.
  beta = await project("Beta", A);
  await project("Zeta", B);
});
after(async () => {
  trialMock?.kill();
  await s?.stop();
  rmSync(s.scratch, { recursive: true, force: true });
});

let inProject = "";

test("a chat in the project's folder, and in one of its worktrees, starts on the project's login", async () => {
  const c = await chatIn(acme);
  assert.deepEqual([c.first.login, c.first.from], [A, undefined], "A, recorded with no note");
  await sleep(1000);
  assert.deepEqual(loginEntries(c.path).map((e) => e.login), [A], "and it stays there");
  inProject = c.path;
  const w = await chatIn(join(s.work, ".worktrees", "acme-feat"));
  assert.equal(w.first.login, A, "a linked worktree is the project's");
});

test("the project's overseer starts on the project's login too", async () => {
  const set = await api("PATCH", `/api/projects/${pid}/overseer`, { model: "claude-code-cli/claude-opus-5-5" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const opened = await api("POST", `/api/projects/${pid}/overseer`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const path = String(opened.body.path);
  // Run Now: the overseer's own look, a turn in its conversation (the prompt route is not its door).
  const ran = await api("POST", `/api/projects/${pid}/overseer/run`, {});
  assert.ok(ran.status < 300, JSON.stringify(ran.body));
  // Its loadout loads no pi-config extension, so it keeps no `claude-login` entry (its failovers neither): the stand-in's
  // answer names the login its child ran on.
  const said = await until(`the overseer's answer`, () => /Fake answer from login (\S+?)\./.exec(readFileSync(path, "utf8"))?.[1]);
  assert.equal(said, A);
});

test("a chat in no project takes the project's login only as a last resort", async () => {
  const c = await chatIn(s.work);
  assert.equal(c.first.login, C, "A is saved for Acme and Beta, B for Zeta, though B is first in this device's order");
});

test("the project's login limited: a new chat moves on, and its note names that login and why", async () => {
  writeFileSync(join(s.agentDir, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: { [A]: { kind: "limit", at: Date.now(), until: Date.now() + 3_600_000, window: "five_hour" } } }));
  try {
    const c = await chatIn(acme);
    assert.equal(c.first.login, C, "the next login with room that no other project keeps");
    assert.equal(c.first.from, A);
    assert.equal(c.first.reason, "moved");
    assert.match(c.first.text ?? "", new RegExp(`^Claude: using ${C}@example\\.com \\(project Acme's login ${A}@example\\.com is limited until `));
  } finally {
    writeFileSync(join(s.agentDir, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: {} }));
  }
});

test("after a server restart, chat processes started again still get the project's login", async () => {
  await s.restart();
  const c = await chatIn(acme);
  assert.equal(c.first.login, A, "a new chat after the restart");
  // The first chat, opened again on the restarted server, keeps its recorded login and records nothing new.
  const before = loginEntries(inProject).length;
  const sent = await api("POST", "/api/sessions/prompt", { path: inProject, text: "again" });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  await sleep(1500);
  assert.equal(loginEntries(inProject).length, before);
  assert.equal(loginEntries(inProject).at(-1)?.login, A);
});

// Workers, team members and hidden chats: each a chat process of its own, started by the server from its loadout
// (server/chat-host.ts startWorker). Each in Beta, whose login (A) is not this device's first (B).

test("a worker started from a project chat starts on the project's login", async () => {
  const parent = await sendIn(beta, TRIAL_MODEL, `[call agent_spawn ${JSON.stringify({ prompt: "hello worker", backend: "claude-code", name: "login-worker" })}]`);
  const w = await childLogin(parent, (r) => r.kind === "worker", "hello worker");
  assert.equal(w.rec.spec?.cwd, beta, "it runs in the project's folder");
  assert.equal(w.login, A, "Beta's login, not this device's first");
});

test("a team member starts on the project's login", async () => {
  const team = { name: "login-team", objective: "login check", defaults: { coordinator: false, monitor: false }, members: [{ role: "alpha", backend: "claude-code", prompt: "hello member" }] };
  const parent = await sendIn(beta, TRIAL_MODEL, `[call team_create ${JSON.stringify(team)}]`);
  const m = await childLogin(parent, (r) => r.kind === "worker", "hello member");
  assert.equal(m.rec.spec?.cwd, beta);
  assert.equal(m.login, A);
});

test("a hidden chat of a project chat (/btw) starts on the project's login", async () => {
  const parent = await chatIn(beta);
  assert.equal(parent.first.login, A, "the parent itself");
  const sent = await api("POST", "/api/sessions/prompt", { path: parent.path, text: "/btw a side question" });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  const h = await childLogin(parent.path, (r) => r.kind === "btw", "a side question");
  assert.equal(h.login, A);
});

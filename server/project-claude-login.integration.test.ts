// A project's own Claude login reaching the chats Sova starts (§app.claude-logins/project-login), end to end: a real
// server with real chat processes (startHermeticServer: the stand-in `claude`, scripts/fake-claude.mjs, first on PATH),
// a registry of two invented logins, and the login each chat's child starts on, read from its session's newest
// `claude-login` entry. A chat in the project's folder and in one of its linked worktrees, a chat in no project (the
// saved login is a last resort), the project's login limited (a note naming it), and after a server restart (each
// chat process starts again from the supervisor, which hands the context over again). Processes: hence this tier.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
const A = "l-0000000a", B = "l-0000000b";
let acme = "";
let pid = "";

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
async function chatIn(cwd: string): Promise<{ path: string; first: LoginEntry }> {
  const made = await api("POST", "/api/sessions", { cwd });
  assert.ok(made.status === 200 || made.status === 201, JSON.stringify(made.body));
  const path = String(made.body.path);
  const conf = await api("POST", "/api/sessions/configure", { path, model: "claude-code-cli/claude-opus-5-5" });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const sent = await api("POST", "/api/sessions/prompt", { path, text: "hello" });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  const first = await until(`a claude-login entry in ${path}\n${s.log().slice(-3000)}`, () => loginEntries(path)[0]);
  return { path, first };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

before(async () => {
  s = await startHermeticServer({ bootTimeoutMs: 60_000 });
  // The Claude Code provider is pi-config's: linked in, then the server boots again so its runtime has it too.
  linkPiConfigExtensions(s.agentDir);
  await s.restart();
  // Two invented logins on this device, B first: a chat in no project would start on B.
  const login = (id: string) => ({ id, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: `acct-${id}`, email: `${id}@example.com` } });
  // Each signed in (the stand-in refuses a turn on a login directory with no credentials).
  for (const id of [A, B]) {
    mkdirSync(join(s.agentDir, "claude-accounts", id), { recursive: true, mode: 0o700 });
    writeFileSync(join(s.agentDir, "claude-accounts", id, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }));
  }
  writeFileSync(join(s.agentDir, "claude-accounts.json"), JSON.stringify({ version: 1, logins: [login(A), login(B)], devices: { local: { order: [B, A, "default"] } } }));
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
  const put = await api("PUT", `/api/projects/${pid}/claude-login`, { login: B });
  assert.equal(put.status, 200, JSON.stringify(put.body));
});
after(async () => {
  await s?.stop();
  rmSync(s.scratch, { recursive: true, force: true });
});

let inProject = "";

test("a chat in the project's folder, and in one of its worktrees, starts on the project's login", async () => {
  const c = await chatIn(acme);
  assert.deepEqual([c.first.login, c.first.from], [B, undefined], "B, recorded with no note");
  await sleep(1000);
  assert.deepEqual(loginEntries(c.path).map((e) => e.login), [B], "and it stays there");
  inProject = c.path;
  const w = await chatIn(join(s.work, ".worktrees", "acme-feat"));
  assert.equal(w.first.login, B, "a linked worktree is the project's");
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
  assert.equal(said, B);
});

test("a chat in no project takes the project's login only as a last resort", async () => {
  const c = await chatIn(s.work);
  assert.equal(c.first.login, A, "B is saved for Acme, though it is first in this device's order");
});

test("the project's login limited: a new chat moves on, and its note names that login and why", async () => {
  writeFileSync(join(s.agentDir, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: { [B]: { kind: "limit", at: Date.now(), until: Date.now() + 3_600_000, window: "five_hour" } } }));
  try {
    const c = await chatIn(acme);
    assert.equal(c.first.login, A);
    assert.equal(c.first.from, B);
    assert.equal(c.first.reason, "moved");
    assert.match(c.first.text ?? "", new RegExp(`^Claude: using ${A}@example\\.com \\(project Acme's login ${B}@example\\.com is limited until `));
  } finally {
    writeFileSync(join(s.agentDir, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: {} }));
  }
});

test("after a server restart, chat processes started again still get the project's login", async () => {
  await s.restart();
  const c = await chatIn(acme);
  assert.equal(c.first.login, B, "a new chat after the restart");
  // The first chat, opened again on the restarted server, keeps its recorded login and records nothing new.
  const before = loginEntries(inProject).length;
  const sent = await api("POST", "/api/sessions/prompt", { path: inProject, text: "again" });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  await sleep(1500);
  assert.equal(loginEntries(inProject).length, before);
  assert.equal(loginEntries(inProject).at(-1)?.login, B);
});

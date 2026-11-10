// Run: pnpm test:int -- server/shell-mode-zsh.integration.test.ts
// A `!` command when the user's login shell is zsh (§chat.shell-mode/running), on a whole hermetic server with real
// chat processes: it runs in zsh with the stand-in setup in the server's home loaded first (the login profile, then
// the shell config), so the config's alias and function and the profile's variable work, and nothing the setup
// prints shows; the command is saved exactly as typed; a setup that fails still runs the command; Stop ends what
// the command started; a sandbox On chat loads the same setup, confined; and with bash as the login shell nothing
// of it loads, as before. With ZDOTDIR set for the server, a confined command reads the setup there, not the home
// folder's, while the agent's own confined commands never see ZDOTDIR. zsh is the one on PATH; skipped, saying so,
// where there is none. The sandbox cases run off /tmp on Linux (shell-mode-sandbox.test.helper.ts) and fail there
// when the sandbox refuses, unless bwrap is missing. Every wait is on a frame or a condition, never a sleep.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { authCookieName } from "./auth";
import { onPath, refusalSkip, sandboxRoot, stopSandboxed } from "./shell-mode-sandbox.test.helper";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

const ZSH = onPath("zsh");
const noZsh = ZSH ? false : "no zsh on PATH on this computer";

/** The stand-in setup: each file prints to stdout and stderr, which must never show. */
const PROFILE = `export ORDER=profile\necho profile-noise\necho profile-noise-err >&2\n`;
const CONFIG = `ORDER="$ORDER,config"\nalias hi='echo hi-from-alias'\nfn() { echo fn-out; }\necho config-noise\necho config-noise-err >&2\n`;
const setupFiles = (home: string) => [join(home, ".zprofile"), join(home, ".zshrc")];
function writeSetup(home: string, config = CONFIG): void {
  const [profile, rc] = setupFiles(home);
  writeFileSync(profile!, PROFILE);
  writeFileSync(rc!, config);
}

let zsh: HermeticServer | undefined;
before(async () => {
  if (noZsh) return;
  zsh = await startHermeticServer({ env: { SHELL: ZSH! }, extensions: ["sandbox"], root: sandboxRoot() });
  writeSetup(zsh.home);
});
after(async () => {
  // The sentinel home as it was, so the server's stop finds it unchanged.
  if (zsh) for (const f of setupFiles(zsh.home)) rmSync(f, { force: true });
  if (zsh) await stopSandboxed(zsh);
});

async function api(s: HermeticServer, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${s.base}${path}`, { method, headers: { "x-sova-token": s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}
/** Poll a condition (a frame, the file, a process) until it holds. */
async function until<T>(what: string, fn: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Session { id: string; path: string }
const newSession = async (s: HermeticServer): Promise<Session> => (await api(s, "POST", "/api/sessions", { cwd: s.work })).body;
const bashEntries = (ses: Session): any[] =>
  readFileSync(ses.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "message" && e.message?.role === "bashExecution");

/** The page's chat socket (the only one that runs a command), and `run`: a command's end, or its refusal. */
async function page(s: HermeticServer, ses: Session) {
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(ses.path)}&tail=rest&wire=2`, { headers: { cookie: `${authCookieName(s.agentDir)}=${s.token}` } } as never);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  await until("the socket's hello", () => frames.find((f) => f.type === "hello"));
  let n = 0;
  const find = (what: string, pred: (f: any) => boolean) => until(what, () => frames.find(pred));
  const start = async (command: string) => {
    const clientId = `c${++n}`;
    ws.send(JSON.stringify({ type: "shell", command, clientId }));
    return find(`${command}: its start or refusal`, (f) => (f.type === "shell_refused" || f.type === "shell_start") && f.clientId === clientId);
  };
  const run = async (command: string): Promise<{ refused: string } | { end: any; saved: any }> => {
    const got = await start(command);
    if (got.type === "shell_refused") return { refused: got.message as string };
    const end = await find(`${command}: its end`, (f) => f.type === "shell_end" && f.id === got.run.id);
    const saved = await find(`${command}: saved`, (f) => f.type === "shell_saved" && f.id === got.run.id);
    return { end, saved };
  };
  return { frames, find, start, run, send: (m: unknown) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}
const ran = (r: Awaited<ReturnType<Awaited<ReturnType<typeof page>>["run"]>>) => {
  assert.ok(!("refused" in r), `refused: ${"refused" in r ? r.refused : ""}`);
  return r;
};

const TYPED = "hi; fn; echo $ORDER; exit 3";
const QUOTED = `cat <<'EOF'\nit's $HOME\nEOF\nprintf '%s\\n' "it's" "$((1+2))"`;

test("with zsh as the login shell, a command gets the setup's alias, function and variable, none of its output, and is saved as typed", { skip: noZsh }, async () => {
  const s = zsh!;
  const ses = await newSession(s);
  const a = await page(s, ses);
  const r = ran(await a.run(TYPED));
  assert.deepEqual([r.end.output, r.end.exitCode], ["hi-from-alias\nfn-out\nprofile,config\n", 3], "the profile, then the config; nothing they print");
  const q = ran(await a.run(QUOTED));
  assert.deepEqual([q.end.output, q.end.exitCode], ["it's $HOME\nit's\n3\n", 0], "quotes, a heredoc and $HOME reach zsh as typed");
  const saved = bashEntries(ses);
  assert.deepEqual(
    saved.map((e) => [e.id, e.message.command, e.message.output, e.message.exitCode]),
    [
      [r.saved.entryId, TYPED, r.end.output, 3],
      [q.saved.entryId, QUOTED, q.end.output, 0],
    ],
    "the record is the typed command, never the setup",
  );
  a.close();
});

test("a setup that fails (a missing command, a parse error) still runs the command, with what loaded before it", { skip: noZsh }, async () => {
  const s = zsh!;
  writeSetup(s.home, `alias hi='echo hi-anyway'\nno-such-command-q7\nif then (\n`);
  try {
    const ses = await newSession(s);
    const a = await page(s, ses);
    const r = ran(await a.run("hi; echo ran"));
    assert.deepEqual([r.end.output, r.end.exitCode], ["hi-anyway\nran\n", 0]);
    a.close();
  } finally {
    writeSetup(s.home);
  }
});

test("Stop ends the command and what it started in the background", { skip: noZsh }, async () => {
  const s = zsh!;
  const ses = await newSession(s);
  const a = await page(s, ses);
  const pidFile = join(s.work, `bg-${Date.now()}`);
  const start = await a.start(`fn; sleep 60 & echo $! > ${pidFile}; wait`);
  assert.equal(start.type, "shell_start");
  const pid = await until("the background sleep's pid", () => (existsSync(pidFile) && Number(readFileSync(pidFile, "utf8").trim())) || undefined);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(), "the background sleep runs");
  a.send({ type: "shell_stop", id: start.run.id });
  const end = await a.find("the stopped end", (f) => f.type === "shell_end" && f.id === start.run.id);
  assert.deepEqual([end.cancelled, end.cancelReason, end.output], [true, "user", "fn-out\n"]);
  await until("the background sleep gone", () => !alive());
  a.close();
});

test("with the sandbox On, the command loads the same setup and runs confined", { skip: noZsh }, async (t) => {
  const s = zsh!;
  const ses = await newSession(s);
  const a = await page(s, ses);
  const on = await api(s, "POST", `/api/sandbox?path=${encodeURIComponent(ses.path)}`, { state: "on" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.notEqual(on.body.outcome, "unsupported", JSON.stringify(on.body));
  const homeFile = join(s.home, `zsh-on-${Date.now()}`);
  const r = await a.run(`${TYPED.replace("; exit 3", "")}; touch ${homeFile} 2>/dev/null || echo home-closed`);
  a.close();
  // A computer whose sandbox can't run (no bwrap; a probe that fails, as inside another sandbox): refused, fail-closed.
  // Reported as skipped, never as passed; on Linux with bwrap, a failure (ran's).
  const why = "refused" in r ? refusalSkip(r.refused) : undefined;
  if (why) return t.skip(why);
  const done = ran(r);
  assert.equal(existsSync(homeFile), false, "the home folder is closed to it");
  assert.deepEqual([done.end.output, done.end.exitCode], ["hi-from-alias\nfn-out\nprofile,config\nhome-closed\n", 0]);
});

test("with ZDOTDIR set for the server, a confined command reads the setup there; the agent's own confined command never sees ZDOTDIR", { skip: noZsh }, async (t) => {
  const base = sandboxRoot() ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const zdotdir = realpathSync(mkdtempSync(join(base, "zdot-")));
  // ZDOTDIR's config and the home folder's define the alias apart: a run that reads the home folder's shows it.
  writeFileSync(join(zdotdir, ".zshrc"), "alias hi='echo hi-from-zdotdir'\n");
  const s = await startHermeticServer({ env: { SHELL: ZSH!, ZDOTDIR: zdotdir }, extensions: ["sandbox"], root: sandboxRoot() });
  const homeRc = join(s.home, ".zshrc");
  writeFileSync(homeRc, "alias hi='echo hi-from-home'\n");
  try {
    const ses = await newSession(s);
    const a = await page(s, ses);
    const off = ran(await a.run("hi"));
    assert.equal(off.end.output, "hi-from-zdotdir\n", "with the sandbox Off zsh reads ZDOTDIR's setup: the check below can fail");
    const on = await api(s, "POST", `/api/sandbox?path=${encodeURIComponent(ses.path)}`, { state: "on" });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const homeFile = join(s.home, `zdot-on-${Date.now()}`);
    const r = await a.run(`hi; touch ${homeFile} 2>/dev/null || echo home-closed`);
    const why = "refused" in r ? refusalSkip(r.refused) : undefined;
    if (why) {
      a.close();
      return t.skip(why);
    }
    assert.equal(ran(r).end.output, "hi-from-zdotdir\nhome-closed\n", "confined, and still ZDOTDIR's setup");
    // The agent's own command, confined by the same sandbox: its environment stays the sandbox's, no ZDOTDIR.
    a.send({ type: "prompt", text: `[[bash:printenv ZDOTDIR || echo no-zdotdir; touch ${homeFile} 2>/dev/null || echo home-closed]]`, clientId: "p1" });
    const result = await until("the agent's bash result", () =>
      readFileSync(ses.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "bash"),
    );
    const text = (result.message.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
    assert.equal(text.trim(), "no-zdotdir\nhome-closed", JSON.stringify(result.message));
    assert.equal(existsSync(homeFile), false, "both ran confined");
    a.close();
  } finally {
    rmSync(homeRc, { force: true });
    await stopSandboxed(s);
    rmSync(zdotdir, { recursive: true, force: true });
  }
});

test("with bash as the login shell, nothing of the zsh setup loads: the command runs in bash, as before", { skip: noZsh }, async () => {
  const s = await startHermeticServer({ env: { SHELL: "/bin/bash" } });
  try {
    writeSetup(s.home);
    const ses = await newSession(s);
    const a = await page(s, ses);
    const r = ran(await a.run('echo "bash=${BASH_VERSION:+yes} zsh=${ZSH_VERSION:+yes} order=$ORDER"; hi'));
    assert.match(r.end.output, /^bash=yes zsh= order=\n.*hi: command not found\n$/);
    assert.equal(r.end.exitCode, 127);
    a.close();
  } finally {
    for (const f of setupFiles(s.home)) rmSync(f, { force: true });
    await s.stop();
  }
});

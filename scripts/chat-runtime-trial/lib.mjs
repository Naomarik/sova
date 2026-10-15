// chat-runtime-trial helpers: a scratch agent dir, the mock LLM, a hermetic server run as a stand-in
// unit (or a plain child), and raw clients on its sockets. Shared by run.mjs and the integration
// tests (server/chat-runtime/*.integration.test.ts). Builtins and `ws` only. Nothing here touches
// ~/.pi or sova-runtime.service: every unit is named sova-trial-*, every chat unit lands in the
// stand-in slice the caller names.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { ancestors, darwin, table, withEnv } from "./procs.mjs";

// The tree the server runs from: this checkout, or CHAT_TRIAL_ROOT (a snapshot of a commit, so a trial
// never boots a tree that others are editing).
export const ROOT = process.env.CHAT_TRIAL_ROOT ? resolve(process.env.CHAT_TRIAL_ROOT) : resolve(import.meta.dirname, "..", "..");
const HERE = import.meta.dirname;
export { sleep };

// What the stage-2 server reads (stage2-design.md §8, §10). One place, so a renamed knob is one edit.
export const KNOBS = {
  /** The old per-server switch, gone with Part B (every chat runs in a process of its own); tdefault sets
      a stale value to see it ignored. */
  switch: "SOVA_CHAT_HOST",
  /** "detached" (test-only): chats run as setsid children instead of systemd units, so a trial
      survives a server restart with no user bus. */
  driver: "SOVA_CHAT_DRIVER",
  /** The slice chat units go into: a stand-in, never sova-chats.slice. */
  slice: "SOVA_CHAT_SLICE",
  /** Idle stop after this many minutes (fractional; 0 never; default 30). */
  idle: "SOVA_CHAT_IDLE_MIN",
  /** The server build a chat is labelled with. */
  build: "SOVA_BUILD",
  /** A chat process whose build equals this exits 3 before hello (the rollout failure case). */
  failBoot: "SOVA_CHAT_TEST_FAIL_BOOT",
  /** A chat process whose build equals this refuses every open (a broken deploy that boots; T27 part 3). */
  failOpen: "SOVA_CHAT_TEST_FAIL_OPEN",
  /** "live": chats run from the checkout, no copy of the code (every check but t25). */
  code: "SOVA_CHAT_CODE",
  /** Where a server copies its code; set, it turns the copy on for that check. */
  codeRoot: "SOVA_CHAT_CODE_ROOT",
  /** "on": the code root is this server's alone, and unused copies there are collected. */
  codeGc: "SOVA_CHAT_CODE_GC",
  /** Chat units are named sova-chat-<stateHash>-<session id>. */
  unitPrefix: "sova-chat-",
};

export const RESUME_TEXT = "The Sova server restarted and cut off your last turn. Continue where you left off.";
export const CRASH_RESUME_TEXT = "This chat's process stopped unexpectedly and cut off your last turn. Continue where you left off.";

export const modelsJson = (port) => ({
  providers: {
    trial: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "trial",
      models: [
        { id: "m1", contextWindow: 100000, maxTokens: 4000 },
        // A second model: a switch to it is visible in the file (run.mjs tsend).
        { id: "m2", contextWindow: 100000, maxTokens: 4000 },
      ],
    },
  },
});

/** Refuses any path in ~/.pi: the trial's state is a scratch dir only. */
function notLive(dir) {
  const homePi = join(homedir(), ".pi");
  if (dir === homePi || dir.startsWith(homePi + "/")) throw new Error(`refusing a scratch dir inside ~/.pi: ${dir}`);
}

/** <scratch>/agent built like dev:hermetic's, plus the mock provider and the trial_ask tool. An
    auth.json to copy in (for a real model such as zai/glm-5.3) is the caller's choice. */
export function buildAgentDir(scratch, { mockPort, auth } = {}) {
  notLive(scratch);
  const agent = join(scratch, "agent");
  const proj = join(scratch, "proj");
  mkdirSync(proj, { recursive: true });
  execFileSync("node", [join(ROOT, "scripts", "hermetic-agent-dir.mjs")], { env: { ...process.env, HERMETIC_AGENT_DIR: agent }, stdio: "pipe" });
  const modelsFile = join(agent, "models.json");
  const models = existsSync(modelsFile) ? JSON.parse(readFileSync(modelsFile, "utf8")) : {};
  models.providers = { ...(models.providers ?? {}), ...modelsJson(mockPort).providers };
  // The hermetic dir links models.json into the worktree's pi-config: replace the link, never write
  // through it.
  rmSync(modelsFile, { force: true });
  writeFileSync(modelsFile, JSON.stringify(models, null, 2));
  // The mock is the default model too: chats the server starts on their own (a project overseer's
  // look, a baton, an explorer) never reach for a real one.
  const settingsFile = join(agent, "settings.json");
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
  rmSync(settingsFile, { force: true });
  writeFileSync(settingsFile, JSON.stringify({ ...settings, defaultProvider: "trial", defaultModel: "m1" }, null, 2));
  // The Overseer on the mock, its explorer a pi worker on the mock (the default is Claude Code).
  mkdirSync(join(agent, "sova"), { recursive: true });
  writeFileSync(join(agent, "sova", "overseer.json"), JSON.stringify({ version: 1, model: "trial/m1", explorer: { backend: "pi", model: "trial/m1", effort: "medium" } }, null, 2));
  mkdirSync(join(agent, "extensions"), { recursive: true });
  copyFileSync(join(HERE, "trial-dialog.ts"), join(agent, "extensions", "trial-dialog.ts"));
  // Replaced, never written through: a link there would reach whatever it names.
  if (auth) (rmSync(join(agent, "auth.json"), { force: true }), copyFileSync(auth, join(agent, "auth.json")));
  const fake = fakeClaude(scratch);
  // topic-outline reads ~/.pi/agent/topic-outline.json and spawns ~/.local/bin/claude whatever the
  // agent dir: in the trial's project (trusted here) its own config sends the outline's one-shot to
  // the fake claude instead (only a trusted project's .pi/topic-outline.json applies).
  const trustFile = join(agent, "trust.json");
  const trust = existsSync(trustFile) ? JSON.parse(readFileSync(trustFile, "utf8")) : {};
  rmSync(trustFile, { force: true });
  writeFileSync(trustFile, JSON.stringify({ ...trust, [proj]: true }, null, 2));
  mkdirSync(join(proj, ".pi"), { recursive: true });
  writeFileSync(join(proj, ".pi", "topic-outline.json"), JSON.stringify({ claudeBin: join(fake.claudeBin, "claude"), summarizers: [{ backend: "claude-code", model: "claude-sonnet-5-5", timeoutMs: 20000 }] }, null, 2));
  return { agent, proj, ...fake };
}

/** scripts/fake-claude.mjs as `claude` (a shim dir to put first on the server's PATH) and a login
    dir it accepts (CLAUDE_CONFIG_DIR): a claude-code worker runs on it with no Anthropic and no real
    login, and no real `claude` on the PATH is ever reached. */
export function fakeClaude(scratch) {
  const bin = join(scratch, "fake-claude-bin");
  const login = join(scratch, "claude-login");
  mkdirSync(bin, { recursive: true });
  mkdirSync(login, { recursive: true });
  // Each call is logged (<scratch>/fake-claude-calls.log: its arguments), so a trial can show a
  // one-shot reached the fake.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$$ $*" >> ${join(scratch, "fake-claude-calls.log")}\nexec node ${join(ROOT, "scripts", "fake-claude.mjs")} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(login, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }), { mode: 0o600 });
  writeFileSync(join(login, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "trial@example.invalid" } }));
  return { claudeBin: bin, claudeLogin: login };
}

/** The mock LLM as its own process: it outlives every server restart. */
export async function startMock({ port, log, step }) {
  const child = spawn(process.execPath, [join(HERE, "mock-llm.mjs"), "--port", String(port), "--log", log, ...(step ? ["--step", String(step)] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise((ok, fail) => {
    child.stdout.once("data", (d) => ok(String(d)));
    child.once("exit", (c) => fail(new Error(`mock llm exited ${c}`)));
  });
  const mockPort = JSON.parse(line).port;
  /** What a message with no tag gets from now on (mock-llm.mjs POST /trial/plain); "" clears it. */
  const plain = (text) => fetch(`http://127.0.0.1:${mockPort}/trial/plain`, { method: "POST", body: JSON.stringify({ text }) }).then((r) => r.text());
  /** Holds (on) or releases (off) the end of the [long … #tag] reply (mock-llm.mjs POST /trial/hold). */
  const hold = (tag, on = true) => fetch(`http://127.0.0.1:${mockPort}/trial/hold`, { method: "POST", body: JSON.stringify({ tag, on }) }).then((r) => r.text());
  return { child, port: mockPort, log, plain, hold, stop: () => child.kill("SIGTERM") };
}
/** The mock's log as records. */
export const mockLog = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The server's environment: the scratch agent dir, the knobs, and nothing that names a real login
    or key (only the mock, or an auth.json copied in, may answer). `driver`:
    "detached" or "systemd" (then `slice` is the stand-in slice); `idleMs`, `build`, `failBoot`. */
export function serverEnv({ agent, port, driver, slice, idleMs, build, failBoot, claude, extra = {} }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !/_API_KEY$|_AUTH_TOKEN$/.test(k) && !k.startsWith("SOVA_")));
  // No network: no price fetch, no usage poll (it would ask Claude with whatever login it finds).
  Object.assign(env, { PORT: String(port), PI_CODING_AGENT_DIR: agent, SOVA_PRICES_FETCH: "off", SOVA_USAGE_POLL: "off" });
  // `claude`: fakeClaude()'s dirs: the fake first on PATH, its login as the default one.
  if (claude) Object.assign(env, { PATH: `${claude.claudeBin}:${env.PATH ?? ""}`, CLAUDE_CONFIG_DIR: claude.claudeLogin });
  if (driver === "detached") env[KNOBS.driver] = "detached";
  if (slice) env[KNOBS.slice] = slice;
  if (idleMs !== undefined) env[KNOBS.idle] = String(idleMs / 60_000);
  if (build) env[KNOBS.build] = build;
  if (failBoot) env[KNOBS.failBoot] = failBoot;
  // No copy of the code per server (its state root sits in the scratch, on another filesystem than the
  // checkout: ~350 MB each), unless the check is about the copies and names their root (t25).
  if (!(KNOBS.codeRoot in extra)) env[KNOBS.code] = "live";
  return { ...env, ...extra };
}

const sc = (...a) => execFileSync("systemctl", ["--user", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const show = (unit, prop) => {
  try {
    return sc("show", "-p", prop, "--value", unit);
  } catch {
    return "";
  }
};
export { sc, show };

/**
 * The hermetic server, supervised like sova-runtime.service but as a stand-in transient unit
 * (sova-trial-server-<tag>.service, KillMode=control-group, as the real unit has): `restart()` is
 * `systemctl --user restart`, so anything left in the server's cgroup dies as it would in a real
 * restart. mode "child" runs it as a plain child instead (no user bus needed; chats on the detached driver). `root`: the
 * tree it runs from (default ROOT; T25 runs a git clone it edits).
 */
export function server({ tag, env, mode = "unit", log, root = ROOT, liveLike = false }) {
  if (mode === "unit" && darwin) return launchdStandIn({ label: `test.sova-s5-${tag}`, env, log, root });
  env = { ...env };
  const unit = `sova-trial-server-${tag}.service`;
  const start = join(root, "scripts", "start-server.sh");
  let child = null;
  const up = () => {
    if (mode === "unit") {
      const sets = Object.entries(env).filter(([k]) => /^(PATH|HOME|PORT|PI_CODING_AGENT_DIR|CLAUDE_CONFIG_DIR|SOVA_\w+|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|TMPDIR|LANG)$/.test(k));
      execFileSync("systemd-run", ["--user", `--unit=${unit}`, ...(liveLike
        ? // docs/running-as-a-service.md's unit, as sova-runtime.service has it (its ExecStartPre, pi-config/install.sh --links,
          // writes ~/.pi/agent and is left out); KillMode is the default, control-group.
          ["--property=Type=simple", "--property=Restart=always", "--property=RestartSec=2", "--property=TimeoutStopSec=90"]
        : ["--property=KillMode=control-group", "--property=TimeoutStopSec=30"]), `--working-directory=${root}`, `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, ...sets.map(([k, v]) => `--setenv=${k}=${v}`), start], { stdio: "pipe" });
    } else {
      child = spawn(start, [], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      // A log that can't be written (a full disk) loses lines, never the runner.
      const out = (d) => {
        try {
          writeFileSync(log, d, { flag: "a" });
        } catch {}
      };
      child.stdout.on("data", out);
      child.stderr.on("data", out);
    }
  };
  const down = async () => {
    if (mode === "unit") {
      try {
        sc("stop", unit);
      } catch {}
    } else if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(35000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  };
  return {
    unit,
    up,
    down,
    /** The server's main pid. */
    pid: () => (mode === "unit" ? Number(show(unit, "MainPID")) : child?.pid ?? 0),
    cgroup: () => (mode === "unit" ? show(unit, "ControlGroup") : ""),
    /** A restart as the service manager does it; `changes` (env) start the new server differently
        (another SOVA_BUILD, say), which for a unit means stop and start again. */
    async restart(changes) {
      if (changes) Object.assign(env, changes);
      if (mode === "unit" && !changes) sc("restart", unit);
      else {
        await down();
        up();
      }
    },
  };
}

/** launchctl in the user's GUI domain. */
const lc = (...a) => execFileSync("launchctl", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * darwin's stand-in for the server unit: a launchd agent of our own label (test.sova-s5-<tag>, never the
 * live install's), set up as the live agent is (KeepAlive on a failed exit, ExitTimeOut 30, 8192 files,
 * Interactive), but with ThrottleInterval 2: by default launchd waits 10 s before it restarts a job that just
 * crashed. `restart()` is `launchctl kickstart -k`; `down()` boots it out and waits for it to go (up to
 * `exitTimeOut` + 5 s). Its plist lives beside its log, in the scratch dir. `exitTimeOut` (default 30):
 * the rehearsal gives the installer's 60.
 */
export function launchdStandIn({ label, env, log, root = ROOT, exitTimeOut = 30 }) {
  env = { ...env };
  const domain = `gui/${process.getuid()}`;
  const plist = log.replace(/\.log$/, "") + `.${label}.plist`;
  const start = join(root, "scripts", "start-server.sh");
  const write = () =>
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n` +
        `<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array><string>${xml(start)}</string></array>\n` +
        `<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>\n` +
        `<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ExitTimeOut</key><integer>${exitTimeOut}</integer><key>ThrottleInterval</key><integer>2</integer><key>ProcessType</key><string>Interactive</string>\n` +
        `<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>8192</integer></dict><key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>8192</integer></dict>\n` +
        `<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`,
    );
  const loaded = () => {
    try {
      lc("print", `${domain}/${label}`);
      return true;
    } catch {
      return false;
    }
  };
  const up = () => {
    write();
    lc("bootstrap", domain, plist);
  };
  const down = async () => {
    if (!loaded()) return;
    try {
      lc("bootout", `${domain}/${label}`);
    } catch {}
    for (let i = 0; i < (exitTimeOut + 5) * 2 && loaded(); i++) await sleep(500);
  };
  return {
    unit: label,
    up,
    down,
    pid: () => {
      try {
        return Number(/\bpid = (\d+)/.exec(lc("print", `${domain}/${label}`))?.[1] ?? 0);
      } catch {
        return 0;
      }
    },
    cgroup: () => "",
    async restart(changes) {
      if (changes) {
        Object.assign(env, changes);
        await down();
        up();
      } else lc("kickstart", "-k", `${domain}/${label}`);
    },
  };
}

/** A port nothing listens on now (bound and released on loopback). */
export const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

/** Whether the systemd user manager answers (a sandboxed shell has no user bus). */
export function userBus() {
  try {
    execFileSync("systemctl", ["--user", "show", "-p", "Version", "--value"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Waits for GET /api/health to answer. */
// 150 s: under `test:int` several trial files boot servers at once, and a boot (bun, the take-back of
// the chats an earlier check left) has taken more than 60 s there.
export async function healthy(base, ms = 150000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    if (Date.now() > end) throw new Error(`${base}: no health answer within ${ms} ms`);
    await sleep(300);
  }
}

export const tokenOf = (agent) => readFileSync(join(agent, "sova", "auth-token"), "utf8").trim();

export function client(base, token) {
  const headers = { "x-sova-token": token };
  const wsBase = base.replace(/^http/, "ws");
  async function api(path, init = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  /** A socket that records every message, parsed, and resolves waits on them. */
  function socket(path) {
    const ws = new WebSocket(`${wsBase}${path}`, { headers });
    const got = [];
    const waiters = [];
    ws.on("message", (d) => {
      try {
        got.push(JSON.parse(String(d)));
      } catch {
        got.push({ raw: String(d) });
      }
      for (const w of [...waiters]) if (w.test()) (waiters.splice(waiters.indexOf(w), 1), w.done());
    });
    let closed = false;
    ws.on("close", () => {
      closed = true;
      for (const w of [...waiters]) w.test();
    });
    const opened = new Promise((ok, fail) => {
      ws.once("open", ok);
      ws.once("error", fail);
      ws.once("unexpected-response", (_q, res) => fail(new Error(`${path}: HTTP ${res.statusCode}`)));
    });
    ws.on("error", () => {});
    /** Resolves with the first message (from index `from`) matching pred. */
    const until = (pred, ms, what, from = 0) =>
      new Promise((ok, fail) => {
        const find = () => got.slice(from).find(pred);
        const hit = find();
        if (hit) return ok(hit);
        const timer = setTimeout(() => fail(new Error(`timed out after ${ms} ms: ${what}`)), ms);
        waiters.push({ test: () => !!find(), done: () => (clearTimeout(timer), ok(find())) });
      });
    const send = (m) => ws.send(JSON.stringify(m));
    return { ws, got, opened, until, send, closed: () => closed, close: () => ws.close() };
  }
  return { api, socket };
}

/** Opens /ws/chat (wire 2) on a session and waits for its hello. `force`: the page's "Open anyway"
    (&force=1), past a "recent" refusal. */
export async function chat(c, path, ms = 40000, { force = false } = {}) {
  const s = c.socket(`/ws/chat?path=${encodeURIComponent(path)}&wire=2${force ? "&force=1" : ""}`);
  await s.opened;
  const first = await s.until((m) => m.type === "hello" || m.type === "error", ms, "hello");
  if (first.type === "error") throw new Error(`/ws/chat: ${JSON.stringify(first)}`);
  return { ...s, hello: first };
}

/** Text of every assistant row in a transcript. */
export async function assistantTexts(c, path) {
  const r = await c.api(`/api/transcript?path=${encodeURIComponent(path)}&wire=2`);
  const rows = Array.isArray(r) ? r : r.items;
  return { rows, texts: rows.filter((x) => x.kind === "assistant-text").map((x) => x.text ?? "") };
}

/** Text of the deltas on wire 2 since index `from`. */
export const streamedText = (got, from = 0) =>
  got
    .slice(from)
    .filter((m) => m.type === "event" && m.event?.type === "part.delta")
    .map((m) => m.event.delta ?? m.event.text ?? "")
    .join("");

/** Chat units of this trial's slice: name, main pid, state. */
export function chatUnits(slice) {
  let out = "";
  try {
    out = sc("list-units", "--all", "--plain", "--no-legend", `${KNOBS.unitPrefix}*`);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => show(u, "Slice") === slice)
    .map((u) => ({ unit: u, pid: Number(show(u, "MainPID")), state: show(u, "ActiveState"), cgroup: show(u, "ControlGroup") }));
}

/** Processes a trial under `root` (a scratch dir, or a root of several) left: every process whose
    PI_CODING_AGENT_DIR lies under it (servers, chat processes, workers in either placement, their
    tools and fake claudes) and, unless `mock` is false, the mock LLM logging there. Never this process or its ancestors. */
export function strays(root, { mock: withMock = true } = {}) {
  const under = (v) => v === root || v.startsWith(root.endsWith("/") ? root : `${root}/`);
  const mine = new Set([process.pid, ...ancestors(process.pid)]);
  const out = withEnv("PI_CODING_AGENT_DIR").filter((p) => !mine.has(p.pid) && under(p.value)).map((p) => ({ pid: p.pid, cmd: p.cmd }));
  if (withMock)
    for (const p of table())
      if (!mine.has(p.pid) && !out.some((o) => o.pid === p.pid) && /mock-llm\.mjs/.test(p.cmd) && p.cmd.split(" ").some(under)) out.push({ pid: p.pid, cmd: p.cmd });
  return out;
}

/** Stops every stray of `root`: SIGTERM, then SIGKILL after `graceMs`. Returns what it found. */
export async function sweep(root, { graceMs = 2000, mock = true } = {}) {
  const found = strays(root, { mock });
  for (const p of found)
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {}
  if (found.length) await sleep(graceMs);
  for (const p of strays(root, { mock }))
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {}
  return found;
}

/**
 * What a chat's processes logged. Under the detached driver: its files under <stateRoot>/chats/logs (named
 * with its session id). Under systemd a chat unit logs to the user journal: `journalctl --user -u <unit>`
 * from `since` (the run's start, so a unit name met in an earlier run never counts), else by `pid`. Take
 * `unit` from the chat's record before its process goes: a stopped chat's record goes with it.
 */
export function chatProcLog({ stateRoot, sessionId, unit, pid, since }) {
  let text = "";
  try {
    const dir = join(stateRoot, "chats", "logs");
    text = readdirSync(dir).filter((f) => sessionId && f.includes(sessionId)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  } catch {}
  if (text || darwin) return text;
  const journal = (...match) => {
    try {
      return execFileSync("journalctl", ["--user", "--no-pager", "-o", "cat", ...(since ? [`--since=@${Math.floor(since / 1000)}`] : []), ...match], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    } catch {
      return "";
    }
  };
  if (unit) text = journal("-u", unit.endsWith(".service") ? unit : `${unit}.service`);
  if (!text.trim() && pid) text = journal(`_PID=${pid}`);
  return text;
}

/** Results and a log, written as the report's raw evidence. */
export function recorder(file) {
  const checks = [];
  return {
    checks,
    check(ok, what, detail) {
      checks.push({ ok: !!ok, what, detail: detail ?? null });
      console.log(`${ok ? "PASS" : "FAIL"} ${what}${!ok && detail ? `\n     ${detail}` : ""}`);
      return !!ok;
    },
    note(s) {
      checks.push({ note: s });
      console.log(`     ${s}`);
    },
    save(extra = {}) {
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), checks, ...extra }, null, 2));
      return file;
    },
  };
}

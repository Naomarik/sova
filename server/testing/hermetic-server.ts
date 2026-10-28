// Test-only: one throwaway Sova server, as a child process, for a scenario (scripts/sova-scenario.mjs)
// or an integration test. Never imported by product code.
//
// What it starts, all under one scratch root in the OS temp dir (never in a repository, never in ~/.pi):
// - the scripted stand-in model (scripts/harness-wire-e2e-mock-llm.mjs) on a free loopback port;
// - the server (scripts/start-server.sh: Bun, as the service runs it) on PORT=0, with
//   - PI_CODING_AGENT_DIR a fresh agent dir whose models.json names only the stand-in and whose
//     settings make it the default model, so no turn can reach a real provider;
//   - HOME a sentinel home whose every file is recorded at the start and compared at the stop;
//   - a pinned random token (SOVA_TOKEN), a stand-in `claude` first on PATH, and none of the caller's
//     SOVA_*, PI_*, CLAUDE* or *_API_KEY / *_AUTH_TOKEN variables;
//   - the price fetch, usage poll and update check off, chats on the detached driver from this tree.
// stop() stops the server, every chat process it left (scripts/stop-chats.ts, then any process that
// still names this agent dir), and the stand-in, then reports what changed in the sentinel home.
//
// Node builtins only and erasable TypeScript only: scripts/sova-scenario.mjs loads it through Node's
// type stripping, the integration tier through Bun.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface HermeticServerOptions {
  /** How long the server may take to answer /api/health (default 30 s). */
  bootTimeoutMs?: number;
  /** Keep the scratch root after stop() (default: removed, unless the home changed). */
  keep?: boolean;
}

export interface HermeticServer {
  /** http://127.0.0.1:<port> */
  base: string;
  token: string;
  /** The scratch root everything lives under. */
  scratch: string;
  agentDir: string;
  /** The sentinel HOME the server ran with. */
  home: string;
  /** A plain folder (with a package.json the stand-in model reads) for sessions to work in. */
  work: string;
  mockPort: number;
  /** The stand-in model's pid. */
  mockPid: number;
  /** The server's pid (start-server.sh execs it, so it is the script's). */
  pid: number;
  /** Spawn to first healthy answer, in ms. */
  bootMs: number;
  /** The server's output so far. */
  log(): string;
  /** What differs in the sentinel home from its first record: "added|removed|changed <path>". */
  homeChanges(): string[];
  /** Stops everything; resolves to homeChanges() at the stop. Idempotent. */
  stop(): Promise<string[]>;
  /** The server alone stops (SIGTERM, as a service restart does) and boots again on the same state
      root and port; the stand-in and the chats it runs keep running. `pid` and `bootMs` follow it. */
  restart(): Promise<void>;
}

/** The model the agent dir defaults to. */
export const STAND_IN_MODEL = "mock/m1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A bound on a wait for something else: it never keeps the process alive by itself. */
const cap = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Refuses any path in the real ~/.pi (the HOME this process started with). */
function notRealPi(path: string): void {
  const homePi = join(homedir(), ".pi");
  const p = resolve(path);
  if (p === homePi || p.startsWith(homePi + "/")) throw new Error(`hermetic-server: refusing a path inside ~/.pi: ${p}`);
}

/** Every entry under `dir`, by path relative to it: kind, mode and a content hash. */
export function recordTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const file = join(d, name);
      const st = lstatSync(file);
      const rel = relative(dir, file);
      if (st.isSymbolicLink()) out.set(rel, `link ${readlinkSync(file)}`);
      else if (st.isDirectory()) {
        out.set(rel, `dir ${(st.mode & 0o777).toString(8)}`);
        walk(file);
      } else out.set(rel, `file ${(st.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
    }
  };
  walk(dir);
  return out;
}

/** "added|removed|changed <path>" for each difference between two records. */
export function treeChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (!before.has(k)) out.push(`added ${k}`);
  else if (before.get(k) !== v) out.push(`changed ${k}`);
  for (const k of before.keys()) if (!after.has(k)) out.push(`removed ${k}`);
  return out.sort();
}

/** A sentinel home shaped like a real one: a pi agent dir and a Claude login, all synthetic. */
function writeSentinelHome(home: string): void {
  const put = (file: string, value: unknown) => {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  };
  put(join(home, ".pi", "agent", "settings.json"), { defaultProvider: "sentinel", defaultModel: "never" });
  put(join(home, ".pi", "agent", "auth.json"), {});
  mkdirSync(join(home, ".pi", "agent", "sessions", "live"), { recursive: true });
  put(join(home, ".pi", "agent", "sova", "auth-token"), "sentinel-token-never-used\n");
  put(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "sentinel", refreshToken: "sentinel", expiresAt: 4102444800000 } });
  put(join(home, ".claude.json"), { oauthAccount: { emailAddress: "sentinel@example.invalid" } });
}

/** The agent dir: the stand-in as the only provider and the default model, nothing else of a user's. */
function writeAgentDir(agent: string, mockPort: number): void {
  mkdirSync(join(agent, "sessions", "live"), { recursive: true });
  mkdirSync(join(agent, "sova"), { recursive: true });
  const [provider, model] = STAND_IN_MODEL.split("/") as [string, string];
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({ providers: { [provider]: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, api: "openai-completions", apiKey: "mock", models: [{ id: model, contextWindow: 100000, maxTokens: 4000 }] } } }, null, 2),
  );
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: model }, null, 2));
  // The Overseer on the stand-in too, its memory off: nothing the server starts on its own reaches a real model.
  writeFileSync(join(agent, "sova", "overseer.json"), JSON.stringify({ version: 1, model: STAND_IN_MODEL, explorer: { backend: "pi", model: STAND_IN_MODEL, effort: "medium" }, memory: { on: false, type: "uniichat", size: 128 } }, null, 2));
}

/** The caller's environment minus anything that names a real login, key, agent dir or Sova knob. */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(SOVA_|PI_|CLAUDE|ANTHROPIC|OPENAI|GIT_|XDG_)/.test(k) || /_API_KEY$|_AUTH_TOKEN$|_TOKEN$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Resolves with the first line of `child`'s stdout matching `re`, or rejects on exit or timeout. */
function lineFrom(child: ChildProcess, re: RegExp, ms: number, what: string): Promise<RegExpExecArray> {
  return new Promise((ok, fail) => {
    let buf = "";
    const timer = setTimeout(() => fail(new Error(`hermetic-server: no ${what} within ${ms} ms`)), ms).unref();
    const onData = (d: Buffer) => {
      buf += String(d);
      const m = re.exec(buf);
      if (m) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        ok(m);
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`hermetic-server: ${what}: the process exited ${code} first`));
    });
  });
}

async function killAndWait(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, cap(ms)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, cap(2000)]);
  }
}

/** Linux: pids whose environment names this agent dir (chats that outlived stop-chats). */
function pidsNaming(agent: string): number[] {
  if (process.platform !== "linux") return [];
  const want = `PI_CODING_AGENT_DIR=${agent}`;
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(want)) out.push(Number(d));
    } catch {
      // gone, or not ours to read
    }
  }
  return out;
}

/** Every process a live hermetic server started here, by agent dir: killed if this process ends first. */
const live = new Map<string, ChildProcess[]>();
let hooked = false;

/** This process ending without stop() (an exit, Ctrl-C, a SIGTERM): kill what it started, now. */
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const [agent, children] of live) {
      for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
      for (const pid of pidsNaming(agent)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    live.clear();
  };
  process.once("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      killAll();
      // The default action, now that the handler is gone.
      process.kill(process.pid, sig);
    });
}

// A watchdog for a parent killed outright (SIGKILL: no handler runs, and a test runner kills the file's
// whole process group, which the server and stand-in are in but detached chats are not). It runs in a
// session of its own, polls the parent, and when the parent is gone kills the pids it was given and,
// on Linux, every process whose environment names the agent dir. stop() kills it first.
const WATCHDOG = `
const [parent, agent, ...pids] = process.argv.slice(1);
const fs = require("node:fs");
const kill = (p) => { try { process.kill(Number(p), "SIGKILL"); } catch {} };
setInterval(() => {
  try { process.kill(Number(parent), 0); return; } catch {}
  pids.forEach(kill);
  if (process.platform === "linux") for (const d of fs.readdirSync("/proc")) {
    if (!/^\\d+$/.test(d)) continue;
    try { if (fs.readFileSync("/proc/" + d + "/environ", "utf8").split("\\0").includes("PI_CODING_AGENT_DIR=" + agent)) kill(d); } catch {}
  }
  process.exit(0);
}, 500);
`;

function startWatchdog(agent: string, pids: number[]): ChildProcess {
  const w = spawn("node", ["-e", WATCHDOG, String(process.pid), agent, ...pids.map(String)], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
  w.unref();
  return w;
}

export async function startHermeticServer(opts: HermeticServerOptions = {}): Promise<HermeticServer> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sova-scenario-")));
  notRealPi(scratch);
  const home = join(scratch, "home");
  const agent = join(scratch, "agent");
  const work = join(scratch, "work");
  const bin = join(scratch, "bin");
  mkdirSync(work, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "scenario-work", private: true }, null, 2)}\n`);
  writeSentinelHome(home);
  const homeBefore = recordTree(home);
  // A `claude` that is never the installed one: the stand-in CLI, whatever PATH held.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec node ${JSON.stringify(join(ROOT, "scripts", "fake-claude.mjs"))} "$@"\n`, { mode: 0o755 });

  const mock = spawn(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "scripts", "harness-wire-e2e-mock-llm.mjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  let server: ChildProcess | null = null;
  let watchdog: ChildProcess | null = null;
  hookExit();
  live.set(agent, [mock]);
  let out = "";
  let stopped: Promise<string[]> | null = null;
  /** The server's environment, and stop-chats' (set once the stand-in's port is known). */
  let env: Record<string, string> = { ...cleanEnv(), HOME: home };
  const homeChanges = () => (existsSync(home) ? treeChanges(homeBefore, recordTree(home)) : ["removed ."]);

  const stop = (): Promise<string[]> =>
    (stopped ??= (async () => {
      watchdog?.kill("SIGKILL");
      if (server) await killAndWait(server, 30_000);
      if (existsSync(join(agent, "sova"))) {
        spawnSync("bun", [join(ROOT, "scripts", "stop-chats.ts"), "--agent-dir", agent], { cwd: ROOT, env, stdio: "ignore", timeout: 60_000 });
      }
      for (const pid of pidsNaming(agent)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await killAndWait(mock, 5000);
      live.delete(agent);
      const changes = homeChanges();
      if (!opts.keep && changes.length === 0) rmSync(scratch, { recursive: true, force: true });
      return changes;
    })());

  try {
    const mockPort = Number((await lineFrom(mock, /^listening (\d+)$/m, 10_000, "stand-in model port"))[1]);
    writeAgentDir(agent, mockPort);
    const token = randomBytes(24).toString("hex");
    env = {
      ...env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PORT: "0",
      PI_CODING_AGENT_DIR: agent,
      SOVA_TOKEN: token,
      SOVA_PRICES_FETCH: "off",
      SOVA_USAGE_POLL: "off",
      SOVA_UPDATES_CHECK: "off",
      SOVA_GIT_MAINTENANCE: "off",
      SOVA_CHAT_DRIVER: "detached",
      SOVA_CHAT_CODE: "live",
      GIT_CEILING_DIRECTORIES: tmpdir(),
      // Bun's transpiler cache stays the caller's (warm, and outside the sentinel home): Bun keeps it
      // in $HOME/.bun/install/cache/@t@ by default.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH || join(homedir(), ".bun", "install", "cache", "@t@"),
    };
    const bootTimeout = opts.bootTimeoutMs ?? 30_000;
    /** Spawn the server on `port` (0: a free one) and wait for its first healthy answer. */
    const boot = async (port: number): Promise<{ base: string; bootMs: number }> => {
      const t0 = performance.now();
      const s = spawn(join(ROOT, "scripts", "start-server.sh"), [], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      server = s;
      live.set(agent, [mock, s]);
      watchdog?.kill("SIGKILL");
      watchdog = startWatchdog(agent, [mock.pid ?? 0, s.pid ?? 0].filter(Boolean));
      s.stdout?.on("data", (d) => (out += String(d)));
      s.stderr?.on("data", (d) => (out += String(d)));
      const bound = Number((await lineFrom(s, /sova server on http:\/\/[^:]+:(\d+)/, bootTimeout, "server port")).at(1));
      const base = `http://127.0.0.1:${bound}`;
      const end = Date.now() + bootTimeout;
      for (;;) {
        try {
          if ((await fetch(`${base}/api/health`, { headers: { "x-sova-token": token } })).ok) break;
        } catch {
          // not answering yet
        }
        if (Date.now() > end) throw new Error(`hermetic-server: ${base} gave no health answer within ${bootTimeout} ms\n${out}`);
        await sleep(50);
      }
      return { base, bootMs: Math.round(performance.now() - t0) };
    };
    const first = await boot(0);
    const hs: HermeticServer = {
      base: first.base,
      token,
      scratch,
      agentDir: agent,
      home,
      work,
      mockPort,
      mockPid: mock.pid ?? 0,
      pid: server!.pid ?? 0,
      bootMs: first.bootMs,
      log: () => out,
      homeChanges,
      stop,
      restart: async () => {
        if (stopped) throw new Error("hermetic-server: restart after stop");
        if (server) await killAndWait(server, 30_000);
        const again = await boot(Number(new URL(hs.base).port));
        hs.pid = server!.pid ?? 0;
        hs.bootMs = again.bootMs;
      },
    };
    return hs;
  } catch (err) {
    await stop();
    throw err;
  }
}

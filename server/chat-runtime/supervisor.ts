import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DetachedDriver, envFileKeeps, realExec, SystemdDriver, type Driver, type Exec, type UnitStatus } from "../project-services/drivers";
import { stateHash } from "../project-services/store";
import type { ExitCause } from "../../shared/chat-runtime-wire";
import { stateRoot } from "../state-root";

/**
 * The chat supervisor (al_3 stage 2, design §3): starts an ordinary chat's process as a systemd
 * transient user unit in `sova-chats.slice`, outside the server's own cgroup, so the chat (and a
 * reply in flight) outlives a server restart. It reuses the project-services Driver: the same
 * `systemd-run` argv, with the chats' slice, a 30 s stop grace, no `Restart=` (the supervisor alone
 * decides, so a crash is reported once and never looped while the server is down) and the env in a
 * 0600 file. Each chat is recorded under `<state root>/chats/registry/<chat>.json`; at a server start
 * the running units are adopted and the records whose unit is gone are reported as deaths, once. It
 * also asks a chat idle for 30 min to close, and keeps the number of idle Claude CLI children across
 * all chat processes bounded, as the in-process bridge does for its own.
 */

export const CHAT_SLICE = "sova-chats.slice";
/** Systemd's stop grace for a chat: SIGTERM to the chat process, then SIGKILL to the whole unit. */
export const CHAT_STOP_SEC = 30;
export const IDLE_STOP_MIN = 30;
/** Idle Claude CLI children kept across all chat processes (the bridge's own `maxIdleSessions`). */
export const CLAUDE_IDLE_MAX = 4;
const LOG_TAIL = 20;
/** How long an accepted drain, or a predecessor still exiting, is waited for. */
const EXIT_WAIT_MS = 30_000;
const PREDECESSOR_WAIT_MS = 10_000;
/** A Claude child asked to go that the mirror still shows idle after this counts again. */
const REAP_WAIT_MS = 30_000;
/** How often, and how far apart, a unit's log is read again when it does not yet say how the unit ended. */
const JOURNAL_RETRIES = 4;
const JOURNAL_RETRY_MS = 750;
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

export const chatsRoot = () => join(stateRoot(), "chats");
export const registryDir = () => join(chatsRoot(), "registry");
export const envDir = () => join(chatsRoot(), "env");
export const deathsFile = () => join(chatsRoot(), "deaths.jsonl");
export const epochFile = () => join(chatsRoot(), "epoch");
const idPart = (id: string, max: number) => id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, max);
/** Every chat unit of this state root starts with this: a hermetic or dev server never adopts another server's chats. */
export const chatUnitPrefix = (hash = stateHash()) => `sova-chat-${hash}-`;
/** The unit of chat `chatId` (its session id: only `[A-Za-z0-9_-]` kept, at most 36). */
export const chatUnitOf = (chatId: string, hash = stateHash()) => `${chatUnitPrefix(hash)}${idPart(chatId, 36)}`;

// ---- knobs --------------------------------------------------------------------------------------

export interface SupervisorConfig {
  slice: string;
  driver: "systemd" | "detached";
  /** 0: never stop an idle chat. */
  idleMs: number;
  claudeIdleMax: number;
}

/** The supervisor's knobs from the server's env: `SOVA_CHAT_SLICE`, `SOVA_CHAT_DRIVER=detached` (tests),
    `SOVA_CHAT_IDLE_MIN` (fractional minutes, 0 never), `SOVA_CHAT_CLAUDE_IDLE_MAX`. */
export function supervisorConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const num = (v: string | undefined, dflt: number) => {
    const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    slice: env.SOVA_CHAT_SLICE?.trim() || CHAT_SLICE,
    driver: env.SOVA_CHAT_DRIVER?.trim() === "detached" ? "detached" : "systemd",
    idleMs: Math.round(num(env.SOVA_CHAT_IDLE_MIN, IDLE_STOP_MIN) * 60_000),
    claudeIdleMax: Math.floor(num(env.SOVA_CHAT_CLAUDE_IDLE_MAX, CLAUDE_IDLE_MAX)),
  };
}

// ---- where chats run ----------------------------------------------------------------------------

export type ChatHost = { mode: "out"; why: string } | { mode: "in"; why: string };

/**
 * Whether this server runs ordinary chats in processes of their own: only with the per-server switch
 * on (`SOVA_CHAT_HOST=out`), on Linux, with the server on Bun (the chat runs on the server's own
 * binary), and the systemd user manager answering. Otherwise in this process as before, and `why`
 * says which condition decided it. macOS stays in-process until its stand-in test passes; a Linux
 * host without systemd too, since a detached child of a server run by a service manager would still
 * die with the server's cgroup. `SOVA_CHAT_DRIVER=detached` (tests only) skips the systemd probe.
 */
export async function chooseChatHost(deps: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; bun?: string | undefined; driver?: Pick<Driver, "available"> } = {}): Promise<ChatHost> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const bun = "bun" in deps ? deps.bun : process.versions.bun;
  const sw = env.SOVA_CHAT_HOST?.trim();
  if (sw !== "out") return { mode: "in", why: sw ? `SOVA_CHAT_HOST=${sw} (only "out" moves chats out)` : "chats run in the server (SOVA_CHAT_HOST is not out)" };
  if (platform !== "linux") return { mode: "in", why: `SOVA_CHAT_HOST=out, but chat processes are Linux-only for now (this is ${platform})` };
  if (!bun) return { mode: "in", why: "SOVA_CHAT_HOST=out, but chat processes need the server on Bun" };
  if (supervisorConfig(env).driver === "detached") return { mode: "out", why: "SOVA_CHAT_HOST=out, detached test driver (SOVA_CHAT_DRIVER=detached)" };
  const probe = await (deps.driver ?? new SystemdDriver()).available();
  if (!probe.ok) return { mode: "in", why: `SOVA_CHAT_HOST=out, but ${probe.detail}` };
  return { mode: "out", why: `SOVA_CHAT_HOST=out, ${probe.detail}` };
}

/** The driver chats run under: systemd units in the chats' slice, env in a 0600 file, never restarted by
    systemd; or, for tests, detached sessions recorded under `chats/procs` and `chats/logs`. */
export function chatDriver(config: Pick<SupervisorConfig, "slice" | "driver"> = supervisorConfig(), exec: Exec = realExec): Driver {
  if (config.driver === "detached") return new DetachedDriver(CHAT_STOP_SEC * 1000, { restart: false, procsDir: () => join(chatsRoot(), "procs"), logsDir: () => join(chatsRoot(), "logs") });
  return new SystemdDriver(exec, { slice: config.slice, timeoutStopSec: CHAT_STOP_SEC, restart: false, envFile: (unit) => join(envDir(), `${unit}.env`) });
}

// ---- socket path and epoch ----------------------------------------------------------------------

/**
 * Where chat `chatId`'s socket lives (design §2.1): `<state root>/chats/s/<id12><suffix>.sock` when
 * that path fits in 100 bytes, else `<XDG_RUNTIME_DIR or the temp dir>/sova-chats-<state hash>/…`
 * (a sockaddr holds 108; a deep hermetic worktree path would not fit).
 */
export function chatSocketPath(chatId: string, o: { suffix?: string; root?: string; runtimeDir?: string | undefined; tmp?: string; hash?: string } = {}): string {
  const name = `${idPart(chatId, 12)}${o.suffix ?? ""}.sock`;
  const primary = join(o.root ?? chatsRoot(), "s", name);
  if (Buffer.byteLength(primary) <= 100) return primary;
  const base = "runtimeDir" in o ? o.runtimeDir : process.env.XDG_RUNTIME_DIR;
  return join(base || (o.tmp ?? tmpdir()), `sova-chats-${o.hash ?? stateHash()}`, name);
}

/** This server's controller epoch (design §2.3): max(now, the last one + 1), written back. */
export function nextEpoch(file = epochFile(), now = Date.now()): number {
  let prev = 0;
  try {
    prev = Number(readFileSync(file, "utf8").trim()) || 0;
  } catch {
    // first start
  }
  const epoch = Math.max(now, prev + 1);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${epoch}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return epoch;
}

// ---- the chat process's environment -------------------------------------------------------------

/** What a chat process never inherits from the server: the service manager's per-unit variables, the shell's own, and the server's listen settings. */
const DENY = new Set(["INVOCATION_ID", "JOURNAL_STREAM", "MANAGERPID", "NOTIFY_SOCKET", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES", "WATCHDOG_PID", "WATCHDOG_USEC", "SYSTEMD_EXEC_PID", "PWD", "OLDPWD", "_", "PORT", "HOST"]);

/**
 * The environment a chat process starts with (design §1.2): the server's (in-process chats see it
 * whole today), minus DENY; PATH with Sova's Bun first and the Claude program's directory next (so the
 * chat finds the same `claude` the server resolved, whatever its cwd's mise config says), then the
 * server's PATH; HOME; PI_CODING_AGENT_DIR. `extra` (the chat's own `SOVA_CHAT_*`) goes last and wins.
 */
export function chatEnv(o: { serverEnv: NodeJS.ProcessEnv; bun: string; claude?: string | null; home: string; agentDir: string; extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.serverEnv)) if (v !== undefined && !DENY.has(k)) env[k] = v;
  const path: string[] = [];
  for (const d of [dirname(o.bun), ...(o.claude ? [dirname(o.claude)] : []), ...(o.serverEnv.PATH ?? "").split(":")]) if (d.startsWith("/") && !path.includes(d)) path.push(d);
  env.PATH = path.join(":");
  env.HOME = o.home;
  env.PI_CODING_AGENT_DIR = o.agentDir;
  return { ...env, ...o.extra };
}

// ---- records ------------------------------------------------------------------------------------

/** Why a chat process exits when it says so first (its `exit{cause}`), or the supervisor stopped it. */
export type { ExitCause };

export interface ChatDeath {
  chatId: string;
  sessionPath: string;
  unit: string;
  /** `crashed`: the process ended on its own (an exit or signal the supervisor saw); `lost`: its unit is gone and how it ended is unknown, or it stopped answering. */
  cause: "crashed" | "lost";
  exit: number | null;
  signal: string | null;
  detail?: string;
  /** The unit's last log lines (its journal), oldest first. */
  logTail: string[];
  at: string;
}

export interface ChatRecord {
  chatId: string;
  sessionPath: string;
  cwd: string;
  unit: string;
  pid: number | null;
  sock: string;
  /** The controller epoch of the server that started it. */
  epoch: number;
  /** The build the process was started on (SOVA_CHAT_BUILD), for the older-code badge. */
  build?: string;
  startedAt: string;
  /** It said it exits (or was asked to), for this cause: its end is no death. */
  exiting?: ExitCause;
  /** Written before the death is reported; the record goes once the report was delivered. */
  death?: ChatDeath;
}

function readRecord(file: string): ChatRecord | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ChatRecord;
  } catch {
    return null;
  }
}

// ---- the supervisor -----------------------------------------------------------------------------

export interface ChatLaunch {
  chatId: string;
  sessionPath: string;
  cwd: string;
}

export interface SupervisorDeps {
  driver: Driver;
  /** The chat process's argv and env (`[bun, main.ts]`; `chatEnv` with SOVA_CHAT_*), and the build it runs. */
  launch(chat: ChatLaunch & { unit: string; sock: string; epoch: number }): { argv: string[]; env: Record<string, string>; build?: string };
  /** This server's controller epoch (nextEpoch at boot). */
  epoch: number;
  /** A chat process died without saying it exits: called once per death. */
  onDeath?(death: ChatDeath): void | Promise<void>;
  /** The supervisor closed a chat of its own accord (idle). */
  onStopped?(chatId: string, cause: ExitCause): void;
  /** A chat started here ended (or was given up) before its first hello: a spawn failure, logged and
      never a death. The router opens it in the server's process until the server restarts. */
  onBootFailed?(chatId: string, death: ChatDeath): void;
  /** Ask the chat to close (`drain{reason, force:false}`); it re-checks and may refuse. */
  drain?(chatId: string, reason: "idle" | "reload"): Promise<{ ok: boolean }>;
  /** Ask chat `chatId` to let its idle Claude CLI child go (the handle's releaseIdleModelChild). */
  reapClaude?(chatId: string): void | Promise<"released" | "busy" | "none" | void>;
  /** Whether a process other than a chat's exiting one still holds the session's writer lock. */
  lockHeld?(sessionPath: string): boolean;
  /** Count `pid` among this server's own chat processes until the returned call (live.ts addOwnPid). */
  ownPid?(pid: number): () => void;
  registryDir?: () => string;
  deathsFile?: () => string;
  socketPath?: (chatId: string, suffix?: string) => string;
  unitPrefix?: string;
  /** 0: never stop an idle chat (default 30 min). */
  idleMs?: number;
  claudeIdleMax?: number;
  /** How long to wait for a started unit's main process, an accepted drain's exit, a predecessor's. */
  startWaitMs?: number;
  exitWaitMs?: number;
  predecessorWaitMs?: number;
  pollMs?: number;
  /** The chat process's working directory (default the repository root, as for the server: never the chat's own cwd, whose mise config must not pick the runtime). */
  workdir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface Tracked {
  rec: ChatRecord;
  releasePid: () => void;
  idleSince: number | null;
  /** An idle drain is in flight: not asked again. */
  draining: boolean;
  claude: "none" | "idle" | "busy";
  claudeIdleSince: number;
  /** When a release was asked: until the mirror answers, it counts as let go (cleared after 30 s). */
  reaping: number | null;
  /** It said hello on a link (an adopted chat did, to an earlier server): its end is a death, not a failed start. */
  connected: boolean;
}

const isUp = (s: UnitStatus) => s.state === "active" || s.state === "activating";
/** The unit and its main process are gone (a deactivating unit still has its pid). */
const isGone = (s: UnitStatus) => !isUp(s) && s.pid === null;

/** The cause a chat process logged on its way out (`[chat-runtime] exit <cause> (pid <n>)`, main.ts),
    for process `pid`: an end it announced even when no server was linked to hear its `exit` frame. */
export function announcedExit(lines: readonly string[], pid: number | null): ExitCause | null {
  if (pid === null) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\[chat-runtime\] exit (\w+) \(pid (\d+)\)/.exec(lines[i]!);
    if (m && Number(m[2]) === pid) return m[1] as ExitCause;
  }
  return null;
}

/** systemd's own account of how a unit's main process ended, from its journal lines. */
export function exitOfLog(lines: readonly string[]): { exit: number | null; signal: string | null } | null {
  // Back to this run's "Started" line. A main process that ended on its own says so ("Main process
  // exited", then "Failed with result"); a unit that ended cleanly by itself says "Deactivated
  // successfully" (older systemd: "Succeeded."); one stopped by request whose process exited 0 says only
  // "Stopping …" and "Stopped …".
  let failed: string | null = null;
  let stopped = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/: (Deactivated successfully|Succeeded)\.$/.test(line)) return { exit: 0, signal: null };
    const m = /Main process exited, code=(\w+), status=(\d+)(?:\/(\w+))?/.exec(line);
    if (m) return m[1] === "exited" ? { exit: Number(m[2]), signal: null } : { exit: null, signal: m[3] ?? `signal ${m[2]}` };
    const f = /Failed with result '([\w-]+)'/.exec(line);
    if (f) failed ??= f[1]!;
    else if (/^Stopped /.test(line)) stopped = true;
    else if (/^Started /.test(line)) break;
  }
  if (failed) return { exit: null, signal: failed };
  return stopped ? { exit: 0, signal: null } : null;
}

export class ChatSupervisor {
  private chats = new Map<string, Tracked>();
  private ticking = false;
  private skippedEnv = new Set<string>();
  private readonly regDir: () => string;
  private readonly deaths: () => string;
  private readonly sockOf: (chatId: string, suffix?: string) => string;
  private readonly prefix: string;
  private readonly idleMs: number;
  private readonly claudeMax: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  constructor(private readonly deps: SupervisorDeps) {
    this.regDir = deps.registryDir ?? registryDir;
    this.deaths = deps.deathsFile ?? deathsFile;
    this.sockOf = deps.socketPath ?? ((id, suffix) => chatSocketPath(id, { suffix }));
    this.prefix = deps.unitPrefix ?? chatUnitPrefix();
    this.idleMs = deps.idleMs ?? IDLE_STOP_MIN * 60_000;
    this.claudeMax = deps.claudeIdleMax ?? CLAUDE_IDLE_MAX;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? ((l) => console.log(`[chat-supervisor] ${l}`));
  }

  /** The unit of chat `chatId` (with `suffix`, a reload's replacement). */
  unitOf(chatId: string, suffix = ""): string {
    return `${this.prefix}${idPart(chatId, 36)}${suffix}`;
  }
  private file = (chatId: string) => join(this.regDir(), `${encodeURIComponent(chatId)}.json`);
  private write(rec: ChatRecord) {
    mkdirSync(this.regDir(), { recursive: true, mode: 0o700 });
    const f = this.file(rec.chatId);
    writeFileSync(`${f}.tmp`, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }
  private records(): ChatRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.regDir());
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith(".json")).flatMap((n) => readRecord(join(this.regDir(), n)) ?? []);
  }
  private track(rec: ChatRecord, connected = true): Tracked {
    this.chats.get(rec.chatId)?.releasePid();
    const t: Tracked = { rec, releasePid: rec.pid && this.deps.ownPid ? this.deps.ownPid(rec.pid) : () => {}, idleSince: null, draining: false, claude: "none", claudeIdleSince: 0, reaping: null, connected };
    this.chats.set(rec.chatId, t);
    return t;
  }

  /** The chats this supervisor runs now. */
  list(): ChatRecord[] {
    return [...this.chats.values()].map((t) => t.rec);
  }
  record(chatId: string): ChatRecord | undefined {
    return this.chats.get(chatId)?.rec;
  }

  /** Wait until `unit` and its main process are gone; false when it is still there after `ms`. */
  private async waitGone(unit: string, ms: number, sessionPath?: string): Promise<boolean> {
    const until = this.now() + ms;
    for (;;) {
      const gone = isGone(await this.deps.driver.status(unit)) && !(sessionPath && this.deps.lockHeld?.(sessionPath));
      if (gone || this.now() >= until) return gone;
      await this.sleep(this.deps.pollMs ?? 100);
    }
  }

  /** Start `unit` for `chat` and wait for its main process; the record is the caller's to write. */
  private async spawn(chat: ChatLaunch, unit: string, sock: string): Promise<ChatRecord> {
    const { argv, env, build } = this.deps.launch({ ...chat, unit, sock, epoch: this.deps.epoch });
    // What a unit's env file can't carry is dropped there: said once per name, so a missing variable is visible.
    for (const [k, v] of Object.entries(env))
      if (!envFileKeeps(k, v) && !this.skippedEnv.has(k)) {
        this.skippedEnv.add(k);
        this.log(`env ${k} is not passed to chat processes (${/[\n\r]/.test(v) ? "a value on more than one line" : "not a variable name"})`);
      }
    const rec: ChatRecord = { ...chat, unit, pid: null, sock, epoch: this.deps.epoch, ...(build ? { build } : {}), startedAt: new Date(this.now()).toISOString() };
    await this.deps.driver.start({ unit, argv, cwd: this.deps.workdir ?? REPO_ROOT, env });
    const until = this.now() + (this.deps.startWaitMs ?? 10_000);
    let st = await this.deps.driver.status(unit);
    while (st.pid === null && st.state === "activating" && this.now() < until) {
      await this.sleep(50);
      st = await this.deps.driver.status(unit);
    }
    rec.pid = st.pid;
    return rec;
  }

  /**
   * Start chat `chat.chatId` in a unit of its own; a chat already running is returned as it is. A
   * previous process of the chat still exiting (it said `closed`, `archived` or `reload`) is waited
   * for, up to 10 s, until its unit and the session's writer lock are free.
   */
  async start(chat: ChatLaunch): Promise<ChatRecord> {
    const held = this.chats.get(chat.chatId);
    if (held) {
      const st = await this.deps.driver.status(held.rec.unit);
      if (!held.rec.exiting && isUp(st)) return held.rec;
      if (held.rec.exiting && !(await this.waitGone(held.rec.unit, this.deps.predecessorWaitMs ?? PREDECESSOR_WAIT_MS, held.rec.sessionPath)))
        throw new Error(`The chat's previous process (${held.rec.unit}) is still closing.`);
      await this.check(chat.chatId);
    }
    const unit = this.unitOf(chat.chatId);
    const sock = this.sockOf(chat.chatId);
    // Recorded before the unit exists: a server that dies in between adopts it, or reports it lost.
    this.write({ ...chat, unit, pid: null, sock, epoch: this.deps.epoch, startedAt: new Date(this.now()).toISOString() });
    let rec: ChatRecord;
    try {
      rec = await this.spawn(chat, unit, sock);
    } catch (err) {
      rmSync(this.file(chat.chatId), { force: true });
      throw err;
    }
    this.write(rec);
    this.track(rec, false);
    if (rec.pid === null) await this.check(chat.chatId);
    return rec;
  }

  /** Chat `chatId` said it exits (`exit{cause}`), or is asked to: its end is no death. */
  expectExit(chatId: string, cause: ExitCause): void {
    const t = this.chats.get(chatId);
    if (!t) return;
    t.rec = { ...t.rec, exiting: cause };
    this.write(t.rec);
  }
  /** A drain the chat refused: it keeps running, and its end is a death again. */
  unexpectExit(chatId: string): void {
    const t = this.chats.get(chatId);
    if (!t?.rec.exiting) return;
    const { exiting: _, ...rec } = t.rec;
    t.rec = rec;
    this.write(rec);
  }

  /** Stop chat `chatId` (SIGTERM, then SIGKILL to the whole unit after 30 s) and forget it. */
  async stop(chatId: string, cause: ExitCause = "operator"): Promise<void> {
    const t = this.chats.get(chatId);
    const unit = t?.rec.unit ?? this.unitOf(chatId);
    this.expectExit(chatId, cause);
    await this.deps.driver.stop(unit);
    this.forget(chatId);
    this.log(`${chatId}: stopped (${cause})`);
  }

  private forget(chatId: string) {
    this.chats.get(chatId)?.releasePid();
    this.chats.delete(chatId);
    rmSync(this.file(chatId), { force: true });
  }

  /** How `rec`'s unit ended, read now: null when it ended cleanly (exit 0: an operator stop, no death). */
  private async deathOf(rec: ChatRecord, st: UnitStatus): Promise<ChatDeath | null> {
    // This run's lines only (the journal keeps earlier runs of the same unit name).
    const since = Date.parse(rec.startedAt);
    const read = async () => (await this.deps.driver.logs(rec.unit, LOG_TAIL * 3, Number.isFinite(since) ? since : undefined).catch(() => [])).map((l) => l.text);
    // The journal can lag the process's end by a moment: with no account of how it ended yet, read again
    // a few times before calling it lost.
    let logs = await read();
    for (let i = 0; i < JOURNAL_RETRIES && st.exit == null && !announcedExit(logs, rec.pid) && !exitOfLog(logs); i++) {
      await this.sleep(JOURNAL_RETRY_MS);
      logs = await read();
    }
    // It said why it exits, with no server linked to hear it: no death.
    if (announcedExit(logs, rec.pid)) return null;
    // A collected unit is gone at once: its journal still says how its main process ended.
    const said = exitOfLog(logs);
    const exit = st.exit ?? said?.exit ?? null;
    const signal = said?.signal ?? null;
    if (exit === 0 && signal === null) return null;
    const tail = logs.filter((l) => !/(Main process exited|Failed with result|Consumed .* CPU time|^Stopped |^Started |^Stopping |Deactivated successfully)/.test(l)).slice(-LOG_TAIL);
    return {
      chatId: rec.chatId,
      sessionPath: rec.sessionPath,
      unit: rec.unit,
      cause: exit === null && signal === null ? "lost" : "crashed",
      exit,
      signal,
      ...(st.detail ? { detail: st.detail } : {}),
      logTail: tail,
      at: new Date(this.now()).toISOString(),
    };
  }

  /** Report `rec`'s death once: written to its record and the deaths log first, the record removed once the report was delivered. */
  private async report(rec: ChatRecord, death: ChatDeath, logged = false): Promise<void> {
    this.write({ ...rec, death });
    if (!logged) {
      try {
        mkdirSync(dirname(this.deaths()), { recursive: true, mode: 0o700 });
        appendFileSync(this.deaths(), `${JSON.stringify(death)}\n`, { mode: 0o600 });
      } catch (err) {
        this.log(`deaths log: ${(err as Error).message}`);
      }
    }
    this.chats.get(rec.chatId)?.releasePid();
    this.chats.delete(rec.chatId);
    this.log(`${rec.chatId}: died (${death.cause}${death.exit !== null ? `, exit ${death.exit}` : ""}${death.signal ? `, ${death.signal}` : ""})`);
    try {
      await this.deps.onDeath?.(death);
    } finally {
      rmSync(this.file(rec.chatId), { force: true });
    }
  }

  /**
   * Look at chat `chatId`'s unit now (the server saw its link close, or the watch ticks). A unit
   * that is gone is an expected end (it said it exits, or exit 0), or a death, reported once.
   */
  /** Chat `chatId` said hello on its link: from now on its end is a death. */
  noteConnected(chatId: string): void {
    const t = this.chats.get(chatId);
    if (t) t.connected = true;
  }

  /** A start that failed before the chat's first hello: forgotten and logged, never a death. */
  private bootFailed(t: Tracked, death: ChatDeath): void {
    this.forget(t.rec.chatId);
    this.log(`${t.rec.chatId}: its process did not start (${death.detail ?? death.cause}${death.exit !== null ? `, exit ${death.exit}` : ""}${death.signal ? `, ${death.signal}` : ""}): ${death.logTail.at(-1) ?? "no output"}`);
    this.deps.onBootFailed?.(t.rec.chatId, death);
  }

  async check(chatId: string): Promise<"up" | "ended" | "died" | "boot-failed" | "unknown"> {
    const t = this.chats.get(chatId);
    if (!t) return "unknown";
    const st = await this.deps.driver.status(t.rec.unit);
    if (isUp(st) || st.pid !== null) return "up";
    if (this.chats.get(chatId) !== t) return "unknown";
    const death = t.rec.exiting ? null : await this.deathOf(t.rec, st);
    if (!death) {
      this.forget(chatId);
      return "ended";
    }
    if (!t.connected) {
      this.bootFailed(t, death);
      return "boot-failed";
    }
    await this.report(t.rec, death);
    return "died";
  }

  /** The unit is up but the chat stopped answering (no hello in time, or its link lost for too long): stop it and report it lost (before its first hello, a failed start). */
  async lost(chatId: string, detail: string): Promise<void> {
    const t = this.chats.get(chatId);
    if (!t) return;
    await this.deps.driver.stop(t.rec.unit).catch(() => {});
    const logs = (await this.deps.driver.logs(t.rec.unit, LOG_TAIL).catch(() => [])).map((l) => l.text);
    const death: ChatDeath = { chatId, sessionPath: t.rec.sessionPath, unit: t.rec.unit, cause: "lost", exit: null, signal: null, detail, logTail: logs, at: new Date(this.now()).toISOString() };
    // One that never said hello did not start: a failed start, not a death.
    if (!t.connected) return this.bootFailed(t, death);
    await this.report(t.rec, death);
  }

  /**
   * At a server start: take charge of the chat units already running (each recorded chat whose unit
   * is up), report as deaths the recorded chats whose unit is gone (once: a death recorded but not
   * yet delivered is delivered now), and stop units of this state root that no record names (a
   * reload's replacement cut off with its server, too).
   */
  async adopt(): Promise<{ adopted: ChatRecord[]; died: ChatDeath[] }> {
    const adopted: ChatRecord[] = [];
    const died: ChatDeath[] = [];
    const named = new Set<string>();
    for (const rec of this.records()) {
      named.add(rec.unit);
      if (this.chats.has(rec.chatId)) continue;
      if (rec.death) {
        died.push(rec.death);
        await this.report(rec, rec.death, true);
        continue;
      }
      const st = await this.deps.driver.status(rec.unit);
      if (isUp(st)) {
        const fresh = { ...rec, pid: st.pid ?? rec.pid };
        if (fresh.pid !== rec.pid) this.write(fresh);
        this.track(fresh);
        adopted.push(fresh);
        continue;
      }
      const death = rec.exiting ? null : await this.deathOf(rec, st);
      if (!death) {
        rmSync(this.file(rec.chatId), { force: true });
        continue;
      }
      died.push(death);
      await this.report(rec, death);
    }
    for (const unit of await this.deps.driver.units(this.prefix).catch(() => [] as string[])) {
      if (named.has(unit)) continue;
      this.log(`${unit}: no chat records it; stopping it`);
      await this.deps.driver.stop(unit).catch(() => {});
    }
    return { adopted, died };
  }

  /** Chat `chatId`'s mirror: idle (quiet, nobody attached) since `since`, or not. */
  noteIdle(chatId: string, idle: boolean, since?: number): void {
    const t = this.chats.get(chatId);
    if (!t) return;
    if (!idle) t.idleSince = null;
    else if (t.idleSince === null) t.idleSince = since ?? this.now();
  }

  /** Chat `chatId`'s Claude CLI child: none, idle (kept for the next turn) or busy (never reaped). */
  noteClaude(chatId: string, state: "none" | "idle" | "busy"): void {
    const t = this.chats.get(chatId);
    if (!t) return;
    if (state === "idle" && t.claude !== "idle") t.claudeIdleSince = this.now();
    t.claude = state;
    t.reaping = null;
    this.capClaude();
  }

  /** Beyond the cap, the idle Claude children idle longest are let go; busy ones never. */
  private capClaude(): void {
    const idle = [...this.chats.entries()].filter(([, t]) => t.claude === "idle" && t.reaping === null).sort((a, b) => a[1].claudeIdleSince - b[1].claudeIdleSince);
    for (let i = 0; i < idle.length - this.claudeMax; i++) {
      const [id, t] = idle[i]!;
      const asked = this.now();
      t.reaping = asked;
      // A release that failed, or found no idle child, must not keep the chat out of the count: the
      // cap would let one more go than needed.
      const unmark = (claude?: "busy" | "none") => {
        if (this.chats.get(id) !== t || t.reaping !== asked) return;
        t.reaping = null;
        if (claude) t.claude = claude;
      };
      let asking: ReturnType<NonNullable<SupervisorDeps["reapClaude"]>>;
      try {
        asking = this.deps.reapClaude?.(id);
      } catch {
        unmark();
        continue;
      }
      Promise.resolve(asking).then(
        (r) => (r === "busy" || r === "none" ? unmark(r) : undefined),
        () => unmark(),
      );
    }
  }

  /**
   * Close an idle chat through its drain: the chat re-checks that it is quiet with nobody attached.
   * A refusal restarts its idle clock; an accepted drain is waited for 30 s, then the unit is stopped.
   */
  private async idleStop(chatId: string, t: Tracked): Promise<void> {
    if (!this.deps.drain) return;
    t.draining = true;
    try {
      this.expectExit(chatId, "idle");
      const r = await this.deps.drain(chatId, "idle").catch(() => ({ ok: false }));
      if (!r.ok) {
        this.unexpectExit(chatId);
        t.idleSince = null;
        return;
      }
      if (!(await this.waitGone(t.rec.unit, this.deps.exitWaitMs ?? EXIT_WAIT_MS))) await this.deps.driver.stop(t.rec.unit);
      if (this.chats.get(chatId) === t) this.forget(chatId);
      this.log(`${chatId}: closed (idle)`);
      this.deps.onStopped?.(chatId, "idle");
    } finally {
      t.draining = false;
    }
  }

  /** One pass of the watch: deaths are reported, and chats idle for the whole idle time are asked to close. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [id, t] of [...this.chats]) {
        if (t.draining || (await this.check(id)) !== "up") continue;
        if (t.reaping !== null && this.now() - t.reaping >= REAP_WAIT_MS) {
          t.reaping = null;
          this.capClaude();
        }
        if (this.idleMs > 0 && !t.rec.exiting && t.idleSince !== null && this.now() - t.idleSince >= this.idleMs) await this.idleStop(id, t);
      }
    } finally {
      this.ticking = false;
    }
  }

  // ---- reload replacements (rollout.ts) ---------------------------------------------------------

  private replacements = 0;
  /** Start a replacement process for chat `chatId` beside its current one (unit `…-r<n>`, its own socket): not recorded, never opened yet. */
  async startReplacement(chatId: string): Promise<ChatRecord> {
    const t = this.chats.get(chatId);
    if (!t) throw new Error(`chat ${chatId} has no process`);
    const n = ++this.replacements;
    return await this.spawn({ chatId, sessionPath: t.rec.sessionPath, cwd: t.rec.cwd }, this.unitOf(chatId, `-r${n}`), this.sockOf(chatId, `-r${n}`));
  }
  /** Stop a replacement that is not used. */
  async stopUnit(unit: string): Promise<void> {
    await this.deps.driver.stop(unit).catch(() => {});
  }
  /** Wait for chat `chatId`'s current process to exit (30 s), then stop what is left of it. */
  async awaitExit(chatId: string): Promise<void> {
    const t = this.chats.get(chatId);
    if (!t) return;
    if (!(await this.waitGone(t.rec.unit, this.deps.exitWaitMs ?? EXIT_WAIT_MS))) await this.deps.driver.stop(t.rec.unit);
  }
  /** Wait up to 10 s until no process holds `sessionPath`'s writer lock (a stale one, of a dead pid, counts as free). */
  async waitUnlocked(sessionPath: string): Promise<boolean> {
    const until = this.now() + (this.deps.predecessorWaitMs ?? PREDECESSOR_WAIT_MS);
    for (;;) {
      if (!this.deps.lockHeld?.(sessionPath)) return true;
      if (this.now() >= until) return false;
      await this.sleep(this.deps.pollMs ?? 100);
    }
  }
  /** Chat `chatId` now runs in `rep` (its old process gone): the record and the own pid follow. */
  repoint(chatId: string, rep: ChatRecord): void {
    this.write(rep);
    this.track(rep);
  }

  private timer: NodeJS.Timeout | null = null;
  /** Run the watch every `ms` until `unwatch`. */
  watch(ms = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => this.log(`watch: ${(err as Error).message}`)), ms);
    this.timer.unref();
  }
  unwatch(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** At server shutdown: stop watching and let go of the chats, which keep running. */
  detach(): void {
    this.unwatch();
    for (const t of this.chats.values()) t.releasePid();
    this.chats.clear();
  }
}

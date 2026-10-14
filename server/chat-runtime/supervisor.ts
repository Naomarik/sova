import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DetachedDriver, envFileKeeps, realExec, SystemdDriver, type Driver, type Exec, type UnitStatus } from "../project-services/drivers";
import { type ProcTable, realSyncExec, type SyncExec } from "../project-services/proctable";
import { stateHash } from "../project-services/store";
import type { ExitCause } from "../../shared/chat-runtime-wire";
import { stateRoot } from "../state-root";
import { GC_TIMER_OFF } from "./gc-timer";

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

export type ChatHost = { driver: "systemd" | "detached"; why: string };

/**
 * How this server runs chat processes (§app.chat-processes/supervision): systemd user units where the
 * user manager answers (Linux), else detached sessions it records (macOS, a Linux without one).
 * `SOVA_CHAT_DRIVER=detached` (tests) skips the probe. Never in this process.
 */
export async function chooseChatHost(deps: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; driver?: Pick<Driver, "available"> } = {}): Promise<ChatHost> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if (supervisorConfig(env).driver === "detached") return { driver: "detached", why: "detached sessions (SOVA_CHAT_DRIVER=detached)" };
  if (platform !== "linux") return { driver: "detached", why: `detached sessions (${platform} has no systemd)` };
  const probe = await (deps.driver ?? new SystemdDriver()).available();
  return probe.ok ? { driver: "systemd", why: `systemd user units: ${probe.detail}` } : { driver: "detached", why: `detached sessions: ${probe.detail}` };
}

/** The driver chats run under: systemd units in the chats' slice, env in a 0600 file, never restarted by
    systemd; or detached sessions recorded under `chats/procs` and `chats/logs`. */
export function chatDriver(config: Pick<SupervisorConfig, "slice" | "driver"> = supervisorConfig(), exec: Exec = realExec): Driver {
  if (config.driver === "detached") return new DetachedDriver(CHAT_STOP_SEC * 1000, { restart: false, procsDir: () => join(chatsRoot(), "procs"), logsDir: () => join(chatsRoot(), "logs") });
  return new SystemdDriver(exec, { slice: config.slice, timeoutStopSec: CHAT_STOP_SEC, restart: false, envFile: (unit) => join(envDir(), `${unit}.env`) });
}

/** Once, at a server's start: workers an older server ran as its own detached children (records under
    `chats/children/`, prefix `sova-chatw-<hash>-`) are stopped, and the place removed. What it stopped. */
export async function sweepOldChildren(root = join(chatsRoot(), "children"), hash = stateHash(), table?: ProcTable): Promise<string[]> {
  const driver = new DetachedDriver(CHAT_STOP_SEC * 1000, { restart: false, procsDir: () => join(root, "procs"), logsDir: () => join(root, "logs"), ...(table ? { table } : {}) });
  const units = await driver.units(`sova-chatw-${hash}-`).catch(() => [] as string[]);
  for (const unit of units) await driver.stop(unit).catch(() => {});
  rmSync(root, { recursive: true, force: true });
  return units;
}

// ---- socket path and epoch ----------------------------------------------------------------------

/** The longest a unix socket's path may be: sockaddr_un's sun_path less its terminating NUL. */
export const sockPathMax = (platform: NodeJS.Platform = process.platform): number => (platform === "darwin" ? 103 : 107);
/** Room kept for a reload replacement's suffix (`-r<epoch base36>-<n>`, supervisor.startReplacement). */
const SUFFIX_ROOM = 18;

/**
 * Where chat `chatId`'s socket lives (design §2.1): `<state root>/chats/s/<hash16><suffix>.sock` when
 * that path, with room for a replacement's suffix, fits the platform's sockaddr limit; else under
 * `<XDG_RUNTIME_DIR or the temp dir>/sova-chats-<state hash>/` (on macOS `/private/tmp`, since its temp
 * dir under /var/folders is too deep). A path that fits neither is refused: no socket is ever cut short.
 */
export function chatSocketPath(chatId: string, o: { suffix?: string; root?: string; runtimeDir?: string | undefined; tmp?: string; hash?: string; platform?: NodeJS.Platform } = {}): string {
  const platform = o.platform ?? process.platform;
  const max = sockPathMax(platform);
  // A short hash of the whole id: a session id's first characters are its creation time (UUIDv7),
  // so two chats made in the same millisecond would share a prefix. A chat already running keeps
  // the path its record names (adoption connects to `rec.sock`, never to this).
  const id = createHash("sha256").update(chatId).digest("hex").slice(0, 16);
  // The place is chosen without the suffix, so a chat's replacements live beside it.
  const fits = (dir: string) => Buffer.byteLength(join(dir, `${id}.sock`)) + SUFFIX_ROOM <= max;
  const name = `${id}${o.suffix ?? ""}.sock`;
  const primary = join(o.root ?? chatsRoot(), "s");
  if (fits(primary)) return join(primary, name);
  const base = platform === "darwin" ? "/private/tmp" : ("runtimeDir" in o ? o.runtimeDir : process.env.XDG_RUNTIME_DIR) || (o.tmp ?? tmpdir());
  const fallback = join(base, `sova-chats-${o.hash ?? stateHash()}`);
  const path = join(fallback, name);
  if (!fits(fallback) || Buffer.byteLength(path) > max) throw new Error(`This chat's socket path is too long for a unix socket here (at most ${max} bytes): ${path}`);
  return path;
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

/** What a chat process never inherits from the server: the service manager's per-unit variables, the shell's own, and the server's listen settings and code root. */
const DENY = new Set(["INVOCATION_ID", "JOURNAL_STREAM", "MANAGERPID", "NOTIFY_SOCKET", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES", "WATCHDOG_PID", "WATCHDOG_USEC", "SYSTEMD_EXEC_PID", "PWD", "OLDPWD", "_", "PORT", "HOST", "SOVA_CHAT_CODE_ROOT"]);

/**
 * The variables the launch sets for one chat process, and only for it: its socket, file, id, unit and
 * build, the state root of the server that started it, and where its code was copied from and to
 * (§app.chat-processes/code-generations). A server never reads them: one started from a chat's own
 * tools (a hermetic server in a worktree) deletes them from its env at boot (scrubChatProcessEnv),
 * and a chat process never inherits them from its server.
 */
export const CHAT_PROCESS_ENV = [
  "SOVA_CHAT_SOCK",
  "SOVA_CHAT_PATH",
  "SOVA_CHAT_ID",
  "SOVA_CHAT_UNIT",
  "SOVA_CHAT_BUILD",
  "SOVA_CHAT_STATE_ROOT",
  "SOVA_CHAT_LIVE_ROOT",
  "SOVA_CHAT_COPIES_ROOT",
] as const;

/** Delete every chat process's own variable from a server's env (the server: at boot, before anything reads it); the names it held. */
export function scrubChatProcessEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const held = CHAT_PROCESS_ENV.filter((k) => k in env);
  for (const k of held) delete env[k];
  return held;
}

/**
 * The environment a chat process starts with (design §1.2): the server's (in-process chats see it
 * whole today), minus DENY and CHAT_PROCESS_ENV; PATH with Sova's Bun first and the Claude program's directory next (so the
 * chat finds the same `claude` the server resolved, whatever its cwd's mise config says), then the
 * server's PATH; HOME; PI_CODING_AGENT_DIR; Bun's GC timer off (server/chat-runtime/gc-timer.ts). `extra`
 * (the chat's own `SOVA_CHAT_*`) goes last and wins.
 */
export function chatEnv(o: { serverEnv: NodeJS.ProcessEnv; bun: string; claude?: string | null; home: string; agentDir: string; extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.serverEnv)) if (v !== undefined && !DENY.has(k) && !(CHAT_PROCESS_ENV as readonly string[]).includes(k)) env[k] = v;
  const path: string[] = [];
  for (const d of [dirname(o.bun), ...(o.claude ? [dirname(o.claude)] : []), ...(o.serverEnv.PATH ?? "").split(":")]) if (d.startsWith("/") && !path.includes(d)) path.push(d);
  env.PATH = path.join(":");
  env.HOME = o.home;
  env.PI_CODING_AGENT_DIR = o.agentDir;
  env[GC_TIMER_OFF.name] = GC_TIMER_OFF.value;
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
  /** When the unit's main process ended, from the journal line saying so (systemd); absent when unknown (the detached driver). */
  endedAt?: string;
  /** The dead process's pid, from its record (a death found at a server's start has no handle to say it). */
  pid?: number | null;
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

/** A recorded chat's pid counted as this server's own before its supervisor takes it over. */
interface Claim {
  pid: number;
  release: () => void;
}
/** Claims made at start (claimRecordedChats), by chat id, until a supervisor takes them over. */
const preclaimed = new Map<string, Claim>();

/**
 * Count every chat process a previous server recorded under this state root as this server's own, at
 * once and synchronously, before anything reads the live records: from the server's start until its
 * supervisor has adopted them (which waits on the build and on systemd), a chat process's live record
 * must never read as a terminal owning its file (session_send, auto-resume, attention). The
 * supervisor takes the claims over, and lets go of each whose process turns out gone.
 */
export function claimRecordedChats(ownPid: (pid: number) => () => void, dir: () => string = registryDir, isChatProcess: (pid: number) => boolean = chatProcessAlive): void {
  let names: string[];
  try {
    names = readdirSync(dir());
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const rec = readRecord(join(dir(), n));
    if (!rec?.pid || rec.death || preclaimed.has(rec.chatId) || !isChatProcess(rec.pid)) continue;
    preclaimed.set(rec.chatId, { pid: rec.pid, release: ownPid(rec.pid) });
  }
}

/** Whether `pid` is alive and a chat process (never a pid reused by another program, say a
    terminal's pi on the same file): its command from /proc on Linux, from `ps` elsewhere. */
export function chatProcessAlive(pid: number, platform: NodeJS.Platform = process.platform, exec: SyncExec = realSyncExec): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  let command: string;
  if (platform === "linux") {
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return false;
    }
  } else {
    const r = exec("ps", ["-o", "command=", "-p", String(pid)]);
    if (r.code !== 0) return false;
    command = r.stdout;
  }
  return command.includes("chat-runtime/main.ts");
}

export interface ChatLaunch {
  chatId: string;
  sessionPath: string;
  cwd: string;
}

export interface SupervisorDeps {
  driver: Driver;
  /** The chat process's argv and env (`[bun, main.ts]`; `chatEnv` with SOVA_CHAT_*), the build it runs, and
      where it runs (its code generation's copy; default `workdir`). */
  launch(chat: ChatLaunch & { unit: string; sock: string; epoch: number }): { argv: string[]; env: Record<string, string>; build?: string; nice?: number; workdir?: string };
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
  /** Whether `pid` still runs a chat process (chatProcessAlive: its command line, so never a reused pid). */
  isChatProcess?(pid: number): boolean;
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
  /** Found lost, but its unit outlived the stop (a stop that failed): kept, record and build, and stopped
      again at each watch tick until it is gone; why it was lost. */
  lostDetail: string | null;
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
  /** Recorded chats' pids counted as own before they are tracked (claimRecordedChats), by chat id. */
  private claims = new Map<string, Claim>();
  /** Replacement processes' pids counted as own from their start until repoint or stopUnit, by unit. */
  private replacementClaims = new Map<string, Claim>();
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
    for (const [id, c] of preclaimed) this.claims.set(id, c);
    preclaimed.clear();
  }

  /** Count `pid` as own; the call that lets go of it. */
  private own(pid: number | null): () => void {
    return pid && this.deps.ownPid ? this.deps.ownPid(pid) : () => {};
  }
  /** A claim made before tracking ends: kept if `pid` is still the chat's, else let go. */
  private takeClaim(chatId: string, pid: number | null): (() => void) | null {
    const c = this.claims.get(chatId);
    if (!c) return null;
    this.claims.delete(chatId);
    if (c.pid === pid) return c.release;
    c.release();
    return null;
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
  private track(rec: ChatRecord, connected = true, claimed: (() => void) | null = null): Tracked {
    const before = this.chats.get(rec.chatId);
    const kept = claimed ?? this.takeClaim(rec.chatId, rec.pid);
    // The same process tracked again keeps its count (a release, then an add, would drop it between).
    let releasePid: () => void;
    if (kept) {
      before?.releasePid();
      releasePid = kept;
    } else if (before && before.rec.pid === rec.pid) releasePid = before.releasePid;
    else {
      before?.releasePid();
      releasePid = this.own(rec.pid);
    }
    const t: Tracked = { rec, releasePid, idleSince: null, draining: false, claude: "none", claudeIdleSince: 0, reaping: null, connected, lostDetail: null };
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
    const { argv, env, build, nice, workdir } = this.deps.launch({ ...chat, unit, sock, epoch: this.deps.epoch });
    // What a unit's env file can't carry is dropped there: said once per name, so a missing variable is visible.
    for (const [k, v] of Object.entries(env))
      if (!envFileKeeps(k, v) && !this.skippedEnv.has(k)) {
        this.skippedEnv.add(k);
        this.log(`env ${k} is not passed to chat processes (${/[\n\r]/.test(v) ? "a value on more than one line" : "not a variable name"})`);
      }
    const rec: ChatRecord = { ...chat, unit, pid: null, sock, epoch: this.deps.epoch, ...(build ? { build } : {}), startedAt: new Date(this.now()).toISOString() };
    await this.deps.driver.start({ unit, argv, cwd: workdir ?? this.deps.workdir ?? REPO_ROOT, env, ...(nice ? { nice } : {}) });
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
    // A process a previous server left running that this one has not taken back yet (a start asked
    // for before adoption finished): never started twice, and its record never overwritten, or the
    // adoption would find it unrecorded and stop it.
    const prior = held ? null : readRecord(this.file(chat.chatId));
    if (prior && !prior.death && isUp(await this.deps.driver.status(prior.unit)))
      throw new Error(`This chat's process (${prior.unit}) is still running from before this server started; it is being taken back.`);
    const unit = this.unitOf(chat.chatId);
    const sock = this.sockOf(chat.chatId);
    // Recorded before the unit exists: a server that dies in between adopts it, or reports it lost.
    this.write({ ...chat, unit, pid: null, sock, epoch: this.deps.epoch, startedAt: new Date(this.now()).toISOString() });
    let rec: ChatRecord;
    try {
      rec = await this.spawn(chat, unit, sock);
    } catch (err) {
      // The record before this start (a death to deliver, say) stays as it was.
      if (prior) this.write(prior);
      else rmSync(this.file(chat.chatId), { force: true });
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
    let entries: { t: string; text: string }[] = [];
    const read = async () => {
      entries = await this.deps.driver.logs(rec.unit, LOG_TAIL * 3, Number.isFinite(since) ? since : undefined).catch(() => []);
      return entries.map((l) => l.text);
    };
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
    // A signal the driver saw itself (the detached driver: `SIGKILL`) reads as the journal's (`KILL`).
    const seen = st.signal?.replace(/^SIG/, "") ?? null;
    const exit = seen ? null : (st.exit ?? said?.exit ?? null);
    const signal = seen ?? said?.signal ?? null;
    if (exit === 0 && signal === null) return null;
    const tail = logs.filter((l) => !/(Main process exited|Failed with result|Consumed .* CPU time|^Stopped |^Started |^Stopping |Deactivated successfully)/.test(l)).slice(-LOG_TAIL);
    // When systemd wrote down the end: its "Main process exited" line, else the unit's failing or stopping.
    const last = (re: RegExp) => [...entries].reverse().find((e) => e.t && re.test(e.text))?.t;
    const endedAt = last(/Main process exited/) ?? last(/(Failed with result|^Stopped )/);
    return {
      chatId: rec.chatId,
      sessionPath: rec.sessionPath,
      unit: rec.unit,
      cause: exit === null && signal === null ? "lost" : "crashed",
      exit,
      signal,
      ...(st.detail ? { detail: st.detail } : {}),
      logTail: tail,
      ...(endedAt ? { endedAt } : {}),
      pid: rec.pid,
      at: new Date(this.now()).toISOString(),
    };
  }

  /** Report `rec`'s death once: written to its record and the deaths log first, the record removed once the report was delivered. */
  private async report(rec: ChatRecord, death: ChatDeath, logged = false): Promise<void> {
    // A newer process of the same chat (a worker's crash resume) already took the id: this report is
    // late, and neither its tracking nor its record is touched.
    const now = this.chats.get(rec.chatId);
    if (now && now.rec !== rec && now.rec.startedAt !== rec.startedAt) return this.log(`${rec.chatId}: a late death report of an earlier process, dropped`);
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
    if (isUp(st) || st.pid !== null) {
      // A start whose main process came after spawn stopped waiting: recorded and own from now.
      if (t.rec.pid === null && st.pid !== null && this.chats.get(chatId) === t) {
        const rec = { ...t.rec, pid: st.pid };
        this.write(rec);
        const again = this.track(rec, t.connected);
        again.idleSince = t.idleSince;
        again.claude = t.claude;
      }
      return "up";
    }
    if (this.chats.get(chatId) !== t) return "unknown";
    const death = t.rec.exiting ? null : await this.deathOf(t.rec, st);
    // Another look (the watch, a link's end) reported it meanwhile, or a new process took the id: once.
    if (this.chats.get(chatId) !== t) return "unknown";
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
    // A stop can fail (the user manager, a process it can't end) and the driver may not say: the process
    // is ended only once its unit is gone. Until then the chat stays tracked, its record and the code it
    // runs kept, and is stopped again at the next watch tick; no death is reported.
    const after = await this.deps.driver.status(t.rec.unit).catch(() => null);
    if (this.chats.get(chatId) !== t) return; // reported meanwhile, or a new process took the id
    // A status that says gone may only mean the manager could not be asked (systemctl failing reads as
    // "missing"): the recorded process still running chat-runtime/main.ts is not gone either.
    const running = !!t.rec.pid && (this.deps.isChatProcess ?? chatProcessAlive)(t.rec.pid);
    // Its status unknown: the recorded process settles it (no pid recorded: can't tell, kept).
    const gone = !running && (after ? isGone(after) : !!t.rec.pid);
    if (!gone) {
      if (t.lostDetail === null) this.log(`${chatId}: ${detail}, but its unit ${t.rec.unit} is still there after a stop (${after ? `${after.state}${after.pid ? `, pid ${after.pid}` : ""}` : "its status unknown"}); kept, stopped again at the next check`);
      t.lostDetail = detail;
      return;
    }
    const logs = (await this.deps.driver.logs(t.rec.unit, LOG_TAIL).catch(() => [])).map((l) => l.text);
    if (this.chats.get(chatId) !== t) return;
    const death: ChatDeath = { chatId, sessionPath: t.rec.sessionPath, unit: t.rec.unit, cause: "lost", exit: null, signal: null, detail, logTail: logs, pid: t.rec.pid, at: new Date(this.now()).toISOString() };
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
    // Claims of chats not adopted (gone, dead, no longer recorded): no process of ours.
    for (const [id, c] of this.claims)
      if (!this.chats.has(id)) {
        c.release();
        this.claims.delete(id);
      }
    // A unit recorded or started since the list above was read (a start made while this adoption ran) is ours too.
    for (const rec of this.records()) named.add(rec.unit);
    for (const t of this.chats.values()) named.add(t.rec.unit);
    for (const unit of this.replacementClaims.keys()) named.add(unit);
    for (const unit of await this.deps.driver.units(this.prefix).catch(() => [] as string[])) {
      if (named.has(unit)) continue;
      // A process still running that no chat records is stopped, and said; what is left of one that
      // already ended (the detached driver keeps its file) is only cleared away.
      const st = await this.deps.driver.status(unit).catch(() => null);
      if (st && (isUp(st) || st.pid !== null)) this.log(`${unit}: no chat records it; stopping it`);
      await this.deps.driver.stop(unit).catch(() => {});
    }
    return { adopted, died };
  }

  /**
   * Stop every chat process this supervisor's records name, and every unit of its prefix, adopting
   * none. The records it stopped.
   */
  async stopAll(cause: ExitCause = "operator"): Promise<ChatRecord[]> {
    const recs = this.records();
    for (const rec of recs) {
      if (this.chats.has(rec.chatId)) this.expectExit(rec.chatId, cause);
      await this.deps.driver.stop(rec.unit).catch(() => {});
      this.forget(rec.chatId);
    }
    for (const unit of await this.deps.driver.units(this.prefix).catch(() => [] as string[])) await this.deps.driver.stop(unit).catch(() => {});
    for (const [id, c] of this.claims) {
      c.release();
      this.claims.delete(id);
    }
    return recs;
  }

  /** Chat `chatId`'s mirror: idle (quiet, whether or not a tab has it open) since `since`, or not. */
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
   * Close an idle chat through its drain: the chat re-checks that it is quiet (an open tab doesn't count).
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
        if (t.lostDetail !== null) {
          await this.lost(id, t.lostDetail);
          continue;
        }
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
  /**
   * Start a replacement process for chat `chatId` beside its current one (unit `…-r<epoch>-<n>`, its own
   * socket): not recorded, never opened yet. The name carries this server's epoch: a chat reloaded in an
   * earlier server life runs as that life's replacement, and a counter alone would name its live unit and
   * socket again.
   */
  async startReplacement(chatId: string): Promise<ChatRecord> {
    const t = this.chats.get(chatId);
    if (!t) throw new Error(`chat ${chatId} has no process`);
    const suffix = `-r${this.deps.epoch.toString(36)}-${++this.replacements}`;
    const rep = await this.spawn({ chatId, sessionPath: t.rec.sessionPath, cwd: t.rec.cwd }, this.unitOf(chatId, suffix), this.sockOf(chatId, suffix));
    // Its own from its start: it opens the chat (and writes its live record) before the repoint.
    if (rep.pid) this.replacementClaims.set(rep.unit, { pid: rep.pid, release: this.own(rep.pid) });
    return rep;
  }
  /** Stop a replacement that is not used; never a unit a chat runs in now. */
  async stopUnit(unit: string): Promise<void> {
    if ([...this.chats.values()].some((t) => t.rec.unit === unit)) {
      this.log(`not stopping ${unit}: a chat runs in it`);
      return;
    }
    await this.deps.driver.stop(unit).catch(() => {});
    this.replacementClaims.get(unit)?.release();
    this.replacementClaims.delete(unit);
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
    const c = this.replacementClaims.get(rep.unit);
    this.replacementClaims.delete(rep.unit);
    if (c && c.pid !== rep.pid) c.release();
    this.track(rep, true, c && c.pid === rep.pid ? c.release : null);
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

  /** At server shutdown: stop watching and let go of the chats, which keep running. Their pids stay
      this server's own until it exits: a server-hosted call still running in the stop (a session
      message) must never take a chat process for a terminal holding its file. */
  detach(): void {
    this.unwatch();
    this.chats.clear();
  }
}

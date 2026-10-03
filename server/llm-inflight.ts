import { readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LlmFeedMessage, LlmInflight, LlmInflightGap, SessionFeedMessage } from "../shared/protocol";

/**
 * The logical LLM calls in flight: this host's own count, and the
 * total over every connected host.
 *
 * This host = this process's counter (pi-config/extensions/llm-inflight/tracker.ts, read in
 * memory) plus every other process's `presence.llm` in its live record, one per process. Live
 * records are read only while someone listens: one directory watcher re-reads just the file an
 * event names, and one sweep re-judges heartbeats and pids from what is cached (a full re-read
 * every RESCAN_EVERY sweeps catches what the watcher missed). Nothing else is read for it: no
 * session list, no Agents facts, no transcript.
 *
 * Connected hosts = one socket per peer to that peer's `/ws/watch?feed=llm`, which only ever
 * sends the peer's OWN count (`llm_local`): a count this host was sent never goes back out, so no
 * total is summed twice around the mesh. Peer sockets exist only while the mesh is on and a
 * browser listens.
 */

/** presence.llm as a process publishes it (and tracker.ts's snapshot()). */
export interface LlmProcessSnapshot {
  v: 1;
  producer: string;
  pid: number;
  active: number;
  approximate: number;
  claudeTurns: number;
  degraded: boolean;
  /** The producer ids of every child process whose calls this count already includes (a worker
      reporting to its parent, transitively): a live record or an unadopted worker of one of
      these adds nothing. */
  folded?: string[];
}

/** A live detached worker no running parent has adopted (pi-config llm-inflight/hosted.ts):
    its last own count, or null when it never reported one (a Claude Code worker, an old host). */
export interface UnadoptedWorker {
  key: string;
  producer?: string;
  counts: { active: number; approximate: number; claudeTurns: number; degraded: boolean } | null;
  folded?: string[];
}

/** This process's counter. */
export interface OwnCounter {
  snapshot(): LlmProcessSnapshot;
  subscribe(fn: () => void): () => void;
}

/** SCHEMA.md: a heartbeat older than this is stale (hidden), its process may come back. */
export const FRESH_MS = 15_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const SWEEP_MS = 5_000;
const RESCAN_EVERY = 6;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** Bounds on what another process or host may claim, so a buggy one can't swamp the total. */
export const MAX_CALLS = 9999;
/** A writer folds at most this many children (tracker.ts); more says it is degraded. */
const FOLDED_LIMIT = 64;
/** What is read of a longer list: every id read is still excluded, so nothing folded is added
    twice; past this the record is already far over its 16 KB budget. */
const MAX_FOLDED = 1024;
/** The most one peer's own count may claim. */
const MAX_HOST_CALLS = 10 * MAX_CALLS;
const MAX_ID = 64;

/** A `folded` list as sent: its valid ids (all of them, up to MAX_FOLDED, so each is still
    excluded); over the writer's limit, or garbage, is degraded. */
function parseFolded(raw: unknown): { folded?: string[]; bad: boolean } {
  if (raw === undefined) return { bad: false };
  if (!Array.isArray(raw)) return { bad: true };
  const folded = raw.slice(0, MAX_FOLDED).filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= MAX_ID);
  return { folded, bad: raw.length > FOLDED_LIMIT || folded.length < Math.min(raw.length, MAX_FOLDED) };
}

/** A record's presence.llm, or null when absent or malformed (a process that doesn't report). */
export function parseProcessLlm(raw: unknown): LlmProcessSnapshot | null {
  const r = raw as Partial<LlmProcessSnapshot> | null;
  if (!r || typeof r !== "object" || r.v !== 1 || typeof r.producer !== "string" || !r.producer || r.producer.length > MAX_ID) return null;
  const active = count(r.active);
  const approximate = count(r.approximate);
  const claudeTurns = count(r.claudeTurns);
  const pid = count(r.pid);
  if (active === null || approximate === null || claudeTurns === null || pid === null || typeof r.degraded !== "boolean") return null;
  const { folded, bad } = parseFolded(r.folded);
  const over = active > MAX_CALLS || claudeTurns > MAX_CALLS;
  const a = Math.min(active, MAX_CALLS);
  return { v: 1, producer: r.producer, pid, active: a, approximate: Math.min(approximate, a), claudeTurns: Math.min(claudeTurns, MAX_CALLS), degraded: r.degraded || bad || over, ...(folded ? { folded } : {}) };
}

/** What a live file says, as far as the count goes. */
export interface LiveEntry {
  pid: number;
  heartbeat: number;
  llm: LlmProcessSnapshot | null;
}

/** A live file's entry, or null for a temp file, a non-record or garbage. */
export function liveEntryOf(rec: any): LiveEntry | null {
  const pid = rec?.session?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  return { pid, heartbeat: typeof rec.heartbeat === "number" ? rec.heartbeat : 0, llm: parseProcessLlm(rec.presence?.llm) };
}

export const EMPTY: LlmInflight = { count: 0, approximate: 0, partial: false, gaps: [] };

/**
 * One host's count: its own process plus one contribution per other process. A process with
 * several records counts once (its freshest record that reports); records of `own`'s pid or
 * producer are this process's hosted chats, already in `own`. A process some counted process
 * has folded in (a worker reporting to its parent) adds nothing of its own.
 * A dead pid counts nothing; a process whose records are all stale, or none reports, is
 * `unreported`. An unadopted detached worker adds its last own count, or is `unreported`.
 */
export function hostCount(own: LlmProcessSnapshot, entries: Iterable<LiveEntry>, now: number, alive: (pid: number) => boolean, workers: readonly UnadoptedWorker[] = []): LlmInflight {
  const byPid = new Map<number, LiveEntry[]>();
  for (const e of entries) {
    if (e.pid === own.pid || e.llm?.producer === own.producer) continue;
    let list = byPid.get(e.pid);
    if (!list) byPid.set(e.pid, (list = []));
    list.push(e);
  }
  // Each live process's freshest reporting record, or null when it doesn't report.
  const procs: Array<{ pid: number; llm: LlmProcessSnapshot | null }> = [];
  for (const [pid, list] of byPid) {
    if (!alive(pid)) continue;
    const fresh = list.filter((e) => now - e.heartbeat <= FRESH_MS && e.heartbeat - now <= FUTURE_SKEW_MS);
    procs.push({ pid, llm: fresh.filter((e) => e.llm).sort((a, b) => b.heartbeat - a.heartbeat)[0]?.llm ?? null });
  }
  const folded = new Set<string>(own.folded);
  for (const p of procs) for (const f of p.llm?.folded ?? []) folded.add(f);
  for (const w of workers) for (const f of w.folded ?? []) folded.add(f);

  const counted = new Set<string>([own.producer]);
  let total = own.active;
  let approximate = own.approximate;
  let claude = own.claudeTurns > 0;
  let unreported = own.degraded ? 1 : 0;
  const add = (c: { active: number; approximate: number; claudeTurns: number; degraded: boolean }) => {
    const n = Math.min(c.active, MAX_CALLS);
    total += n;
    approximate += Math.min(c.approximate, n);
    if (c.claudeTurns > 0) claude = true;
    if (c.degraded) unreported++;
  };
  for (const { llm } of procs) {
    if (llm && folded.has(llm.producer)) continue;
    if (!llm) {
      unreported++;
      continue;
    }
    if (counted.has(llm.producer)) continue;
    counted.add(llm.producer);
    add(llm);
  }
  for (const w of workers) {
    if (w.producer !== undefined && (folded.has(w.producer) || counted.has(w.producer))) continue;
    if (w.producer !== undefined) counted.add(w.producer);
    if (w.counts) add(w.counts);
    else unreported++;
  }
  const gaps: LlmInflightGap[] = [];
  if (claude) gaps.push({ reason: "claude-internal" });
  if (unreported) gaps.push({ reason: "unreported", processes: unreported });
  return { count: total, approximate, partial: gaps.length > 0, gaps };
}

/** A peer as the fan-in sees it. */
export type PeerState =
  | { state: "connecting" | "unreachable" | "unsupported" }
  | { state: "ok"; instance: string; local: LlmInflight };

/**
 * The total over this host and its peers. A peer whose count arrived adds it, once per server
 * instance (this host's own instance, reached through a peer entry, adds nothing); any other
 * peer is a gap, never a 0. Peers are taken in id order, so a duplicate is always the same one.
 */
export function meshTotal(local: LlmInflight, selfInstance: string, peers: ReadonlyMap<string, PeerState>): LlmInflight {
  let total = local.count;
  let approximate = local.approximate;
  const gaps: LlmInflightGap[] = [...local.gaps];
  const seen = new Set([selfInstance]);
  for (const id of [...peers.keys()].sort()) {
    const p = peers.get(id)!;
    if (p.state !== "ok") {
      gaps.push({ reason: `peer-${p.state}`, host: id });
      continue;
    }
    if (seen.has(p.instance)) continue;
    seen.add(p.instance);
    total += p.local.count;
    approximate += p.local.approximate;
    for (const g of p.local.gaps) {
      if (g.reason === "claude-internal") gaps.push({ reason: "claude-internal", host: id });
      else if (g.reason === "unreported") gaps.push({ reason: "unreported", host: id, processes: g.processes });
    }
  }
  return { count: total, approximate, partial: gaps.length > 0, gaps };
}

/** A minimal client socket (ws's WebSocket satisfies it). */
export interface PeerSocket {
  on(event: "message", fn: (data: unknown) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  on(event: "error", fn: (err: unknown) => void): unknown;
  on(event: "pong", fn: () => void): unknown;
  close(): void;
  /** A WebSocket ping; the peer's ws answers it with a pong by itself. */
  ping?(): void;
  /** Drop the connection now, without a closing handshake (a half-open one never answers). */
  terminate?(): void;
}

export interface MeshPeersSource {
  /** The peers to reach now: empty while the mesh is off. */
  peers(): Array<{ id: string; url: string }>;
  /** This host's peer id. */
  selfId(): string;
  /** A socket to `<url>/ws/watch?feed=llm` through the peer's gate. */
  connect(url: string): PeerSocket;
}

export interface LlmInflightOptions {
  own: OwnCounter;
  liveDir: string;
  /** Live detached workers no running parent has adopted. Read once when counting starts and
      then once per sweep, never per call: a begin or end only recounts from what is held. An
      adoption between two reads is still counted once, because the adopting parent names the
      worker it now counts (its `folded`); one that can't be named reads as unknown meanwhile. */
  workers?: () => readonly UnadoptedWorker[];
  mesh?: MeshPeersSource;
  now?: () => number;
  alive?: (pid: number) => boolean;
  /** Re-judge period while anyone listens. */
  sweepMs?: number;
  /** How long a peer's socket may stay open without a count before it counts as too old. */
  peerAnswerMs?: number;
  /** Retry after a peer socket closed: first delay, doubled up to 60 s. */
  peerRetryMs?: number;
  /** A peer silent this long is pinged (checked at each sweep). */
  peerPingMs?: number;
  /** A peer silent this long (no frame, no pong) is unreachable: its last count is dropped. */
  peerDeadMs?: number;
  /** Coalesces bursts of record writes and begin/end pairs. */
  debounceMs?: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface PeerLink {
  url: string;
  socket: PeerSocket | null;
  state: PeerState;
  answerTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryMs: number;
  /** When the peer was last heard from (a frame or a pong), once it has answered. */
  heard: number;
}

const same = (a: LlmInflight | null, b: LlmInflight): boolean => !!a && JSON.stringify(a) === JSON.stringify(b);

export class LlmInflightHub {
  readonly instance = randomUUID();
  private readonly browsers = new Set<(msg: SessionFeedMessage) => void>();
  private readonly locals = new Set<(msg: LlmFeedMessage) => void>();
  private readonly entries = new Map<string, LiveEntry>();
  /** The unadopted workers as last read (refreshWorkers). */
  private workers: readonly UnadoptedWorker[] = [];
  private readonly links = new Map<string, PeerLink>();
  /** Peers that have sent a count on some connection: one silent later is unreachable, not old. */
  private readonly supported = new Set<string>();
  private watcher: FSWatcher | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private sweeps = 0;
  private offOwn: (() => void) | null = null;
  private pendingFiles = new Set<string>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private lastLocal: LlmInflight | null = null;
  private lastTotal: LlmInflight | null = null;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;

  constructor(private readonly opts: LlmInflightOptions) {
    this.now = opts.now ?? Date.now;
    this.alive = opts.alive ?? pidAlive;
  }

  /** A browser on the session feed: the total now, then each change. */
  addBrowser(send: (msg: SessionFeedMessage) => void): () => void {
    this.start();
    this.emit(); // the listeners already here catch up first, so the baseline below is theirs too
    this.browsers.add(send);
    this.reconcilePeers();
    this.lastTotal = this.total();
    send({ type: "llm_inflight", inflight: this.lastTotal });
    return () => {
      this.browsers.delete(send);
      if (this.browsers.size === 0) this.closePeers();
      this.stopIfIdle();
    };
  }

  /** A peer on /ws/watch?feed=llm: this host's own count now, then each change. */
  addLocal(send: (msg: LlmFeedMessage) => void): () => void {
    this.start();
    this.emit();
    this.locals.add(send);
    this.lastLocal = this.local();
    send(this.localFrame(this.lastLocal));
    return () => {
      this.locals.delete(send);
      this.stopIfIdle();
    };
  }

  /** This host's own count (own process + live records as last read). */
  local(): LlmInflight {
    return hostCount(this.opts.own.snapshot(), this.entries.values(), this.now(), this.alive, this.workers);
  }

  total(): LlmInflight {
    const peers = new Map<string, PeerState>();
    for (const [id, l] of this.links) peers.set(id, l.state);
    return meshTotal(this.local(), this.instance, peers);
  }

  /** Open peer sockets, by peer id (tests). */
  peerSockets(): string[] {
    return [...this.links].filter(([, l]) => l.socket).map(([id]) => id);
  }

  get listening(): boolean {
    return this.watcher !== null || this.sweep !== null;
  }

  stop(): void {
    this.closePeers();
    this.watcher?.close();
    this.watcher = null;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.offOwn?.();
    this.offOwn = null;
    this.entries.clear();
    this.workers = [];
    this.lastLocal = this.lastTotal = null;
  }

  private localFrame(local: LlmInflight): LlmFeedMessage {
    return { type: "llm_local", host: this.opts.mesh?.selfId() ?? "", instance: this.instance, local };
  }

  private start(): void {
    if (this.sweep) return;
    this.rescan();
    this.refreshWorkers();
    this.attachWatcher();
    this.offOwn = this.opts.own.subscribe(() => this.schedule());
    this.sweeps = 0;
    this.sweep = setInterval(() => {
      // Without a watcher (no live dir yet, or the watch failed) each sweep tries to attach one
      // again, and rescans until it holds: the fallback lasts only as long as the cause.
      if (!this.watcher && this.attachWatcher()) this.rescan();
      else if (++this.sweeps % RESCAN_EVERY === 0 || !this.watcher) this.rescan();
      this.refreshWorkers();
      this.reconcilePeers();
      this.checkPeers();
      this.emit();
    }, this.opts.sweepMs ?? SWEEP_MS);
    this.sweep.unref?.();
  }

  private refreshWorkers(): void {
    try {
      this.workers = this.opts.workers?.() ?? [];
    } catch {
      this.workers = [{ key: "?", counts: null }]; // unreadable: unknown, never 0
    }
  }

  /** Watch the live dir; false when it can't be watched now (missing, or the watch failed). */
  private attachWatcher(): boolean {
    try {
      const w = watch(this.opts.liveDir, (_event, name) => {
        if (typeof name === "string" && name) this.fileChanged(name);
        else this.schedule(); // the platform didn't say which: the next sweep rescans
      });
      w.on("error", () => {
        w.close();
        if (this.watcher === w) this.watcher = null; // the sweeps rescan and re-attach
      });
      this.watcher = w;
      return true;
    } catch {
      this.watcher = null;
      return false;
    }
  }

  /** A peer that answered once but has gone silent: ping it, and past the dead line drop it
      (a half-open socket would otherwise keep its last count forever). */
  private checkPeers(): void {
    const now = this.now();
    const pingMs = this.opts.peerPingMs ?? 30_000;
    const deadMs = this.opts.peerDeadMs ?? 75_000;
    for (const link of this.links.values()) {
      const s = link.socket;
      if (!s || link.state.state !== "ok" || !link.heard) continue;
      const quiet = now - link.heard;
      if (quiet > deadMs) {
        link.state = { state: "unreachable" };
        if (s.terminate) s.terminate();
        else s.close();
      } else if (quiet > pingMs) {
        try {
          s.ping?.();
        } catch {
          // closing already: its close event retries
        }
      }
    }
  }

  private stopIfIdle(): void {
    if (this.browsers.size === 0 && this.locals.size === 0) this.stop();
  }

  private fileChanged(name: string): void {
    if (!name.endsWith(".json") || name.startsWith(".")) return; // dotfiles = writers' temp files
    this.pendingFiles.add(name);
    this.schedule();
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      for (const name of this.pendingFiles) this.readFile(name);
      this.pendingFiles.clear();
      this.emit();
    }, this.opts.debounceMs ?? 50);
    this.pending.unref?.();
  }

  private readFile(name: string): void {
    try {
      const entry = liveEntryOf(JSON.parse(readFileSync(join(this.opts.liveDir, name), "utf8")));
      if (entry) this.entries.set(name, entry);
      else this.entries.delete(name);
    } catch (err) {
      // Gone (a clean exit deletes it), or caught mid-write: a rename replaces it whole, so a
      // parse error is a non-atomic writer's half; keep what it said last until the next event.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") this.entries.delete(name);
    }
  }

  private rescan(): void {
    let names: string[];
    try {
      names = readdirSync(this.opts.liveDir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
    } catch {
      names = [];
    }
    const keep = new Set(names);
    for (const name of [...this.entries.keys()]) if (!keep.has(name)) this.entries.delete(name);
    for (const name of names) this.readFile(name);
  }

  private emit(): void {
    if (this.locals.size) {
      const local = this.local();
      if (!same(this.lastLocal, local)) {
        this.lastLocal = local;
        const msg = this.localFrame(local);
        for (const send of this.locals) send(msg);
      }
    }
    if (this.browsers.size) {
      const total = this.total();
      if (!same(this.lastTotal, total)) {
        this.lastTotal = total;
        for (const send of this.browsers) send({ type: "llm_inflight", inflight: total });
      }
    }
  }

  /** One link per configured peer while a browser listens; none otherwise. */
  private reconcilePeers(): void {
    const want = this.browsers.size > 0 && this.opts.mesh ? this.opts.mesh.peers() : [];
    const ids = new Set(want.map((p) => p.id));
    for (const [id, link] of this.links) {
      const now = want.find((p) => p.id === id);
      if (!ids.has(id) || now?.url !== link.url) this.dropLink(id);
    }
    for (const p of want) if (!this.links.has(p.id)) this.openLink(p.id, p.url, 0);
  }

  private closePeers(): void {
    for (const id of [...this.links.keys()]) this.dropLink(id);
  }

  private dropLink(id: string): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    this.supported.delete(id);
    if (link.answerTimer) clearTimeout(link.answerTimer);
    if (link.retryTimer) clearTimeout(link.retryTimer);
    const s = link.socket;
    link.socket = null;
    try {
      s?.close();
    } catch {
      // already gone
    }
  }

  private openLink(id: string, url: string, retryMs: number, prev?: PeerState): void {
    const mesh = this.opts.mesh!;
    const link: PeerLink = { url, socket: null, state: prev ?? { state: "connecting" }, answerTimer: null, retryTimer: null, retryMs, heard: 0 };
    this.links.set(id, link);
    const current = () => this.links.get(id) === link;
    const settle = (state: PeerState) => {
      if (!current()) return;
      link.state = state;
      this.emit();
    };
    let socket: PeerSocket;
    try {
      socket = mesh.connect(url);
    } catch {
      settle({ state: "unreachable" });
      this.retryLater(id, link);
      return;
    }
    link.socket = socket;
    let answered = false;
    // A Sova older than the count answers ?feed=llm with an error and a close, or not at all.
    link.answerTimer = setTimeout(() => {
      if (!answered && current()) {
        settle({ state: this.supported.has(id) ? "unreachable" : "unsupported" });
        socket.close(); // its close retries later: the peer may be updated meanwhile
      }
    }, this.opts.peerAnswerMs ?? 10_000);
    link.answerTimer.unref?.();
    socket.on("pong", () => {
      if (current() && answered) link.heard = this.now();
    });
    socket.on("message", (data) => {
      if (!current()) return;
      if (answered) link.heard = this.now();
      let msg: LlmFeedMessage | { type?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "llm_local" && typeof (msg as any).instance === "string" && isInflight((msg as any).local)) {
        answered = true;
        this.supported.add(id);
        link.heard = this.now();
        link.retryMs = 0;
        if (link.answerTimer) clearTimeout(link.answerTimer);
        settle({ state: "ok", instance: (msg as any).instance, local: (msg as any).local });
      } else if (!answered && msg.type === "error") {
        answered = true;
        if (link.answerTimer) clearTimeout(link.answerTimer);
        settle({ state: "unsupported" });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!current() || link.socket !== socket) return;
      link.socket = null;
      if (link.answerTimer) clearTimeout(link.answerTimer);
      if (link.state.state !== "unsupported") settle({ state: "unreachable" });
      this.retryLater(id, link);
    });
  }

  private retryLater(id: string, link: PeerLink): void {
    const delay = Math.min(60_000, link.retryMs ? link.retryMs * 2 : (this.opts.peerRetryMs ?? 5_000));
    link.retryTimer = setTimeout(() => {
      if (this.links.get(id) !== link || this.browsers.size === 0) return;
      this.openLink(id, link.url, delay, link.state);
    }, delay);
    link.retryTimer.unref?.();
  }
}

/** A peer's `local` as sent: checked before it is added. */
/** A peer's `local` as sent, within bounds (a host's own gaps are at most its two kinds). */
function isInflight(v: any): v is LlmInflight {
  const n = count(v?.count);
  const a = count(v?.approximate);
  return n !== null && n <= MAX_HOST_CALLS && a !== null && a <= n && typeof v.partial === "boolean" && Array.isArray(v.gaps) && v.gaps.length <= 2 &&
    v.gaps.every((g: any) => g && (g.reason === "claude-internal" || (g.reason === "unreported" && count(g.processes) !== null && g.processes <= MAX_CALLS)));
}

let shared: LlmInflightHub | null = null;

/** The server's one hub, configured once at startup (index.ts). */
export function configureLlmInflight(opts: LlmInflightOptions): LlmInflightHub {
  shared?.stop();
  shared = new LlmInflightHub(opts);
  return shared;
}

export function llmInflight(): LlmInflightHub | null {
  return shared;
}

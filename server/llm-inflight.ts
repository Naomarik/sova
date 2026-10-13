import { randomUUID } from "node:crypto";
import type { LlmFeedMessage, LlmInflight, LlmInflightGap, LlmTokens, SessionFeedMessage } from "../shared/protocol";

/**
 * The logical LLM calls in flight: this host's own count, and the
 * total over every connected host.
 *
 * This host = this process's counter (pi-config/extensions/llm-inflight/tracker.ts, read in
 * memory), which already holds what every chat process (workers and hidden chats included) reports
 * with its state over its link (server/chat-host.ts setChildCounts). Nothing else is read for it:
 * no live record, no session list, no Agents facts, no transcript.
 *
 * Connected hosts = one socket per peer to that peer's `/ws/watch?feed=llm`, which only ever
 * sends the peer's OWN count (`llm_local`): a count this host was sent never goes back out, so no
 * total is summed twice around the mesh. Peer sockets exist only while the mesh is on and a
 * browser listens.
 *
 * Output tokens ride the same counts: each process publishes a ring of 60 epoch-aligned 30 s slots
 * (`tokens`), summed per host and over the mesh like `active`. A process or peer that departs
 * leaves its last ring in the sum until it ages out (while anyone listens), so a finished worker's
 * tokens don't vanish from the 30-minute window when its process does.
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
      reporting to its parent, transitively): a live record of one of these adds nothing. */
  folded?: string[];
  /** Its ended calls' output tokens (absent from an older counter: unknown). */
  tokens?: TokenRing;
}

/** presence.llm.tokens: 60 slots of 30 s, oldest first; `out[59]` is slot `end`. */
export interface TokenRing {
  bucketMs: number;
  end: number;
  out: number[];
  /** Some of its calls' tokens are known missing. */
  partial?: true;
}

export const TOKEN_BUCKET_MS = 30_000;
export const TOKEN_SLOTS = 60;
/** The most one process's slot may claim (pi-config llm-inflight/tracker.ts MAX_SLOT_TOKENS). */
export const MAX_SLOT_TOKENS = 10_000_000;
/** The most one host's slot may claim, and the most the mesh total's may hold. */
const MAX_HOST_SLOT_TOKENS = 10 * MAX_SLOT_TOKENS;
const MAX_MESH_SLOT_TOKENS = 1_000_000_000;

const slotOf = (ms: number): number => Math.floor(ms / TOKEN_BUCKET_MS);

/** A ring as sent, its slots within `max`; undefined when it isn't one (its tokens are unknown). */
export function parseTokenRing(raw: unknown, max: number = MAX_SLOT_TOKENS): TokenRing | undefined {
  const r = raw as Partial<TokenRing> | null | undefined;
  if (!r || typeof r !== "object" || r.bucketMs !== TOKEN_BUCKET_MS || !Number.isSafeInteger(r.end) || (r.end as number) < 0) return undefined;
  if (!Array.isArray(r.out) || r.out.length !== TOKEN_SLOTS) return undefined;
  const out: number[] = [];
  for (const n of r.out) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return undefined;
    out.push(Math.min(n, max));
  }
  return { bucketMs: TOKEN_BUCKET_MS, end: r.end as number, out, ...(r.partial === true ? { partial: true as const } : {}) };
}

/** `ring`'s slots as seen from slot `end`: older than end − 59 are gone, newer are 0. */
export function alignRing(ring: { end: number; out: readonly number[] }, end: number): number[] {
  const out = new Array<number>(TOKEN_SLOTS).fill(0);
  const shift = end - ring.end;
  if (Math.abs(shift) >= TOKEN_SLOTS) return out;
  for (let i = 0; i < TOKEN_SLOTS; i++) {
    const j = i + shift;
    if (j >= 0 && j < TOKEN_SLOTS) out[i] = ring.out[j] ?? 0;
  }
  return out;
}

function addRing(into: number[], ring: { end: number; out: readonly number[] }, end: number, max: number): void {
  const add = alignRing(ring, end);
  for (let i = 0; i < TOKEN_SLOTS; i++) into[i] = Math.min(max, (into[i] ?? 0) + (add[i] ?? 0));
}

/** Two token snapshots say the same once time is allowed to pass: no slot gained or lost
    anything but by ageing out. */
function sameTokens(a: LlmTokens | undefined, b: LlmTokens | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.partial !== b.partial) return false;
  const [older, newer] = a.end <= b.end ? [a, b] : [b, a];
  const aligned = alignRing(older, newer.end);
  return newer.out.every((n, i) => n === aligned[i]);
}

/** This process's counter. */
export interface OwnCounter {
  snapshot(): LlmProcessSnapshot;
  subscribe(fn: () => void): () => void;
}

const SWEEP_MS = 5_000;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** Bounds on what another process or host may claim, so a buggy one can't swamp the total. */
export const MAX_CALLS = 9999;
/** The most one peer's own count may claim. */
const MAX_HOST_CALLS = 10 * MAX_CALLS;

export const EMPTY: LlmInflight = { count: 0, approximate: 0, partial: false, gaps: [] };

/** This host's count: its own process's counter (chat processes' reports folded in), tokens aligned to `now`. */
export function hostCount(own: LlmProcessSnapshot, now: number): LlmInflight {
  const gaps: LlmInflightGap[] = [];
  if (own.claudeTurns > 0) gaps.push({ reason: "claude-internal" });
  if (own.degraded) gaps.push({ reason: "unreported", processes: 1 });
  const active = Math.min(own.active, MAX_HOST_CALLS);
  const result: LlmInflight = { count: active, approximate: Math.min(own.approximate, active), partial: gaps.length > 0, gaps };
  if (own.tokens) {
    const end = slotOf(now);
    const out = new Array<number>(TOKEN_SLOTS).fill(0);
    addRing(out, own.tokens, end, MAX_HOST_SLOT_TOKENS);
    result.tokens = { bucketMs: TOKEN_BUCKET_MS, end, out, partial: gaps.length > 0 || !!own.tokens.partial };
  }
  return result;
}

/** A peer as the fan-in sees it. */
export type PeerState =
  | { state: "connecting" | "unreachable" | "unsupported" }
  | { state: "ok"; instance: string; local: LlmInflight };

/**
 * The total over this host and its peers. A peer whose count arrived adds it, once per server
 * instance (this host's own instance, reached through a peer entry, adds nothing); any other
 * peer is a gap, never a 0. Peers are taken in id order, so a duplicate is always the same one.
 *
 * Tokens (only when `local` has them) add each counted peer's ring at `local`'s slot; a peer
 * without one makes them partial, as does any gap. `retained` (kept by the caller, by instance)
 * holds each counted peer's last ring: a peer no longer counted adds it until it ages out.
 */
export function meshTotal(local: LlmInflight, selfInstance: string, peers: ReadonlyMap<string, PeerState>, retained?: Map<string, TokenRing>): LlmInflight {
  let total = local.count;
  let approximate = local.approximate;
  const gaps: LlmInflightGap[] = [...local.gaps];
  const seen = new Set([selfInstance]);
  const end = local.tokens?.end ?? 0;
  const out = local.tokens ? [...local.tokens.out] : [];
  let tokensMissing = !!local.tokens?.partial;
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
    const ring = p.local.tokens;
    if (!local.tokens) continue;
    if (!ring) tokensMissing = true;
    else {
      if (ring.partial) tokensMissing = true;
      addRing(out, ring, end, MAX_MESH_SLOT_TOKENS);
      retained?.set(p.instance, { bucketMs: TOKEN_BUCKET_MS, end: ring.end, out: ring.out });
    }
  }
  if (retained && local.tokens) {
    for (const [instance, ring] of retained) {
      if (seen.has(instance)) continue;
      if (alignRing(ring, end).every((n) => n === 0)) {
        retained.delete(instance);
        continue;
      }
      addRing(out, ring, end, MAX_MESH_SLOT_TOKENS);
    }
  }
  const result: LlmInflight = { count: total, approximate, partial: gaps.length > 0, gaps };
  if (local.tokens) result.tokens = { bucketMs: TOKEN_BUCKET_MS, end, out, partial: gaps.length > 0 || tokensMissing };
  return result;
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
  mesh?: MeshPeersSource;
  now?: () => number;
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
  /** Coalesces bursts of begin/end pairs. */
  debounceMs?: number;
  /** Where its timers run (the sweep, the debounce, peer answers and retries); default the globals. */
  timers?: HubTimers;
}

export interface HubTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

type Timer = ReturnType<typeof setTimeout>;
const unref = (t: Timer): Timer => (t.unref?.(), t);
/** The globals, each timer unref'd: the hub never keeps the process alive. */
const GLOBAL_TIMERS: HubTimers = {
  setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
  clearTimeout: (handle) => clearTimeout(handle as Timer),
  setInterval: (fn, ms) => unref(setInterval(fn, ms)),
  clearInterval: (handle) => clearInterval(handle as Timer),
};

interface PeerLink {
  url: string;
  socket: PeerSocket | null;
  state: PeerState;
  answerTimer: unknown;
  retryTimer: unknown;
  retryMs: number;
  /** When the peer was last heard from (a frame or a pong), once it has answered. */
  heard: number;
}

/** Nothing to send: the counts and gaps are the same, and the tokens differ only by time passing. */
const same = (a: LlmInflight | null, b: LlmInflight): boolean => {
  if (!a) return false;
  const { tokens: ta, ...ra } = a;
  const { tokens: tb, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb) && sameTokens(ta, tb);
};

export class LlmInflightHub {
  readonly instance = randomUUID();
  private readonly browsers = new Set<(msg: SessionFeedMessage) => void>();
  private readonly locals = new Set<(msg: LlmFeedMessage) => void>();
  /** Each counted peer instance's last ring: kept until it ages out. */
  private readonly peerRetained = new Map<string, TokenRing>();
  private readonly links = new Map<string, PeerLink>();
  /** Peers that have sent a count on some connection: one silent later is unreachable, not old. */
  private readonly supported = new Set<string>();
  private sweep: unknown = null;
  private offOwn: (() => void) | null = null;
  private pending: unknown = null;
  private lastLocal: LlmInflight | null = null;
  private lastTotal: LlmInflight | null = null;
  private readonly now: () => number;
  private readonly timers: HubTimers;

  constructor(private readonly opts: LlmInflightOptions) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? GLOBAL_TIMERS;
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

  /** This host's own count (its process, chat processes folded in). */
  local(): LlmInflight {
    return hostCount(this.opts.own.snapshot(), this.now());
  }

  total(): LlmInflight {
    const peers = new Map<string, PeerState>();
    for (const [id, l] of this.links) peers.set(id, l.state);
    return meshTotal(this.local(), this.instance, peers, this.peerRetained);
  }

  /** Open peer sockets, by peer id (tests). */
  peerSockets(): string[] {
    return [...this.links].filter(([, l]) => l.socket).map(([id]) => id);
  }

  get listening(): boolean {
    return this.sweep !== null;
  }

  stop(): void {
    this.closePeers();
    if (this.sweep) this.timers.clearInterval(this.sweep);
    this.sweep = null;
    if (this.pending) this.timers.clearTimeout(this.pending);
    this.pending = null;
    this.offOwn?.();
    this.offOwn = null;
    this.peerRetained.clear();
    this.lastLocal = this.lastTotal = null;
  }

  private localFrame(local: LlmInflight): LlmFeedMessage {
    return { type: "llm_local", host: this.opts.mesh?.selfId() ?? "", instance: this.instance, local };
  }

  private start(): void {
    if (this.sweep) return;
    this.offOwn = this.opts.own.subscribe(() => this.schedule());
    this.sweep = this.timers.setInterval(() => {
      this.reconcilePeers();
      this.checkPeers();
      this.emit();
    }, this.opts.sweepMs ?? SWEEP_MS);
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

  private schedule(): void {
    if (this.pending) return;
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      this.emit();
    }, this.opts.debounceMs ?? 50);
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
    if (link.answerTimer) this.timers.clearTimeout(link.answerTimer);
    if (link.retryTimer) this.timers.clearTimeout(link.retryTimer);
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
    link.answerTimer = this.timers.setTimeout(() => {
      if (!answered && current()) {
        settle({ state: this.supported.has(id) ? "unreachable" : "unsupported" });
        socket.close(); // its close retries later: the peer may be updated meanwhile
      }
    }, this.opts.peerAnswerMs ?? 10_000);
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
        if (link.answerTimer) this.timers.clearTimeout(link.answerTimer);
        settle({ state: "ok", instance: (msg as any).instance, local: peerLocal((msg as any).local) });
      } else if (!answered && msg.type === "error") {
        answered = true;
        if (link.answerTimer) this.timers.clearTimeout(link.answerTimer);
        settle({ state: "unsupported" });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!current() || link.socket !== socket) return;
      link.socket = null;
      if (link.answerTimer) this.timers.clearTimeout(link.answerTimer);
      if (link.state.state !== "unsupported") settle({ state: "unreachable" });
      this.retryLater(id, link);
    });
  }

  private retryLater(id: string, link: PeerLink): void {
    const delay = Math.min(60_000, link.retryMs ? link.retryMs * 2 : (this.opts.peerRetryMs ?? 5_000));
    link.retryTimer = this.timers.setTimeout(() => {
      if (this.links.get(id) !== link || this.browsers.size === 0) return;
      this.openLink(id, link.url, delay, link.state);
    }, delay);
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

/** A peer's checked `local`, its tokens within a host's bounds (dropped, so unknown, when malformed). */
function peerLocal(v: LlmInflight): LlmInflight {
  const { tokens, ...rest } = v;
  const ring = parseTokenRing(tokens, MAX_HOST_SLOT_TOKENS);
  return { count: rest.count, approximate: rest.approximate, partial: rest.partial, gaps: rest.gaps,
    ...(ring ? { tokens: { bucketMs: ring.bucketMs, end: ring.end, out: ring.out, partial: (tokens as any)?.partial === true } } : {}) };
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

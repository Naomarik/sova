// Sessions ping their Overseer (§app/overseer-pings): the `overseer_ping` tool every ordinary chat has,
// the open pings and their counts (`<stateRoot>/pings/pings.json`, one file under a lock, shared by the
// server and every chat process), the log (`pings/audit.jsonl`, never a ping's text), which Overseer
// hears a ping, the raised hand the attention digest reads, and the outcome the pinging chat's card
// shows. The Overseer's side (its ping turn, sova_relay, a project overseer's reason) hears each new
// ping through `onPing` and reports back through `setPingOutcome`; nothing here starts a turn anywhere.
//
// Light on purpose: chat processes import it (a user's turn lowers the hand from there), so every
// heavy server module is imported only inside the function that needs it.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolSpec } from "../shared/harness";
import type { RunStanding } from "../shared/chat-runtime";
import {
  OVERSEER_PING_TOOL,
  PING_DETAIL_MAX,
  PING_ID_RE,
  PING_KINDS,
  PING_SAID_MAX,
  PING_SUMMARY_MAX,
  PING_TO_MAX,
  type OverseerPingLimits,
  type PingAuditLine,
  type PingKind,
  type PingOutcome,
  type PingRecord,
  type PingRoute,
  type SessionSummary,
} from "../shared/protocol";
import { pingLimitsOf } from "../shared/overseer-limits";
import { pingCardData } from "../shared/transcript-cards";
export { PING_KIND_WORDS } from "../shared/transcript-cards";
import { stateRoot } from "./state-root";
import { lockOwned } from "./write-guard";

// ---- files ---------------------------------------------------------------------------------------

export const pingsDir = () => join(stateRoot(), "pings");
export const pingsFile = () => join(pingsDir(), "pings.json");
export const pingsAuditFile = () => join(pingsDir(), "audit.jsonl");

/** The kinds that put something in the attention digest: a raised hand (`stuck`, `decision`) or the done line. */
export const HAND_KINDS: ReadonlySet<PingKind> = new Set(["stuck", "decision", "done"]);
/** Pings kept once they are down and delivered: the newest this many. */
const KEPT_DONE = 200;
/** Count stamps older than this are dropped (the longest window is a local day). */
const COUNT_KEEP_MS = 2 * 86_400_000;
const HOUR_MS = 3_600_000;

interface PingsFileData {
  version: 1;
  /** The last id's number: ids are `pg_{n}`, never reused. */
  n: number;
  pings: PingRecord[];
  /** Count stamps (ms epoch) per key, pruned to COUNT_KEEP_MS: `session:{id}` for pings, and whatever keys
      the Overseer's side counts (`turn`, `relay`, `recipient:{id}`, PingStore.note). */
  counts: Record<string, number[]>;
  /** Passed-on notes waiting for their recipient's turn to settle (§app.overseer-pings/relay "How it arrives"). */
  relays?: PendingRelay[];
  /** News waiting for each recipient's next turn, as a hidden note. */
  news?: PendingNews[];
}

/** A relay sova_relay passed on whose recipient was busy: handed over at its next settle, never queued. */
export interface PendingRelay {
  /** `rl_…`, the delivery's own id. */
  id: string;
  ping: string;
  to: { id: string; path: string; title: string };
  text: string;
  hop: number;
  from: { sessionId: string; title: string };
  at: string;
}
/** News passed on, waiting for the recipient's next turn. */
export interface PendingNews {
  ping: string;
  to: { id: string; path: string; title: string };
  text: string;
  at: string;
}

const empty = (): PingsFileData => ({ version: 1, n: 0, pings: [], counts: {} });
const objects = <T>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x): x is T => !!x && typeof x === "object") : []);

const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function parseFile(text: string): PingsFileData {
  try {
    const raw = JSON.parse(text) as Partial<PingsFileData> | null;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.pings)) return empty();
    const counts: Record<string, number[]> = {};
    if (raw.counts && typeof raw.counts === "object")
      for (const [k, v] of Object.entries(raw.counts)) if (Array.isArray(v)) counts[k] = v.filter((x): x is number => typeof x === "number");
    const pings = raw.pings.filter((p): p is PingRecord => !!p && typeof p === "object" && typeof p.id === "string" && PING_ID_RE.test(p.id) && typeof p.sessionId === "string");
    const relays = objects<PendingRelay>(raw.relays);
    const news = objects<PendingNews>(raw.news);
    return {
      version: 1,
      n: typeof raw.n === "number" ? raw.n : pings.length,
      pings: pings.map((p) => ({ ...p, outcomes: Array.isArray(p.outcomes) ? p.outcomes : [] })),
      counts,
      ...(relays.length ? { relays } : {}),
      ...(news.length ? { news } : {}),
    };
  } catch {
    return empty();
  }
}

/**
 * The pings file, read and changed only under its lock (every change re-reads the file first, so the
 * server and the chat processes never drop each other's writes), written atomically (tmp + rename).
 * Every method takes `now` from the store's clock.
 */
export class PingStore {
  private cache: { file: string; mtimeMs: number; size: number; data: PingsFileData } | null = null;
  constructor(
    private readonly file: () => string = pingsFile,
    readonly now: () => number = Date.now,
  ) {}
  /** The file as it stands, re-read only when it changed on disk. */
  read(): PingsFileData {
    const file = this.file();
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(file);
    } catch {
      this.cache = null;
      return empty();
    }
    const c = this.cache;
    if (c && c.file === file && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.data;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return empty();
    }
    const data = parseFile(text);
    this.cache = { file, mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  }
  /** Change the file under its lock: `change` gets a fresh copy and returns what to answer; it writes only when it says so. */
  update<T>(change: (d: PingsFileData) => { write: boolean; value: T }): T {
    const file = this.file();
    mkdirSync(dirname(file), { recursive: true });
    const unlock = lockOwned(`${file}.lock`);
    try {
      this.cache = null;
      const d = structuredClone(this.read());
      const out = change(d);
      if (out.write) {
        const cut = this.now() - COUNT_KEEP_MS;
        for (const [k, v] of Object.entries(d.counts)) {
          const kept = v.filter((t) => t > cut);
          if (kept.length) d.counts[k] = kept;
          else delete d.counts[k];
        }
        const done = d.pings.filter((p) => p.lowered || (!HAND_KINDS.has(p.kind) && p.delivered));
        if (done.length > KEPT_DONE) {
          const drop = new Set(done.slice(0, done.length - KEPT_DONE).map((p) => p.id));
          d.pings = d.pings.filter((p) => !drop.has(p.id));
        }
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(d)}\n`);
        renameSync(tmp, file);
        this.cache = null;
      }
      return out.value;
    } finally {
      unlock?.();
    }
  }
  get(id: string): PingRecord | null {
    return this.read().pings.find((p) => p.id === id) ?? null;
  }
  /** A session's pings, oldest first. */
  ofSession(sessionId: string): PingRecord[] {
    return this.read().pings.filter((p) => p.sessionId === sessionId);
  }
  /** Stamps of `key` in the last `windowMs`. */
  recent(key: string, windowMs: number, d = this.read()): number {
    const cut = this.now() - windowMs;
    return (d.counts[key] ?? []).filter((t) => t > cut).length;
  }
  /** Stamps of `key` in this local day. */
  today(key: string, d = this.read()): number {
    const day = localDay(this.now());
    return (d.counts[key] ?? []).filter((t) => localDay(t) === day).length;
  }
  /** Add one stamp to `key` (the Overseer's side's counts: ping turns, pass-ons, a recipient's notes); returns it, for `give`. */
  note(key: string): number {
    const at = this.now();
    this.update((d) => {
      d.counts[key] = [...(d.counts[key] ?? []), at];
      return { write: true, value: undefined };
    });
    return at;
  }
  /** Take back a stamp `note` added (a refused or failed act takes nothing). */
  give(key: string, at: number): void {
    this.update((d) => {
      const list = d.counts[key] ?? [];
      const i = list.lastIndexOf(at);
      if (i < 0) return { write: false, value: undefined };
      list.splice(i, 1);
      return { write: true, value: undefined };
    });
  }
}

let store: PingStore | null = null;
export function pingStore(): PingStore {
  return (store ??= new PingStore());
}
/** Tests only. */
export function setPingStore(s: PingStore | null): void {
  store = s;
}

/** One line of the log; never throws. */
export function auditPing(line: Omit<PingAuditLine, "at"> & { at?: string }, file = pingsAuditFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: line.at ?? new Date().toISOString(), ...line })}\n`);
  } catch (err) {
    console.warn("[pings] audit write failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---- listeners: the Overseer's side ----------------------------------------------------------------

type Listener<T> = (v: T) => void;
const pingListeners = new Set<Listener<PingRecord>>();
const changeListeners = new Set<Listener<{ sessionId: string; ping: string }>>();

/** A new ping was kept (in the server's process: every ping is made there). The Overseer's side routes
    it by `ping.route`: a ping turn or run note for the Overseer, a reason to look for a project overseer. */
export function onPing(fn: Listener<PingRecord>): () => void {
  pingListeners.add(fn);
  return () => pingListeners.delete(fn);
}
/** A ping changed in this process (a hand came down, an outcome was set): the digest and the card readers. */
export function onPingChanged(fn: Listener<{ sessionId: string; ping: string }>): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function tell<T>(set: Set<Listener<T>>, v: T): void {
  for (const fn of set) {
    try {
      fn(v);
    } catch (err) {
      console.error("[pings] listener failed", err);
    }
  }
}

// ---- the raised hand ----------------------------------------------------------------------------

/** Each session's newest ping that is up in the digest (`stuck`/`decision`: its hand; `done`: its line), by session id. */
export function raisedHands(s: PingStore = pingStore()): Map<string, PingRecord> {
  const out = new Map<string, PingRecord>();
  for (const p of s.read().pings) if (HAND_KINDS.has(p.kind) && !p.lowered) out.set(p.sessionId, p);
  return out;
}

/** Lower a session's hand (and its done line), if one is up. Returns whether anything came down. Cheap
    when none is: the file is read, never locked or written. */
export function lowerHand(sessionId: string, why: NonNullable<PingRecord["lowered"]>["why"], s: PingStore = pingStore()): boolean {
  if (!s.read().pings.some((p) => p.sessionId === sessionId && HAND_KINDS.has(p.kind) && !p.lowered)) return false;
  const lowered = s.update<PingRecord[]>((d) => {
    const at = new Date(s.now()).toISOString();
    const hit = d.pings.filter((p) => p.sessionId === sessionId && HAND_KINDS.has(p.kind) && !p.lowered);
    for (const p of hit) p.lowered = { at, why };
    return { write: hit.length > 0, value: hit };
  });
  for (const p of lowered) {
    auditPing({ sessionId, kind: p.kind, ping: p.id, outcome: "lowered", reason: why });
    tell(changeListeners, { sessionId, ping: p.id });
  }
  return lowered.length > 0;
}

// ---- outcomes: what the pinging chat's card says -----------------------------------------------------

/** The same recipient's earlier line gives way to its newer one; `offered` and `declined` are one line each. */
const sameLine = (a: PingOutcome, b: PingOutcome): boolean => {
  const to = (o: PingOutcome) => ("to" in o ? o.to.id : null);
  if (to(a) !== null || to(b) !== null) return to(a) === to(b);
  return a.kind === b.kind;
};

/** Revise a ping's card in its chat: best effort, never a turn. */
async function reviseCard(p: PingRecord): Promise<void> {
  if (!p.card) return;
  try {
    const { reviseSovaCard } = await import("./transcript-cards");
    await reviseSovaCard(p.sessionId, p.card, pingCardData(p));
  } catch (err) {
    console.warn("[pings] card not revised:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * What became of a ping, from the Overseer's side (a pass-on, a recipient refused, an offer on a card, a
 * decision not to pass it on): kept on the ping, its card in the pinging chat revised in place, no model
 * turn anywhere (§app.overseer-pings/tool "Its card"). Null: no such ping.
 */
export async function setPingOutcome(id: string, outcome: PingOutcome, s: PingStore = pingStore()): Promise<PingRecord | null> {
  const p = s.update<PingRecord | null>((d) => {
    const hit = d.pings.find((x) => x.id === id);
    if (!hit) return { write: false, value: null };
    hit.outcomes = [...hit.outcomes.filter((o) => !sameLine(o, outcome)), outcome];
    return { write: true, value: structuredClone(hit) };
  });
  if (!p) return null;
  auditPing({ sessionId: p.sessionId, kind: p.kind, ping: p.id, ...("to" in outcome ? { to: [outcome.to.id] } : {}), outcome: "outcome", reason: outcome.kind });
  await reviseCard(p);
  tell(changeListeners, { sessionId: p.sessionId, ping: p.id });
  return p;
}

/** The Overseer's side took a ping (a ping turn carried it, a run note, a project overseer's reason). */
export function markPingDelivered(id: string, s: PingStore = pingStore()): void {
  s.update((d) => {
    const hit = d.pings.find((x) => x.id === id);
    if (!hit || hit.delivered) return { write: false, value: undefined };
    hit.delivered = new Date(s.now()).toISOString();
    return { write: true, value: undefined };
  });
}

/** The pings not yet taken by the Overseer's side, oldest first, optionally only those a route hears. */
export function undeliveredPings(route?: PingRoute["kind"], s: PingStore = pingStore()): PingRecord[] {
  return s.read().pings.filter((p) => !p.delivered && (!route || p.route.kind === route));
}

// ---- which Overseer hears it (§app.overseer-pings/routing) ------------------------------------------

export interface RouteFacts {
  /** The registered project whose folder holds `cwd`, or null. */
  projectFor(cwd: string): Promise<{ id: string; name: string; archived: boolean } | null>;
  /** The project's overseer exists, is watching and is not paused. */
  overseerHears(projectId: string): boolean | Promise<boolean>;
}

/** A relay always goes to the Overseer; any other ping to the project's overseer when it exists, watches, isn't
    paused and its project isn't archived; otherwise to the Overseer. Pure over `facts`. */
export async function routePing(kind: PingKind, cwd: string, facts: RouteFacts = defaultRouteFacts()): Promise<PingRoute> {
  if (kind === "relay" || !cwd) return { kind: "overseer" };
  const p = await facts.projectFor(cwd).catch(() => null);
  if (!p || p.archived) return { kind: "overseer" };
  return (await Promise.resolve(facts.overseerHears(p.id)).catch(() => false)) ? { kind: "project", projectId: p.id, projectName: p.name } : { kind: "overseer" };
}

const within = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root.replace(/\/+$/, "")}/`);

/** This server's projects and project overseers (lazily imported: chat processes never route). */
export function defaultRouteFacts(): RouteFacts {
  return {
    async projectFor(cwd) {
      const [{ listProjects }, { projectRootOf }] = await Promise.all([import("./projects/spaces"), import("./project-root")]);
      const projects = listProjects();
      const root = await projectRootOf(cwd).catch(() => null);
      // Its project (the main checkout and its worktrees, §chat.profiles/projects), else a project folder that holds it.
      const p = (root ? projects.find((x) => x.root === root) : undefined) ?? projects.filter((x) => within(cwd, x.root)).sort((a, b) => b.root.length - a.root.length)[0];
      return p ? { id: p.id, name: p.name, archived: !!p.archived } : null;
    },
    async overseerHears(projectId) {
      const [{ readPoState, readPoSettings, projectOverseerPaths }, { overseerPausedSince }] = await Promise.all([import("./project-overseer-store"), import("./projects/spaces")]);
      const paths = projectOverseerPaths(projectId);
      return !!readPoState(paths) && readPoSettings(paths).watch && !overseerPausedSince(projectId);
    },
  };
}

// ---- the tool (§app.overseer-pings/tool) ------------------------------------------------------------

/** Fixed for the runtime's life and across releases: a Claude Code chat's CLI restarts when it changes. */
export const OVERSEER_PING_DESCRIPTION =
  "Tell the Overseer something it should know: you are stuck, done with work the user is waiting on, need the user's decision, changed something other sessions of this project rely on (news), or the user asked you to give something to another session (relay, with to). It never ends your turn, and no answer comes back here.";
export const OVERSEER_PING_GUIDELINES = [
  "Ping stuck or decision when you are blocked on the user, and done when you finish work the user is waiting on; say it in your reply as well: a ping never replaces that.",
  "Ping news when you changed something other sessions of this project rely on.",
  "Ping relay only when the user asks you to give something to another session; put who it is for in to, in the user's words or as a sova://s/ link.",
];

export const NOTHING_SENT = "Nothing was sent:";

export class PingRefusal extends Error {}

/** What the tool needs from where it runs. `standing`: the run's, read in the chat's own process (an
    in-process chat's own RunState); absent, the served call's (ServerToolCall.standing). */
export interface PingingSession {
  sessionId(): string;
  path(): string;
  title(): string | Promise<string>;
  standing?: (params: unknown) => RunStanding | null;
}

export interface PingDeps {
  store: PingStore;
  summary(path: string): Promise<SessionSummary | null>;
  limits(): OverseerPingLimits | Promise<OverseerPingLimits>;
  overseerExists(): boolean | Promise<boolean>;
  route(kind: PingKind, cwd: string): Promise<PingRoute>;
  /** Raise the ping's card in its chat, standing at the call; its id, or null when none could be raised. */
  card(p: PingRecord, toolCallId: string): Promise<string | null>;
  audit(line: Omit<PingAuditLine, "at">): void;
}

export function defaultPingDeps(): PingDeps {
  return {
    store: pingStore(),
    summary: async (path) => (await import("./sessions-index")).getSessionSummary(path),
    // The Overseer's store, imported here so a chat process never loads it at boot.
    limits: async () => pingLimitsOf((await import("./overseer-store")).readOverseerSettings()),
    overseerExists: async () => !!(await import("./overseer-store")).readOverseerState(),
    route: (kind, cwd) => routePing(kind, cwd),
    card: async (p, toolCallId) => {
      const { raiseSovaCard } = await import("./transcript-cards");
      return (await raiseSovaCard({ path: p.path, sessionId: p.sessionId, data: pingCardData(p), key: p.id, toolCallId }))?.id ?? null;
    },
    audit: (line) => auditPing(line),
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** Session ids a relay's `to` links (sova://s/{id}): the log's `to`, never its words. */
const linkedIds = (to: string): string[] => [...to.matchAll(/sova:\/\/s\/([A-Za-z0-9_-]{1,128})/g)].map((m) => m[1]!);

/** The answer to an accepted ping. */
export function pingAnswer(p: Pick<PingRecord, "id" | "kind" | "route"> & Partial<Pick<PingRecord, "attended" | "hop">>): string {
  const who = p.route.kind === "project" ? `Told ${p.route.projectName}'s overseer` : "Told the Overseer";
  const hand = p.kind === "stuck" || p.kind === "decision" ? " Your hand stays up in Needs you until the user starts a turn here." : "";
  // A relay the user's message didn't start, or at hop 1 or more, is kept and goes only at the user's click (§app.overseer-pings/tool).
  const click = p.kind === "relay" && (p.attended === false || (p.hop ?? 0) > 0) ? " The user didn't ask for this here, so it waits for their click." : "";
  return `${who} (${p.id}).${hand}${click}`;
}

/** A session that may ping (§app.overseer-pings/tool: never a worker, an Overseer's, a project overseer's, a baton's, a merge queue chat or a TUI's). */
function notPinging(s: SessionSummary): string | null {
  if (s.archived) return "this session is archived.";
  if (s.live) return "this session is open in a terminal.";
  if (s.overseer || s.projectOverseer || s.baton || s.workerSession || s.queueChat) return "this session doesn't ping an Overseer.";
  return null;
}

/**
 * One ping: every rule checked (a refusal takes nothing), then kept, counted, logged, its card raised and
 * the Overseer's side told. Returns the record; throws a PingRefusal whose message starts "Nothing was sent:".
 */
export async function makePing(
  who: { sessionId: string; path: string; title: string; standing: RunStanding | null; toolCallId: string },
  params: unknown,
  deps: PingDeps = defaultPingDeps(),
): Promise<PingRecord> {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const kind = typeof p.kind === "string" ? (p.kind as PingKind) : undefined;
  const refuse = (why: string, reason?: string): never => {
    deps.audit({ sessionId: who.sessionId, kind: kind && PING_KINDS.includes(kind) ? kind : "news", outcome: "refused", error: `${NOTHING_SENT} ${why}`, ...(reason ? { reason } : {}) });
    throw new PingRefusal(`${NOTHING_SENT} ${why}`);
  };
  if (!kind || !PING_KINDS.includes(kind)) refuse(`kind is one of ${PING_KINDS.join(", ")}.`, "bad-kind");
  const summary = typeof p.summary === "string" ? oneLine(p.summary) : "";
  if (!summary) refuse("summary must not be blank.", "bad-summary");
  if (summary.length > PING_SUMMARY_MAX) refuse(`summary is one line of at most ${PING_SUMMARY_MAX} characters.`, "bad-summary");
  const detail = typeof p.detail === "string" ? p.detail.trim() : undefined;
  if (p.detail !== undefined && typeof p.detail !== "string") refuse("detail must be text.", "bad-detail");
  if (detail && detail.length > PING_DETAIL_MAX) refuse(`detail is at most ${PING_DETAIL_MAX} characters.`, "bad-detail");
  const to = typeof p.to === "string" ? oneLine(p.to) : undefined;
  if (kind === "relay") {
    if (!to) refuse("a relay says who it is for in to.", "no-to");
    if (to!.length > PING_TO_MAX) refuse(`to is at most ${PING_TO_MAX} characters.`, "bad-to");
  } else if (p.to !== undefined) refuse("to is only for a relay.", "to-not-relay");
  const s = await deps.summary(who.path).catch(() => null);
  if (!s) refuse("this session can't be read right now.", "no-session");
  const not = notPinging(s!);
  if (not) refuse(not, "not-pinging");
  // Fails closed: a call with no run record (an older chat process) is unattended, at hop 1.
  const standing = who.standing ?? { attended: false, hop: 1 };
  if (kind === "decision" && (s!.align?.openQuestions ?? 0) > 0) refuse("this session has open alignment questions, and they are in Needs you already.", "open-questions");
  if ((kind === "news" || kind === "relay") && !(await deps.overseerExists())) refuse("this Sova has no Overseer.", "no-overseer");
  const limits = await deps.limits();
  const store = deps.store;
  const key = `session:${who.sessionId}`;
  const route = await deps.route(kind!, s!.cwd);
  // Checked and taken in one step under the file's lock, so two calls at once can't both pass.
  const made = store.update((d): { write: boolean; value: PingRecord | string } => {
    const hour = store.recent(key, HOUR_MS, d);
    if (hour + 1 > limits.sessionPerHour) return { write: false, value: `limit reached: at most ${limits.sessionPerHour} pings an hour from one session (${hour} sent).` };
    const day = store.today(key, d);
    if (day + 1 > limits.sessionPerDay) return { write: false, value: `limit reached: at most ${limits.sessionPerDay} pings a day from one session (${day} sent).` };
    const open = d.pings.filter((x) => x.sessionId === who.sessionId && (HAND_KINDS.has(x.kind) ? !x.lowered : !x.delivered));
    if (open.some((x) => x.summary.toLowerCase() === summary.toLowerCase())) return { write: false, value: "that is the same summary as this session's open ping." };
    const at = store.now();
    const id = `pg_${++d.n}`;
    // A newer done lowers the session's hand and a newer stuck or decision replaces it; news and relay leave it up.
    if (HAND_KINDS.has(kind!)) for (const x of d.pings) if (x.sessionId === who.sessionId && HAND_KINDS.has(x.kind) && !x.lowered) x.lowered = { at: new Date(at).toISOString(), why: "newer-ping" };
    const said = kind === "relay" && standing.said ? standing.said.slice(0, PING_SAID_MAX) : undefined;
    const rec: PingRecord = {
      id,
      at: new Date(at).toISOString(),
      sessionId: who.sessionId,
      path: who.path,
      title: who.title.trim() || "Untitled",
      cwd: s!.cwd,
      kind: kind!,
      summary,
      ...(detail ? { detail } : {}),
      ...(to ? { to } : {}),
      attended: standing.attended,
      hop: standing.hop,
      ...(said !== undefined ? { said } : {}),
      route,
      outcomes: [],
    };
    d.pings.push(rec);
    d.counts[key] = [...(d.counts[key] ?? []), at];
    return { write: true, value: rec };
  });
  if (typeof made === "string") refuse(made, "limit");
  const rec = made as PingRecord;
  deps.audit({ sessionId: who.sessionId, kind: rec.kind, ping: rec.id, ...(rec.to && linkedIds(rec.to).length ? { to: linkedIds(rec.to) } : {}), outcome: "ok", reason: rec.route.kind === "project" ? `project:${rec.route.projectId}` : "overseer" });
  const card = await deps.card(rec, who.toolCallId).catch(() => null);
  if (card) {
    rec.card = card;
    store.update((d) => {
      const hit = d.pings.find((x) => x.id === rec.id);
      if (hit) hit.card = card;
      return { write: !!hit, value: undefined };
    });
  }
  tell(pingListeners, rec);
  tell(changeListeners, { sessionId: rec.sessionId, ping: rec.id });
  return rec;
}

const obj = (properties: Record<string, unknown>, required: string[]): any => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

/** `overseer_ping` as a server hosts it (served to a chat in its own process, or run here for an in-process chat). */
export function overseerPingTool(ctx: PingingSession, deps?: () => PingDeps): ToolSpec {
  return {
    name: OVERSEER_PING_TOOL,
    label: "Ping the Overseer",
    description: OVERSEER_PING_DESCRIPTION,
    promptSnippet: "tell the Overseer you are stuck, done, need the user's decision, have news, or have a note the user asked you to pass on",
    promptGuidelines: OVERSEER_PING_GUIDELINES,
    parameters: obj(
      {
        kind: str("stuck, done, decision, news or relay.", { enum: [...PING_KINDS] }),
        summary: str(`One line, at most ${PING_SUMMARY_MAX} characters.`),
        detail: str(`Optional, at most ${PING_DETAIL_MAX} characters.`),
        to: str(`relay only, and required there: who it is for, in the user's words or as a sova://s/ link (at most ${PING_TO_MAX} characters).`),
      },
      ["kind", "summary"],
    ),
    async execute(toolCallId, params) {
      const standing = ctx.standing ? ctx.standing(params) : ((await import("./chat-handle")).serverToolCall()?.call.standing ?? null);
      const rec = await makePing({ sessionId: ctx.sessionId(), path: ctx.path(), title: await ctx.title(), standing, toolCallId }, params, deps?.());
      return { content: [{ type: "text", text: pingAnswer(rec) }], details: { v: 1, ping: rec.id, kind: rec.kind, route: rec.route, ...(rec.card ? { card: rec.card } : {}) } };
    },
  };
}

/** The text of the user's message a relay carries: the newest user entry's text on the chat's own branch,
    at most PING_SAID_MAX. Read only while the run is attended (then it is the user's own, by identity). */
export function ownWordsOf(branch: readonly { kind: string; blocks?: readonly { type: string; text?: string }[] }[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (h.kind !== "user") continue;
    const text = (h.blocks ?? []).flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n").trim();
    return text.slice(0, PING_SAID_MAX);
  }
  return undefined;
}

// A transport's record on each of the two devices (§app/transport): one file per transport under
// this server's state root, `transport/<tid>.json` (0600), never in a chat home, a transcript or the
// shared folder. It holds the one-time ticket (§mesh.peers/transport-ticket), so it is never logged or
// sent to a page whole: `publicView` is what the page sees. Listeners hear every change.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state-root";

export type TransportMode = "move" | "copy";
export type TransportSide = "source" | "destination";
export type TransportState =
  | "preparing"
  | "waiting-helpers"
  | "packing"
  | "sending"
  | "checking"
  | "switching"
  | "done"
  | "needs-you"
  | "cancelled";

/** The steps, in order, as both sides name them (the lab's kill and pause knobs take these). */
export const STEPS = ["offered", "prepared", "stopped", "packed", "pulled", "staged", "verified", "decided", "published", "opened", "confirmed"] as const;
export type Step = (typeof STEPS)[number];

export interface TransportRecord {
  v: 1;
  tid: string;
  side: TransportSide;
  mode: TransportMode;
  /** The chat here (source) or the chat as it arrives (destination: its id there). */
  chatId: string;
  /** The chat's id on the source (a Copy's is new on the destination). */
  sourceChatId: string;
  title: string;
  /** The other device: its peer id in this host's peers.json, and its name. */
  peer: string;
  peerLabel: string;
  /** Source: the chat's conversation file; destination: where it is published. */
  path: string;
  /** The folder on the destination the chat's main folder goes to. */
  folder: string;
  state: TransportState;
  steps: Partial<Record<Step, string>>;
  needsYou?: { reason: string; at: string };
  /** The one-time ticket: the source mints it, the destination spends it. Never logged, never shown. */
  ticket?: string;
  /** The ticket was burnt (verified, cancelled, failed for good). */
  ticketBurnt?: boolean;
  /** The package as packed: its hash and size (destination: as the offer said). */
  pkg?: { sha256: string; size: number };
  /** Bytes the destination holds of the package. */
  received?: number;
  /** Source: the dialog's choices. */
  choices?: { untick: string[]; include: string[]; busyChoice?: "safe" | "interrupt"; agentModel?: string; copies?: string[] };
  /** Source: commits the destination has, from its first answer. */
  haves?: string[];
  /** Source: the switch was decided (the commit sent, or about to be): the chat doesn't run here again unless the destination says it has nothing. */
  decided?: boolean;
  /** Source: what a Move stopped at the switch, named for the chat there. */
  stopped?: { jobs: string[]; copies: string[] };
  /** Worker ids interrupted, or wrapped up, at the switch. */
  interrupted?: string[];
  wrapped?: string[];
  /** Destination: the chat's id there once published (a Copy's new one). */
  arrivedId?: string;
  /** Branch names that changed on arrival: "<there>" from "<here>". */
  renamed?: { from: string; to: string }[];
  /** Attempts (Retry continues from what arrived). */
  attempt: number;
  createdAt: string;
  updatedAt: string;
  /** Other members' sub-records (the Transport agent, Safe Transport): read and written only by them. */
  ext?: Record<string, unknown>;
}

const dirOf = () => join(stateRoot(), "transport");
const fileOf = (tid: string) => join(dirOf(), `${tid}.json`);
const listeners = new Set<(r: TransportRecord) => void>();

export const newTid = (): string => `tr_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x").toLowerCase()}`;
export const newTicket = (): string => randomBytes(32).toString("base64url");

const validTid = (tid: string) => /^tr_[a-z0-9]{6,32}$/.test(tid);

export function readTransport(tid: string): TransportRecord | null {
  if (!validTid(tid)) return null;
  try {
    const r = JSON.parse(readFileSync(fileOf(tid), "utf8")) as TransportRecord;
    return r?.v === 1 && r.tid === tid ? r : null;
  } catch {
    return null;
  }
}

export function listTransports(): TransportRecord[] {
  let names: string[];
  try {
    names = readdirSync(dirOf());
  } catch {
    return [];
  }
  const out: TransportRecord[] = [];
  for (const n of names) if (n.endsWith(".json")) {
    const r = readTransport(n.slice(0, -5));
    if (r) out.push(r);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function write(r: TransportRecord): void {
  mkdirSync(dirOf(), { recursive: true, mode: 0o700 });
  const f = fileOf(r.tid);
  writeFileSync(`${f}.tmp`, `${JSON.stringify(r)}\n`, { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
  if (active?.dir === dirOf()) index(active.byTid, r);
}

// The transports still under way, per chat, in memory: read from disk once, then kept by every write here (this
// server is their only writer). A chat's start asks it on each attach, prompt and wake, so it never reads a file.
let active: { dir: string; byTid: Map<string, TransportRecord> } | null = null;
const live = (r: TransportRecord) => r.state !== "done" && r.state !== "cancelled";
function index(byTid: Map<string, TransportRecord>, r: TransportRecord): void {
  if (live(r)) byTid.set(r.tid, r);
  else byTid.delete(r.tid);
}
function activeIndex(): Map<string, TransportRecord> {
  const dir = dirOf();
  if (active?.dir !== dir) {
    const byTid = new Map<string, TransportRecord>();
    for (const r of listTransports()) index(byTid, r);
    active = { dir, byTid };
  }
  return active.byTid;
}
/** Tests: forget the index. */
export const resetActiveIndex = (): void => void (active = null);

export function createTransport(r: Omit<TransportRecord, "v" | "createdAt" | "updatedAt" | "attempt" | "steps"> & { steps?: TransportRecord["steps"] }): TransportRecord {
  const now = new Date().toISOString();
  const rec: TransportRecord = { v: 1, attempt: 1, steps: {}, ...r, createdAt: now, updatedAt: now };
  write(rec);
  emit(rec);
  return rec;
}

/** Change a record (a patch, or a function of the record as it is now). Returns the new record. */
export function updateTransport(tid: string, patch: Partial<TransportRecord> | ((r: TransportRecord) => Partial<TransportRecord>)): TransportRecord | null {
  const cur = readTransport(tid);
  if (!cur) return null;
  const p = typeof patch === "function" ? patch(cur) : patch;
  const next: TransportRecord = { ...cur, ...p, ext: p.ext ? { ...cur.ext, ...p.ext } : cur.ext, v: 1, tid, updatedAt: new Date().toISOString() };
  write(next);
  emit(next);
  return next;
}

/** Mark a step done (the time it was done). */
export function stepDone(tid: string, step: Step, patch: Partial<TransportRecord> = {}): TransportRecord | null {
  return updateTransport(tid, (r) => ({ ...patch, steps: { ...r.steps, [step]: r.steps[step] ?? new Date().toISOString() } }));
}

export function onTransportChange(fn: (r: TransportRecord) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(r: TransportRecord): void {
  for (const fn of listeners) {
    try {
      fn(r);
    } catch (err) {
      console.error(`[transport] a listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The transport of chat `chatId` that is still under way here, if any. */
export function activeTransportOf(chatId: string): TransportRecord | null {
  let first: TransportRecord | null = null;
  for (const r of activeIndex().values()) if ((r.chatId === chatId || r.sourceChatId === chatId) && (!first || r.createdAt < first.createdAt)) first = r;
  return first;
}

/** What a page may see of a record: never the ticket. */
export function publicView(r: TransportRecord): Omit<TransportRecord, "ticket"> {
  const { ticket: _t, ...rest } = r;
  return rest;
}

/** A log line's name for a transport: its id only, never its ticket. */
export const logName = (r: Pick<TransportRecord, "tid" | "mode" | "side">): string => `${r.tid} (${r.mode}, ${r.side})`;

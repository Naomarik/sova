import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOPIC_NAME_RE } from "../shared/topic-message";
import { stateRoot } from "./state-root";

/**
 * Topic queues' store (§chat.topics/store, §chat.topics/open): the open topics in `topics.json`
 * (atomic rename), and each topic's notes in `<topic>.jsonl`, items and acks folded on load.
 * One writer, this server; everything is cached in memory after the first read.
 */

export const TOPIC_PENDING_CAP = 200;
export const TOPIC_TEXT_MAX = 4000;
export const TOPICS_PER_SESSION = 10;
const BASE_MAX = 16;
const SUFFIX = 6;
/** Closed topics' records are kept this long (so a name is never handed out twice meanwhile). */
const CLOSED_KEEP_MS = 30 * 24 * 3600_000;

export interface TopicRecord {
  receiver: { sessionId: string; path: string };
  base: string;
  project?: string;
  createdAt: string;
  closedAt?: string;
  /** Sessions the receiver asked to answer here: only they may push. */
  invited?: string[];
  /** The Overseer's pairing this topic was opened for (§app.overseer/pairs): never reused by base. */
  pairing?: string;
}

/** Notes each way a pairing takes before that direction pauses (§app.overseer/pairs). */
export const PAIR_NOTES_EACH_WAY = 40;

/** One side of a pairing: the chat, the topic it receives on, and its job in the Overseer's words. */
export interface PairSide {
  sessionId: string;
  path: string;
  topic: string;
  job: string;
}

/** A pairing of two chats (§app.overseer/pairs). `notes.toA` counts notes pushed to `a`'s topic
    (sent by `b`) since the last resume of that direction; at PAIR_NOTES_EACH_WAY it is paused. */
export interface PairRecord {
  id: string;
  a: PairSide;
  b: PairSide;
  createdAt: string;
  notes: { toA: number; toB: number };
  endedAt?: string;
  endedWhy?: "unpaired" | "archived" | "gone";
}

/** A direction of a pairing, named by where its notes go. */
export type PairDirection = "toA" | "toB";

export const pairPaused = (p: PairRecord, d: PairDirection): boolean => p.notes[d] >= PAIR_NOTES_EACH_WAY;

export interface TopicItem {
  id: string;
  at: string;
  from: { sessionId: string; title: string };
  text: string;
}

type Line =
  | ({ t: "item"; v: 1 } & TopicItem)
  | { t: "ack"; v: 1; ids: string[]; batch: string; sessionId: string; at: string };

interface Loaded {
  pending: TopicItem[];
  /** Lines in the file that no longer matter (delivered items and their acks). */
  dead: number;
  /** The file ends mid-line (a torn write): the next line starts on a fresh one. */
  torn: boolean;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A caller's base name as the topic keeps it: lowercase letters, digits and single dashes, at
    most 16 characters, `topic` when nothing is left. */
export function topicBase(name: string): string {
  const b = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, BASE_MAX)
    .replace(/-+$/, "");
  return b || "topic";
}

export class TopicStore {
  private topics: Record<string, TopicRecord> | null = null;
  private loaded = new Map<string, Loaded>();
  /** Receivers Stop has paused, by session file (§chat.topics/delivery): kept with the store so a
      restart still holds the pause, until the user's next real message. */
  private paused: Set<string> | null = null;

  constructor(
    readonly dir: string = join(stateRoot(), "topics"),
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {}

  private get topicsFile(): string {
    return join(this.dir, "topics.json");
  }
  private get pausedFile(): string {
    return join(this.dir, "paused.json");
  }
  private get pairsFile(): string {
    return join(this.dir, "pairs.json");
  }
  private notesFile(name: string): string {
    return join(this.dir, `${name}.jsonl`);
  }

  private all(): Record<string, TopicRecord> {
    if (this.topics) return this.topics;
    let topics: Record<string, TopicRecord> = {};
    try {
      const raw = JSON.parse(readFileSync(this.topicsFile, "utf8"));
      if (raw && typeof raw.topics === "object" && raw.topics) topics = raw.topics;
    } catch {
      // missing or unreadable: no topics
    }
    this.topics = topics;
    return topics;
  }

  private saveTopics(): void {
    const all = this.all();
    const cutoff = this.now() - CLOSED_KEEP_MS;
    for (const [name, t] of Object.entries(all)) if (t.closedAt && Date.parse(t.closedAt) < cutoff) delete all[name];
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.topicsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, topics: all }, null, 1)}\n`);
    renameSync(tmp, this.topicsFile);
  }

  /** An open topic's record, or null for a name that isn't one (closed, never made, malformed). */
  topic(name: string): TopicRecord | null {
    if (typeof name !== "string" || !TOPIC_NAME_RE.test(name)) return null;
    const t = this.all()[name];
    return t && !t.closedAt ? t : null;
  }

  /** Every open topic, by name. */
  openTopics(): [string, TopicRecord][] {
    return Object.entries(this.all()).filter(([, t]) => !t.closedAt);
  }

  /**
   * Open a topic for `receiver` under `name`'s base, or hand back the one it already has open under
   * that base (§chat.topics/open). Throws a sentence when the session already holds the maximum.
   */
  open(receiver: { sessionId: string; path: string }, name: string, project?: string | null): { name: string; reused: boolean } {
    const base = topicBase(name);
    const mine = this.openTopics().filter(([, t]) => t.receiver.sessionId === receiver.sessionId);
    // A pairing's topic is never handed out by base (§chat.topics/open): only its pairing has it.
    const same = mine.find(([, t]) => t.base === base && !t.pairing);
    if (same) {
      if (same[1].receiver.path !== receiver.path) {
        same[1].receiver.path = receiver.path;
        this.saveTopics();
      }
      return { name: same[0], reused: true };
    }
    if (mine.length >= TOPICS_PER_SESSION)
      throw new Error(`This session already has ${TOPICS_PER_SESSION} topics open (${mine.map(([n]) => n).join(", ")}); reuse one of them.`);
    const all = this.all();
    const made = this.freshName(base);
    all[made] = { receiver: { ...receiver }, base, ...(project ? { project } : {}), createdAt: new Date(this.now()).toISOString() };
    this.saveTopics();
    return { name: made, reused: false };
  }

  private freshName(base: string): string {
    const all = this.all();
    let made = "";
    do {
      const bytes = this.random(SUFFIX);
      let suffix = "";
      for (let i = 0; i < SUFFIX; i++) suffix += ALPHABET[bytes[i]! % ALPHABET.length];
      made = `${base}-${suffix}`;
    } while (all[made] || existsSync(this.notesFile(made)));
    return made;
  }

  /** Open topics `sessionId` receives on, pairings' included. */
  openCount(sessionId: string): number {
    return this.openTopics().filter(([, t]) => t.receiver.sessionId === sessionId).length;
  }

  // ---- pairings (§app.overseer/pairs) ----------------------------------------------------------

  private pairsCache: Record<string, PairRecord> | null = null;

  private allPairs(): Record<string, PairRecord> {
    if (this.pairsCache) return this.pairsCache;
    let pairs: Record<string, PairRecord> = {};
    try {
      const raw = JSON.parse(readFileSync(this.pairsFile, "utf8"));
      if (raw && typeof raw.pairs === "object" && raw.pairs) pairs = raw.pairs;
    } catch {
      // missing or unreadable: no pairings
    }
    return (this.pairsCache = pairs);
  }

  private savePairs(): void {
    const all = this.allPairs();
    const cutoff = this.now() - CLOSED_KEEP_MS;
    for (const [id, p] of Object.entries(all)) if (p.endedAt && Date.parse(p.endedAt) < cutoff) delete all[id];
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.pairsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, pairs: all }, null, 1)}\n`);
    renameSync(tmp, this.pairsFile);
  }

  /** A pairing by id, ended or not; null for none. */
  pair(id: string): PairRecord | null {
    return (typeof id === "string" && this.allPairs()[id]) || null;
  }

  /** Every pairing still in force, oldest first; with `sessionId`, only that chat's. */
  livePairs(sessionId?: string): PairRecord[] {
    return Object.values(this.allPairs())
      .filter((p) => !p.endedAt && (!sessionId || p.a.sessionId === sessionId || p.b.sessionId === sessionId))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  }

  /** The live pairing of these two chats, in either order. */
  pairOf(x: string, y: string): PairRecord | null {
    return this.livePairs(x).find((p) => (p.a.sessionId === x && p.b.sessionId === y) || (p.a.sessionId === y && p.b.sessionId === x)) ?? null;
  }

  /** The pairing a topic was opened for and the direction its notes go, or null. Closed topics too. */
  pairOfTopic(name: string): { pair: PairRecord; dir: PairDirection } | null {
    const t = typeof name === "string" ? this.all()[name] : undefined;
    const p = t?.pairing ? this.pair(t.pairing) : null;
    if (!p) return null;
    return p.a.topic === name ? { pair: p, dir: "toA" } : p.b.topic === name ? { pair: p, dir: "toB" } : null;
  }

  /**
   * Pair two chats: one new topic on each (base `pair`, its chat the receiver, the partner its one
   * invited sender). Both chats' room under TOPICS_PER_SESSION is checked first, so either both
   * topics open or neither does. The same two chats already paired get their pairing back.
   */
  openPair(a: Omit<PairSide, "topic">, b: Omit<PairSide, "topic">): { pair: PairRecord; existing: boolean } {
    if (a.sessionId === b.sessionId) throw new Error("A pairing joins two different chats.");
    const had = this.pairOf(a.sessionId, b.sessionId);
    if (had) return { pair: had, existing: true };
    for (const side of [a, b]) {
      const n = this.openCount(side.sessionId);
      if (n >= TOPICS_PER_SESSION)
        throw new Error(`Session ${side.sessionId} already has ${TOPICS_PER_SESSION} topics open, so it can't be paired. Nothing was changed.`);
    }
    const all = this.all();
    const pairs = this.allPairs();
    let id = "";
    do id = `pr_${this.random(6).toString("hex")}`;
    while (pairs[id]);
    const at = new Date(this.now()).toISOString();
    const topicA = this.freshName("pair");
    all[topicA] = { receiver: { sessionId: a.sessionId, path: a.path }, base: "pair", createdAt: at, invited: [b.sessionId], pairing: id };
    const topicB = this.freshName("pair");
    all[topicB] = { receiver: { sessionId: b.sessionId, path: b.path }, base: "pair", createdAt: at, invited: [a.sessionId], pairing: id };
    const pair: PairRecord = { id, a: { ...a, topic: topicA }, b: { ...b, topic: topicB }, createdAt: at, notes: { toA: 0, toB: 0 } };
    pairs[id] = pair;
    this.saveTopics();
    this.savePairs();
    return { pair, existing: false };
  }

  /** End a pairing: both its topics close and their waiting notes are dropped. Returns the dropped
      counts, or null when it was already ended or never was. */
  endPair(id: string, why: NonNullable<PairRecord["endedWhy"]>): { pair: PairRecord; dropped: { a: number; b: number } } | null {
    const p = this.pair(id);
    if (!p || p.endedAt) return null;
    p.endedAt = new Date(this.now()).toISOString();
    p.endedWhy = why;
    this.savePairs();
    const dropped = { a: this.close(p.a.topic), b: this.close(p.b.topic) };
    return { pair: p, dropped };
  }

  /** One more note accepted toward `dir`'s chat. */
  countPairNote(id: string, dir: PairDirection): void {
    const p = this.pair(id);
    if (!p || p.endedAt) return;
    p.notes[dir]++;
    this.savePairs();
  }

  /** Lift a pause: `dir`'s count, or both, back to 0. Null for a pairing not in force. */
  resumePair(id: string, dir?: PairDirection): PairRecord | null {
    const p = this.pair(id);
    if (!p || p.endedAt) return null;
    if (!dir || dir === "toA") p.notes.toA = 0;
    if (!dir || dir === "toB") p.notes.toB = 0;
    this.savePairs();
    return p;
  }

  /** Record `sessionId` as invited on the open topic `name`. Returns whether
      that is new: an invitation lasts until the topic closes, and asking again changes nothing. */
  invite(name: string, sessionId: string): boolean {
    const t = this.topic(name);
    if (!t || !sessionId || t.invited?.includes(sessionId)) return false;
    (t.invited ??= []).push(sessionId);
    this.saveTopics();
    return true;
  }

  /** Take back an invitation `invite` just made, for a send that was then refused. */
  uninvite(name: string, sessionId: string): void {
    const t = this.topic(name);
    const i = t?.invited?.indexOf(sessionId) ?? -1;
    if (i < 0) return;
    t!.invited!.splice(i, 1);
    if (!t!.invited!.length) delete t!.invited;
    this.saveTopics();
  }

  invited(name: string, sessionId: string): boolean {
    return !!this.topic(name)?.invited?.includes(sessionId);
  }

  /** Close a topic: its record says so, its undelivered notes are dropped. Returns how many. */
  close(name: string): number {
    const t = this.all()[name];
    if (!t || t.closedAt) return 0;
    const dropped = this.pending(name).length;
    t.closedAt = new Date(this.now()).toISOString();
    this.saveTopics();
    this.loaded.delete(name);
    rmSync(this.notesFile(name), { force: true });
    // Nothing left to pause for them: clear the Stop pause of a receiver with no open topic.
    if (!this.openTopics().some(([, x]) => x.receiver.path === t.receiver.path)) this.resumeReceiver(t.receiver.path);
    return dropped;
  }

  /** Stop was pressed in this receiver: no batch starts there until its user's next real message. */
  pauseReceiver(path: string): void {
    const s = this.pauses();
    if (!s.has(path)) {
      s.add(path);
      this.savePauses();
    }
  }

  /** The lift of a Stop's pause: the user's real message, or the receiver's last topic closing. */
  resumeReceiver(path: string): void {
    if (this.pauses().delete(path)) this.savePauses();
  }

  receiverPaused(path: string): boolean {
    return this.pauses().has(path);
  }

  private pauses(): Set<string> {
    if (this.paused) return this.paused;
    const set = new Set<string>();
    try {
      const raw = JSON.parse(readFileSync(this.pausedFile, "utf8"));
      // A path whose file is gone can never be un-paused by a message: prune it.
      for (const p of raw?.paused ?? []) if (typeof p === "string" && existsSync(p)) set.add(p);
    } catch {
      // missing or unreadable: no pauses
    }
    return (this.paused = set);
  }

  private savePauses(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.pausedFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, paused: [...this.pauses()], updatedAt: new Date(this.now()).toISOString() })}\n`);
    renameSync(tmp, this.pausedFile);
  }

  private load(name: string): Loaded {
    const hit = this.loaded.get(name);
    if (hit) return hit;
    const items = new Map<string, TopicItem>();
    let lines = 0;
    let raw = "";
    try {
      raw = readFileSync(this.notesFile(name), "utf8");
    } catch {
      // no notes yet
    }
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      let l: Line;
      try {
        l = JSON.parse(text);
      } catch {
        continue; // a torn last line
      }
      lines++;
      if (l?.t === "item" && typeof l.id === "string" && typeof l.text === "string") items.set(l.id, { id: l.id, at: l.at, from: l.from, text: l.text });
      else if (l?.t === "ack" && Array.isArray(l.ids)) for (const id of l.ids) items.delete(id);
    }
    const loaded = { pending: [...items.values()], dead: lines - items.size, torn: raw.length > 0 && !raw.endsWith("\n") };
    this.loaded.set(name, loaded);
    return loaded;
  }

  private append(name: string, line: Line): void {
    const l = this.load(name);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.notesFile(name), `${l.torn ? "\n" : ""}${JSON.stringify(line)}\n`);
    l.torn = false;
  }

  /** The topic's undelivered notes, oldest first. */
  pending(name: string): readonly TopicItem[] {
    return this.topic(name) ? this.load(name).pending : [];
  }

  /** Keep a note. The caller has checked the topic is open and the text's size. */
  push(name: string, from: { sessionId: string; title: string }, text: string): { ok: true; id: string } | { ok: false; error: string } {
    const l = this.load(name);
    if (l.pending.length >= TOPIC_PENDING_CAP) return { ok: false, error: `"${name}" already holds ${TOPIC_PENDING_CAP} undelivered notes; tell the user.` };
    const item: TopicItem = { id: `qi_${this.random(6).toString("hex")}`, at: new Date(this.now()).toISOString(), from: { ...from }, text };
    this.append(name, { t: "item", v: 1, ...item });
    l.pending.push(item);
    return { ok: true, id: item.id };
  }

  /** The next batch: the oldest notes, at most `max` and about `chars` characters of text (always
      at least one note). Nothing is taken out until `ack`. */
  batch(name: string, max = 20, chars = 8000): TopicItem[] {
    const out: TopicItem[] = [];
    let size = 0;
    for (const it of this.pending(name)) {
      if (out.length >= max || (out.length && size + it.text.length > chars)) break;
      out.push(it);
      size += it.text.length;
    }
    return out;
  }

  /** The notes reached their receiver's context (§chat.topics/delivery): drop them from pending. */
  ack(name: string, ids: readonly string[], batch: string, sessionId: string): void {
    const l = this.loaded.get(name) ?? this.load(name);
    const set = new Set(ids);
    const before = l.pending.length;
    l.pending = l.pending.filter((it) => !set.has(it.id));
    const acked = before - l.pending.length;
    if (!acked || !this.topic(name)) return;
    this.append(name, { t: "ack", v: 1, ids: [...ids], batch, sessionId, at: new Date(this.now()).toISOString() });
    l.dead += acked + 1;
    if (l.dead > 50 && l.dead > l.pending.length) this.compact(name, l);
  }

  /** Rewrite the file with only the undelivered notes, by atomic rename. */
  private compact(name: string, l: Loaded): void {
    const file = this.notesFile(name);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, l.pending.map((it) => `${JSON.stringify({ t: "item", v: 1, ...it })}\n`).join(""));
    renameSync(tmp, file);
    l.dead = 0;
    l.torn = false;
  }

  /** One audit line (§chat.topics/push), never a note's text. */
  audit(line: {
    sessionId: string;
    tool: "queue_open" | "queue_push" | "session_send" | "sova_pair";
    topic?: string;
    outcome: "ok" | "refused" | "closed" | "invited";
    item?: string;
    error?: string;
    reason?: "not-open" | "not-invited" | "receiver-gone" | "pairing-ended" | "pairing-paused";
    pairing?: string;
    target?: string;
    dropped?: number;
  }): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, "audit.jsonl"), `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...line })}\n`);
    } catch (err) {
      console.warn("[topics] audit not written:", err instanceof Error ? err.message : String(err));
    }
  }
}

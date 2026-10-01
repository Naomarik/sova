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
export const TOPICS_PER_SESSION = 5;
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
}

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
    const same = mine.find(([, t]) => t.base === base);
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
    let made = "";
    do {
      const bytes = this.random(SUFFIX);
      let suffix = "";
      for (let i = 0; i < SUFFIX; i++) suffix += ALPHABET[bytes[i]! % ALPHABET.length];
      made = `${base}-${suffix}`;
    } while (all[made] || existsSync(this.notesFile(made)));
    all[made] = { receiver: { ...receiver }, base, ...(project ? { project } : {}), createdAt: new Date(this.now()).toISOString() };
    this.saveTopics();
    return { name: made, reused: false };
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
  audit(line: { sessionId: string; tool: "queue_open" | "queue_push"; topic?: string; outcome: "ok" | "refused" | "closed"; item?: string; error?: string; dropped?: number }): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, "audit.jsonl"), `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...line })}\n`);
    } catch (err) {
      console.warn("[topics] audit not written:", err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Outline state: topics, incremental delta extraction from the session,
 * snapshot persistence via pi.appendEntry("topic-outline", …), and the
 * free instant "Now" activity line (built from lifecycle events, no model).
 */

import { fingerprintOf, isMarkedMessage, normalize, stripAnsi, textOf } from "./anchors.ts";
import type {
  Anchor,
  OutlineBroadcast,
  OutlineConfig,
  OutlineData,
  OutlineStateName,
  SummarizerResult,
  Topic,
} from "./types.ts";

const CUSTOM_TYPE = "topic-outline";

interface EntryLike {
  id: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  timestamp?: string;
  message?: {
    role?: string;
    stopReason?: string;
    toolName?: string;
    isError?: boolean;
    content?: ({ type?: string; text?: string; thinking?: string; name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>)[] | string | null;
  };
}

export interface DeltaMessage {
  ref: string;
  entryId: string;
  role: "user" | "assistant" | "tool";
  line: string;
  anchor?: Anchor;
}

function entryTimestamp(entry: EntryLike): number | undefined {
  const value = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Broadcast-safe text: ANSI + control characters removed, whitespace collapsed, ≤ max chars total. */
function boundedLine(value: string, max: number): string {
  const clean = stripAnsi(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Limits for the "summary"-mode per-topic detail sent to /sessions. */
const DETAIL_TOPICS = 6;
const DETAIL_BULLETS = 3;
const DETAIL_HEADING_CHARS = 60;
const DETAIL_BULLET_CHARS = 120;

/** Path-ish tool argument names that are safe to show (never bash commands). */
function toolDetail(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["path", "file_path", "file", "pattern", "glob"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const base = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
      return ` · ${clip(base, 60)}`;
    }
  }
  return "";
}

/**
 * Extract new transcript lines and anchor candidates from context entries
 * appearing after `basisLeafId` (or all entries when basis is missing/absent).
 * Only user/assistant messages are anchorable; tool results carry context text.
 */
export function extractDelta(entries: EntryLike[], basisLeafId?: string): DeltaMessage[] {
  const ordered = entries.filter(entry => entry.type === "message" && entry.message?.role);
  let start = 0;
  if (basisLeafId) {
    const index = ordered.findIndex(entry => entry.id === basisLeafId);
    if (index >= 0) start = index + 1;
  }
  const out: DeltaMessage[] = [];
  let n = 0;
  for (const entry of ordered.slice(start)) {
    n++;
    const ref = `m${n}`;
    const message = entry.message as NonNullable<EntryLike["message"]>;
    const role = message.role ?? "";
    if (role === "user") {
      const text = textOf(message);
      if (!text.trim()) continue;
      const anchor: Anchor = {
        entryId: entry.id, role: "user",
        timestamp: entryTimestamp(entry),
        fingerprint: fingerprintOf(message),
      };
      out.push({ ref, entryId: entry.id, role: "user", line: `[${ref}] USER: ${clip(text, 1000)}`, anchor });
      continue;
    }
    if (role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string")
        .map(block => block.text as string).join("\n");
      const tools = blocks.filter(block => block?.type === "toolCall");
      const lines: string[] = [];
      const anchor: Anchor | undefined = tools.length === 0 && text.trim()
        ? { entryId: entry.id, role: "assistant", timestamp: entryTimestamp(entry), fingerprint: fingerprintOf(message) }
        : undefined;
      for (const [index, call] of tools.entries()) {
        const label = `TOOL${index > 0 ? ` ${index + 1}` : ""}`;
        lines.push(`[${ref}] ${label} call: ${call.name ?? "tool"}${toolDetail(call.arguments)}`);
      }
      if (text.trim()) lines.push(`[${ref}] ASSISTANT: ${clip(text, 1200)}`);
      if (message.stopReason === "error") lines.push(`[${ref}] ASSISTANT errored: ${clip(String((message as { errorMessage?: string }).errorMessage ?? ""), 200)}`);
      for (const line of lines) out.push({ ref, entryId: entry.id, role: "assistant", line, anchor });
      continue;
    }
    if (role === "toolResult") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string")
        .map(block => block.text as string).join("\n");
      if (!text.trim()) continue;
      const label = message.toolName ?? "tool";
      const suffix = message.isError ? " (error)" : "";
      out.push({ ref, entryId: entry.id, role: "tool", line: `[${ref}] TOOL ${label}${suffix} result: ${clip(text, 500)}` });
    }
  }
  return out;
}

/** Last message entry id on the current context view (basis for the next delta). */
export function lastMessageEntryId(entries: EntryLike[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "message" && entries[i].message?.role) return entries[i].id;
  }
  return undefined;
}

/** Compact JSON view of the outline handed back to the summarizer. */
export function existingOutlineJson(topics: Topic[]): string {
  if (!topics.length) return "none";
  return JSON.stringify(topics.map(topic => ({
    id: topic.id,
    heading: topic.heading,
    summary: topic.summary,
  })));
}

export function applyUpdates(
  topics: Topic[],
  updates: SummarizerResult["topicUpdates"],
  anchors: Map<string, Anchor>,
  limits: OutlineConfig["limits"],
): Topic[] {
  let next = [...topics];
  for (const update of updates) {
    const anchor = anchors.get(update.anchor);
    if (!anchor) continue;
    if (update.kind === "update") {
      const topic = next.find(item => item.id === update.topicId) ??
        next.find(item => item.heading.toLowerCase() === update.heading.toLowerCase());
      if (!topic) continue;
      next = next.map(item => item === topic
        ? { ...topic, anchor, summary: update.summary.slice(0, limits.maxBullets), at: Date.now() }
        : item);
    } else {
      next.push({
        id: `t-new:${update.heading}`, // placeholder, id assigned by caller
        heading: update.heading,
        anchor,
        summary: update.summary.slice(0, limits.maxBullets),
        at: Date.now(),
      });
    }
  }
  return next.length > limits.maxTopics ? next.slice(next.length - limits.maxTopics) : next;
}

export class OutlineStore {
  topics: Topic[] = [];
  now = "";
  overall = "";
  state: OutlineStateName = "none";
  basisLeafId: string | undefined;
  generatedAt = 0;
  /** Heading of the most recent user `#`-topic (kept even if the topic is later trimmed). */
  lastManualHeading = "";
  private topicCounter = 0;

  /**
   * The heading /sessions shows: the latest user `#` heading, else the heading of the
   * most recently created/updated topic, else "".
   */
  get lastHeading(): string {
    if (this.lastManualHeading) return this.lastManualHeading;
    let latest: Topic | undefined;
    for (const topic of this.topics) if (!latest || (topic.at ?? 0) >= (latest.at ?? 0)) latest = topic;
    return latest?.heading ?? "";
  }

  /** Hydrate from the latest snapshot on the current branch (or clear). */
  restore(entries: EntryLike[]): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
      const data = entry.data as Partial<OutlineData> | undefined;
      if (data?.version !== 2 || !Array.isArray(data.topics)) break;
      this.topics = data.topics.filter((topic): topic is Topic =>
        !!topic && typeof topic.id === "string" && typeof topic.heading === "string" &&
        Array.isArray(topic.summary) && !!topic.anchor && typeof topic.anchor === "object");
      this.now = typeof data.now === "string" ? data.now : "";
      this.overall = typeof data.overall === "string" ? data.overall : "";
      this.basisLeafId = typeof data.basisLeafId === "string" ? data.basisLeafId : undefined;
      this.generatedAt = typeof data.generatedAt === "number" ? data.generatedAt : 0;
      this.topicCounter = typeof data.topicCounter === "number" ? data.topicCounter : this.topics.length;
      this.lastManualHeading = typeof data.lastManualHeading === "string" ? data.lastManualHeading : "";
      this.state = this.topics.length || this.now ? "stale" : "none";
      return;
    }
    this.clear();
  }

  clear(): void {
    this.topics = [];
    this.now = "";
    this.overall = "";
    this.state = "none";
    this.basisLeafId = undefined;
    this.generatedAt = 0;
    this.lastManualHeading = "";
  }

  /** Apply a summarizer result. Returns false when validation rejected everything. */
  apply(result: SummarizerResult, anchors: Map<string, Anchor>, basisLeafId: string | undefined, limits: OutlineConfig["limits"]): boolean {
    let next = applyUpdates(this.topics, result.topicUpdates, anchors, limits);
    // Assign real ids to the placeholders applyUpdates created for kind:new.
    let assigned = 0;
    next = next.map(topic => topic.id.startsWith("t-new:") ? (++assigned, { ...topic, id: `t${++this.topicCounter}` }) : topic);
    const changed = assigned > 0 || next.length !== this.topics.length ||
      JSON.stringify(next.map(t => [t.heading, t.summary])) !==
      JSON.stringify(this.topics.map(t => [t.heading, t.summary]));
    this.topics = next;
    if (result.now) this.now = result.now;
    if (result.overall) this.overall = result.overall;
    this.basisLeafId = basisLeafId;
    this.generatedAt = Date.now();
    this.state = "fresh";
    return changed || !!result.now || !!result.overall;
  }

  markStale(): void {
    if (this.state === "fresh") this.state = "stale";
  }

  snapshot(): OutlineData {
    return {
      version: 2,
      topics: this.topics,
      now: this.now,
      overall: this.overall,
      topicCounter: this.topicCounter,
      basisLeafId: this.basisLeafId,
      generatedAt: this.generatedAt,
      state: this.state === "none" ? "none" : this.state === "failed-keeping-last" ? "failed-keeping-last" : "stale",
      lastHeading: this.lastHeading,
      lastManualHeading: this.lastManualHeading,
    };
  }

  /** Create an instant topic from a `#`-headed user message (no model call). */
  addManualTopic(heading: string, anchor: Anchor): Topic {
    const topic: Topic = { id: `t${++this.topicCounter}`, heading, anchor, summary: [], at: Date.now(), manual: true };
    this.topics = [...this.topics, topic];
    if (this.topics.length > 40) this.topics = this.topics.slice(-40);
    if (this.state === "none") this.state = "stale";
    this.lastManualHeading = heading;
    return topic;
  }

  /** A repeated `#` heading (topic already exists) still becomes the latest heading. */
  noteManualHeading(heading: string): void {
    this.lastManualHeading = heading;
  }

  /** Most recently created/updated topics, newest first (later position wins ties). */
  private recentTopics(limit: number): Topic[] {
    return this.topics.map((topic, index) => ({ topic, index }))
      .sort((a, b) => (b.topic.at ?? 0) - (a.topic.at ?? 0) || b.index - a.index)
      .slice(0, limit)
      .map(item => item.topic);
  }

  broadcast(sessionId: string, share: OutlineConfig["shareWithSessions"], shareLastHeading = true): OutlineBroadcast | undefined {
    if (share === "off") return undefined;
    const value: OutlineBroadcast = {
      sessionId, state: this.state, generatedAt: this.generatedAt,
    };
    if (share !== "off") value.now = this.now;
    const lastHeading = shareLastHeading ? clip(this.lastHeading, 80) : "";
    if (lastHeading) value.lastHeading = lastHeading;
    if (share === "summary") {
      value.overall = this.overall;
      value.topics = this.topics.map(topic => topic.heading).slice(0, 12);
      value.detail = this.recentTopics(DETAIL_TOPICS).map(topic => ({
        heading: boundedLine(topic.heading, DETAIL_HEADING_CHARS),
        bullets: topic.summary.slice(0, DETAIL_BULLETS)
          .map(bullet => boundedLine(String(bullet ?? ""), DETAIL_BULLET_CHARS))
          .filter(Boolean),
      }));
    }
    return value;
  }
}

/** Instant, free "Now" line derived from lifecycle events (no model involved). */
export class NowLine {
  private busy = false;
  private waiting = false;
  private failed = false;
  private readonly tools = new Map<string, string>();
  private idleSince = Date.now();

  agentStart(): void { this.busy = true; this.failed = false; this.tools.clear(); }
  agentSettled(): void { this.busy = false; this.tools.clear(); this.idleSince = Date.now(); }
  toolStart(id: string, name: string, args?: Record<string, unknown>): void { this.tools.set(id, `${name}${toolDetail(args)}`); }
  toolEnd(id: string): void { this.tools.delete(id); }
  promptStart(skipOwn: boolean): void { if (!skipOwn) this.waiting = true; }
  promptEnd(): void { if (this.waiting) this.waiting = false; }
  errored(message?: string): void { this.failed = true; if (message) this.lastError = message; }
  lastError = "";

  text(): string {
    if (!this.busy && !this.waiting && !this.failed) {
      const seconds = Math.max(0, Math.floor((Date.now() - this.idleSince) / 1000));
      return seconds < 60 ? "Idle" : `Idle ${Math.floor(seconds / 60)}m`;
    }
    if (this.waiting) return "Needs input";
    if (this.failed) return normalize(this.lastError) ? `Error: ${clip(this.lastError, 80)}` : "Error";
    if (this.tools.size) return `Running: ${[...new Set(this.tools.values())].slice(0, 3).join(", ")}${this.tools.size > 3 ? ` +${this.tools.size - 3}` : ""}`;
    return this.busy ? "Running" : "Idle";
  }
}

export { CUSTOM_TYPE, isMarkedMessage };

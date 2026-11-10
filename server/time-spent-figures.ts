// Time Spent's figures read from the transcript (§app.subagents-pane/time-spent): the agent's working
// time over the whole active branch, and each alignment document's title, reading time and decided
// moment. Pure over what the file's reader gave, so it never depends on how much a page has loaded.

import type { HEntry } from "../shared/harness";
import type { AlignDocInfo, TranscriptItem } from "../shared/protocol";

/** The main thread's turns so far: `closedMs` finished, and the turn the file leaves open. */
export interface AgentSpans {
  closedMs: number;
  /** When the turn the file leaves open began, or null. */
  openAt: number | null;
  /** The last moment the agent is known to have worked in that turn. */
  lastAt: number | null;
}

/**
 * A turn runs from what started it (a message, or an extension's message such as a worker's report)
 * to the agent's last entry in it. A reply that didn't stop to use a tool ends it, unless it was an
 * error or an abort: a retry goes on, and new input closes it. The gap before new input is never the
 * agent's, so a turn that died with its process doesn't run on until the next message.
 */
export function agentSpans(branch: readonly HEntry[]): AgentSpans {
  let closedMs = 0;
  let openAt: number | null = null;
  let lastAt: number | null = null;
  const close = () => {
    if (openAt !== null && lastAt !== null) closedMs += Math.max(0, lastAt - openAt);
    openAt = null;
    lastAt = null;
  };
  for (const e of branch) {
    const t = e.at ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(t)) continue;
    if (e.kind === "user" || e.kind === "note") {
      close();
      openAt = t;
      lastAt = t;
    } else if (e.kind === "assistant") {
      if (openAt === null) openAt = t;
      lastAt = t;
      if (e.stop !== "toolUse" && e.stop !== "error" && e.stop !== "aborted") close();
    } else if (e.kind === "tool-result") {
      if (openAt !== null) lastAt = t;
    }
  }
  return { closedMs, openAt, lastAt };
}

/** The figures at `now`. `running`: the session's agent is working right now. */
export function agentFigures(spans: AgentSpans, running: boolean, now: number): { agent: number; agentRunning: number | null } {
  if (running && spans.openAt !== null) {
    const agentRunning = Math.max(0, Math.round((now - spans.openAt) / 1000));
    return { agent: Math.round(spans.closedMs / 1000) + agentRunning, agentRunning };
  }
  const open = spans.openAt !== null && spans.lastAt !== null ? Math.max(0, spans.lastAt - spans.openAt) : 0;
  return { agent: Math.round((spans.closedMs + open) / 1000), agentRunning: null };
}

const wordsIn = (text: string | undefined) => (text ? (text.trim().match(/\S+/g)?.length ?? 0) : 0);

/** The reading pace of the idle cutoff (§app.subagents-pane/time-spent-counting). */
const WORDS_PER_MINUTE = 250;

/** The seconds a document's text takes to read: what its card and full report say. */
export function readingSeconds(doc: AlignDocInfo): number {
  let words = wordsIn(doc.title) + wordsIn(doc.summary);
  for (const f of doc.findings ?? []) words += wordsIn(f.text);
  for (const a of doc.approach ?? []) words += wordsIn(a.text);
  for (const t of doc.technical ?? []) words += wordsIn(t.text);
  for (const x of doc.rejected ?? []) words += wordsIn(x.option) + wordsIn(x.why);
  for (const q of doc.questions ?? []) {
    if (q.dropped) continue;
    words += wordsIn(q.topic) + wordsIn(q.ask) + wordsIn(q.context) + wordsIn(q.recommendation?.why) + wordsIn(q.decision?.text);
    for (const o of q.options ?? []) words += wordsIn(o.label) + wordsIn(o.tradeoff);
  }
  return Math.ceil((words * 60) / WORDS_PER_MINUTE);
}

export interface AlignFacts {
  docId: string;
  title: string;
  toRead: number;
  /** The revision where the last open question became decided (ms), while the newest revision has them all decided. */
  decidedAt: number | null;
}

/** One per document on the branch, by its first row, with its newest revision's words. */
export function alignFacts(items: readonly TranscriptItem[]): AlignFacts[] {
  const docs = new Map<string, AlignFacts>();
  for (const it of items) {
    const doc = it.kind === "align" ? it.align?.doc : undefined;
    if (!doc) continue;
    const had = docs.get(doc.id);
    const live = doc.questions.filter((q) => !q.dropped);
    const settled = live.length > 0 && live.every((q) => q.decision);
    const at = it.at ? Date.parse(it.at) : NaN;
    // The moment stays with the revision that settled it: later revisions (a new finding, a status change)
    // don't move it, and a reopened question clears it.
    const decidedAt = !settled ? null : (had?.decidedAt ?? (Number.isFinite(at) ? at : null));
    docs.set(doc.id, { docId: doc.id, title: doc.title, toRead: readingSeconds(doc), decidedAt });
  }
  return [...docs.values()];
}

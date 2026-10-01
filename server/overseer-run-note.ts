import { OVERSEER_BRIEF_PREFIX } from "../shared/protocol";
import { CARDS_NOTE_MESSAGE, foldCards, openCardsOf } from "../shared/overseer-card";

/**
 * The global Overseer's run note (§app.overseer/run-note): the hidden message every run a message
 * starts carries, beside the open cards. It says the time now (the system prompt keeps the time the
 * conversation opened, so its cache holds), which blockers the briefs named have cleared since,
 * and which open cards' sessions merged or were archived. Pure: the caller gathers the digest's act
 * keys and each session's state.
 */

/** Briefs older than this are not looked back at. */
export const CLEARED_WINDOW_MS = 24 * 3_600_000;
/** At most this many cleared blockers per note. */
export const CLEARED_MAX = 12;

/** A blocker a brief named: its digest key (`id:kind`, attention.ts blockerKey) and when the brief went. */
export interface BriefedBlocker {
  key: string;
  id: string;
  kind: string;
  at: number;
}

/** A session as the note needs it now; null when it is gone. */
export interface SessionNow {
  /** Its link text (summary-first, §app.overseer/session-names). */
  name: string;
  archived: boolean;
  /** Its branch merged (readiness badge merged or restart pending): when. */
  merged?: number;
  /** It waits on the user's answers to open alignment questions. */
  waitsOnAnswers: boolean;
}

/** The note's `details`: the blockers it listed as cleared, each `<key>@<brief ms>`, so a later note lists each once per brief. */
export interface RunNoteDetails {
  v: 1;
  cleared?: string[];
}

type Entry = { type?: unknown; customType?: unknown; details?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n")
      : "";

/** One blocker line of a brief, as briefText (overseer.ts) writes it: `- <kind>: [<name>](sova://s/<id>)…`. */
const BRIEF_LINE = /^- ([a-z][a-z-]*): \[[^\]\n]*\]\(sova:\/\/s\/([^)\s]+)\)/;

/** Every blocker the briefs on a branch named, the newest brief's time per key. */
export function briefedBlockers(branch: readonly unknown[]): BriefedBlocker[] {
  const out = new Map<string, BriefedBlocker>();
  for (const raw of branch) {
    const e = raw as Entry;
    if (e?.type !== "message" || e.message?.role !== "user") continue;
    const text = textOf(e.message.content);
    if (!text.startsWith(OVERSEER_BRIEF_PREFIX)) continue;
    const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    for (const line of text.split("\n")) {
      const m = BRIEF_LINE.exec(line.trim());
      if (!m) continue;
      const key = `${m[2]}:${m[1]}`;
      out.delete(key);
      out.set(key, { key, id: m[2]!, kind: m[1]!, at });
    }
  }
  return [...out.values()];
}

/** What earlier run notes on the branch already listed as cleared (`<key>@<brief ms>`). */
export function listedCleared(branch: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const raw of branch) {
    const e = raw as Entry;
    if (e?.type !== "custom_message" || e.customType !== CARDS_NOTE_MESSAGE) continue;
    const d = e.details as RunNoteDetails | undefined;
    if (d?.v === 1 && Array.isArray(d.cleared)) for (const k of d.cleared) if (typeof k === "string") out.add(k);
  }
  return out;
}

/** Why a briefed blocker cleared: the first that holds. `definite`: the server knows (else it only
    stopped being listed). */
export function clearedWhy(kind: string, s: SessionNow | null): { why: string; definite: boolean } {
  if (!s) return { why: "the session is gone", definite: true };
  if (s.archived) return { why: "archived", definite: true };
  if (s.merged !== undefined) return { why: "merged", definite: true };
  if (kind === "open-questions" && !s.waitsOnAnswers) return { why: "its questions were answered in the session", definite: true };
  return { why: "no longer needs the user", definite: false };
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const linkTo = (name: string, id: string) => `[${name.replace(/[[\]]/g, "")}](sova://s/${id})`;

export interface RunNoteInput {
  now: Date;
  branch: readonly unknown[];
  /** The digest's act-tier keys now (`id:kind`). `complete`: false when the digest's cap left act items out. */
  act: { keys: ReadonlySet<string>; complete: boolean };
  /** A session's state now, by id; null when it is gone. */
  session: (id: string) => SessionNow | null;
  /** The open-cards note (cardsNote), when a card is open. */
  cardsText?: string;
  /** Text from other sessions is redacted before it reaches the model. */
  redact?: (text: string) => string;
}

/** The ids the note will ask `session` about: briefed blockers in the window, and open cards' sessions. */
export function runNoteSessionIds(branch: readonly unknown[], now: number): string[] {
  const ids = new Set<string>();
  for (const b of briefedBlockers(branch)) if (now - b.at <= CLEARED_WINDOW_MS) ids.add(b.id);
  for (const c of openCardsOf(foldCards(branch))) for (const it of c.items) if (it.kind === "session") ids.add(it.id);
  return [...ids];
}

/** The note's text and details. */
export function runNote(input: RunNoteInput): { content: string; details: RunNoteDetails } {
  const now = input.now.getTime();
  const redact = input.redact ?? ((t: string) => t);
  const parts = [
    `[now] It is ${input.now.toString()}. The time in your system prompt is when this conversation opened; read elapsed time from this line and from tool ages.`,
  ];

  const listed = listedCleared(input.branch);
  const cleared: string[] = [];
  const lines: string[] = [];
  const briefed = briefedBlockers(input.branch)
    .filter((b) => now - b.at <= CLEARED_WINDOW_MS && !input.act.keys.has(b.key) && !listed.has(`${b.key}@${b.at}`))
    .sort((a, b) => b.at - a.at);
  for (const b of briefed) {
    if (lines.length >= CLEARED_MAX) break;
    const s = input.session(b.id);
    const { why, definite } = clearedWhy(b.kind, s);
    // A digest cut short may have left a live blocker out: only a reason the server knows lists it then.
    if (!definite && !input.act.complete) continue;
    lines.push(`- ${b.kind}: ${linkTo(s?.name ?? b.id, b.id)} — ${why} (briefed ${ago(b.at, now)})`);
    cleared.push(`${b.key}@${b.at}`);
  }
  if (lines.length)
    parts.push(redact(["[cleared] Blockers your briefs named that no longer need the user. Don't report them as open; check with sova_session before saying more:", ...lines].join("\n")));

  const cardLines: string[] = [];
  for (const c of openCardsOf(foldCards(input.branch))) {
    const raised = Date.parse(c.createdAt);
    for (const it of c.items) {
      if (it.kind !== "session") continue;
      const s = input.session(it.id);
      if (s === null) cardLines.push(`- ${c.id} item ${it.n}: ${it.id} — the session is gone`);
      else if (s.archived) cardLines.push(`- ${c.id} item ${it.n}: ${linkTo(s.name, it.id)} — archived`);
      else if (s.merged !== undefined && Number.isFinite(raised) && s.merged > raised)
        cardLines.push(`- ${c.id} item ${it.n}: ${linkTo(s.name, it.id)} — merged ${ago(s.merged, now)}, after the card was raised`);
    }
  }
  if (cardLines.length) parts.push(redact(["[card sessions] Sessions on open cards whose state moved. Drop or replace a card they make moot:", ...cardLines].join("\n")));

  if (input.cardsText) parts.push(input.cardsText);
  return { content: parts.join("\n\n"), details: { v: 1, ...(cleared.length ? { cleared } : {}) } };
}

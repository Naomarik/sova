import { alignMenuRows, isOpenDoc, liveCount, openCount, questionStateOf, type AlignEntry } from "./align";
import type { AlignDocInfo } from "../../shared/protocol";

/**
 * The composer's waiting badge and its dialog (§chat.composer/waiting-badge,
 * §chat.composer/waiting-dialog): what in this chat waits for the user's answer, its open
 * alignments and its open option cards. Pure: counts, the ring's geometry, the numeral, the names.
 */

export interface WaitingCounts {
  /** Open alignments on the branch. */
  alignments: number;
  /** Their decided live questions. */
  decided: number;
  /** All their live (not dropped) questions. */
  total: number;
  /** Their open (undecided) questions. */
  open: number;
  /** Open option cards: offer cards, or the Overseer's open cards. */
  cards: number;
}

export function waitingCounts(entries: readonly AlignEntry[], cards: number): WaitingCounts {
  const docs = entries.filter((e) => isOpenDoc(e.doc)).map((e) => e.doc);
  const total = docs.reduce((n, d) => n + liveCount(d), 0);
  const open = docs.reduce((n, d) => n + openCount(d), 0);
  return { alignments: docs.length, decided: total - open, total, open, cards };
}

/**
 * How the badge draws: not there (nothing to list), cards only (the track and the numeral),
 * faded (open alignments, nothing undecided, no card) or full.
 */
export type WaitingLook = "hidden" | "cards" | "faded" | "full";

export function waitingLook(c: WaitingCounts): WaitingLook {
  if (c.alignments === 0) return c.cards > 0 ? "cards" : "hidden";
  return c.open === 0 && c.cards === 0 ? "faded" : "full";
}

/** The ring: r 14, a 270° arc open at the bottom (the reference glyph's numbers). */
export const RING_R = 14;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;
export const RING_ARC = RING_CIRCUMFERENCE * 0.75;

/** The accent arc's length: decided / total of the ring's 270°; 0 with no questions. */
export function progressLength(c: Pick<WaitingCounts, "decided" | "total">): number {
  return c.total > 0 ? (Math.min(c.decided, c.total) / c.total) * RING_ARC : 0;
}

/** A dash array as the SVG takes it, to two decimals. */
export const dash = (len: number): string => `${len.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;

/** The middle number as drawn: the count, or "99+" above 99. */
export const countText = (n: number): string => (n > 99 ? "99+" : String(n));

/** The middle number's size in the glyph's units: 14, 11.5 for two digits, 9.2 for "99+". */
export const countSize = (n: number): number => (n > 99 ? 9.2 : n >= 10 ? 11.5 : 14);

/** Its baseline below the centre: 0.36 × its size, to one decimal. */
export const countY = (n: number): number => Math.round(countSize(n) * 3.6) / 10;

const NUMERALS = ["", "I", "II", "III", "IV"] as const;

/** The option cards' numeral: I, II, III, IV, then V+; "" at 0 (left out). */
export function cardNumeral(n: number): string {
  if (n <= 0) return "";
  return n < 5 ? NUMERALS[n]! : "V+";
}

/** The dots' x positions: one per open alignment, centred, 6 units apart (closer past 6, so they
    stay inside the ring's width). */
export function dotXs(n: number): number[] {
  if (n <= 0) return [];
  const gap = n > 6 ? 30 / (n - 1) : 6;
  return Array.from({ length: n }, (_, i) => Math.round((i - (n - 1) / 2) * gap * 100) / 100);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The badge's accessible name: "3 questions open in 2 alignments, 1 card waiting — show what's waiting". */
export function waitingLabel(c: WaitingCounts): string {
  const parts: string[] = [];
  if (c.alignments > 0) {
    const where = plural(c.alignments, "alignment");
    if (c.open > 0) parts.push(`${plural(c.open, "question")} open in ${where}`);
    else if (c.total > 0) parts.push(`All questions decided in ${where}`);
    else parts.push(`${where} open`);
  }
  if (c.cards > 0) parts.push(`${plural(c.cards, "card")} waiting`);
  return `${parts.join(", ")} — show what's waiting`;
}

/** The dialog's alignments: those with an open question first, each group the last touched first. */
export const waitingAlignments = (entries: readonly AlignEntry[]): AlignEntry[] => alignMenuRows(entries);

/** The topic of a document's next open question, in question order; undefined when none is open. */
export function nextOpenTopic(doc: Pick<AlignDocInfo, "questions">): string | undefined {
  return doc.questions.find((q) => questionStateOf(q) === "open")?.topic;
}

/** An alignment's line in the dialog: its meter's numbers and its next question's words. */
export function alignmentLine(doc: AlignDocInfo): { decided: number; live: number; next: string } {
  const live = liveCount(doc);
  const topic = nextOpenTopic(doc);
  return { decided: live - openCount(doc), live, next: topic ? `Next: ${topic}` : "All decided" };
}

/** Newest first, by the time each was shown (ISO strings sort as times). */
export function newestFirst<T extends { at?: string }>(cards: readonly T[]): T[] {
  return [...cards].map((c, i) => ({ c, i })).sort((a, b) => (b.c.at ?? "").localeCompare(a.c.at ?? "") || b.i - a.i).map((x) => x.c);
}

/** The dialog's title: "Waiting on you · 3". */
export const waitingTitle = (items: number): string => `Waiting on you · ${items}`;

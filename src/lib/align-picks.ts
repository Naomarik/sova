// Recommendations the user ticked on an alignment card (§chat.alignment/card), staged per session
// until the composer sends them. Nothing here writes alignment state: the ticks only compose an
// ordinary message, and the agent records it with its `align` tool.

import { createSignal } from "solid-js";
import type { AlignEntry } from "./align";
import { isOpenDoc, questionStateOf } from "./align";

/** One session's ticks: alignment id → question ids, each in the card's order. */
export type Picks = Readonly<Record<string, readonly string[]>>;

const NO_PICKS: Picks = {};

/** Ticks for a doc: on adds `q`, off removes it; a doc left with none goes. */
export function withPick(picks: Picks, doc: string, q: string, on: boolean): Picks {
  const cur = picks[doc] ?? [];
  if (cur.includes(q) === on) return picks;
  const next = on ? [...cur, q] : cur.filter((x) => x !== q);
  const { [doc]: _, ...rest } = picks;
  return next.length > 0 ? { ...rest, [doc]: next } : rest;
}

/**
 * The ticks that still apply: each doc must be on the branch and open, each question still open in
 * the doc's newest revision (a revision that settled q1 drops its tick). Docs keep the fold's
 * order, questions the card's.
 */
export function prunePicks(picks: Picks, entries: readonly AlignEntry[]): Picks {
  const out: Record<string, string[]> = {};
  for (const { doc } of entries) {
    const ticked = picks[doc.id];
    if (!ticked || !isOpenDoc(doc)) continue;
    const qs = doc.questions.filter((q) => questionStateOf(q) === "open" && ticked.includes(q.id)).map((q) => q.id);
    if (qs.length > 0) out[doc.id] = qs;
  }
  return out;
}

export const samePicks = (a: Picks, b: Picks): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k]?.join(" ") === b[k]?.join(" "));
};

export const pickCount = (picks: Picks): number => Object.values(picks).reduce((n, qs) => n + qs.length, 0);

/** "q1", "q1 and q3", "q1, q2 and q3". */
const series = (ids: readonly string[]): string => (ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);

/** The composer's staged row: "al_3 q1, q3; al_4 q2". */
export const picksLabel = (picks: Picks): string =>
  Object.entries(picks)
    .map(([doc, qs]) => `${doc} ${qs.join(", ")}`)
    .join("; ");

/**
 * What the ticks send, one line per alignment: "al_3: take your recommendation on q1 and q3." The
 * align tool's own wording for an accept of exactly these questions.
 */
export const picksMessage = (picks: Picks): string =>
  Object.entries(picks)
    .map(([doc, qs]) => `${doc}: take your recommendation on ${series(qs)}.`)
    .join("\n");

/** The ticks line, a blank line, then the typed text: one message. Either may be empty. */
export const composeWithPicks = (picks: Picks, text: string): string => [picksMessage(picks), text].filter((t) => t !== "").join("\n\n");

/**
 * The card's "Go With Recommendations": every question still open takes the recommendation, then
 * the go-ahead — the align tool's accept_all, then status implementing.
 */
export const acceptAllMessage = (doc: string): string => `${doc}: go with your recommendations for every open question, and go ahead.`;

// ---- The store: in memory per session path, like the drafts map; never persisted. ----------

const [picksByPath, setPicksByPath] = createSignal<Record<string, Picks>>({});

export const picksOf = (path: string): Picks => picksByPath()[path] ?? NO_PICKS;

export const setPicks = (path: string, picks: Picks) =>
  setPicksByPath((m) => {
    if (samePicks(m[path] ?? NO_PICKS, picks)) return m;
    const { [path]: _, ...rest } = m;
    return Object.keys(picks).length > 0 ? { ...rest, [path]: picks } : rest;
  });

export const togglePick = (path: string, doc: string, q: string, on: boolean) => setPicks(path, withPick(picksOf(path), doc, q, on));

/** Drops one doc's ticks, or the whole session's. */
export const clearPicks = (path: string, doc?: string) => {
  if (doc === undefined) return setPicks(path, NO_PICKS);
  const { [doc]: _, ...rest } = picksOf(path);
  setPicks(path, rest);
};

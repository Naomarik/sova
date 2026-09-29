// Answers the user picked on an alignment card (§chat.alignment/card) — a recommendation ticked or
// an option clicked — staged per session until the composer sends them. Nothing here writes
// alignment state: the picks only compose an ordinary message, and the agent records it with its
// `align` tool.

import { createSignal } from "solid-js";
import type { AlignQuestionInfo } from "../../shared/protocol";
import type { AlignEntry } from "./align";
import { isOpenDoc, optionLetter, questionStateOf, recommendedOption } from "./align";

/**
 * One question's staged answer: the recommendation (no option), or one of its options, kept with
 * the label it had when picked so an edit to that option drops the pick.
 */
export interface QPick {
  q: string;
  option?: { index: number; label: string };
}

/** One session's picks: alignment id → its questions' picks, at most one per question, in the card's order. */
export type Picks = Readonly<Record<string, readonly QPick[]>>;

const NO_PICKS: Picks = {};

/** A question's pick for option `index`: the option the recommendation names is the recommendation itself. */
export const optionPick = (q: Pick<AlignQuestionInfo, "id" | "options" | "recommendation">, index: number): QPick => {
  const label = q.options?.[index]?.label;
  return label === undefined || recommendedOption(q) === index ? { q: q.id } : { q: q.id, option: { index, label } };
};

const samePick = (a: QPick, b: QPick): boolean => a.q === b.q && a.option?.index === b.option?.index && a.option?.label === b.option?.label;

/** Sets a doc's pick for `q` (replacing any other on that question), or with null clears it; a doc left with none goes. */
export function withPick(picks: Picks, doc: string, q: string, pick: QPick | null): Picks {
  const cur = picks[doc] ?? [];
  const at = cur.findIndex((p) => p.q === q);
  if (pick === null ? at < 0 : at >= 0 && samePick(cur[at]!, pick)) return picks;
  const next = pick === null ? cur.filter((p) => p.q !== q) : at >= 0 ? cur.map((p, i) => (i === at ? pick : p)) : [...cur, pick];
  const { [doc]: _, ...rest } = picks;
  return next.length > 0 ? { ...rest, [doc]: next } : rest;
}

/**
 * The picks that still apply: each doc must be on the branch and open, each question still open in
 * the doc's newest revision (a revision that settled q1 drops its pick), and an option pick's option
 * still there under the same label; one the recommendation now names reads as the recommendation.
 * Docs keep the fold's order, questions the card's.
 */
export function prunePicks(picks: Picks, entries: readonly AlignEntry[]): Picks {
  const out: Record<string, QPick[]> = {};
  for (const { doc } of entries) {
    const staged = picks[doc.id];
    if (!staged || !isOpenDoc(doc)) continue;
    const kept: QPick[] = [];
    for (const q of doc.questions) {
      const p = staged.find((x) => x.q === q.id);
      if (!p || questionStateOf(q) !== "open") continue;
      if (!p.option) kept.push(p);
      else if (q.options?.[p.option.index]?.label === p.option.label) kept.push(optionPick(q, p.option.index));
    }
    if (kept.length > 0) out[doc.id] = kept;
  }
  return out;
}

export const samePicks = (a: Picks, b: Picks): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k]?.length === b[k]?.length && a[k]!.every((p, i) => samePick(p, b[k]![i]!)));
};

export const pickCount = (picks: Picks): number => Object.values(picks).reduce((n, ps) => n + ps.length, 0);

/** "q1", "q1 and q3", "q1, q2 and q3". */
const series = (ids: readonly string[]): string => (ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);

/** An option pick as the user would type it: "2b" (q2's option b). */
const shortAnswer = (p: QPick): string => `${p.q.replace(/^q/, "")}${p.option ? optionLetter(p.option.index) : ""}`;

/** The composer's staged row: "al_3 q1 rec, q2 b; al_4 q2 rec". */
export const picksLabel = (picks: Picks): string =>
  Object.entries(picks)
    .map(([doc, ps]) => `${doc} ${ps.map((p) => `${p.q} ${p.option ? optionLetter(p.option.index) : "rec"}`).join(", ")}`)
    .join("; ");

/**
 * What the picks send, one line per alignment: the recommendations taken, in the align tool's own
 * wording for an accept of exactly those questions, then the options picked, as the user would type
 * them with each option's label: "al_3: take your recommendation on q1 and q3. My answers: 2b —
 * Parquet; 4a — 1 per 10 min."
 */
export const picksMessage = (picks: Picks): string =>
  Object.entries(picks)
    .map(([doc, ps]) => {
      const recs = ps.filter((p) => !p.option).map((p) => p.q);
      const answers = ps.filter((p) => p.option).map((p) => `${shortAnswer(p)} — ${p.option!.label}`);
      const parts = [recs.length > 0 ? `take your recommendation on ${series(recs)}.` : "", answers.length > 0 ? `${recs.length > 0 ? "My" : "my"} answers: ${answers.join("; ")}.` : ""];
      return `${doc}: ${parts.filter((t) => t !== "").join(" ")}`;
    })
    .join("\n");

/** The picks line, a blank line, then the typed text: one message. Either may be empty. */
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

/** Stages `pick` for its question in `doc`, or with null clears that question's pick. */
export const choosePick = (path: string, doc: string, q: string, pick: QPick | null) => setPicks(path, withPick(picksOf(path), doc, q, pick));

/** Drops one doc's picks, or the whole session's. */
export const clearPicks = (path: string, doc?: string) => {
  if (doc === undefined) return setPicks(path, NO_PICKS);
  const { [doc]: _, ...rest } = picksOf(path);
  setPicks(path, rest);
};

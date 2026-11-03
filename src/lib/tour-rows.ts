import type { TranscriptItem } from "../../shared/protocol";
import { normalizeTourCardDetails, TOUR_TOOLS, type TourCardDetails } from "../../shared/tour";
import type { LiveTool } from "./live";
import { resultDetails, toolResultView } from "./message";

/**
 * One tour card per tour (§app.tours/one-card): every successful record_tour / show_tour call
 * names its tour, and only the newest call for each tour draws the full card; an earlier one is a
 * one-line tool row with what it reported then. A failed call names no tour, so it never takes or
 * hides the card.
 */
export interface TourFold {
  /** Call row id → the checked card its successful result carries. */
  rows: Map<string, TourCardDetails>;
  /** Tour id → the row id of its newest successful call. */
  newest: Map<string, string>;
}

/** The checked card a successful tour result carries, else undefined (a failure, a malformed result). */
export function tourResultCard(result: TranscriptItem | undefined): TourCardDetails | undefined {
  return result && !toolResultView(result).isError ? normalizeTourCardDetails(resultDetails(result)) : undefined;
}

/** Folds the settled rows: each successful tour call's card, and the newest call of each tour. */
export function tourFold(items: readonly TranscriptItem[]): TourFold {
  const results = new Map<string, TranscriptItem>();
  for (const it of items) if (it.kind === "tool-result" && it.toolCallId) results.set(it.toolCallId, it);
  const rows = new Map<string, TourCardDetails>();
  const newest = new Map<string, string>();
  for (const it of items) {
    if (it.kind !== "tool-call" || !it.toolCallId || !TOUR_TOOLS.has(it.text ?? "")) continue;
    const card = tourResultCard(results.get(it.toolCallId));
    if (!card) continue;
    rows.set(it.id, card);
    newest.set(card.tourId, it.id);
  }
  return { rows, newest };
}

/**
 * Row ids that draw the full tour card: the newest successful call of each tour, unless this
 * streaming run already finished a call for that tour (its live card is the newest then, and the
 * settled one reads as a line until the refetch).
 */
export function newestTourRows(items: readonly TranscriptItem[], liveTourIds?: ReadonlySet<string>): Set<string> {
  const { newest } = tourFold(items);
  return new Set([...newest].filter(([tourId]) => !liveTourIds?.has(tourId)).map(([, rowId]) => rowId));
}

/** This run's finished tour calls: tour id → the call id of its newest successful one (call order). */
export function liveTourCalls(tools: Readonly<Record<string, LiveTool>>): Map<string, string> {
  const newest = new Map<string, string>();
  for (const [callId, t] of Object.entries(tools)) {
    if (!TOUR_TOOLS.has(t.name) || t.status !== "done") continue;
    const card = normalizeTourCardDetails(t.details);
    if (card) newest.set(card.tourId, callId);
  }
  return newest;
}

/** An earlier call's one line, as the server writes a tour result's output: "A look at the app · 4 steps · queued". */
export const tourLine = (card: TourCardDetails): string => `${card.title} · ${card.steps} steps · ${card.status}`;

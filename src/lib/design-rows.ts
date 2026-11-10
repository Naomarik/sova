import type { TranscriptItem } from "../../shared/protocol";
import type { LiveTool } from "./live";
import { resultDetails, toolResultView } from "./message";

/** The tool whose result anchors a Lookbook card in the transcript. */
export const DESIGN_TOOL = "lookbook";

/** What a `lookbook` result carries when it stands for a card: only which run. */
export interface DesignCardDetails {
  runId: string;
}

export function normalizeDesignCard(details: unknown): DesignCardDetails | undefined {
  const card = details && typeof details === "object" ? (details as { designCard?: unknown }).designCard : undefined;
  const runId = card && typeof card === "object" ? (card as { runId?: unknown }).runId : undefined;
  return typeof runId === "string" && runId ? { runId } : undefined;
}

/**
 * One Design card per run, the same rule a tour card follows: every successful `design` call that
 * names a run may draw the card, and only the newest call for each run does. An earlier call, or one
 * that names no run (a read, a tell), is an ordinary tool row.
 */
export interface DesignFold {
  rows: Map<string, DesignCardDetails>;
  newest: Map<string, string>;
}

export function designFold(items: readonly TranscriptItem[]): DesignFold {
  const results = new Map<string, TranscriptItem>();
  for (const it of items) if (it.kind === "tool-result" && it.toolCallId) results.set(it.toolCallId, it);
  const rows = new Map<string, DesignCardDetails>();
  const newest = new Map<string, string>();
  for (const it of items) {
    if (it.kind !== "tool-call" || !it.toolCallId || it.text !== DESIGN_TOOL) continue;
    const result = results.get(it.toolCallId);
    const card = result && !toolResultView(result).isError ? normalizeDesignCard(resultDetails(result)) : undefined;
    if (!card) continue;
    rows.set(it.id, card);
    newest.set(card.runId, it.id);
  }
  return { rows, newest };
}

/** Rows that draw the card: each run's newest call, unless this streaming turn already finished a call for it. */
export function newestDesignRows(items: readonly TranscriptItem[], liveRuns?: ReadonlySet<string>): Set<string> {
  const { newest } = designFold(items);
  return new Set([...newest].filter(([runId]) => !liveRuns?.has(runId)).map(([, rowId]) => rowId));
}

/** This turn's finished design calls: run id → the call id of its newest. */
export function liveDesignCalls(tools: Readonly<Record<string, LiveTool>>): Map<string, string> {
  const newest = new Map<string, string>();
  for (const [callId, t] of Object.entries(tools)) {
    if (t.name !== DESIGN_TOOL || t.status !== "done") continue;
    const card = normalizeDesignCard(t.details);
    if (card) newest.set(card.runId, callId);
  }
  return newest;
}

// What a live event does besides the live store: the chat view's side effects, decided here as data
// and executed by ChatView's flush, so they can be tested and recorded apart from the view.
// applyEvent (live.ts) returns them from the same switch that applies the event to the store, so the
// event names are read in one place; these deciders take the event its arm already picked.

import { messageContextTokens } from "./context";
import { isObj } from "./message";
import { navigateDetails } from "./overseer";

/**
 * One side effect of a live event:
 * - "clearTurnError", "announceWorking": a fresh turn supersedes the last one's failure, and says so;
 * - `{context}`: the finished reply's context fill (no extra server push);
 * - "compacting" / "compactingDone": the compaction indicator on and off;
 * - "compacted": a compaction that wrote one made the fill stale until the next reply;
 * - `{navigate}`: the Overseer's navigate, applied once the batch is out;
 * - "settled": the run settled.
 */
export type LiveEffect =
  | "clearTurnError"
  | "announceWorking"
  | { context: number }
  | "compacting"
  | "compactingDone"
  | "compacted"
  | { navigate: string }
  | "settled";

export interface LiveEffectsContext {
  /** The view is the Overseer's chat. */
  overseer: boolean;
  /** This tab's message started the running turn (createTurnOwner's `mine()`, read at this event). */
  mine: boolean;
}

/** No view: nothing is the Overseer's, nothing is this tab's. */
export const NO_VIEW: LiveEffectsContext = { overseer: false, mine: false };

export const turnStartEffects = (): LiveEffect[] => ["clearTurnError", "announceWorking"];

/** A finished assistant message carries the final usage; one that measured nothing (an error, an
    abort, zero usage) leaves the fill alone (§chat.context-window/last-reply). */
export function replyEndEffects(message: unknown): LiveEffect[] {
  const tokens = messageContextTokens(message);
  return tokens !== null ? [{ context: tokens }] : [];
}

export const compactionStartEffects = (): LiveEffect[] => ["compacting"];

/** Only a compaction that WROTE one makes the fill stale; a failed or cancelled one (no `result`)
    left the context exactly as it was. */
export const compactionEndEffects = (ev: Record<string, unknown>): LiveEffect[] =>
  isObj(ev.result) ? ["compactingDone", "compacted"] : ["compactingDone"];

/** The Overseer's navigate: applied only in the tab whose message started this turn — never another
    tab's, never a proactive brief's (no tab sent it), never a replay (§app.overseer/navigation). */
export function toolEndEffects(ev: Record<string, unknown>, view: LiveEffectsContext): LiveEffect[] {
  if (!view.overseer || ev.toolName !== "sova_navigate" || ev.isError === true || !view.mine) return [];
  const nav = navigateDetails(isObj(ev.result) ? ev.result.details : undefined);
  return nav ? [{ navigate: nav.href }] : [];
}

export const settleEffects = (): LiveEffect[] => ["settled"];

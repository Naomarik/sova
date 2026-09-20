import type { TranscriptItem } from "../../shared/protocol";
import type { LiveBlock, LiveState } from "./live";
import { toolResultView } from "./message";

/** Which kinds a session hides: "Hide tool calls" and "Hide thinking", independent of each other. */
export interface HideKinds {
  tools: boolean;
  thinking: boolean;
}

/** A transcript split for the hide preferences: the rows that stay, and what the summary row stands for. */
export interface HiddenSplit {
  /** Every row neither preference hides, in order. Reports always stay. */
  shown: TranscriptItem[];
  /** Hidden rows, in order — a tool call and its result always go together. */
  hidden: TranscriptItem[];
  /** Index in `hidden` from which a call without a result may still be running (after the last user row). */
  openFrom: number;
  /** Cards the hidden rows make: each call, plus each result whose call is missing. */
  calls: number;
  /** Of those cards, how many ended in an error result. */
  failed: number;
  /** Hidden thinking rows. */
  thinking: number;
}

const isToolRow = (it: TranscriptItem) => it.kind === "tool-call" || it.kind === "tool-result";
const isHidden = (it: TranscriptItem, hide: HideKinds) => (hide.tools && isToolRow(it)) || (hide.thinking && it.kind === "thinking");

/** Counts the way `HistoryItems` renders: a paired result folds into its call's card, an orphan gets its own. */
export function splitHidden(items: TranscriptItem[], hide: HideKinds): HiddenSplit {
  const results = new Map<string, TranscriptItem>();
  const callIds = new Set<string>();
  for (const it of items) {
    if (it.kind === "tool-result" && it.toolCallId) results.set(it.toolCallId, it);
    if (it.kind === "tool-call" && it.toolCallId) callIds.add(it.toolCallId);
  }
  const failedResult = (r: TranscriptItem | undefined) => !!r && toolResultView(r.raw, r.text).isError;

  const shown: TranscriptItem[] = [];
  const hidden: TranscriptItem[] = [];
  let openFrom = 0;
  let calls = 0;
  let failed = 0;
  let thinking = 0;
  for (const it of items) {
    if (!isHidden(it, hide)) {
      shown.push(it);
      if (it.kind === "user") openFrom = hidden.length;
      continue;
    }
    hidden.push(it);
    if (it.kind === "thinking") thinking++;
    else if (it.kind === "tool-call") {
      calls++;
      if (it.toolCallId && failedResult(results.get(it.toolCallId))) failed++;
    } else if (!it.toolCallId || !callIds.has(it.toolCallId)) {
      calls++;
      if (failedResult(it)) failed++;
    }
  }
  return { shown, hidden, openFrom, calls, failed, thinking };
}

/** Whether a streaming block is one the preferences hide. */
export const isHiddenBlock = (b: LiveBlock | undefined, hide: HideKinds) =>
  !!b && ((hide.tools && b.type === "toolCall") || (hide.thinking && b.type === "thinking"));

/** The streaming turn's hidden blocks, counted from its blocks and, for tool calls, their live status. */
export function liveHiddenCounts(live: LiveState, hide: HideKinds): { calls: number; failed: number; running: number; thinking: number } {
  let calls = 0;
  let failed = 0;
  let running = 0;
  let thinking = 0;
  for (const e of live.entries) {
    if (e.kind !== "assistant") continue;
    for (const b of e.blocks) {
      if (!isHiddenBlock(b, hide)) continue;
      if (b.type === "thinking") {
        thinking++;
        continue;
      }
      if (b.type !== "toolCall") continue;
      calls++;
      const status = live.tools[b.id]?.status ?? (live.running ? "running" : undefined);
      if (status === "error") failed++;
      if (status === "running") running++;
    }
  }
  return { calls, failed, running, thinking };
}

/** "1 tool call hidden" / "12 tool calls hidden". */
export const toolsHiddenLabel = (calls: number) => `${calls} tool ${calls === 1 ? "call" : "calls"} hidden`;

/** "1 thinking block hidden" / "8 thinking blocks hidden". */
export const thinkingHiddenLabel = (blocks: number) => `${blocks} thinking ${blocks === 1 ? "block" : "blocks"} hidden`;

/** Rows the transcript renders, for the scroller's "N new": hidden rows aren't new to the reader. */
export const visibleCount = (items: TranscriptItem[], hide: HideKinds) =>
  hide.tools || hide.thinking ? items.filter((it) => !isHidden(it, hide)).length : items.length;

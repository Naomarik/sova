// Context-window fill for the session head. Mirrors the server's
// rule (server/transcript.ts contextForBranch): input + cacheRead + cacheWrite of the LAST
// assistant message on the branch that reports a context (not an error or aborted reply, not a
// zero usage); a compaction after it makes that stale → null.

import type { ContextInfo, TranscriptItem } from "../../shared/protocol";
import { rowFacts } from "../../shared/wire-v1";
import { isObj } from "./message";

/** Tokens in context for one assistant usage object, or null when there's no usage. */
export function usageTokens(usage: unknown): number | null {
  if (!isObj(usage)) return null;
  const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  return n("input") + n("cacheRead") + n("cacheWrite");
}

/**
 * Tokens in context as one assistant message reports them, or null when it says nothing about the
 * context: not an assistant message, no usage, an error or aborted reply, or a usage of zero (a
 * request that failed before the model read anything). Mirrors server/transcript.ts
 * messageContextTokens.
 */
export function messageContextTokens(message: unknown): number | null {
  if (!isObj(message) || message.role !== "assistant") return null;
  if (message.stopReason === "error" || message.stopReason === "aborted") return null;
  const tokens = usageTokens(message.usage);
  return tokens !== null && tokens > 0 ? tokens : null;
}

/**
 * Fill from normalized transcript items: each entry's facts ride its first row (`rowFacts`: `facts`,
 * or a wire-1 row's `meta`), so the other rows of a reply are skipped. `window` comes from the
 * server (the model's contextWindow), unknown → null.
 */
export function contextFromItems(items: TranscriptItem[], window: number | null): ContextState {
  for (let i = items.length - 1; i >= 0; i--) {
    const facts = rowFacts(items[i]!);
    if (!facts) continue;
    if (facts.resetsContext) return "compacted";
    if (facts.contextTokens !== undefined) return { tokens: facts.contextTokens, window };
  }
  return null;
}

/** What the head shows: a fill, "compacted" (null after a compaction row), or nothing yet. */
export type ContextState = ContextInfo | "compacted" | null;

/** The window of a state, when it has one. */
export const windowOf = (s: ContextState | undefined): number | null => (s && s !== "compacted" ? s.window : null);

/** Token counts per the context window spec: 812 · 8.4k · 237k · 1M · 1.5M. */
export function formatTokens(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trim(n / 1000)}k`;
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k}k`;
  return `${trim(n / 1_048_576 >= 1 && n % 1_048_576 === 0 ? n / 1_048_576 : n / 1_000_000)}M`;
}

/** floor(tokens / window × 100); "<1" when above 0 and under 1. */
export function formatPercent(tokens: number, window: number): string {
  const pct = (tokens / window) * 100;
  return pct > 0 && pct < 1 ? "<1" : String(Math.floor(pct));
}

/** Step class by the exact ratio: warn at 80%, error at 95%. */
export function contextStep(tokens: number, window: number | null): "" | "context-warn" | "context-error" {
  if (!window) return "";
  const r = tokens / window;
  return r >= 0.95 ? "context-error" : r >= 0.8 ? "context-warn" : "";
}

/** The exact sentence for the gauge's title and #context-desc. */
export function contextSentence(s: ContextInfo | "compacted"): string {
  if (s === "compacted") return "Context was compacted. The next reply reports the new size.";
  const t = s.tokens.toLocaleString("en-US");
  if (!s.window) return `Context: ${t} tokens, as of the last reply. This model's limit is unknown.`;
  return `Context: ${t} of ${s.window.toLocaleString("en-US")} tokens (${formatPercent(s.tokens, s.window)}%), as of the last reply.`;
}

/** The server reports null both before any reply and after a compaction; the items tell which. */
export const contextStateFor = (server: ContextInfo | null, items: TranscriptItem[]): ContextState =>
  server ?? (contextFromItems(items, null) === "compacted" ? "compacted" : null);

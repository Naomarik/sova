// pi's usage and context fill (§app.harness/reader): the rules Sova reads a pi session's spend and context
// size by, over raw entries (moved from server/transcript.ts, unchanged) and over HEntries. The only place
// outside pi-config's own tests meant to import pi-config/extensions/subagents/adapters/pi.ts: the worker
// adapter's accumulator and per-entry context rule are re-exported for the readers that move here (M2-C).
import type { HEntry } from "../../../shared/harness";

export { piContextOf, piUsage, piUsageAccumulator, type PiUsageAccumulator, type PiUsageOptions } from "../../../pi-config/extensions/subagents/adapters/pi.ts";

/** Context fill before the window lookup: tokens + the model ("provider/id") that produced them. */
export interface BranchContext {
  tokens: number;
  model: string | null;
}

/**
 * Tokens in context as one assistant message reports them (input + cacheRead + cacheWrite), or
 * null when it says nothing about the context: no usage, an error or aborted reply, or a usage of
 * zero (a request that failed before the model read anything). Mirrored by src/lib/context.ts
 * messageContextTokens.
 */
export function messageContextTokens(m: unknown): number | null {
  if (!m || typeof m !== "object") return null;
  const msg = m as Record<string, any>;
  if (msg.role !== "assistant" || msg.stopReason === "error" || msg.stopReason === "aborted") return null;
  const u = msg.usage;
  if (!u || typeof u !== "object") return null;
  const tokens = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
  return tokens > 0 ? tokens : null;
}

/**
 * Context fill = messageContextTokens of the LAST assistant message on the branch that reports
 * one; an error reply or a zero usage is passed over, so it never shows as an empty context. A
 * compaction after it makes that number stale, so we return null until the next reply.
 * The model is the assistant message's own provider/model, else the last model_change before it,
 * else the session's first model_change.
 */
export function contextForBranch(branch: Record<string, any>[]): BranchContext | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "compaction" || (e.type === "message" && e.message?.role === "compactionSummary")) return null;
    const m = e.type === "message" ? e.message : undefined;
    const tokens = messageContextTokens(m);
    if (tokens === null) continue;
    let model = m.provider && m.model ? `${m.provider}/${m.model}` : null;
    if (!model) {
      const change = branch.slice(0, i).reverse().find((x) => x.type === "model_change")
        ?? branch.find((x) => x.type === "model_change");
      if (change) model = `${change.provider}/${change.modelId}`;
    }
    return { tokens, model };
  }
  return null;
}

// ---- Over HEntries ---------------------------------------------------------------------------------

/** Whether an entry makes the context size before it stale: a compaction, or a compaction's summary. */
export function resetsContext(h: HEntry): boolean {
  return h.kind === "compaction" || (h.kind === "summary" && h.of === "compaction" && h.inMessage);
}

/** What one entry says about the context's size: an assistant reply's tokens, "compacted" for a reset,
    else null (piContextOf's rule). */
export function contextStep(h: HEntry): number | "compacted" | null {
  if (resetsContext(h)) return "compacted";
  return h.kind === "assistant" ? (h.contextTokens ?? null) : null;
}

/** contextForBranch's rule over HEntries: the same answer, byte for byte (`provider/modelId` of a model
    setting is formatted as written, `undefined` included). */
export function contextOfBranch(branch: readonly HEntry[]): BranchContext | null {
  const modelOf = (h: HEntry | undefined) => (h?.kind === "setting" && h.what === "model" ? `${h.provider}/${h.modelId}` : null);
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (resetsContext(h)) return null;
    if (h.kind !== "assistant" || h.contextTokens === undefined) continue;
    let model = h.provider && h.model ? `${h.provider}/${h.model}` : null;
    if (!model) {
      const isChange = (x: HEntry) => x.kind === "setting" && x.what === "model";
      model = modelOf(branch.slice(0, i).reverse().find(isChange) ?? branch.find(isChange));
    }
    return { tokens: h.contextTokens, model };
  }
  return null;
}

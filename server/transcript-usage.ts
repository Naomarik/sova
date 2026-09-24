import { claudeUsageAccumulator } from "../pi-config/extensions/claude-code/transcript-adapter.ts";
import { piUsageAccumulator } from "../pi-config/extensions/subagents/adapters/pi.ts";
import { parseLines } from "./transcript";

/**
 * Token counts of a transcript so far. Structurally the same as `TokenUsage` in
 * shared/protocol.ts; declared here so this module compiles on its own (it is the
 * only place the server derives usage from a file rather than from a live record).
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD, only when the transcript reports it (pi does; Claude Code's JSONL does not). */
  cost?: number;
}

/**
 * A per-connection running total. Feed it the same text `Normalize` gets: a
 * "snapshot" restarts the tally (the file was read from the top), an "append" adds
 * to it. Returns the total after that text, so the value is always cumulative.
 *
 * Both tallies are deduplicating and stateful on purpose: a Claude Code transcript
 * repeats one assistant message (same `message.id`, same usage) on several lines as
 * the turn is written, and those lines routinely straddle two appends.
 */
export type UsageTally = (text: string, part: "snapshot" | "append") => TokenUsage;

/** Zero is "nothing counted yet"; a total is only sent once something was. */
const spent = (u: TokenUsage): boolean => u.input + u.output + u.cacheRead + u.cacheWrite > 0;

/** The total as it goes on the wire, or undefined while the transcript has no usage at all. */
export function totalOf(u: TokenUsage): TokenUsage | undefined {
  if (!spent(u)) return undefined;
  const cost = u.cost && u.cost > 0 ? u.cost : undefined;
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, ...(cost === undefined ? {} : { cost }) };
}

/**
 * A tally over one of the worker-transcript protocol's usage accumulators — the same parse the
 * subagents extension and restored workers use (pi-config/extensions/subagents/adapters/pi.ts,
 * claude-code/transcript-adapter.ts), so a header ticking live and a worker rebuilt after a
 * restart can't count one file two ways.
 */
function tally(acc: { add(entries: readonly unknown[]): void; usage(): TokenUsage; reset(): void }): UsageTally {
  return (text, part) => {
    if (part === "snapshot") acc.reset();
    acc.add(parseLines(text));
    const u = acc.usage();
    return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost ?? 0 };
  };
}

/**
 * pi sessions: every assistant message's own `usage`, every top-level `usage` entry (pi 0.86.0+
 * work outside the conversation, e.g. kind "cache_warm"), and the usage a tool result, compaction
 * or branch summary carries — deduplicated by entry id. This is what the session has spent,
 * including branches a rewind later abandoned, unlike the context-fill number in transcript.ts,
 * which is the last message only. A forked session's copied history is not its spend and is
 * left out (the accumulator's fork boundary).
 */
export const piUsageTally = (): UsageTally => tally(piUsageAccumulator());

/**
 * Claude Code sessions: assistant lines deduplicated by `message.id`, which CC repeats across
 * lines with the same (already cumulative for that message) usage. Sidechain lines count too: a
 * worker's own Task agents are its spend. CC's JSONL carries no cost, so none is reported.
 */
export const claudeUsageTally = (): UsageTally => tally(claudeUsageAccumulator());

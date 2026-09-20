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

type Entry = Record<string, any>;

const amount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Zero is "nothing counted yet"; a total is only sent once something was. */
const spent = (u: TokenUsage): boolean => u.input + u.output + u.cacheRead + u.cacheWrite > 0;

/** The total as it goes on the wire, or undefined while the transcript has no usage at all. */
export function totalOf(u: TokenUsage): TokenUsage | undefined {
  if (!spent(u)) return undefined;
  const cost = u.cost && u.cost > 0 ? u.cost : undefined;
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, ...(cost === undefined ? {} : { cost }) };
}

function tally(add: (total: TokenUsage, entries: Entry[], seen: Set<string>) => void): UsageTally {
  let total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let seen = new Set<string>();
  return (text, part) => {
    if (part === "snapshot") {
      total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      seen = new Set<string>();
    }
    add(total, parseLines(text), seen);
    return { ...total };
  };
}

/**
 * pi sessions: every assistant message's own `usage`, entries deduplicated by id.
 * This is what the session has spent, including branches a rewind later abandoned —
 * unlike the context-fill number in transcript.ts, which is the last message only.
 */
export const piUsageTally = (): UsageTally =>
  tally((total, entries, seen) => {
    for (const e of entries) {
      if (e.type !== "message" || e.message?.role !== "assistant") continue;
      const u = e.message.usage;
      if (!u) continue;
      const id = typeof e.id === "string" ? e.id : undefined;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      total.input += amount(u.input);
      total.output += amount(u.output);
      total.cacheRead += amount(u.cacheRead);
      total.cacheWrite += amount(u.cacheWrite);
      total.cost = (total.cost ?? 0) + amount(u.cost?.total);
    }
  });

/**
 * Claude Code sessions: assistant lines deduplicated by `message.id`, which CC
 * repeats across lines with the same (already cumulative for that message) usage.
 * Sidechain lines count too: a worker's own Task agents are its spend. CC's JSONL
 * carries no cost, so none is reported.
 */
export const claudeUsageTally = (): UsageTally =>
  tally((total, entries, seen) => {
    for (const e of entries) {
      if (e.type !== "assistant") continue;
      const message = e.message;
      const u = message?.usage;
      if (!u) continue;
      const id = typeof message.id === "string" ? message.id : typeof e.uuid === "string" ? e.uuid : undefined;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      total.input += amount(u.input_tokens);
      total.output += amount(u.output_tokens);
      total.cacheRead += amount(u.cache_read_input_tokens);
      total.cacheWrite += amount(u.cache_creation_input_tokens);
    }
  });

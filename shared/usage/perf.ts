// Measured reply timing's wire contract: one reply's timings (the reply hover, a transcript row's
// `reply` fact and a live reply's `message.end`), and the Performance tab's answer. Types, constants
// and pure rules only: the browser and the usage helper apply the same speed rule from here.
//
// Routes (main listener only, relayed unparsed from the usage helper, like shared/usage/wire.ts):
//   GET /api/usage/performance?range=7d|30d|all[&provider=<p>]…[&model=<p>/<m>]…&tz=<zone> -> UsagePerformance
// The helper not running: 503 `{error: "usage-unavailable"}`; a bad parameter: 400 `{error}`.

import type { ReplyTiming } from "../harness-wire";
import type { UsageDevice, UsageRange } from "./wire";

/** One finished reply's measurement (defined with the wire it travels on, shared/harness-wire.ts). */
export type { ReplyTiming };

/** A speed counts only when its part produced at least this many tokens… */
export const PERF_MIN_TOKENS = 100;
/** …over at least this long (ms). Times (first token, thinking time) always count. */
export const PERF_MIN_MS = 1000;
/** A figure resting on fewer replies shows its median and count, no range and no chart. */
export const PERF_MIN_RANGE = 5;
/** At most this many histogram bins. */
export const PERF_BINS = 12;

/** Why a figure can't be had (PerfFigure.unsupported). */
export const PERF_NO_SPLIT = "Provider doesn't count thinking tokens";
export const PERF_ALL_TOOLS = "Every reply wrote tool calls";

const speed = (tokens: number, ms: number): number | undefined => (tokens >= PERF_MIN_TOKENS && ms >= PERF_MIN_MS ? tokens / (ms / 1000) : undefined);

/** The reply thought: it wrote a thinking part, however short its window (a part's characters can all
    arrive in one chunk; Claude's hidden thinking can end in the tick it starts). */
export const didThink = (t: ReplyTiming): boolean => (t.thinkingParts ?? 0) > 0 || t.thinkingMs > 0;

/** Reply-text tokens, where the split is real: no tool calls (their argument tokens are output too),
    and the reply didn't think (every token is reply) or the provider counted the thinking ones. */
export function replyTokens(t: ReplyTiming): number | undefined {
  if ((t.toolCalls ?? 0) > 0) return undefined;
  if (t.reasoning !== undefined) return Math.max(0, t.output - t.reasoning);
  return didThink(t) ? undefined : t.output;
}

/**
 * A reply's speeds (tokens per second), each only where its part has >= PERF_MIN_TOKENS tokens over
 * >= PERF_MIN_MS: overall = every output token over thinking + text + tool-call writing time; reply =
 * reply-text tokens over reply time (only where the split is real: no tool calls, thinking absent or
 * counted); thinking = thinking tokens over thinking time (only
 * where the provider counted them).
 */
export function replySpeeds(t: ReplyTiming): { overall?: number; reply?: number; thinking?: number } {
  const out: { overall?: number; reply?: number; thinking?: number } = {};
  const overall = speed(t.output, t.thinkingMs + t.replyMs);
  if (overall !== undefined) out.overall = overall;
  const rt = replyTokens(t);
  const reply = rt === undefined ? undefined : speed(rt, t.replyMs);
  if (reply !== undefined) out.reply = reply;
  const thinking = t.reasoning === undefined ? undefined : speed(t.reasoning, t.thinkingMs);
  if (thinking !== undefined) out.thinking = thinking;
  return out;
}

/** One histogram bin: values in [lo, hi) (the last bin includes hi). */
export interface PerfBin {
  lo: number;
  hi: number;
  n: number;
}

/**
 * One figure over a group's replies. Speeds are tokens per second, times ms. `n` is the replies it
 * rests on. Under PERF_MIN_RANGE replies only `median` (and `mean`) are given. `unsupported` (with
 * n 0): no reply in the group could give this figure at all, and why.
 */
export interface PerfFigure {
  n: number;
  median?: number;
  mean?: number;
  p10?: number;
  p90?: number;
  /** Log-spaced, at most PERF_BINS, oldest-free: lowest first. An effort level's are its model's
      bands (some may be empty), so its bars line up on the model's axis. */
  bins?: PerfBin[];
  unsupported?: string;
}

/** A group's figures: one provider+model, or one of its effort levels. */
export interface PerfFigures {
  /** Replies measured. */
  replies: number;
  /** Of those, the replies that thought (a thinking window > 0). */
  thought: number;
  /** Every output token over thinking + reply time (tok/s). */
  overall: PerfFigure;
  /** Reply-text speed (tok/s), where the split is real. */
  reply: PerfFigure;
  /** Thinking speed (tok/s), where the provider counts thinking tokens. */
  thinkingTps: PerfFigure;
  /** Thinking time per reply (ms), over the replies that thought only. */
  thinkingMs: PerfFigure;
  /** Thinking tokens per reply, over the replies that thought and were counted. */
  thinkingTokens: PerfFigure;
  /** Wait for the first token (ms). */
  ttft: PerfFigure;
}

export interface PerfEffortRow extends PerfFigures {
  /** The level that ran ("off" when none, "unknown" when not recorded). */
  effort: string;
}

export interface PerfModelRow extends PerfFigures {
  provider: string;
  /** As the Costs tab's rows name it (a Claude catalog id for Claude models). */
  model: string;
  /** One row per effort level seen, in level order (off, minimal, low, medium, high, xhigh, then others). */
  efforts: PerfEffortRow[];
}

/** GET /api/usage/performance: the Agents page's Performance tab. */
export interface UsagePerformance {
  device: UsageDevice;
  range: UsageRange;
  /** ms: when the helper answered. */
  asOf: number;
  /** ISO time of the first measured reply on this device, or null when none was measured yet. */
  since: string | null;
  /** The filter as applied. */
  providers: string[];
  models: string[];
  /** Every provider and model with measured replies in the range, ignoring the filter. */
  facets: { providers: string[]; models: { provider: string; model: string }[] };
  /** Most replies first. */
  rows: PerfModelRow[];
}

/** Effort levels in the order rows list them. */
export const PERF_EFFORT_ORDER: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

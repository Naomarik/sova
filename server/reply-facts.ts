// A session's measured replies for its rows' `reply` fact (shared/harness-wire.ts RowFacts,
// shared/usage/perf.ts ReplyTiming): asked of the usage helper (`session-timings`) once per transcript
// load. The helper not running, or a session with nothing measured, gives none: its rows look as
// they always did.
import { basename } from "node:path";
import type { ReplyTiming } from "../shared/usage/perf";
import { askUsage } from "./usage-helper/client";
import type { ReplyLookup } from "./wire-rows";

/** A session's measured replies: `v` changes whenever they do (a cache key), `get` by entry id. */
export interface ReplyTimings {
  v: string;
  get: ReplyLookup;
}

/** Session id from a session file name (`<ts>_<id>.jsonl`). */
export function sessionIdOfPath(path: string): string {
  const b = basename(path, ".jsonl");
  const i = b.indexOf("_");
  return i >= 0 ? b.slice(i + 1) : b;
}

/** The measured replies of session `sid`, or null when there are none or the helper can't say. */
export async function replyTimingsOf(sid: string): Promise<ReplyTimings | null> {
  if (!sid) return null;
  try {
    const a = await askUsage("session-timings", { sid });
    if (a.status !== 200) return null;
    const body = JSON.parse(a.body.toString("utf8")) as { v?: unknown; timings?: Record<string, ReplyTiming> };
    const timings = body.timings && typeof body.timings === "object" ? body.timings : {};
    if (!Object.keys(timings).length) return null;
    return { v: String(body.v ?? ""), get: (entryId) => (Object.hasOwn(timings, entryId) ? timings[entryId] : undefined) };
  } catch {
    return null;
  }
}

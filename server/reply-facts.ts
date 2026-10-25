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

/** A session's measured replies as data (the helper's `session-timings` answer; a chat's ask carries it). */
export interface SessionReplyTimings {
  v: string;
  timings: Record<string, ReplyTiming>;
}

/** Ask the usage helper (the server's process only) for session `sid`'s measured replies; null when
    there are none or the helper can't say. */
export async function fetchSessionTimings(sid: string): Promise<SessionReplyTimings | null> {
  if (!sid) return null;
  try {
    const a = await askUsage("session-timings", { sid });
    if (a.status !== 200) return null;
    const body = JSON.parse(a.body.toString("utf8")) as { v?: unknown; timings?: unknown };
    const timings = body.timings && typeof body.timings === "object" && !Array.isArray(body.timings) ? (body.timings as Record<string, ReplyTiming>) : {};
    return Object.keys(timings).length ? { v: String(body.v ?? ""), timings } : null;
  } catch {
    return null;
  }
}

/** The lookup over a session's measured replies. */
export function lookupOf(data: SessionReplyTimings | null | undefined): ReplyTimings | null {
  if (!data || !data.timings || !Object.keys(data.timings).length) return null;
  const { timings } = data;
  return { v: String(data.v ?? ""), get: (entryId) => (Object.hasOwn(timings, entryId) ? timings[entryId] : undefined) };
}

/** Where a process gets a session's measured replies: the server asks its helper; a chat process
    asks the server (server/chat-runtime/host.ts sets the `reply.timings` ask). */
type Source = (sid: string) => Promise<SessionReplyTimings | null>;
let source: Source = fetchSessionTimings;
export function setReplyTimingsSource(fn: Source | null): void {
  source = fn ?? fetchSessionTimings;
}

/** The measured replies of session `sid`, or null when there are none or nobody can say. In a chat
    process: one ask to the server. */
export async function replyTimingsOf(sid: string): Promise<ReplyTimings | null> {
  if (!sid) return null;
  try {
    return lookupOf(await source(sid));
  } catch {
    return null;
  }
}

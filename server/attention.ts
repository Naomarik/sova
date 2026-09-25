import { homedir } from "node:os";
import type { AttentionDigest, AttentionItem, AttentionKind, AttentionTier, SessionSummary } from "../shared/protocol";

/**
 * The Overseer's attention digest: what needs the user, what finished, what is running — built
 * from data the server already has (the session list with its live-record activity, held-chat
 * state, the seen store), with no model call and no transcript read. It feeds the entry button's
 * badge, GET /api/overseer/attention, the sova_attention tool and "Brief me".
 *
 * `buildDigest` is pure: the caller gathers one AttentionRow per session.
 */

/** One session plus the facts the list does not carry. */
export interface AttentionRow {
  summary: SessionSummary;
  /** Titles of live-pending dialogs of a hosted chat (a browser is attached and can answer). */
  dialogs: string[];
  /** Items waiting in the hosted chat's outgoing queue. */
  queued: number;
  /** Subagent workers that ended in an error (presence.workerCounts.error). */
  failedWorkers: number;
  /** ms epoch of the latest worker error (see workerErrorTime); undefined unknown. */
  workerErrorAt?: number;
  /** A pane has the session on screen right now (seen.ts isViewing). */
  viewing?: boolean;
  /** ms epoch the live record's activity state began; 0 unknown. */
  activitySince: number;
  /** ms epoch of the last assistant reply; undefined unknown. */
  lastReplyAt?: number;
}

export const DIGEST_MAX = 30;
export const STALE_MS = 3 * 86_400_000;
export const CONTEXT_FULL = 0.85;
const DETAIL_MAX = 200;
const TIER_ORDER: Record<AttentionTier, number> = { act: 0, decide: 1, fyi: 2 };

const cap = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX - 1)}…` : t;
};

/** Where a session runs, as a person reads it: `target:/remote/path`, or the cwd with ~ for home. */
export function whereOf(s: Pick<SessionSummary, "cwd" | "target" | "remoteCwd">, home = homedir()): string {
  if (s.target) return `${s.target}:${s.remoteCwd ?? ""}`;
  return home && (s.cwd === home || s.cwd.startsWith(`${home}/`)) ? `~${s.cwd.slice(home.length)}` : s.cwd;
}

/** The items one session contributes, most urgent first. */
export function sessionItems(row: AttentionRow, now: number, home?: string): AttentionItem[] {
  const s = row.summary;
  if (s.overseer || s.workerSession) return [];
  const out: AttentionItem[] = [];
  const lastActive = Date.parse(s.lastActiveAt) || 0;
  const base = {
    id: s.id,
    path: s.path,
    title: s.title,
    where: whereOf(s, home),
    href: `#/s/${encodeURIComponent(s.path)}`,
    ...(s.live ? { tuiLive: true as const } : {}),
  };
  const add = (tier: AttentionTier, kind: AttentionKind, since: number, detail?: string) =>
    out.push({ ...base, tier, kind, since, ...(detail ? { detail: cap(detail) } : {}) });
  const state = s.activity?.state;
  const running = s.busy || state === "working";

  // act: blocked on the user.
  if (row.dialogs.length) add("act", "needs-input", row.activitySince || lastActive, `Waiting on: ${row.dialogs.join("; ")}`);
  else if (state === "needs-input")
    add("act", "needs-input", row.activitySince || lastActive, s.live ? "Waiting on a dialog in the terminal." : "Waiting on a dialog.");
  if (state === "error") add("act", "error", row.activitySince || lastActive, s.activity?.error ?? "The last turn stopped with an error.");
  // A worker error is acknowledged once the user has had the session in front of them after it
  // (the seen stamp is at or past the error, or a pane shows it now). A never-stamped session or an
  // error of unknown time is not acknowledged: a blocker errs on the side of showing.
  const errorSeen =
    row.viewing === true || (s.seenAt !== undefined && row.workerErrorAt !== undefined && s.seenAt >= row.workerErrorAt);
  if (row.failedWorkers > 0 && !errorSeen)
    add("act", "worker-error", lastActive, `${row.failedWorkers} subagent${row.failedWorkers === 1 ? "" : "s"} ended in an error.`);
  // An archived session is out of the user's way on purpose: only a blocker brings it back.
  if (s.archived) return out;

  // decide: finished work to look at, input left behind.
  if (s.unread) add("decide", "finished", row.lastReplyAt ?? lastActive, s.outlineNow ?? s.outlineGist);
  if (!running && s.hasDraft) add("decide", "draft", lastActive, s.draftPreview ? `Unsent draft: ${s.draftPreview}` : "Unsent draft.");
  if (!running && row.queued > 0) add("decide", "queued", lastActive, `${row.queued} queued message${row.queued === 1 ? "" : "s"} not sent yet.`);

  // fyi: running, nearly full, stale.
  const workers = s.workers?.working ?? s.live?.workers?.working ?? 0;
  if (running || workers > 0) {
    const w = workers > 0 ? `${workers} subagent${workers === 1 ? "" : "s"} working. ` : "";
    add("fyi", "working", row.activitySince || lastActive, `${w}${s.outlineNow ?? ""}`.trim() || undefined);
  }
  const ctx = s.context;
  if (ctx?.window && ctx.tokens / ctx.window >= CONTEXT_FULL)
    add("fyi", "context-full", lastActive, `Context ${Math.round((ctx.tokens / ctx.window) * 100)}% full.`);
  if (s.origin === "web" && !s.live && !running && !s.hasDraft && !s.unread && now - lastActive > STALE_MS)
    add("fyi", "stale", lastActive, `Idle for ${Math.floor((now - lastActive) / 86_400_000)} days.`);
  return out;
}

/**
 * The digest: every session's items, tier first, then newest first; `counts` cover everything,
 * `items` ≤30. `badge` counts SESSIONS, not items, and each session once, at its most urgent tier:
 * a session with a dialog and an error is one "needs you", not two.
 */
export function buildDigest(rows: AttentionRow[], now = Date.now(), home?: string): AttentionDigest & { badge: { act: number; decide: number } } {
  const badge = { act: 0, decide: 0 };
  const all: AttentionItem[] = [];
  for (const r of rows) {
    const items = sessionItems(r, now, home);
    if (items.some((i) => i.tier === "act")) badge.act++;
    else if (items.some((i) => i.tier === "decide")) badge.decide++;
    all.push(...items);
  }
  all.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.since - a.since);
  const counts = { act: 0, decide: 0, fyi: 0 };
  for (const it of all) counts[it.tier]++;
  return { generatedAt: now, counts, items: all.slice(0, DIGEST_MAX), badge };
}

/**
 * When a session's latest worker error happened. `rowTimes` are the error rows' own times
 * (live.ts workerErrorTimesOf); when they cover every failed worker, their latest is the answer.
 * Rows can be dropped for size, so when they cover fewer, `risenAt` (when the caller last saw the
 * failed count rise, or first saw it at all) stands in for the missing ones: the later of the two.
 */
export function workerErrorTime(failed: number, rowTimes: number[], risenAt?: number): number | undefined {
  if (failed <= 0) return undefined;
  const latest = rowTimes.length ? Math.max(...rowTimes) : undefined;
  if (rowTimes.length >= failed) return latest;
  const t = Math.max(latest ?? 0, risenAt ?? 0);
  return t > 0 ? t : undefined;
}

/** A stable key per blocker, for "Brief me": a NEW key is a new blocker. */
export const blockerKey = (it: AttentionItem) => `${it.id}:${it.kind}`;

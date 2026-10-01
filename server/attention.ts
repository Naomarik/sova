import { homedir } from "node:os";
import type { AttentionDigest, AttentionItem, AttentionKind, AttentionTier, SessionSummary } from "../shared/protocol";
import { readinessItems } from "./merge-readiness";
import { sessionName } from "./session-names";

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
  /** Words for the decision-signal items (signals-store.ts signalTextOf): the reply's asking
      sentence, and the names of subagents that look stuck. Absent: the fixed fallbacks. */
  signalText?: { sentence?: string; stuckWorkers: string[] };
  /** The session waits on subagents that have all gone quiet (signals-store.ts teamStallOf,
      §app.decisions/team-stall): since when, and who. Absent: not stalled, or the feature is off. */
  teamStall?: { since: number; names: string[] };
  /** The user's alias for the session (§app.overseer/session-names), when it has one. */
  alias?: string;
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

/** "3 open questions in al_3 Autonomy settings" (one alignment asks) / "… in 2 alignments". */
export function openQuestionsText(a: NonNullable<SessionSummary["align"]>): string {
  const n = `${a.openQuestions} open question${a.openQuestions === 1 ? "" : "s"}`;
  if (a.questionDocs === 1 && a.lead) return `${n} in ${a.lead.id} ${a.lead.title}`;
  return `${n} in ${a.questionDocs} alignments`;
}

/** The session's branch is merged: its readiness badge is merged or restart pending (§chat.worktrees/readiness). */
export const mergedBranch = (s: Pick<SessionSummary, "readiness">): boolean => s.readiness?.badge === "merged" || s.readiness?.badge === "restart";

/** The items one session contributes, most urgent first. */
export function sessionItems(row: AttentionRow, now: number, home?: string): AttentionItem[] {
  const s = row.summary;
  if (s.overseer || s.projectOverseer || s.workerSession) return [];
  const out: AttentionItem[] = [];
  const lastActive = Date.parse(s.lastActiveAt) || 0;
  const base = {
    id: s.id,
    path: s.path,
    title: s.title,
    name: sessionName(s, row.alias),
    where: whereOf(s, home),
    href: `#/s/${encodeURIComponent(s.path)}`,
    ...(s.live ? { tuiLive: true as const } : {}),
    // The sidebar lists an org session's items in the Organizations region's own Needs you.
    ...(s.org ? { org: { orgId: s.org.orgId, orgName: s.org.orgName, ...(s.org.projectId ? { projectId: s.org.projectId } : {}), ...(s.org.projectName !== undefined ? { projectName: s.org.projectName } : {}) } } : {}),
  };
  const add = (tier: AttentionTier, kind: AttentionKind, since: number, detail?: string) =>
    out.push({ ...base, tier, kind, since, ...(detail ? { detail: cap(detail) } : {}) });
  const state = s.activity?.state;
  const running = s.busy || state === "working";

  // act: blocked on the user.
  // A baton session (§app.baton/needs-you): the baton is with the operator, or a person holds it
  // through a hand-off nobody has a link for yet.
  if (s.baton?.needsYou) add("act", "baton-needs-you", s.baton.needsYou.since || lastActive, `${s.baton.needsYou.from} → you: ${s.baton.needsYou.question}`);
  else if (s.baton?.sendLink) {
    add("act", "baton-needs-you", s.baton.sendLink.since || lastActive, `Send ${s.baton.sendLink.to} their link: ${s.baton.sendLink.question}`);
    // r12: the offer's invitees still waiting for their hours ride on it (they need nothing yet).
    if (s.baton.waiting?.length) out[out.length - 1]!.waiting = s.baton.waiting;
  }
  // decide: a referral from this session waits for the operator (§app.organizations/referrals).
  for (const p of s.baton?.proposals ?? [])
    add("decide", "roster-proposal", p.since || lastActive, `Approve ${p.name}${p.role ? ` (${p.role})` : ""}${p.by ? ` proposed by ${p.by}` : ""}?`);
  if (row.dialogs.length) add("act", "needs-input", row.activitySince || lastActive, `Waiting on: ${row.dialogs.join("; ")}`);
  else if (state === "needs-input")
    add("act", "needs-input", row.activitySince || lastActive, s.live ? "Waiting on a dialog in the terminal." : "Waiting on a dialog.");
  // An errored turn: the file's last finished reply (turnError, already seen-gated by the list),
  // else a live record's error state. One item either way.
  if (s.turnError || state === "error") {
    const message = s.turnError?.message ?? (state === "error" ? s.activity?.error : undefined);
    const since = s.turnError ? row.lastReplyAt ?? lastActive : row.activitySince || lastActive;
    add("act", "error", since, message ?? "The last turn stopped with an error.");
  }
  // A worker error is acknowledged once the user has had the session in front of them after it
  // (the seen stamp is at or past the error, or a pane shows it now). A never-stamped session or an
  // error of unknown time is not acknowledged: a blocker errs on the side of showing. The session
  // finishing a turn after the error deals with it too: its last finished reply is later, so the
  // failure (the worker's report) was in front of it.
  const errorSeen =
    row.viewing === true ||
    (row.workerErrorAt !== undefined && ((s.seenAt !== undefined && s.seenAt >= row.workerErrorAt) || (row.lastReplyAt !== undefined && row.lastReplyAt > row.workerErrorAt)));
  if (row.failedWorkers > 0 && !errorSeen)
    add("act", "worker-error", lastActive, `${row.failedWorkers} subagent${row.failedWorkers === 1 ? "" : "s"} ended in an error.`);
  // Open alignment questions (§chat.alignment/session-mark): a fact of the file, no model. Waiting
  // on the user only while nothing runs; an archived session is out of the way on purpose. A merged
  // branch (readiness from git) has moved on: the questions stay visible as a decide item, never a
  // blocker, a brief or a push.
  const questions = !!s.align && s.align.openQuestions > 0 && !running && !s.archived;
  if (questions && mergedBranch(s)) add("decide", "open-questions", row.lastReplyAt ?? lastActive, `Merged with ${openQuestionsText(s.align!)}`);
  else if (questions) add("act", "open-questions", row.lastReplyAt ?? lastActive, openQuestionsText(s.align!));
  // Decision signals (server/signals-store.ts): the list carries them only while unseen and idle,
  // with the kinds already derived from the fixed thresholds. They are guesses, so never blockers
  // (§app.overseer/attention-digest): a reply that seems to ask the user something is a decide
  // item — a row mark and a digest line — unless open questions already say so
  // (§app.decisions/asks-user). "looping" is a judgement call (decide), a subagent's too: the user
  // acts through the parent session, and a subagent counts only after two looping checks in a row.
  const sig = s.signals?.kinds ?? [];
  const at = s.signals?.at ?? lastActive;
  const asks = sig.includes("asks-you") && !questions && !s.archived;
  if (asks) {
    const sentence = row.signalText?.sentence;
    add("decide", "asks-you", at, sentence ? `Asks you: ${sentence}` : "The last reply asks you something.");
  }
  // A stalled team (counted in code, §app.decisions/team-stall): a decide item, only when the
  // session is not already waiting on the user. Never Needs you, a brief or a notification.
  const stall = row.teamStall;
  if (stall && !questions && !asks && !running && !s.archived) {
    const who = stall.names.length > 3 ? `${stall.names.slice(0, 3).join(", ")} and ${stall.names.length - 3} more` : stall.names.join(", ");
    add("decide", "team-stalled", stall.since, `Waiting on ${who}, quiet for ${Math.max(1, Math.round((now - stall.since) / 60_000))} min.`);
  }
  const ws = s.workerSignals;
  if (ws?.stuck) {
    const names = row.signalText?.stuckWorkers ?? [];
    const who = names.length === 1 ? `A subagent looks stuck: ${names[0]}.` : names.length > 1 ? `Subagents look stuck: ${names.join(", ")}.` : ws.stuck === 1 ? "A subagent looks stuck." : `${ws.stuck} subagents look stuck.`;
    add("decide", "looping", at, sig.includes("looping") ? `${who} The last turn looks like it went in circles too.` : who);
  } else if (sig.includes("looping")) add("decide", "looping", at, "The last turn looks like it went in circles.");
  // An archived session is out of the user's way on purpose: only a blocker brings it back.
  if (s.archived) return out;

  // decide: finished work to look at, input left behind.
  if (s.unread) add("decide", "finished", row.lastReplyAt ?? lastActive, s.outlineNow ?? s.outlineGist);
  if (!running && s.hasDraft) add("decide", "draft", lastActive, s.draftPreview ? `Unsent draft: ${s.draftPreview}` : "Unsent draft.");
  if (!running && row.queued > 0) add("decide", "queued", lastActive, `${row.queued} queued message${row.queued === 1 ? "" : "s"} not sent yet.`);
  // Merge readiness (server/merge-readiness.ts): a branch ready or waiting on the go-ahead, a merge with open work.
  for (const it of readinessItems(s)) add(it.tier, it.kind, it.since, it.detail);

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
export function buildDigest(rows: AttentionRow[], now = Date.now(), home?: string, extra: AttentionItem[] = []): AttentionDigest & { badge: { act: number; decide: number } } {
  const badge = { act: 0, decide: 0 };
  // Items of no session (an org project's missing main stakeholder): each counts once in the badge.
  const all: AttentionItem[] = [...extra];
  for (const it of extra) if (it.tier === "act") badge.act++;
  else if (it.tier === "decide") badge.decide++;
  for (const r of rows) {
    const items = sessionItems(r, now, home);
    if (items.some((i) => i.tier === "act")) badge.act++;
    else if (items.some((i) => i.tier === "decide")) badge.decide++;
    all.push(...items);
  }
  all.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.since - a.since);
  const counts = { act: 0, decide: 0, fyi: 0 };
  for (const it of all) counts[it.tier]++;
  return { generatedAt: now, counts, items: capKeepingKinds(all), badge };
}

/**
 * The first DIGEST_MAX of `sorted`, except that every kind present keeps its first (most urgent,
 * newest) item: each one missing takes the place of the last kept item whose kind stays
 * represented without it, so a flood of one kind never hides another. Order is kept.
 */
function capKeepingKinds(sorted: AttentionItem[]): AttentionItem[] {
  const kept = sorted.slice(0, DIGEST_MAX);
  const perKind = new Map<AttentionKind, number>();
  for (const it of kept) perKind.set(it.kind, (perKind.get(it.kind) ?? 0) + 1);
  const missing = new Map<AttentionKind, AttentionItem>();
  for (const it of sorted.slice(DIGEST_MAX)) if (!perKind.has(it.kind) && !missing.has(it.kind)) missing.set(it.kind, it);
  if (!missing.size) return kept;
  const out = new Set(kept);
  for (const it of missing.values()) {
    const drop = [...out].reverse().find((k) => (perKind.get(k.kind) ?? 0) > 1);
    if (!drop) break;
    out.delete(drop);
    perKind.set(drop.kind, perKind.get(drop.kind)! - 1);
    out.add(it);
    perKind.set(it.kind, 1);
  }
  return sorted.filter((it) => out.has(it));
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
export const blockerKey = (it: Pick<AttentionItem, "id" | "kind">) => `${it.id}:${it.kind}`;

/** The count a blocker carries, for "Brief me" (§app.overseer/brief-repeat): an open-questions item's
    open questions, a worker-error item's failed subagents, read back from the detail sessionItems
    writes ("3 open questions in …", "2 subagents ended in an error."); 1 for every other kind. */
export function blockerCount(it: Pick<AttentionItem, "kind" | "detail">): number {
  if (it.kind !== "open-questions" && it.kind !== "worker-error") return 1;
  const m = /^(?:Merged with )?(\d+) /.exec(it.detail ?? "");
  return m ? Number(m[1]) : 1;
}

// The Agents board (#/agents): one row per session, its workers, team and worktrees folded inside.
// Everything here is pure — which rows a scope or filter shows, how they sort, what the head
// totals say, and the words a worktree reading turns into — so it runs under `tsx --test`.

import type { AgentsInsight, LiveAgentSession, SessionSummary, TeamInfo, WorkerInfo, WorktreeStatus } from "../../shared/protocol";
import { SESSION_TITLE_MAX } from "../../shared/protocol";
import { teamKey } from "./insights";
import { isMainThread, isTopSession } from "./regions";
import { rowNeedsYou } from "./signals";
import { summaryLineOf } from "./summary-row";
import { isHostSession, sessionWorking } from "./workers";

/** A row's one state, which is what its rail and chip say. */
export type BoardState = "working" | "needs-you" | "idle" | "archived";

/** The filter chips, in bar order. No chip is the default scope. */
export type BoardFilter = "live" | "needs-you" | "has-workers" | "unmerged" | "archived";
export const BOARD_FILTERS: readonly { id: BoardFilter; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "needs-you", label: "Needs you" },
  { id: "has-workers", label: "Has workers" },
  { id: "unmerged", label: "Unmerged" },
  { id: "archived", label: "Archived" },
];

export const STATE_WORD: Record<BoardState, string> = { working: "Working", "needs-you": "Needs you", idle: "Idle", archived: "Archived" };

/** How many rows render before "Show more": the worktrees request names every rendered row. */
export const BOARD_PAGE = 50;
/** The worktrees poll, and how long the board waits after the visible rows change. */
export const WORKTREES_POLL_MS = 15_000;

export interface BoardRow {
  session: SessionSummary;
  /** Its live record in GET /api/insights/agents, when it has one (a host session, by path). */
  agent: LiveAgentSession | null;
  state: BoardState;
  /** Why it needs you, one short sentence; null unless `state` is "needs-you". */
  reason: string | null;
  /** A TUI has it open, or a runtime (this server's or a TUI's) reports on it. */
  live: boolean;
  working: number;
  total: number;
  teams: TeamInfo[];
  /** Lifetime USD of its workers, when the record reports one. */
  spend: number | null;
  /** ms epoch. */
  lastActive: number;
}

/** The session's live record in the agents poll: host sessions only, matched by path. */
export function agentIndex(a: Pick<AgentsInsight, "sessions"> | undefined): Map<string, LiveAgentSession> {
  const out = new Map<string, LiveAgentSession>();
  for (const s of a?.sessions ?? []) if (s.path && isHostSession(s)) out.set(s.path, s);
  return out;
}

type StateInput = Pick<
  SessionSummary,
  "path" | "live" | "activity" | "busy" | "archived" | "pendingDialogs" | "turnError" | "signals" | "workerSignals" | "seenAt" | "workers"
>;

/**
 * One state per row. A question the session is blocked on (an input request, an open dialog) wins
 * over work, because nothing moves until you answer; then work (its own turn, or a worker's);
 * then what the last finished turn left for you (a failure, a question, a loop); then idle, or
 * archived for a session you archived that nothing runs in.
 */
export function boardState(
  s: StateInput,
  agent: Pick<LiveAgentSession, "state" | "workerCounts"> | null,
  busy: boolean,
): { state: BoardState; reason: string | null } {
  const activity = s.activity?.state ?? agent?.state;
  if (activity === "needs-input") return { state: "needs-you", reason: "Waiting on your input." };
  if ((s.pendingDialogs ?? 0) > 0) return { state: "needs-you", reason: s.pendingDialogs === 1 ? "A dialog is waiting on you." : `${s.pendingDialogs} dialogs are waiting on you.` };
  const workersWorking = agent ? agent.workerCounts.working : sessionWorking(s);
  if (busy || activity === "working" || workersWorking > 0) return { state: "working", reason: null };
  if (activity === "error") return { state: "needs-you", reason: s.activity?.error ? `Stopped on an error: ${s.activity.error}` : "Stopped on an error." };
  if (s.turnError) return { state: "needs-you", reason: s.turnError.message ? `Last turn failed: ${s.turnError.message}` : "Last turn failed." };
  const mark = rowNeedsYou(s, { selected: null, busy: false });
  if (mark) return { state: "needs-you", reason: mark.worker ? "A subagent may be stuck." : mark.kind === "asks-you" ? "Asks you something." : "May be looping." };
  const live = s.live !== null || s.activity !== undefined || agent !== null;
  return { state: s.archived && !live ? "archived" : "idle", reason: null };
}

/**
 * The board's rows: every main thread (never a worker's own session or an Overseer file), each with
 * its live record. `busyOf` is the tab's own view of a turn in flight, newer than the list.
 */
export function boardRows(sessions: readonly SessionSummary[], agents: Pick<AgentsInsight, "sessions"> | undefined, busyOf: (s: SessionSummary) => boolean): BoardRow[] {
  const index = agentIndex(agents);
  return sessions.filter(isMainThread).map((s) => {
    const agent = index.get(s.path) ?? null;
    const { state, reason } = boardState(s, agent, busyOf(s));
    const counts = s.workers ?? s.live?.workers;
    const t = Date.parse(s.lastActiveAt);
    return {
      session: s,
      agent,
      state,
      reason,
      live: s.live !== null || s.activity !== undefined || agent !== null,
      working: agent ? agent.workerCounts.working : (counts?.working ?? 0),
      total: agent ? Math.max(agent.workerCounts.total, agent.workers.length) : (counts?.total ?? 0),
      teams: agent?.teams ?? [],
      spend: agent?.usageTotal?.cost ?? null,
      lastActive: Number.isNaN(t) ? 0 : t,
    };
  });
}

/** The default scope, with no chip: what runs, and what you started in Sova and haven't archived. */
export const inDefaultScope = (r: Pick<BoardRow, "live" | "session">): boolean => r.live || isTopSession(r.session);

/** A row has a tree whose branch isn't in its base. Unknown (not read yet) is not unmerged. */
export const hasUnmerged = (trees: readonly WorktreeStatus[] | undefined): boolean => !!trees?.some((t) => t.exists && t.merged === "no");

/**
 * Whether a row passes a chip. Chips narrow what the board is for (the default scope), except
 * Needs you, which reaches any session that asks, and Archived, which is only what you archived.
 */
export function passesFilter(r: BoardRow, filter: BoardFilter | null, trees: readonly WorktreeStatus[] | undefined): boolean {
  switch (filter) {
    case null:
      return inDefaultScope(r);
    case "live":
      return r.live;
    case "needs-you":
      return r.state === "needs-you";
    case "has-workers":
      return r.total > 0;
    case "unmerged":
      return inDefaultScope(r) && hasUnmerged(trees);
    case "archived":
      return r.session.archived === true;
  }
}

/** Case-insensitive, every word somewhere in the title, gist, path, cwd or a tree's branch. */
export function matchesSearch(r: Pick<BoardRow, "session">, query: string, trees: readonly WorktreeStatus[] | undefined): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const s = r.session;
  const hay = [s.title, s.originalTitle ?? "", summaryLineOf(s), s.path, s.cwd, ...(trees ?? []).flatMap((t) => [t.branch ?? "", t.path])].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

const RANK: Record<BoardState, number> = { working: 0, "needs-you": 1, idle: 2, archived: 2 };

/** Working first, then needs-you, then by last active, newest first. A new array. */
export function sortRows<R extends Pick<BoardRow, "state" | "lastActive">>(rows: readonly R[]): R[] {
  return [...rows].sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastActive - a.lastActive);
}

/**
 * The rows on screen: the chip (or the default scope), then the search. A search with no chip
 * looks through every session, not only the default scope — the one you're looking for is often
 * an old one. `pinned` stays in whatever the filter says: a team link's parent session.
 */
export function visibleRows(
  rows: readonly BoardRow[],
  opts: { filter: BoardFilter | null; query: string; treesOf(path: string): WorktreeStatus[] | undefined; pinned?: string | null },
): BoardRow[] {
  const searching = opts.query.trim() !== "";
  return sortRows(
    rows.filter((r) => {
      const trees = opts.treesOf(r.session.path);
      if (r.session.path === opts.pinned) return true;
      const inScope = opts.filter === null && searching ? true : passesFilter(r, opts.filter, trees);
      return inScope && matchesSearch(r, opts.query, trees);
    }),
  );
}

/** How many rows each chip would show now, for the counts in the bar. */
export function filterCounts(rows: readonly BoardRow[], treesOf: (path: string) => WorktreeStatus[] | undefined): Record<BoardFilter, number> {
  const out: Record<BoardFilter, number> = { live: 0, "needs-you": 0, "has-workers": 0, unmerged: 0, archived: 0 };
  for (const r of rows) for (const f of BOARD_FILTERS) if (passesFilter(r, f.id, treesOf(r.session.path))) out[f.id]++;
  return out;
}

export interface BoardTotals {
  working: number;
  live: number;
  /** USD across the workers of sessions active today (their lifetime spend); null when none reports one. */
  spendToday: number | null;
  /** Distinct unmerged branches across the trees read so far; null before any reading. */
  unmerged: number | null;
}

/** Local midnight of `now`. */
const startOfDay = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The head's totals. Trees are counted once each, however many sessions touch them. */
export function boardTotals(rows: readonly BoardRow[], trees: Iterable<readonly WorktreeStatus[]>, now: number): BoardTotals {
  const today = startOfDay(now);
  let spend: number | null = null;
  for (const r of rows) if (r.spend !== null && r.lastActive >= today) spend = (spend ?? 0) + r.spend;
  let read = false;
  const unmerged = new Set<string>();
  for (const list of trees) {
    read = true;
    for (const t of list) if (t.exists && t.merged === "no") unmerged.add(t.path);
  }
  return {
    working: rows.filter((r) => r.state === "working").length,
    live: rows.filter((r) => r.live).length,
    spendToday: spend,
    unmerged: read ? unmerged.size : null,
  };
}

/** "2 working · 5 live · $3.40 today · 3 unmerged": the head's line; the spend only when reported. */
export function totalsLine(t: BoardTotals): string {
  const parts = [`${t.working} working`, `${t.live} live`];
  if (t.spendToday !== null) parts.push(`${money(t.spendToday)} today`);
  if (t.unmerged !== null) parts.push(`${t.unmerged} unmerged`);
  return parts.join(" · ");
}

/** `$1,240.00`; under a cent reads `<$0.01` rather than a zero that isn't one. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Worktrees

/** The comma-joined `paths` the worktrees request names: the rendered rows, in order. "" = none. */
export const worktreePathsKey = (rows: readonly Pick<BoardRow, "session">[]): string => rows.map((r) => r.session.path).join(",");

/** What a tree's merge reading says: merged (either way), ahead/behind counts, or nothing known. */
export type TreeMerge = { kind: "merged"; text: "merged" | "content merged"; title: string } | { kind: "diverged"; ahead: number; behind: number } | { kind: "unknown"; text: string };

export function treeMerge(t: WorktreeStatus): TreeMerge {
  if (!t.exists) return { kind: "unknown", text: "gone" };
  if (t.error && t.merged === undefined) return { kind: "unknown", text: "unreadable" };
  if (t.merged === "ancestor") return { kind: "merged", text: "merged", title: `Its tip is in ${t.base ?? "the base"}.` };
  if (t.merged === "content") return { kind: "merged", text: "content merged", title: `Merging into ${t.base ?? "the base"} would change nothing (a squash or rebase merge).` };
  if (t.merged === "no") return { kind: "diverged", ahead: t.ahead ?? 0, behind: t.behind ?? 0 };
  return { kind: "unknown", text: "no base" };
}

/** "feat/x", or "detached" for a detached HEAD, or the folder name when the tree is gone. */
export function treeName(t: WorktreeStatus): string {
  if (t.branch) return t.branch;
  if (!t.exists) return t.path.replace(/\/+$/, "").split("/").pop() || t.path;
  return "detached";
}

/** Lines the branch adds and removes, when both were read and it changes any. */
export const treeLines = (t: WorktreeStatus): { added: number; removed: number } | null =>
  t.added !== undefined && t.removed !== undefined && t.added + t.removed > 0 ? { added: t.added, removed: t.removed } : null;

/** One sentence for a tree's title: branch, base, the reading, and uncommitted work. */
export function treeTitle(t: WorktreeStatus): string {
  if (!t.exists) return `${t.path} is gone.`;
  const m = treeMerge(t);
  const reading =
    m.kind === "merged"
      ? m.title
      : m.kind === "diverged"
        ? `${m.ahead} ahead of ${t.base ?? "the base"}, ${m.behind} behind.`
        : t.error
          ? `Couldn't read it: ${t.error}`
          : "No base branch to compare with.";
  const lines = treeLines(t);
  return [`${treeName(t)} · ${t.path}`, reading, lines ? `+${lines.added} −${lines.removed} lines.` : "", t.dirty ? "Uncommitted changes." : ""].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Titles, workers, teams

/** The gist as a title: one line, within the title limit; null when there's none or it IS the title. */
export function gistTitle(s: Pick<SessionSummary, "title" | "outlineGist" | "outlineNow">): string | null {
  const line = summaryLineOf(s as SessionSummary).replace(/\s+/g, " ").trim();
  if (!line) return null;
  const cut = line.length > SESSION_TITLE_MAX ? `${line.slice(0, SESSION_TITLE_MAX - 1).trimEnd()}…` : line;
  return cut === s.title ? null : cut;
}

/** Workers of a row that aren't in one of its teams, working first. */
export function soloWorkers(agent: Pick<LiveAgentSession, "workers"> | null): WorkerInfo[] {
  const list = (agent?.workers ?? []).filter((w) => !w.teamId);
  return [...list].sort((a, b) => Number(b.working) - Number(a.working) || (b.lastActivity ?? b.startedAt ?? 0) - (a.lastActivity ?? a.startedAt ?? 0));
}

/**
 * The team a `#/agents/<key>` link names: its exact key, or, for a bare team id from an older
 * link, the newest team with that id. Null when no live session has it.
 */
export function teamForLink(a: Pick<AgentsInsight, "sessions"> | undefined, key: string): TeamInfo | null {
  const teams = (a?.sessions ?? []).filter(isHostSession).flatMap((s) => s.teams);
  const exact = teams.find((t) => teamKey(t) === key);
  if (exact || key.includes(".")) return exact ?? null;
  return teams.filter((t) => t.id === key).sort((x, y) => y.createdAt - x.createdAt)[0] ?? null;
}

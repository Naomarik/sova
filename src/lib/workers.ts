import type { AgentsInsight, ContextInfo, LiveAgentSession, SessionSummary, TeamInfo, WorkerInfo } from "../../shared/protocol";
import { clockTime } from "./format";

/** Subagents working now in a session, TUI-run or web-run; 0 when none or unknown.
    `workers` is top-level from newer servers; older ones only set it under `live`. */
export const sessionWorking = (s: Pick<SessionSummary, "workers" | "live">): number => (s.workers ?? s.live?.workers)?.working ?? 0;

/** Live agents right now: workers actually working in a fresh host session, and how many sessions
    hold at least one. Idle is not active: a `waiting` worker is steerable but settled (SCHEMA.md),
    so it counts for nothing here. */
export function activeAgentCounts(a: AgentsInsight | undefined): { agents: number; sessions: number } {
  let agents = 0;
  let sessions = 0;
  for (const s of a?.sessions ?? []) {
    if (!s.fresh || !isHostSession(s)) continue;
    // From the counts, not `workers`: the array drops evicted workers, the counts never do.
    const active = s.workerCounts.working;
    if (active <= 0) continue;
    agents += active;
    sessions++;
  }
  return { agents, sessions };
}

/** Teams the Agents foot row counts: a fresh host session's teams with at least one member still
    working. A team whose members are all idle is listed on the Agents page, but not counted here. */
export function activeTeamCount(a: AgentsInsight | undefined): number {
  let teams = 0;
  for (const s of a?.sessions ?? []) {
    if (!s.fresh || !isHostSession(s)) continue;
    teams += s.teams.filter((t) => t.working > 0).length;
  }
  return teams;
}

/** "1 subagent working…" / "3 subagents working…" */
export const subagentsWorkingLabel = (n: number): string => `${n} ${n === 1 ? "subagent" : "subagents"} working…`;

/** Live records the Agents page shows: everything but headless worker pis (mode "rpc", not
    embedded). Chat runtimes embedded in Sova are rpc too, but real sessions hosting agents. */
export const isHostSession = (s: Pick<LiveAgentSession, "mode" | "embedded">): boolean => s.mode !== "rpc" || s.embedded === true;

/** Subagents pane order: working first, then the most recent activity (else start) first. */
export function sortWorkers<W extends Pick<WorkerInfo, "working" | "lastActivity" | "startedAt">>(workers: readonly W[]): W[] {
  const at = (w: W) => w.lastActivity ?? w.startedAt ?? 0;
  return [...workers].sort((a, b) => Number(b.working) - Number(a.working) || at(b) - at(a));
}

/** A worker's label: its team role when it's a team member, else its own name. */
export function workerLabel(w: Pick<WorkerInfo, "id" | "name">, teams: readonly Pick<TeamInfo, "members">[] | undefined): string {
  for (const t of teams ?? []) {
    const m = t.members.find((m) => m.workerId === w.id);
    if (m?.role) return m.role;
  }
  return w.name;
}

/** Whether a worker's team released its seat: it then shows the Ejected chip. */
export function workerEjected(w: Pick<WorkerInfo, "id">, teams: readonly Pick<TeamInfo, "members">[] | undefined): boolean {
  return (teams ?? []).some((t) => t.members.some((m) => m.workerId === w.id && m.ejectedAt !== undefined));
}

/** The team a worker belongs to, or null when it's a plain subagent. */
export function workerTeam<T extends { members: readonly { workerId: string }[] }>(
  w: Pick<WorkerInfo, "id">,
  teams: readonly T[] | undefined,
): T | null {
  return (teams ?? []).find((t) => t.members.some((m) => m.workerId === w.id)) ?? null;
}

/**
 * What's working now, by kind. A team member is a worker a team claims (or one that names a
 * team itself); everything else is a plain subagent — the two are different things and the
 * status row says which.
 */
export interface WorkingSplit {
  members: number;
  subagents: number;
  /** The team the working members share, when they all share one. */
  team?: string;
}

/**
 * Splits `working` into team members and plain subagents. Null when the lists can't answer it —
 * no workers, no teams, or a list too short to cover the count (a live record trims it) — and
 * the caller keeps the plain "{n} subagents" wording rather than guessing.
 */
export function workingSplit(
  working: number,
  workers: readonly Pick<WorkerInfo, "id" | "working" | "teamId">[] | undefined,
  teams: readonly { name: string; members: readonly { workerId: string }[] }[] | undefined,
): WorkingSplit | null {
  if (!workers?.length || !teams?.length) return null;
  const names = new Set<string>();
  let members = 0;
  let subagents = 0;
  for (const w of workers) {
    if (!w.working) continue;
    const team = workerTeam(w, teams);
    if (!team && !w.teamId) subagents++;
    else {
      members++;
      if (team) names.add(team.name);
    }
  }
  if (members + subagents !== working) return null;
  return names.size === 1 ? { members, subagents, team: [...names][0]! } : { members, subagents };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 team members working…" · "1 subagent · 2 team members working…" · else the plain wording. */
export function workersWorkingLabel(working: number, split: WorkingSplit | null | undefined): string {
  if (!split || split.members === 0) return subagentsWorkingLabel(working);
  const members = count(split.members, "team member", "team members");
  const parts = split.subagents > 0 ? `${count(split.subagents, "subagent", "subagents")} · ${members}` : members;
  return `${parts} working…`;
}

/** The same split for the row that ALREADY says Working (the parent's own turn is running): the
    counts alone, since "Working · 2 subagents working…" would say it twice. */
export function workersRunningLabel(working: number, split: WorkingSplit | null | undefined): string {
  if (!split || split.members === 0) return count(working, "subagent", "subagents");
  const members = count(split.members, "team member", "team members");
  return split.subagents > 0 ? `${count(split.subagents, "subagent", "subagents")} · ${members}` : members;
}

/** "1 subagent working — show subagents": the composer trigger's accessible name. */
export const showSubagentsLabel = (n: number): string => `${n} ${n === 1 ? "subagent" : "subagents"} working — show subagents`;

/** The trigger's accessible name, naming what's working; with team members the pane is workers. */
export function showWorkersLabel(working: number, split: WorkingSplit | null | undefined): string {
  if (!split || split.members === 0) return showSubagentsLabel(working);
  return `${workersWorkingLabel(working, split).replace(/…$/, "")} — show workers`;
}

/** What a count of this session's workers is called: subagents, team members, or workers for a mix. */
const countNoun = (n: number, split: WorkingSplit | null | undefined): string => {
  if (!split || split.members === 0) return n === 1 ? "subagent" : "subagents";
  if (split.subagents === 0) return n === 1 ? "team member" : "team members";
  return n === 1 ? "worker" : "workers";
};

/** "2 of 5 subagents working": the working share the subagents trigger's ring draws, in words. */
export function workersOfLabel(working: number, total: number, split: WorkingSplit | null | undefined): string {
  return `${working} of ${total} ${countNoun(total, split)} working`;
}

/** The trigger's accessible name for the same: "2 of 5 subagents working — show subagents". */
export function showWorkersOfLabel(working: number, total: number, split: WorkingSplit | null | undefined): string {
  return `${workersOfLabel(working, total, split)} — show ${!split || split.members === 0 ? "subagents" : "workers"}`;
}

/** A worker has ended once it is done, failed or stopped; every other status (starting, running,
    stopping, waiting, restored) is live. The session's list keeps the ended ones for good. */
export const workerEnded = (w: Pick<WorkerInfo, "status">): boolean => w.status === "done" || w.status === "error" || w.status === "killed";

/** A session's workers split into live and ended, the ended by kind. */
export interface WorkerTally {
  live: number;
  ended: number;
  /** The ended by kind, only when the list names every ended worker; null: it can't say. */
  kinds: { stopped: number; failed: number; done: number } | null;
}

/**
 * Tallies a worker list. `total` is the record's own count (a live record lists at most 40
 * workers, the live ones first), so the ended ones it trims still count as ended; the kinds are
 * then unknown and left out rather than shown as a split that doesn't add up.
 */
export function tallyWorkers(workers: readonly Pick<WorkerInfo, "status">[], total?: number): WorkerTally {
  let live = 0;
  const kinds = { stopped: 0, failed: 0, done: 0 };
  for (const w of workers) {
    if (w.status === "killed") kinds.stopped++;
    else if (w.status === "error") kinds.failed++;
    else if (w.status === "done") kinds.done++;
    else live++;
  }
  const listed = kinds.stopped + kinds.failed + kinds.done;
  const ended = Math.max(listed, (total ?? 0) - live);
  return { live, ended, kinds: ended === listed ? kinds : null };
}

/** "16 stopped, 2 failed": the ended by kind, a kind at 0 left out; undefined when unknown. */
export function endedKinds(t: WorkerTally): string | undefined {
  if (!t.kinds || t.ended === 0) return undefined;
  const { stopped, failed, done } = t.kinds;
  const parts = [stopped && `${stopped} stopped`, failed && `${failed} failed`, done && `${done} done`].filter(Boolean);
  return parts.join(", ") || undefined;
}

/** "18 ended: 16 stopped, 2 failed" ("18 ended" when the kinds are unknown); undefined: none ended. */
export function endedNote(t: WorkerTally | null | undefined): string | undefined {
  if (!t || t.ended === 0) return undefined;
  const kinds = endedKinds(t);
  return kinds ? `${t.ended} ended: ${kinds}` : `${t.ended} ended`;
}

/** The idle row's words when nothing is live but some ended: "18 subagents, all ended". */
export const allEndedLabel = (n: number): string => (n === 1 ? "1 subagent, ended" : `${n} subagents, all ended`);

/** The composer's subagents trigger: what its ring draws (`working` of `total`), its narrow count
    `n`, its wide words `text`, `say` (the words plus the ended note: a plain row's tooltip) and the
    button's accessible name `label`. */
export interface WorkersTrigger {
  working: number;
  total: number;
  n: string;
  text: string;
  say: string;
  label: string;
}

/**
 * The subagents trigger, or null when there's no row. `total` is the live workers (or, before the
 * session's list has come, the list count it falls back to), never fewer than `working`;
 * `tally` (null before the list) names the ended ones. Idle, the row is offered only when it
 * can open the pane: for the live ones, else, when every worker has ended, for those.
 */
export function workersTrigger(o: {
  working: number;
  total: number;
  tally?: WorkerTally | null;
  split?: WorkingSplit | null;
  running: boolean;
  canOpen: boolean;
}): WorkersTrigger | null {
  const working = Math.max(0, o.working);
  // The list's total can lag the socket's working count: never draw more working than there are.
  const total = Math.max(o.total, working);
  const note = endedNote(o.tally);
  const withNote = (words: string) => (note ? `${words} · ${note}` : words);
  if (working > 0) {
    const text = workersOfLabel(working, total, o.split);
    const say = withNote(text);
    return { working, total, n: `${working}/${total}`, text, say, label: `${say} — show ${!o.split || o.split.members === 0 ? "subagents" : "workers"}` };
  }
  if (o.running || !o.canOpen) return null; // an idle row is only worth having when it opens the pane
  if (total > 0) {
    const text = count(total, "subagent", "subagents");
    const say = withNote(text);
    return { working: 0, total, n: `${total}`, text, say, label: `${say} — show subagents` };
  }
  const ended = o.tally?.ended ?? 0;
  if (ended === 0) return null;
  const text = allEndedLabel(ended);
  const kinds = endedKinds(o.tally!);
  const say = kinds ? `${text}: ${kinds}` : text;
  return { working: 0, total: ended, n: `${ended}`, text, say, label: `${say} — show subagents` };
}

/** "Team · Explain UX" for the one team behind a count, else nothing to add. */
export const teamNote = (split: WorkingSplit | null | undefined): string | undefined =>
  split?.team && split.members > 0 ? `Team · ${split.team}` : undefined;

/** What the working count is called where there's no room to split it: a chip's title. */
export function workingChipTitle(split: WorkingSplit | null | undefined): string {
  if (!split || split.members === 0) return "Subagents working now";
  return split.subagents > 0 ? "Workers working now" : "Team members working now";
}

/** The pane's noun: a session with a team holds more than subagents. */
export const workersNoun = (hasTeams: boolean): string => (hasTeams ? "Workers" : "Subagents");

/**
 * Where a worker's transcript is read from: its own pi session file (`/ws/watch?path=`), or —
 * for a claude-code worker, which writes no pi file — the Claude Code session it reported
 * (`/ws/watch?claude=`, read out of ~/.claude/projects).
 */
export type TranscriptSource = { kind: "pi"; path: string } | { kind: "claude"; sessionId: string };

/** A stable key for the source, so the viewer remounts (and reconnects) only when it changes.
    undefined: nothing to read yet. pi paths are absolute, so they can't look like a claude key. */
export function sourceKey(w: Pick<WorkerInfo, "sessionFile" | "backend" | "sessionId">): string | undefined {
  if (w.sessionFile) return w.sessionFile;
  return w.backend === "claude-code" && w.sessionId ? `claude:${w.sessionId}` : undefined;
}

export const sourceOf = (key: string): TranscriptSource =>
  key.startsWith("claude:") ? { kind: "claude", sessionId: key.slice("claude:".length) } : { kind: "pi", path: key };

/** What the source is, for "we couldn't read it" copy. */
export const sourceName = (s: TranscriptSource): string => (s.kind === "pi" ? s.path : `Claude session ${s.sessionId}`);

/**
 * A context state off `unknown` (a server older than this build sends none): a fill with a
 * positive token count, or "compacted". Anything else is "nothing to show" — never a 0 fill.
 * A fill without a window takes `fallbackWindow` (a Claude Code transcript can't name its own).
 */
function asContext(value: unknown, fallbackWindow: unknown): ContextInfo | "compacted" | null {
  if (value === "compacted") return "compacted";
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  const tokens = c.tokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  return { tokens, window: ok(c.window) ? c.window : ok(fallbackWindow) ? fallbackWindow : null };
}

/** A worker's own context fill as its row reports it, or null when unknown. */
export const workerContext = (w: unknown): ContextInfo | "compacted" | null => {
  const r = w as { context?: unknown; contextWindow?: unknown } | null;
  return asContext(r?.context, r?.contextWindow);
};

/**
 * The fill a watch `snapshot`/`append` carries for the open transcript, completed with the
 * worker's window. undefined: the message says nothing (an older server) — keep what we have;
 * null: no reply reports one yet.
 */
export function transcriptContext(msg: unknown, worker: unknown): ContextInfo | "compacted" | null | undefined {
  if (!msg || typeof msg !== "object" || !("context" in msg)) return undefined;
  return asContext((msg as { context?: unknown }).context, (worker as { contextWindow?: unknown } | null)?.contextWindow);
}

/** What a worker row's ring shows: a fill with a window, never "compacted" (the view head says
    that in words) and never a fill without a denominator — the sidebar ring's rule. */
export const ringContext = (s: ContextInfo | "compacted" | null): ContextInfo | null => (s && s !== "compacted" && s.window ? s : null);

/**
 * A native `title` kept to a readable size: cut at a word boundary near `max`, ellipsis added.
 * Tooltips have no scroll and no width of their own, so a 4000-char objective is a wall of text.
 */
export function capTitle(text: string | null | undefined, max = 300): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `14:06` for an epoch-ms "as of" stamp; empty for a bad one. */
export const asOfClock = (ms: number): string => clockTime(new Date(ms).toISOString());


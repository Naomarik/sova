import type { AgentsInsight, LiveAgentSession, SessionSummary, TeamInfo, WorkerInfo } from "../../shared/protocol";
import { formatTokens } from "./context";

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
    embedded). Chat runtimes embedded in pi-web are rpc too, but real sessions hosting agents. */
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

/** "1 subagent working — show subagents": the composer trigger's accessible name. */
export const showSubagentsLabel = (n: number): string => `${n} ${n === 1 ? "subagent" : "subagents"} working — show subagents`;

/** The trigger's accessible name, naming what's working; with team members the pane is workers. */
export function showWorkersLabel(working: number, split: WorkingSplit | null | undefined): string {
  if (!split || split.members === 0) return showSubagentsLabel(working);
  return `${workersWorkingLabel(working, split).replace(/…$/, "")} — show workers`;
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
 * Token counts, as the pane reads them. Structurally `TokenUsage` in shared/protocol.ts; the
 * accessors below take the loosest shape that can carry one, so a row, a `workers` message or a
 * watch message can be passed straight in whether or not the server that sent it reports usage.
 */
export interface UsageView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
}
export interface UsageTotalView extends UsageView {
  /** How many workers the Σ covers — a session-lifetime count, so it can exceed the list. */
  workers: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Usage arrives from a server that may be older than this build, on messages whose type may not
 * declare the field yet, so these accessors read it off `unknown` and validate as they go.
 * Null means "nothing to show": no field, or a worker that has spent nothing.
 */
function asUsage(value: unknown): UsageView | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  const usage: UsageView = { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite) };
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite <= 0) return null;
  const cost = n(u.cost);
  return cost > 0 ? { ...usage, cost } : usage;
}

/** A worker's own counts, or null when it has none (nothing spent, or an older pi-config). */
export const workerUsage = (w: unknown): UsageView | null => asUsage((w as { usage?: unknown } | null)?.usage);

/** The counts a watch `snapshot`/`append` carries for the open transcript, or null. */
export const transcriptUsage = (msg: unknown): UsageView | null => asUsage((msg as { usage?: unknown } | null)?.usage);

/** The session-lifetime Σ on a `workers` message or a session insight, with its head count. */
export function usageTotal(source: unknown): UsageTotalView | null {
  const raw = (source as { usageTotal?: unknown } | null)?.usageTotal;
  const usage = asUsage(raw);
  if (!usage) return null;
  const workers = (raw as Record<string, unknown>).workers;
  return { ...usage, workers: Number.isSafeInteger(workers) && (workers as number) > 0 ? (workers as number) : 0 };
}

/** The headline number: what was actually spoken, input + output. §11 shows cache in the title. */
export const usageHeadline = (u: UsageView): number => u.input + u.output;

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

/** `$1.24`, `$0.08`, `<$0.01`; nothing at all when the backend reported no cost. */
export function formatCost(cost: number | undefined): string | null {
  if (cost === undefined || !(cost > 0)) return null;
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/**
 * The `title` behind a token chip: the split the headline hides, and the cost when there is one.
 * `workers` is set for a Σ, whose head count is the point — it covers workers the list dropped.
 */
export function usageTitle(u: UsageView, workers?: number): string {
  const parts = [
    `${formatTokens(u.input)} in`,
    `${formatTokens(u.output)} out`,
    `${formatTokens(u.cacheRead)} cache read`,
    `${formatTokens(u.cacheWrite)} cache write`,
  ];
  const cost = formatCost(u.cost);
  if (cost) parts.push(cost);
  const head = workers === undefined ? "" : `${workers} ${workers === 1 ? "subagent" : "subagents"} so far · `;
  return head + parts.join(" · ");
}

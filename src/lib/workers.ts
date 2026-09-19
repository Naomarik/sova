import type { LiveAgentSession, SessionSummary, TeamInfo, WorkerInfo } from "../../shared/protocol";

/** Subagents working now in a session, TUI-run or web-run; 0 when none or unknown.
    `workers` is top-level from newer servers; older ones only set it under `live`. */
export const sessionWorking = (s: Pick<SessionSummary, "workers" | "live">): number => (s.workers ?? s.live?.workers)?.working ?? 0;

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

/** "1 subagent working — show subagents": the composer trigger's accessible name. */
export const showSubagentsLabel = (n: number): string => `${n} ${n === 1 ? "subagent" : "subagents"} working — show subagents`;

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

import type { UpdatesRunning } from "../../shared/protocol";

/**
 * Restart Sova (Settings → General, **Server · this machine**): its words, and the wait for the server
 * to come back. Pure but for what callers hand in, so the unit tests drive the wait with a fake clock.
 */

/** "3 new commits and uncommitted changes": only the parts that apply; "" when nothing is newer. */
export function aheadPhrase(ahead: UpdatesRunning["diskAhead"]): string {
  if (!ahead) return "";
  const parts: string[] = [];
  if (ahead.commits > 0) parts.push(`${ahead.commits} new ${ahead.commits === 1 ? "commit" : "commits"}`);
  if (ahead.dirty) parts.push("uncommitted changes");
  return parts.join(" and ");
}

/** The confirm's sentences. */
export function restartConfirmText(running: Pick<UpdatesRunning, "diskAhead">): string[] {
  const lines = ["Sova restarts in a few seconds. Chats keep running; open tabs reconnect."];
  const ahead = aheadPhrase(running.diskAhead);
  if (ahead) lines.push(`It loads newer code: ${ahead} since it started.`);
  return lines;
}

/** "feat/x · abc1234", "abc1234", or "" (no git). */
export function runsLabel(branch: string | null, commit: string | null): string {
  const sha = commit ? commit.slice(0, 7) : "";
  return [branch, sha].filter(Boolean).join(" · ");
}

/** The terminal command that shows the service's state. */
export function serviceCheckCommand(unit: NonNullable<UpdatesRunning["restartUnit"]>): string {
  return unit.manager === "launchd" ? `launchctl print gui/$(id -u)/${unit.name}` : `systemctl --user status ${unit.name}`;
}

/** How often the wait asks, and when it says Sova is late. */
export const POLL_MS = 1_000;
export const SLOW_POLL_MS = 5_000;
export const LATE_MS = 60_000;

export interface RestartWait {
  /** The startedAt the restart replaces. */
  before: string;
  /** `GET /api/health`'s startedAt, or null while Sova doesn't answer. */
  health(): Promise<string | null>;
  wait(ms: number): Promise<void>;
  now(): number;
  /** Told once, when Sova hasn't come back after LATE_MS. */
  onLate(): void;
  /** True once nobody watches any more (the section closed): the wait ends with null. */
  stopped(): boolean;
}

/**
 * Ask every second until the server answers with another startedAt; after a minute, say so once and
 * keep asking every 5 s. The new startedAt, or null when stopped.
 */
export async function waitForRestart(w: RestartWait): Promise<string | null> {
  const t0 = w.now();
  let late = false;
  for (;;) {
    if (w.stopped()) return null;
    const at = await w.health().catch(() => null);
    if (w.stopped()) return null;
    if (at && at !== w.before) return at;
    if (!late && w.now() - t0 >= LATE_MS) {
      late = true;
      w.onLate();
    }
    await w.wait(late ? SLOW_POLL_MS : POLL_MS);
  }
}

/** `GET /api/health`'s startedAt, this host's own, or null when it doesn't answer within `timeoutMs`. */
export async function healthStartedAt(timeoutMs = 3_000): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: ctl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { startedAt?: unknown };
    return typeof body.startedAt === "string" ? body.startedAt : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Where the block is: the button, its confirm, waiting for Sova, or done. */
export type RestartPhase = "idle" | "confirm" | "sending" | "waiting" | "done";

export const NO_SERVICE_HINT = "This copy isn't run by a service, so it can't restart itself. Restart it where you started it.";
export const UPGRADE_HINT = "An upgrade is running; it restarts Sova itself.";

export interface RestartBlockView {
  /** null: no button at all (no service runs this copy). */
  button: { label: "Restart Sova" | "Restarting…"; disabled: boolean } | null;
  /** The sentence under it, when there is one. */
  hint: string | null;
}

/** What the block shows for what runs, whether an upgrade runs, and where the block is. Pure. */
export function restartBlockView(running: Pick<UpdatesRunning, "canRestart" | "restartWhyNot" | "restartUnit">, upgrading: boolean, phase: RestartPhase): RestartBlockView {
  if (!running.restartUnit) return { button: null, hint: running.restartWhyNot ?? NO_SERVICE_HINT };
  const busy = phase === "sending" || phase === "waiting";
  const button = { label: busy ? ("Restarting…" as const) : ("Restart Sova" as const), disabled: busy || upgrading || !running.canRestart };
  if (busy || phase === "confirm") return { button, hint: null };
  if (upgrading) return { button, hint: UPGRADE_HINT };
  return { button, hint: running.canRestart ? null : (running.restartWhyNot ?? null) };
}

/** "Restarted just now. Runs feat/x · abc1234." once Sova answered with another start. */
export function restartedLine(running: Pick<UpdatesRunning, "branch" | "startedHead" | "head">): string {
  const runs = runsLabel(running.branch, running.startedHead ?? running.head);
  return runs ? `Restarted just now. Runs ${runs}.` : "Restarted just now.";
}

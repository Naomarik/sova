import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * Resuming the runs a server restart cut off (§app.overseer/auto-resume).
 *
 * The ledger (`<stateRoot>/runs-in-flight.json`) lists the hosted chats with a run in flight: a
 * session is added at its run's `agent_start` and removed at its `agent_settled`. A shutdown
 * freezes it before it aborts the runs, so those aborts remove nothing; a crash leaves it as it
 * was. The next start reads and empties it: what was left there is what that stop cut off. A run
 * stopped any other way (a usage limit, an error, the user's Stop) settles, so it is never here.
 */

export const RESUME_TEXT = "The Sova server restarted and cut off your last turn. Continue where you left off.";
/** How long after start the resume waits, so the server is up before runs begin. */
export const RESUME_DELAY_MS = 5000;

export interface InFlight {
  /** ms epoch the run started. */
  since: number;
  /** The run was an auto-resume: cut off again, it is not resumed a second time. */
  auto?: true;
}

const ledgerFile = () => join(stateRoot(), "runs-in-flight.json");

export class RunLedger {
  private runs = new Map<string, InFlight>();
  private frozen = false;
  /** Paths whose next run is an auto-resume. */
  private readonly resuming = new Set<string>();
  constructor(private readonly file: string = ledgerFile()) {}

  /** A run started in a hosted chat. */
  started(path: string, now = Date.now()): void {
    if (this.frozen) return;
    const auto = this.resuming.delete(path);
    this.runs.set(path, { since: now, ...(auto ? { auto: true as const } : {}) });
    this.persist();
  }
  /** That run settled, however it ended. */
  settled(path: string): void {
    if (this.frozen || !this.runs.delete(path)) return;
    this.persist();
  }
  /** The next run of this chat is a resume. */
  markResuming(path: string): void {
    this.resuming.add(path);
  }
  /** The server is stopping: what is in flight now stays recorded. */
  freeze(): void {
    this.frozen = true;
  }
  /** Read and empty what the previous process left: the runs its stop cut off. Called once at start,
      before this process starts any run. */
  takeInterrupted(): Map<string, InFlight> {
    const out = new Map<string, InFlight>();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { runs?: Record<string, unknown> };
      for (const [path, v] of Object.entries(raw?.runs ?? {})) {
        const r = v as { since?: unknown; auto?: unknown };
        if (typeof r?.since === "number") out.set(path, { since: r.since, ...(r.auto === true ? { auto: true as const } : {}) });
      }
    } catch {
      // missing or corrupt: nothing was cut off that we know of
    }
    // Emptied before any resume (only this process's own runs stay): this stop is answered once,
    // whatever happens next.
    this.persist();
    return out;
  }
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, runs: Object.fromEntries(this.runs) })}\n`);
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn("[auto-resume] ledger not saved:", err instanceof Error ? err.message : String(err));
    }
  }
}

/** The one ledger of this process (chat-manager records into it; index.ts freezes and reads it). */
export const runLedger = new RunLedger();

/** What the resume needs from the server, injected so the decision is testable. */
export interface ResumeDeps {
  enabled: boolean;
  /** The session now, or null when it is gone. */
  session(path: string): Promise<{ id: string; title: string; name: string; archived?: boolean; live?: unknown; overseer?: boolean; projectOverseer?: boolean; baton?: unknown; workerSession?: unknown } | null>;
  /** Free running-at-once slots of the Overseer's cap. */
  freeSlots(): number;
  /** Send the resume message; throws with the refusal. */
  prompt(path: string, text: string): Promise<void>;
  /** Log one resume (overseer-actions.jsonl). */
  log(path: string, outcome: "ok" | "refused", why?: string): void;
  /** One brief to the Overseer (sent only under Brief Me). */
  brief(text: string): Promise<void>;
}

export interface ResumeOutcome {
  resumed: { id: string; name: string }[];
  skipped: { id: string | null; name: string; why: string }[];
}

/** Resume what the last stop cut off, oldest run first. */
export async function resumeInterrupted(runs: Map<string, InFlight>, deps: ResumeDeps, ledger: Pick<RunLedger, "markResuming"> = runLedger): Promise<ResumeOutcome> {
  const out: ResumeOutcome = { resumed: [], skipped: [] };
  if (!deps.enabled || runs.size === 0) return out;
  const order = [...runs.entries()].sort((a, b) => a[1].since - b[1].since);
  for (const [path, run] of order) {
    const s = await deps.session(path).catch(() => null);
    const skip = (why: string) => {
      out.skipped.push({ id: s?.id ?? null, name: s?.name ?? path, why });
      deps.log(path, "refused", why);
    };
    // The overseers and baton sessions are never resumed, and not reported either.
    if (s && (s.overseer || s.projectOverseer || s.baton || s.workerSession)) continue;
    if (!s) skip("it is gone");
    else if (s.archived) skip("it is archived");
    else if (s.live) skip("it is open in a terminal");
    else if (run.auto) skip("it was cut off again while resuming");
    else if (deps.freeSlots() <= 0) skip("the running-at-once limit was reached");
    else {
      try {
        ledger.markResuming(path);
        await deps.prompt(path, RESUME_TEXT);
        out.resumed.push({ id: s.id, name: s.name });
        deps.log(path, "ok");
      } catch (err) {
        skip(err instanceof Error ? err.message : String(err));
      }
    }
  }
  if (out.resumed.length || out.skipped.length) await deps.brief(resumeBriefText(out)).catch(() => {});
  return out;
}

/** The brief's body (after the brief prefix): each session as an in-app link. */
export function resumeBriefText(o: ResumeOutcome): string {
  const link = (x: { id: string | null; name: string }) => (x.id ? `[${x.name.replace(/[[\]]/g, "")}](sova://s/${x.id})` : x.name);
  const lines = [`The server restarted. ${o.resumed.length} interrupted session${o.resumed.length === 1 ? "" : "s"} resumed${o.skipped.length ? `, ${o.skipped.length} not` : ""}:`];
  for (const r of o.resumed) lines.push(`- resumed: ${link(r)}`);
  for (const r of o.skipped) lines.push(`- not resumed: ${link(r)} — ${r.why}`);
  return lines.join("\n");
}

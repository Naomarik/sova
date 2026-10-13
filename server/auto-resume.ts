/**
 * Resuming the runs a chat process's death cut off (§app.overseer/auto-resume). A server stop cuts
 * none off: every chat runs in a process of its own and records its own run in flight
 * (server/chat-runtime/inflight.ts).
 */

/** A chat in a process of its own whose process died with a run in flight (§app.chat-processes/crash). */
export const CRASH_RESUME_TEXT = "This chat's process stopped unexpectedly and cut off your last turn. Continue where you left off.";
/** How long after the death the resume waits. */
export const RESUME_DELAY_MS = 5000;

export interface InFlight {
  /** ms epoch the run started. */
  since: number;
  /** The run was an auto-resume: cut off again, it is not resumed a second time. */
  auto?: true;
}

/** What the resume needs from the server, injected so the decision is testable. */
export interface ResumeDeps {
  enabled: boolean;
  /** The session now, or null when it is gone. */
  session(path: string): Promise<{ id: string; title: string; name: string; archived?: boolean; live?: unknown; overseer?: boolean; projectOverseer?: boolean; baton?: unknown; workerSession?: unknown } | null>;
  /** Free running-at-once slots of the Overseer's cap. */
  freeSlots(): number;
  /** Send the resume message; throws with the refusal. `key`: sent again, it is accepted once (§app.chat-processes/server-messages). */
  prompt(path: string, text: string, key?: string): Promise<void>;
  /** Log one resume (overseer-actions.jsonl). */
  log(path: string, outcome: "ok" | "refused", why?: string): void;
  /** One brief to the Overseer (sent only under Brief Me). */
  brief(text: string): Promise<void>;
}

export interface ResumeOutcome {
  resumed: { id: string; name: string }[];
  skipped: { id: string | null; name: string; why: string }[];
}

/** Resume what a death cut off, oldest run first. */
export async function resumeInterrupted(runs: Map<string, InFlight>, deps: ResumeDeps): Promise<ResumeOutcome> {
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
        await deps.prompt(path, CRASH_RESUME_TEXT, `resume:${path}:${run.since}`);
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
  const lines = [`A chat process stopped unexpectedly. ${o.resumed.length} interrupted session${o.resumed.length === 1 ? "" : "s"} resumed${o.skipped.length ? `, ${o.skipped.length} not` : ""}:`];
  for (const r of o.resumed) lines.push(`- resumed: ${link(r)}`);
  for (const r of o.skipped) lines.push(`- not resumed: ${link(r)} — ${r.why}`);
  return lines.join("\n");
}

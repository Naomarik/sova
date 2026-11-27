/**
 * Automatic archive compression (§app.session-list/archive-compression "On its own"): while the
 * server runs and Settings leaves it on, every archived chat last active more than AUTO_AGE_DAYS
 * ago is compressed in the background, a few at a time, never slowing the list. Each pass reads the
 * last listing's rows (no listing of its own) and hands the chats to Clean Up's own compress
 * (`run`), which makes every check Clean Up makes and skips, to be tried at the next pass, a chat
 * that is open, live, mid-turn, has a worker or command running, or was just written.
 */
import type { SessionSummary } from "../../shared/protocol";

export const AUTO_AGE_DAYS = 60;
/** How often a pass runs: at least once a day, as the claim promises. */
export const PASS_MS = 6 * 3_600_000;
/** The first pass, after the server has settled. */
export const FIRST_PASS_MS = 10 * 60_000;
/** Chats per step, and the pause between steps, so a pass never holds the server. */
export const STEP = 3;
export const STEP_PAUSE_MS = 2_000;

/** The archived chats a pass compresses, oldest first: never a helper's own conversation (it goes
    with its chat), an Overseer's, an organization's or a merge queue chat, nor one already compressed. */
export function autoCandidates(rows: Iterable<SessionSummary>, now = Date.now(), ageDays = AUTO_AGE_DAYS): string[] {
  const cutoff = now - ageDays * 86_400_000;
  const out: { path: string; at: number }[] = [];
  for (const r of rows) {
    if (!r.archived || r.compressed || r.workerSession || r.overseer || r.org || r.baton || r.projectOverseer || r.queueChat) continue;
    if (r.live || r.busy) continue;
    const at = Date.parse(r.lastActiveAt);
    if (Number.isFinite(at) && at < cutoff) out.push({ path: r.path, at });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.path);
}

export interface AutoCompressOptions {
  /** Settings → automatic compression (on by default). */
  enabled: () => boolean;
  rows: () => Iterable<SessionSummary> | Promise<Iterable<SessionSummary>>;
  /** Which of the rows a pass takes, in order (default autoCandidates at AUTO_AGE_DAYS). */
  candidates?: (rows: Iterable<SessionSummary>) => string[];
  /** Clean Up's compress of these paths; answers the ids it compressed. */
  run: (paths: string[]) => Promise<{ compressedIds: string[] }>;
  passMs?: number;
  firstMs?: number;
  pauseMs?: number;
  log?: (line: string) => void;
}

/** Starts the passes; answers a stop. One pass at a time; a pass stops at the first step that compresses nothing. */
export function startAutoCompress(opts: AutoCompressOptions): { stop: () => void; pass: () => Promise<number> } {
  let stopped = false;
  let running: Promise<number> | null = null;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
  const pass = (): Promise<number> => {
    if (running) return running;
    running = (async () => {
      let done = 0;
      try {
        if (!opts.enabled()) return 0;
        const tried = new Set<string>();
        for (;;) {
          if (stopped || !opts.enabled()) break;
          const batch = (opts.candidates ?? ((rows) => autoCandidates(rows)))(await opts.rows()).filter((p) => !tried.has(p)).slice(0, STEP);
          if (batch.length === 0) break;
          for (const p of batch) tried.add(p);
          const r = await opts.run(batch);
          done += r.compressedIds.length;
          await sleep(opts.pauseMs ?? STEP_PAUSE_MS);
        }
        if (done > 0) (opts.log ?? console.log)(`[archive] compressed ${done} archived chats older than ${AUTO_AGE_DAYS} days`);
      } catch (err) {
        (opts.log ?? console.warn)(`[archive] automatic compression stopped: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = null;
      }
      return done;
    })();
    return running;
  };
  const first = setTimeout(() => void pass(), opts.firstMs ?? FIRST_PASS_MS);
  first.unref?.();
  const every = setInterval(() => void pass(), opts.passMs ?? PASS_MS);
  every.unref?.();
  return {
    pass,
    stop: () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
    },
  };
}

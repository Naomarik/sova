import { createSignal } from "solid-js";
import type { BackgroundJob } from "../../shared/protocol";
import { duration, tildePath } from "./format";

/** What a Background jobs row says (§app.background-jobs/pane, §design.copy-deck/subagents-pane):
    what runs, for how long, where its output goes, and whose worker it is. */
export interface JobRowText {
  /** The command's first non-blank line: a row is one line; the title holds the whole command. */
  what: string;
  command: string;
  howLong: string;
  output: string;
  /** The whole output path (the row shows it with `~`). */
  outputTitle: string | null;
  worker: string | null;
}

export const NO_OUTPUT_FILE = "No output file";

export function jobRowText(job: BackgroundJob, now: number, home: string | null): JobRowText {
  const what = job.command.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? job.command;
  const output = !job.noOutput && job.output ? job.output : null;
  return {
    what,
    command: job.command,
    howLong: duration(now - job.startedAt),
    output: output ? tildePath(output, home) : NO_OUTPUT_FILE,
    outputTitle: output,
    worker: job.worker,
  };
}

/** A row's key: a worker's job ids repeat its main chat's, so the owner is part of it. */
export const jobKey = (job: Pick<BackgroundJob, "sessionId" | "id">) => `${job.sessionId}/${job.id}`;

export interface JobsDeps {
  list(path: string): Promise<{ jobs: BackgroundJob[] }>;
  stop(path: string, id: string, sessionId?: string): Promise<unknown>;
  /** Told when Stop fails, in words. */
  failed(text: string): void;
}

/**
 * The section's state: the last list read, and the rows whose Stop is out. `read` re-reads the list
 * (a stale answer never overwrites a newer one); `stop` stops one job (a worker's by its own chat id)
 * then re-reads. Neither starts a chat or wakes one: both are plain reads and writes of the job store.
 */
export function createJobsState(path: () => string, deps: JobsDeps) {
  const [jobs, setJobs] = createSignal<BackgroundJob[]>([]);
  const [pressed, setPressed] = createSignal<ReadonlySet<string>>(new Set());
  let reading = 0;
  let disposed = false;
  const read = async () => {
    const mine = ++reading;
    const at = path();
    try {
      const r = await deps.list(at);
      if (!disposed && mine === reading && at === path()) setJobs(r.jobs ?? []);
    } catch {
      // An older server has no route, a peer may be away: the section stays as it was.
    }
  };
  const stop = async (job: BackgroundJob) => {
    const key = jobKey(job);
    setPressed((s) => new Set(s).add(key));
    try {
      await deps.stop(path(), job.id, job.worker ? job.sessionId : undefined);
      await read();
    } catch (e) {
      deps.failed(`Couldn't stop job ${job.id}. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPressed((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };
  /** Stop is out, or the server already stops it: the button waits. */
  const stopping = (job: BackgroundJob) => job.stopping || pressed().has(jobKey(job));
  return { jobs, read, stop, stopping, dispose: () => void (disposed = true) };
}

import { changedPaths, commitAll, headCommitMs, retryPush, type CommitOutcome } from "./workspace-git";

/**
 * The periodic commit of every attached org's workspace repo (§app.organizations/workspace-repo).
 * At most once per interval per repo — counted from the repo's own HEAD commit, so Commit Now, a
 * restart or a clone made elsewhere all count and nothing bursts — it commits whatever changed and
 * pushes to the repo's `origin` when one is set. Nothing changed: no commit. On a graceful shutdown
 * `flush` commits every repo with changes, due or not. A failure is the repo's last error
 * (server/workspace-git.ts), never thrown.
 */

export const COMMIT_EVERY_MS = 3_600_000;
/** How often the ticker looks; a repo is committed only when its interval has passed. */
const TICK_MAX_MS = 60_000;

/** The interval: an hour, or SOVA_WORKSPACE_COMMIT_MS (a positive whole number; tests only). */
export function commitEveryMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SOVA_WORKSPACE_COMMIT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : COMMIT_EVERY_MS;
}

export interface CommitTarget {
  id: string;
  dir: string;
}

/** "roster.json, sessions/ (3 files)": the changed paths by their first segment, for the message. */
export function changeSummary(paths: string[]): string {
  const tops = new Map<string, number>();
  for (const p of paths) {
    const i = p.indexOf("/");
    const top = i >= 0 ? `${p.slice(0, i)}/` : p;
    tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  const parts = [...tops.keys()].sort().map((t) => (t.endsWith("/") ? `${t} (${tops.get(t)} file${tops.get(t) === 1 ? "" : "s"})` : t));
  return parts.length > 6 ? `${parts.slice(0, 6).join(", ")}, …` : parts.join(", ");
}

export class WorkspaceCommitter {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();
  readonly everyMs: number;
  private readonly now: () => number;

  constructor(
    private readonly list: () => CommitTarget[],
    opts: { everyMs?: number; now?: () => number } = {},
  ) {
    this.everyMs = opts.everyMs ?? commitEveryMs();
    this.now = opts.now ?? Date.now;
  }

  /** Commit one repo if its interval has passed and anything changed (else retry a failed push). */
  async commitIfDue(t: CommitTarget): Promise<CommitOutcome | null> {
    const head = await headCommitMs(t.dir);
    if (head !== null && this.now() - head < this.everyMs) return null;
    const changed = await changedPaths(t.dir);
    if (!changed.length) {
      const retried = await retryPush(t.dir);
      return retried.pushed || retried.error ? retried : null;
    }
    return commitAll(t.dir, `Workspace changes: ${changeSummary(changed)}`);
  }

  /** One pass over every attached repo, one at a time. */
  tick(): Promise<(CommitOutcome | null)[]> {
    const run = (async () => {
      const out: (CommitOutcome | null)[] = [];
      for (const t of this.list()) out.push(await this.commitIfDue(t).catch(() => null));
      return out;
    })();
    this.running = run.catch(() => {});
    return run;
  }

  /** Commit every repo with changes now, due or not (a graceful shutdown). */
  async flush(reason: string): Promise<CommitOutcome[]> {
    await this.running;
    const out: CommitOutcome[] = [];
    for (const t of this.list()) {
      const changed = await changedPaths(t.dir).catch(() => []);
      if (changed.length) out.push(await commitAll(t.dir, `Workspace changes (${reason}): ${changeSummary(changed)}`));
    }
    return out;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), Math.min(this.everyMs, TICK_MAX_MS));
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

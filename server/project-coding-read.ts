// The project page's branch read (§app.project-overseer/coding-worktrees, "Read in two steps"): the
// order its steps run in, apart from what each step does, so the order is tested with stubs.
//
// Adoption rewrites a build's record and the statechart hears git's facts: both stay one at a time,
// in list order. Only the git reads themselves (pure, read-only) run side by side, at most `limit`.

/** How many git reads of a project's worktrees run at once: each spawns 3 to 5 short git processes. */
export const WORKTREE_READS_AT_ONCE = 5;

/** `fn` over `items`, at most `limit` running at once; the answers in `items`' order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}

export interface CodingReadSteps<B, L, W, O> {
  /** A `later` build adopts the worktree its session made (it writes the build's record): the row to read after it. */
  adopt(build: B): Promise<B>;
  /** Where the build's worktree is, or null for one in the project root (read-only; may ask git). */
  locate(build: B): Promise<L | null>;
  /** Git's facts about one located worktree (read-only). */
  read(located: L, build: B): Promise<W>;
  /** The row, once its facts are read: tells the statechart and the merged cache (writes), so one at a time. */
  finish(build: B, located: L | null, reading: W | null): Promise<O>;
}

/** Adopt, one at a time; locate and read side by side, at most `limit`; finish, one at a time, in order. */
export async function readCodingPass<B, L, W, O>(builds: readonly B[], steps: CodingReadSteps<B, L, W, O>, limit = WORKTREE_READS_AT_ONCE): Promise<O[]> {
  const adopted: B[] = [];
  for (const b of builds) adopted.push(await steps.adopt(b));
  const read = await mapLimit(adopted, limit, async (b) => {
    const located = await steps.locate(b);
    return { located, reading: located ? await steps.read(located, b) : null };
  });
  const out: O[] = [];
  for (let i = 0; i < adopted.length; i++) out.push(await steps.finish(adopted[i]!, read[i]!.located, read[i]!.reading));
  return out;
}

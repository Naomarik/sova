/**
 * The working as one timeline: every consecutive run of working rows — thinking, plain tool calls,
 * an orphan result — draws as a single rail with a dot per step, however short the run.
 */

/** A run of consecutive working rows, drawn as one timeline. */
export interface ChainRun {
  /** Index of the run's first row in the list: the id every row of the run shares. */
  at: number;
  /** The run's first row: the rail starts at its dot, and its line carries the expand button. */
  first: boolean;
  /** The run's last row: the rail ends at its dot. */
  last: boolean;
  /** Steps the run DRAWS. A tool result whose call is there draws inside its call's row, so the
      caller never counts it as working; everything counted here is a visible line. */
  steps: number;
}

/**
 * One entry per row: the run it belongs to, or null. `working` says which rows are the working.
 * `skip` rows draw nothing: they get null, never count as steps, and never break a run.
 * Every run is a run, one row long or fifty; `steps` is how many lines it draws.
 */
export function chainRuns(working: readonly boolean[], skip: readonly boolean[] = []): (ChainRun | null)[] {
  const out: (ChainRun | null)[] = working.map(() => null);
  let pending: number[] = [];
  const finish = () => {
    pending.forEach((i, step) => {
      out[i] = { at: pending[0]!, first: step === 0, last: step === pending.length - 1, steps: pending.length };
    });
    pending = [];
  };
  for (let i = 0; i < working.length; i += 1) {
    if (skip[i]) continue;
    if (working[i]) pending.push(i);
    else finish();
  }
  finish();
  return out;
}

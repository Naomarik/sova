/**
 * One write at a time, always of the newest value: the autosave behind a settings screen whose
 * route replaces the whole object. A push while a write is in flight waits, and a later push
 * replaces it, so however fast the edits come the server sees at most one write in flight and
 * the last one it receives is the newest value. Only the newest value's outcome is reported: a
 * write that finished while a newer one was waiting would put the screen back to an older state.
 * Framework-free, so it is tested on its own; the caller keeps its signals in the hooks.
 */
export interface SaveQueueHooks<T, R> {
  send(value: T): Promise<R>;
  /** The newest value was written, and nothing newer is waiting. */
  saved(result: R, value: T): void;
  /**
   * The newest value's write failed. `landed` is the last result of an older write in this run
   * that nobody was told about, if one succeeded: the server holds that, not what came before.
   */
  failed(err: unknown, value: T, landed: R | undefined): void;
  /** True from the first push until nothing is in flight or waiting. */
  busy?(busy: boolean): void;
}

export interface SaveQueue<T> {
  push(value: T): void;
  /** A write is in flight or waiting. */
  pending(): boolean;
  /** Resolves once nothing is in flight or waiting. */
  idle(): Promise<void>;
  /** Forget everything: what is waiting is dropped, and what is in flight reports nothing. */
  reset(): void;
}

export function createSaveQueue<T, R>(hooks: SaveQueueHooks<T, R>): SaveQueue<T> {
  let waiting: { value: T } | null = null;
  let inFlight = false;
  let epoch = 0;
  let landed: { result: R } | null = null;
  let idlers: (() => void)[] = [];

  const settle = () => {
    landed = null;
    hooks.busy?.(false);
    const done = idlers;
    idlers = [];
    for (const resolve of done) resolve();
  };

  const pump = async () => {
    const next = waiting;
    if (inFlight || !next) return;
    waiting = null;
    inFlight = true;
    const mine = epoch;
    let outcome: { ok: true; result: R } | { ok: false; err: unknown };
    try {
      outcome = { ok: true, result: await hooks.send(next.value) };
    } catch (err) {
      outcome = { ok: false, err };
    }
    if (mine !== epoch) return; // reset while in flight
    if (waiting) {
      // Stale: a newer value is waiting, so this outcome would only put the screen back.
      if (outcome.ok) landed = { result: outcome.result };
    } else {
      const older = landed?.result;
      landed = null; // reported, or superseded by this result
      if (outcome.ok) hooks.saved(outcome.result, next.value);
      else hooks.failed(outcome.err, next.value, older);
    }
    // Still in flight during the hooks, so a push from one of them waits here rather than racing.
    inFlight = false;
    if (mine !== epoch) return; // a hook reset the queue
    if (waiting) void pump();
    else settle();
  };

  return {
    push(value) {
      const wasIdle = !inFlight && !waiting;
      waiting = { value };
      if (wasIdle) hooks.busy?.(true);
      void pump();
    },
    pending: () => inFlight || waiting !== null,
    idle: () => (inFlight || waiting ? new Promise<void>((resolve) => idlers.push(resolve)) : Promise.resolve()),
    reset() {
      const was = inFlight || waiting !== null;
      epoch++;
      waiting = null;
      inFlight = false;
      if (was) settle();
      else landed = null;
    },
  };
}

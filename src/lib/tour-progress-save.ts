import type { TourPosition } from "./tour-state";

/**
 * One reader's writes reach the server in navigation order, one at a time. While a write is in
 * flight only the newest waiting position is kept: the positions it supersedes are never sent and
 * their callers settle with its outcome, so rapid navigation ends at the latest place in two writes.
 */
export function createTourProgressSaver<T>(write: (position: TourPosition) => Promise<T>) {
  type Waiter = { resolve(value: T): void; reject(error: unknown): void };
  let tail: Promise<unknown> = Promise.resolve();
  let waiting: { position: TourPosition; waiters: Waiter[] } | null = null;
  return {
    save(position: TourPosition): Promise<T> {
      const snapshot = { ...position };
      return new Promise<T>((resolve, reject) => {
        if (waiting) { waiting.position = snapshot; waiting.waiters.push({ resolve, reject }); return; }
        const batch = waiting = { position: snapshot, waiters: [{ resolve, reject }] };
        tail = tail.catch(() => {}).then(async () => {
          if (waiting === batch) waiting = null;
          try { const value = await write(batch.position); for (const w of batch.waiters) w.resolve(value); }
          catch (error) { for (const w of batch.waiters) w.reject(error); throw error; }
        });
        tail.catch(() => {}); // Observed through save() and settled(), never an unhandled rejection.
      });
    },
    /** Resolves once every save so far has been written; rejects when the newest write failed. */
    settled(): Promise<void> { return tail.then(() => {}); },
  };
}

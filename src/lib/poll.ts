import { createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { recall, remember } from "./page-cache";

/** Delay after the Nth consecutive failure; never shorter than the poll interval itself. */
const BACKOFF_MS = [5000, 15_000, 30_000, 60_000];

export interface Poll<T> {
  /** Last good value; kept on screen through later failures. */
  data: Accessor<T | undefined>;
  /** Message of the latest failure, cleared by the next success. */
  error: Accessor<string | null>;
  /** True until the first fetch settles (either way), even while a remembered value shows. */
  pending: Accessor<boolean>;
  /** The value shown came from this poll (a fetch or `set`), not from what the tab remembered: false
      until then, a failed fetch included. Nothing may act on a remembered value (lib/page-cache). */
  fresh: Accessor<boolean>;
  /** Fetch now and restart the timer (backoff reset). */
  refetch(): void;
  /** Adopt a value obtained elsewhere (a request that returns the new state) as the latest result:
      a fetch in flight is dropped, the error clears, and the timer restarts from now. */
  set(value: T): void;
}

/**
 * Polls `fetcher` every `intervalMs` while the tab is visible. Pauses while hidden and fetches
 * again as soon as it's shown. On failure keeps the previous value and backs off. Each result is
 * reconciled into the last one (objects matched by `id`), so unchanged rows keep their identity
 * and <For> updates them in place: focus and scroll survive a poll. Must be created inside a
 * reactive owner; the timer stops on cleanup.
 *
 * `cacheKey`: the last answer under that key, kept for this browser tab only (lib/page-cache), is
 * shown at once and replaced in place by the first fresh one; `pending` stays true until then.
 */
export function createPoll<T extends object>(fetcher: () => Promise<T>, intervalMs: number, opts: { cacheKey?: string } = {}): Poll<T> {
  const key = opts.cacheKey;
  const cached = key ? recall<T>(key) : undefined;
  const [store, setStore] = createStore<{ value?: T }>(cached ? { value: structuredClone(cached) } : {});
  const keep = (v: T) => key && remember(key, v);
  const data = () => store.value;
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(true);
  const [fresh, setFresh] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let run = 0;
  let stopped = false;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(tick, ms);
  };

  const tick = async () => {
    clearTimeout(timer);
    const mine = ++run;
    try {
      const next = await fetcher();
      if (mine !== run || stopped) return;
      failures = 0;
      setStore("value", reconcile(next, { key: "id" }) as never);
      setFresh(true);
      keep(next);
      setError(null);
    } catch (err) {
      if (mine !== run || stopped) return;
      failures++;
      setError((err as Error).message);
    }
    setPending(false);
    schedule(failures ? Math.max(intervalMs, BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!) : intervalMs);
  };

  const onVisibility = () => {
    if (document.hidden) clearTimeout(timer);
    else void tick();
  };
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  void tick();

  return {
    data,
    error,
    pending,
    fresh,
    refetch() {
      failures = 0;
      void tick();
    },
    set(value) {
      if (stopped) return;
      ++run;
      failures = 0;
      setStore("value", reconcile(value, { key: "id" }) as never);
      setFresh(true);
      keep(value);
      setError(null);
      setPending(false);
      schedule(intervalMs);
    },
  };
}

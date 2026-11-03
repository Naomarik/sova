// The run page's reads (components/MergeRunView.tsx): one run, kept in a store, and a log that follows a step
// while it runs. Each read of the run is reconciled into the last one by `id` (steps are unique per run:
// "copy", "check:unit", …), so a step keeps its identity through every refresh and `<For>` keeps its row,
// with what the row holds: an open log, the focus on its Log button, the scroll inside the log.
import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MergeRun } from "./merge-queue-types";

export interface RunRead {
  /** The run as last read; the same store object (and the same step objects) across reads. */
  run: Accessor<MergeRun | undefined>;
  /** The latest read's failure, cleared by the next success; the last good run stays shown. */
  error: Accessor<unknown>;
  /** Read it now (a queue change); a running run then goes on being read every `pollMs`. */
  refetch(): void;
}

const hidden = () => typeof document !== "undefined" && document.hidden;

/**
 * Reads run `id()` now, again every `pollMs` while its verdict is `running`, and on `refetch`. Pauses
 * while the tab is hidden and reads again once it's shown. A new `id` starts afresh. Must be created
 * inside a reactive owner; the timer stops on cleanup.
 */
export function createRunRead(id: Accessor<string>, read: (id: string) => Promise<MergeRun>, pollMs: number): RunRead {
  const [store, setStore] = createStore<{ run?: MergeRun }>({});
  const [error, setError] = createSignal<unknown>(null);
  const which = createMemo(id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let stopped = false;

  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!stopped && !hidden() && store.run?.verdict === "running") timer = setTimeout(tick, pollMs);
  };
  const tick = async () => {
    clearTimeout(timer);
    const mine = ++seq;
    const want = untrack(which);
    try {
      const next = await read(want);
      if (mine !== seq || stopped) return;
      setStore("run", reconcile(next, { key: "id" }));
      setError(null);
    } catch (err) {
      if (mine !== seq || stopped) return;
      setError(err);
    }
    schedule();
  };

  createEffect(
    on(which, () => {
      ++seq;
      clearTimeout(timer);
      setStore("run", undefined);
      setError(null);
      void tick();
    }),
  );
  const onVisibility = () => {
    if (hidden()) clearTimeout(timer);
    else if (store.run?.verdict === "running") void tick();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  });

  return { run: () => store.run, error, refetch: () => void tick() };
}

export interface FollowedRead {
  /** The text as last read; kept through later reads (no flicker), cleared when `key` goes null. */
  text: Accessor<string | undefined>;
  /** True while a read is out. */
  reading: Accessor<boolean>;
  /** The latest read's failure, cleared by the next success. */
  error: Accessor<string | null>;
}

/**
 * A log, read while `key()` is set: at once, again whenever `key` changes (a step that finished reads once
 * more), and every `everyMs` after each read while `follow()` holds (a step still running). Nothing reads
 * while `key` is null. `key` is a string, so it re-reads only on a real change.
 */
export function createFollowedRead(key: Accessor<string | null>, read: (key: string) => Promise<string>, follow: Accessor<boolean>, everyMs: number): FollowedRead {
  const k = createMemo(key);
  const [text, setText] = createSignal<string | undefined>(undefined);
  const [reading, setReading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let stopped = false;

  const go = async () => {
    clearTimeout(timer);
    const want = untrack(k);
    if (want == null || stopped) return;
    const mine = ++seq;
    setReading(true);
    try {
      const t = await read(want);
      if (mine !== seq || stopped) return;
      setText(t);
      setError(null);
    } catch (err) {
      if (mine !== seq || stopped) return;
      setError(err instanceof Error ? err.message : String(err));
    }
    setReading(false);
    if (untrack(follow) && untrack(k) === want && !stopped) timer = setTimeout(go, everyMs);
  };

  createEffect(
    on(k, (v) => {
      ++seq;
      clearTimeout(timer);
      if (v == null) {
        setText(undefined);
        setError(null);
        setReading(false);
        return;
      }
      void go();
    }),
  );
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
  });
  return { text, reading, error };
}

import { createSignal, onCleanup } from "solid-js";

/**
 * One app-wide "now" that ticks once a minute, for relative times that must stay current (the
 * "· 5m ago" in every message head). One interval however many readers: it starts with the first
 * `useMinuteNow()` and stops when the last reader's owner is disposed.
 */
const TICK_MS = 60_000;
const [now, setNow] = createSignal(Date.now());
let readers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** The minute clock, as an accessor. Call it inside a component (it registers an `onCleanup`). */
export function useMinuteNow(): () => number {
  if (readers++ === 0) {
    setNow(Date.now());
    timer = setInterval(() => setNow(Date.now()), TICK_MS);
  }
  onCleanup(() => {
    if (--readers > 0) return;
    clearInterval(timer);
    timer = undefined;
  });
  return now;
}

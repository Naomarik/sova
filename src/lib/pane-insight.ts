import { batch, createEffect, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SessionInsight } from "../../shared/protocol";
import type { PaneInsight } from "../components/SessionPane";
import { fetchSessionInsight } from "./api";

/** Session insight (outline, teams) reloads this long after the session's file last changed. */
const SESSION_INSIGHT_DEBOUNCE_MS = 1500;
/** While the session pane is open, its worker status and file paths refresh this often. */
const PANE_INSIGHT_POLL_MS = 3000;

/**
 * One session's insight store: loaded at once, `load` now, `reload` debounced after its file
 * changed (the next load to land bumps `changed`), and polled while `polling()` holds. Owned by the
 * caller's reactive scope: its cleanup drops the timers and any load still in flight.
 */
export function createPaneInsight(path: string, polling: () => boolean) {
  const [insight, setInsight] = createStore<PaneInsight>({ data: null, error: null, pending: true, changed: 0 });
  let run = 0;
  /** Set when the file changed; the next load to land says so through `changed`. */
  let fileMoved = false;
  const load = async () => {
    const mine = ++run;
    try {
      const next: SessionInsight = await fetchSessionInsight(path);
      if (mine !== run) return;
      // Keyed by id so open topics stay open when a newer outline lands.
      batch(() => {
        setInsight("data", reconcile(next, { key: "id" }));
        setInsight("error", null);
      });
    } catch (err) {
      // Secondary to the transcript: keep the last outline, the next change retries.
      if (mine !== run) return;
      setInsight("error", (err as Error).message);
    }
    batch(() => {
      setInsight("pending", false);
      if (fileMoved) setInsight("changed", (n) => n + 1);
      fileMoved = false;
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fileMoved = true;
      void load();
    }, SESSION_INSIGHT_DEBOUNCE_MS);
  };
  onCleanup(() => {
    clearTimeout(timer);
    run++;
  });
  void load();
  createEffect(() => {
    if (!polling()) return;
    void load();
    const t = setInterval(() => document.hidden || void load(), PANE_INSIGHT_POLL_MS);
    onCleanup(() => clearInterval(t));
  });
  return { insight, load, reload };
}

import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { ContextInfo, SessionInsight, SessionSummary, TranscriptItem } from "../../shared/protocol";
import { fetchSessionInsight } from "../lib/api";
import { relativeTime } from "../lib/format";
import { SessionDetails } from "./SessionDetails";
import { trapFocus } from "./ui";

/** Relative times in here are minutes-old at most; a slow tick keeps them honest. */
const TICK_MS = 30_000;
/** Same rule as everywhere else: a skeleton only after the fetch has actually been slow. */
const SKELETON_MS = 300;

/**
 * Per-session info modal (spec/04-composer.md §4h): opened from the composer flyout's "Session info"
 * item. Read-only — it reports what this session has spent and what it's made of, and changes
 * nothing.
 *
 *   path     this chat's session file (key for insights/context)
 *   summary  App-level session list row, live (undefined before the list loads)
 *   context  this chat's context fill (ContextGauge's source)
 *   items    this chat's transcript rows (for the model/thinking/mode timeline)
 *   onClose  close and return focus to the flyout trigger
 *   onArchiveChanged  after Archive/Unarchive succeeds: re-read the session list, with the
 *                     session's path and its new archived state
 *   onGroupsChanged  after a group change succeeds: re-read the session list
 */
export function SessionInfoDialog(props: {
  path: string;
  onClose(): void;
  summary?: () => SessionSummary | undefined;
  context?: () => ContextInfo | null;
  items?: () => TranscriptItem[];
  onArchiveChanged?: (path: string, archived: boolean) => void;
  onGroupsChanged?: () => void;
}) {
  const [insight, setInsight] = createSignal<SessionInsight | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [fetchedAt, setFetchedAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [slow, setSlow] = createSignal(false);

  // The dialog is mounted while it's open, so mounting IS opening: reopening refetches, and a
  // path that changes under an open dialog (never today) would too.
  let run = 0;
  const load = async () => {
    const mine = ++run;
    setLoading(true);
    const slowTimer = setTimeout(() => mine === run && setSlow(true), SKELETON_MS);
    try {
      const next = await fetchSessionInsight(props.path);
      if (mine !== run) return;
      setInsight(next);
      setError(null);
      setFetchedAt(Date.now());
    } catch (err) {
      if (mine !== run) return;
      setError((err as Error).message);
    } finally {
      clearTimeout(slowTimer);
      if (mine === run) {
        setLoading(false);
        setSlow(false);
      }
    }
  };
  createEffect(on(() => props.path, () => void load()));

  const tick = setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => {
    run++; // an answer that lands after the close writes to nothing
    clearInterval(tick);
  });

  const close = () => props.onClose();

  return (
    <Portal>
      <div class="scrim" onClick={close} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-info-title"
        tabindex="-1"
        ref={(el) => {
          trapFocus(el);
          queueMicrotask(() => el.focus());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="session-info-title">
            Session info
          </h2>
        </div>

        <div class="modal-body">
          <SessionDetails
            path={props.path}
            insight={insight()}
            error={error()}
            onRetry={() => void load()}
            skeleton={loading() && slow()}
            summary={props.summary?.()}
            context={props.context?.() ?? null}
            items={props.items?.() ?? []}
            now={now()}
            onArchiveChanged={props.onArchiveChanged}
            onGroupsChanged={props.onGroupsChanged}
          />
        </div>

        <div class="modal-foot">
          <Show when={fetchedAt() > 0}>
            <span class="text-caption text-muted">Refreshed {relativeTime(new Date(fetchedAt()).toISOString(), now())}</span>
          </Show>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={() => void load()} aria-disabled={loading() ? "true" : undefined}>
            Refresh
          </button>
          <button type="button" class="button" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}

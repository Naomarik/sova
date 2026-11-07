import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import { RUN_LOGS_KEEP_NEWEST, sizeLabel, type RunLogsInfo } from "../../shared/merge-run-logs";
import { ApiError, cleanRunLogs, fetchRunLogsOfThread } from "../lib/api";
import { mergeChanged } from "../lib/merge-queue-client";
import { leftPopover } from "../lib/popover-focus";
import { toast } from "../lib/ui-state";
import { Icon } from "./ui";
import "./merge-run-logs.css";

/** An error body's own sentence ({error: {message}}), else the status line. */
const said = (err: unknown): string => {
  const b = err instanceof ApiError ? (err.body as { error?: { message?: unknown } } | undefined) : undefined;
  return typeof b?.error?.message === "string" ? b.error.message : err instanceof Error ? err.message : String(err);
};
const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;

/**
 * The merge thread's Run Logs chip (§app.merge-queue/run-logs), in its chat's head and no other chat's: the project's
 * run folders' size, and Clean Logs, which asks first. Shown once the server answers that this chat is the
 * project's merge thread (an earlier thread's chat reads not-found and shows nothing).
 */
export function MergeRunLogsChip(props: { session: string }) {
  const [open, setOpen] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [info, { refetch, mutate }] = createResource(
    () => props.session,
    (s) => fetchRunLogsOfThread(s).catch((): RunLogsInfo | null => null),
  );
  // A run that ended or a clean elsewhere: read the size again (the queue's feed bumps this).
  createEffect(on(mergeChanged, () => void refetch(), { defer: true }));
  let chip: HTMLButtonElement | undefined;
  let ask: HTMLButtonElement | undefined;
  let cancel: HTMLButtonElement | undefined;
  const close = (refocus = false) => {
    setOpen(false);
    setConfirming(false);
    if (refocus) chip?.focus();
  };
  // Swapping the steps unmounts the focused button, which drops focus to <body>: hand it on ourselves.
  const toConfirm = () => {
    setConfirming(true);
    cancel?.focus();
  };
  const toFirst = () => {
    setConfirming(false);
    ask?.focus();
  };
  const clean = async (i: RunLogsInfo) => {
    setBusy(true);
    try {
      const r = await cleanRunLogs(i.project);
      mutate(r.info);
      close();
      chip?.focus();
      toast(r.runs ? `Cleaned the logs of ${runs(r.runs)}: ${sizeLabel(r.freed)} freed.` : "Nothing to clean: every run's logs are still kept.", { key: "run-logs-clean" });
    } catch (err) {
      toast(`Couldn't clean the run logs. ${said(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={info()}>
      {(i) => (
        <span
          class="run-logs-wrap"
          onFocusOut={(e) => {
            const wrap = e.currentTarget;
            const from = e.target as Node;
            const to = e.relatedTarget as Node | null;
            if (to && wrap.contains(to)) return;
            if (to) return close();
            // No next target: a click on nothing, a window switch, or our own step swap removing the focused
            // button. Decide once focus has settled; a removed button's focus loss is not leaving.
            setTimeout(() => {
              const now = document.activeElement;
              const onBody = !now || now === document.body;
              if (leftPopover({ inside: !onBody && !!now && wrap.contains(now), onBody, fromConnected: from.isConnected, windowFocused: document.hasFocus() })) close();
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open()) {
              e.stopPropagation();
              close(true);
            }
          }}
        >
          <button
            type="button"
            ref={chip}
            class="button button-ghost run-logs-chip"
            aria-label={`Run logs ${sizeLabel(i().bytes)}`}
            aria-expanded={open()}
            aria-haspopup="dialog"
            title="The merge queue's run logs for this project"
            onClick={() => {
              if (!open()) void refetch();
              setConfirming(false);
              setOpen(!open());
            }}
          >
            <Icon name="archive" small />
            <span class="run-logs-chip-label">Run logs</span>
            <span class="run-logs-chip-size">{sizeLabel(i().bytes)}</span>
          </button>
          <Show when={open()}>
            <div class="run-logs-popover" role="dialog" aria-label="Run logs">
              <p class="run-logs-sentence">
                <span class="run-logs-figure">{sizeLabel(i().bytes)}</span> in {runs(i().runs)}, {i().packed} packed.
              </p>
              <p class="run-logs-muted">A finished run's logs are packed a day after it ends. Nothing is deleted unless you clean.</p>
              <Show
                when={confirming()}
                fallback={
                  <div class="run-logs-actions">
                    <button
                      type="button"
                      class="button button-sm button-destructive"
                      disabled={!i().cleanable.runs}
                      title={i().cleanable.runs ? undefined : `Nothing to clean: the newest ${RUN_LOGS_KEEP_NEWEST} runs and the runs still in use keep their logs.`}
                      ref={ask}
                      onClick={toConfirm}
                    >
                      Clean Logs…
                    </button>
                  </div>
                }
              >
                <div class="run-logs-confirm" role="group" aria-label="Clean the run logs">
                  <p class="run-logs-sentence">
                    Deletes the logs of {runs(i().cleanable.runs)} ({sizeLabel(i().cleanable.bytes)}). The newest {RUN_LOGS_KEEP_NEWEST} runs, the run checking now, and the runs of entries still open or sent back to fix keep theirs. Every run keeps its record, verdict, and steps.
                  </p>
                  <div class="run-logs-actions">
                    <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => void clean(i())}>
                      {busy() ? "Cleaning…" : "Clean Logs"}
                    </button>
                    <button type="button" class="button button-sm button-ghost" ref={cancel} disabled={busy()} onClick={toFirst}>
                      Cancel
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </span>
      )}
    </Show>
  );
}

import { onCleanup, onMount, Show } from "solid-js";
import type { BackgroundJob } from "../../shared/protocol";
import { fetchSessionJobs, stopSessionJob } from "../lib/api";
import { createJobsState, jobKey, jobRowText } from "../lib/background-jobs";
import { ForKey } from "../lib/for-key";
import { home, toast } from "../lib/ui-state";

/** How often an open Session tab re-reads its chat's jobs: a job's end is the server's to notice. */
const POLL_MS = 5000;

/**
 * The Session tab's Background jobs section (§app.background-jobs/pane): while the chat or one of
 * its workers has a job running, one row per job with what runs, for how long, where its output
 * goes, its worker, and Stop. Absent while none runs. Reading it and Stop start no chat and wake none.
 */
export function BackgroundJobsSection(props: { path: string; now: number; labelId: string }) {
  const state = createJobsState(() => props.path, { list: fetchSessionJobs, stop: stopSessionJob, failed: (t) => toast(t) });
  onMount(() => {
    void state.read();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void state.read();
    }, POLL_MS);
    onCleanup(() => {
      state.dispose();
      clearInterval(timer);
    });
  });
  return (
    <BackgroundJobsView
      jobs={state.jobs()}
      now={props.now}
      home={home()}
      labelId={props.labelId}
      stopping={state.stopping}
      onStop={(j) => void state.stop(j)}
    />
  );
}

/** The section as drawn from a list: nothing at all while the list is empty. */
export function BackgroundJobsView(props: {
  jobs: BackgroundJob[];
  now: number;
  home: string | null;
  labelId: string;
  stopping(job: BackgroundJob): boolean;
  onStop(job: BackgroundJob): void;
}) {
  return (
    <Show when={props.jobs.length > 0}>
      <section class="stack-2" aria-labelledby={props.labelId}>
        <h3 class="text-eyebrow" id={props.labelId}>
          Background jobs
        </h3>
        <ul class="list">
          {/* Keyed by owner and id: each poll's fresh objects update a row in place, so a focused Stop keeps its focus. */}
          <ForKey each={props.jobs} by={jobKey}>
            {(job) => {
              const t = () => jobRowText(job(), props.now, props.home);
              const busy = () => props.stopping(job());
              return (
                <li class="list-row">
                  <div class="list-main">
                    <p class="list-title text-mono" title={t().command}>
                      {t().what}
                    </p>
                    <p class="list-meta">
                      <span class="text-num">{t().howLong}</span>
                      {" · "}
                      <span class={t().outputTitle ? "text-mono" : undefined} title={t().outputTitle ?? undefined}>
                        {t().output}
                      </span>
                      <Show when={t().worker}>
                        {(w) => (
                          <>
                            {" · "}
                            <span class="text-mono">{w()}</span>
                          </>
                        )}
                      </Show>
                    </p>
                  </div>
                  <button
                    type="button"
                    class="button button-sm"
                    disabled={busy()}
                    aria-busy={busy() ? "true" : undefined}
                    aria-label={`Stop job ${job().id}`}
                    onClick={() => props.onStop(job())}
                  >
                    Stop
                  </button>
                </li>
              );
            }}
          </ForKey>
        </ul>
      </section>
    </Show>
  );
}

import { createSignal, For, Show } from "solid-js";
import type { BranchSummary } from "../../shared/merge-queue";
import { retryBranchSummary } from "../lib/merge-queue-requests-client";
import { branchSummaryShown } from "../lib/branch-summary";
import { announce } from "../lib/ui-state";

/**
 * What a branch does, under a row's facts line (the Merge Queue tab's rows and the Worktrees rows): up to 5 bullets,
 * "Summarizing…" while they are written (busy to a screen reader), "From an earlier commit" over an earlier commit's
 * bullets, and "Couldn't summarize this branch" with Try Again after a failure (only then). Nothing else on the row
 * depends on it.
 */
export function BranchSummaryView(props: { summary?: BranchSummary; projectId?: string; branch: string }) {
  const shown = () => branchSummaryShown(props.summary);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const retry = async () => {
    const s = props.summary;
    if (!s || !props.projectId || busy()) return;
    setBusy(true);
    setError(null);
    const r = await retryBranchSummary(props.projectId, props.branch, s.commit);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      announce(`Try Again refused: ${r.message}`);
    } else announce(`Summarizing ${props.branch}.`);
  };
  return (
    <Show when={shown()}>
      {(v) => (
        <div class="mq-summary" data-summary={v().line}>
          <Show when={v().line === "writing"}>
            <p class="mq-summary-line text-caption text-muted" role="status" aria-busy="true">
              Summarizing…
            </p>
          </Show>
          <Show when={v().line === "failed"}>
            <p class="mq-summary-line text-caption">
              <span>Couldn't summarize this branch.</span>
              <Show when={props.projectId}>
                {" "}
                <button type="button" class="button button-sm button-ghost mq-summary-retry" aria-label={`Try summarizing ${props.branch} again`} disabled={busy()} aria-busy={busy() ? "true" : undefined} onClick={() => void retry()}>
                  Try Again
                </button>
              </Show>
            </p>
          </Show>
          <Show when={v().bullets.length > 0}>
            <Show when={v().stale}>
              <p class="mq-summary-stale text-caption text-muted">From an earlier commit</p>
            </Show>
            <ul class="mq-summary-bullets" classList={{ "mq-summary-old": v().stale }} aria-label={`What ${props.branch} does`}>
              <For each={v().bullets}>{(b) => <li>{b}</li>}</For>
            </ul>
          </Show>
          <Show when={error()}>{(m) => <p class="mq-summary-line text-caption mq-error" role="alert">{m()}</p>}</Show>
        </div>
      )}
    </Show>
  );
}

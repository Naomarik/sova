import { Match, Show, Switch } from "solid-js";
import type { ExplanationInfo } from "../../shared/protocol";
import { explainHref, explainModel, explainState } from "../lib/explain";
import { capTitle } from "../lib/workers";
import { Chip, Icon } from "./ui";
import "../explain.css";

/**
 * An explanation's transcript row, in the report-row grammar (one line: label, topic). The whole
 * row is the link to its standalone page, opened in place (a new tab would strand an installed
 * app's back button); the page outlives the session.
 *
 * Four states, and the difference between the last two matters:
 * - running (`status: "running"`) — the explainer is still writing. The page doesn't exist yet,
 *   so the row isn't a link: it reads Explaining, with the live pulse where the chevron sits.
 *   The same id's finished entry replaces this row in place when the run settles.
 * - ok — the page is there; the row is a link.
 * - failed (`error`) — the run wrote no servable page. Nothing to open, so the row isn't a link
 *   at all: it carries a Failed chip and the explainer's reason in its place.
 * - noted (`note`) — the page is complete and good, but the run then errored or was aborted (a
 *   worker killed right after writing, say). The page is the deliverable, so the link stays and
 *   the note sits under the row as a muted advisory — not a failure.
 */
export function ExplainCard(props: { explain: ExplanationInfo }) {
  const state = () => explainState(props.explain);
  /** Tooltip only, so the row keeps its single line; absent when the entry names no model. */
  const modelTitle = () => {
    const model = explainModel(props.explain);
    return model ? `${running() ? "Explaining with" : "Explained by"} ${model}` : undefined;
  };
  const running = () => state() === "running";
  const row = () => (
    <>
      <Show when={running()} fallback={<Icon name="chevron-right" small />}>
        <span class="explain-card-live" aria-hidden="true">
          <span class="live-dot" />
        </span>
      </Show>
      <span class="report-from">{running() ? "Explaining" : "Explained"}</span>
      <Show when={state() === "failed"}>
        <Chip tone="error">Failed</Chip>
      </Show>
      <Show when={props.explain.topic}>
        <span class="disclosure-preview">{props.explain.topic}</span>
      </Show>
    </>
  );
  return (
    <div class="disclosure report explain-card">
      <Switch>
        {/* No page yet, so nothing to link to; the finished entry replaces this row. */}
        <Match when={running()}>
          <div class="disclosure-summary report-summary explain-card-summary explain-card-running" title={capTitle(modelTitle())}>
            {row()}
          </div>
        </Match>
        <Match when={state() === "failed"}>
          {/* The entry names its model on a failed run too, and which model failed is worth knowing. */}
          <div class="disclosure-summary report-summary explain-card-summary explain-card-failed" title={capTitle(modelTitle())}>
            {row()}
          </div>
          <p class="report-error">{props.explain.error}</p>
        </Match>
        <Match when={true}>
          {/* The row stays one line: the producing model lives in the tooltip, not in the preview. */}
          <a
            class="disclosure-summary report-summary explain-card-summary"
            href={explainHref(props.explain.id)}
            title={capTitle(modelTitle())}
          >
            <span class="visually-hidden">Explanation: </span>
            {row()}
          </a>
          <Show when={props.explain.note}>{(note) => <p class="report-meta explain-card-note">{note()}</p>}</Show>
        </Match>
      </Switch>
    </div>
  );
}

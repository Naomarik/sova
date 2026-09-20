import { Show } from "solid-js";
import type { ExplanationInfo } from "../../shared/protocol";
import { explainHref, explainModel, explainState } from "../lib/explain";
import { capTitle } from "../lib/workers";
import { Chip, Icon } from "./ui";
import "../explain.css";

/**
 * An explanation's transcript row, in the report-row grammar (one line: label, topic). The whole
 * row is the link to its standalone page, opened in a new tab: the explainer never takes over the
 * session's own tab, and the page outlives the session.
 *
 * Three states, and the difference between the last two matters:
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
    return model ? `Explained by ${model}` : undefined;
  };
  const row = () => (
    <>
      <Icon name="chevron-right" small />
      <span class="report-from">Explained</span>
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
      <Show
        when={state() !== "failed"}
        fallback={
          <>
            {/* The entry names its model on a failed run too, and which model failed is worth knowing. */}
            <div class="disclosure-summary report-summary explain-card-summary explain-card-failed" title={capTitle(modelTitle())}>
              {row()}
            </div>
            <p class="report-error">{props.explain.error}</p>
          </>
        }
      >
        {/* The row stays one line: the producing model lives in the tooltip, not in the preview. */}
        <a
          class="disclosure-summary report-summary explain-card-summary"
          href={explainHref(props.explain.id)}
          target="_blank"
          rel="noopener"
          title={capTitle(modelTitle())}
        >
          <span class="visually-hidden">Explanation, opens in a new tab: </span>
          {row()}
          <Icon name="external" small class="explain-card-external" />
        </a>
        <Show when={props.explain.note}>{(note) => <p class="report-meta explain-card-note">{note()}</p>}</Show>
      </Show>
    </div>
  );
}

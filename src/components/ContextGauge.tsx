import { Show } from "solid-js";
import type { ContextInfo } from "../../shared/protocol";
import { contextSentence, contextStep, formatPercent, formatTokens } from "../lib/context";
import { sessionContext } from "../lib/ui-state";
import { paneScopedId, usePaneId, type PaneScope } from "../lib/pane-scope";
import { Icon } from "./ui";

/** The shown state for a session, or null when there's nothing to show (no reply yet / unknown). */
const stateOf = (path: string) => sessionContext()[path] ?? null;

const stepOf = (s: ContextInfo | "compacted") => (s === "compacted" ? "" : contextStep(s.tokens, s.window));

/** The short form: "24%", or "237k" without a window, or "compacted". */
function shortText(s: ContextInfo | "compacted"): string {
  if (s === "compacted") return "compacted";
  return s.window ? `${formatPercent(s.tokens, s.window)}%` : formatTokens(s.tokens);
}

/** The full value: "237k / 1M · 24%", or "237k" without a window, or "compacted". */
function fullText(s: ContextInfo | "compacted"): string {
  if (s === "compacted") return "compacted";
  return s.window ? `${formatTokens(s.tokens)} / ${formatTokens(s.window)} · ${formatPercent(s.tokens, s.window)}%` : formatTokens(s.tokens);
}

/** `aria-describedby` for the session title: only while a context sentence exists. The sentence
    is the gauge's, so in a workspace it carries that pane's id like every other. */
export const contextDescribedBy = (path: string, scope?: PaneScope) =>
  stateOf(path) ? (scope ? paneScopedId(scope, "context-desc") : "context-desc") : undefined;

/** The readout itself, one copy of the markup for every place that shows it. Its visible parts
    are aria-hidden: the caller gives AT the one sentence. */
function Gauge(props: { s: ContextInfo | "compacted"; class?: string }) {
  return (
    <span
      class={`context-gauge ${props.s === "compacted" ? "context-compacted" : stepOf(props.s)} ${props.class ?? ""}`.trim()}
      title={contextSentence(props.s)}
    >
      <Show when={stepOf(props.s) === "context-error"}>
        <Icon name="alert-circle" small />
      </Show>
      <span class="context-label" aria-hidden="true">
        Context
      </span>
      <span class="context-value" aria-hidden="true">
        {fullText(props.s)}
      </span>
      <span class="context-pct" aria-hidden="true">
        {shortText(props.s)}
      </span>
    </span>
  );
}

/**
 * The head's context readout: plain text, never a bar, never animated. All
 * visible copies are aria-hidden; AT gets the one #context-desc sentence. CSS collapses it by the
 * head's width (full → percent → moves to the meta line).
 */
export function ContextGauge(props: { path: string }) {
  const paneId = usePaneId();
  return (
    <Show when={stateOf(props.path)}>
      {(s) => (
        <>
          <Gauge s={s()} />
          <span class="visually-hidden" id={paneId("context-desc")}>
            {contextSentence(s())}
          </span>
        </>
      )}
    </Show>
  );
}

/**
 * The same readout for a state the caller holds rather than a session's (a worker's, in the
 * subagents pane's view head). The sentence rides inline, visually hidden, as the gauge's words.
 */
export function ContextReadout(props: { state: ContextInfo | "compacted"; class?: string }) {
  return (
    <span class="context-readout">
      <Gauge s={props.state} class={props.class} />
      <span class="visually-hidden">{contextSentence(props.state)}</span>
    </span>
  );
}

/** The meta-line copy for narrow heads ("24% · ~/cwd"); CSS shows it only under 520px. */
export function ContextMetaPrefix(props: { path: string }) {
  return (
    <Show when={stateOf(props.path)}>
      {(s) => (
        <>
          <span class={`context-meta ${stepOf(s())}`.trim()} aria-hidden="true">
            {shortText(s())}
          </span>
          <span class="context-meta" aria-hidden="true">
            ·
          </span>
        </>
      )}
    </Show>
  );
}

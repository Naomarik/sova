import { Show } from "solid-js";
import type { ContextInfo } from "../../shared/protocol";
import { contextSentence, contextStep, formatPercent, formatTokens } from "../lib/context";
import { sessionContext } from "../lib/ui-state";
import { paneScopedId, usePaneId, type PaneScope } from "../lib/pane-scope";
import { ContextRing } from "./ContextRing";
import { Icon } from "./ui";

/** The shown state for a session, or null when there's nothing to show (no reply yet / unknown). */
const stateOf = (path: string) => sessionContext()[path] ?? null;

const stepOf = (s: ContextInfo | "compacted") => (s === "compacted" ? "" : contextStep(s.tokens, s.window));

/** The worker readout's short form: "24%", or "237k" without a window, or "compacted". */
function shortText(s: ContextInfo | "compacted"): string {
  if (s === "compacted") return "compacted";
  return s.window ? `${formatPercent(s.tokens, s.window)}%` : formatTokens(s.tokens);
}

/** `aria-describedby` for the session title: only while a context sentence exists. The sentence
    is the gauge's, so in a workspace it carries that pane's id like every other. */
export const contextDescribedBy = (path: string, scope?: PaneScope) =>
  stateOf(path) ? (scope ? paneScopedId(scope, "context-desc") : "context-desc") : undefined;

/** The head's readout: the list's ring (with a window, never when compacted) and the token count,
    "222k", with " / 1M" that CSS shows only on a 720px head. No percent: that is the title's.
    Its visible parts are aria-hidden: the caller gives AT the one sentence. */
function Gauge(props: { s: ContextInfo | "compacted" }) {
  const info = () => (props.s === "compacted" ? null : props.s);
  return (
    <span class={`context-gauge ${props.s === "compacted" ? "context-compacted" : stepOf(props.s)}`.trim()} title={contextSentence(props.s)}>
      <Show when={stepOf(props.s) === "context-error"}>
        <Icon name="alert-circle" small />
      </Show>
      <Show when={info()?.window ? info() : null}>{(c) => <ContextRing info={c()} />}</Show>
      <span class="context-value" aria-hidden="true">
        <Show when={info()} fallback="compacted">
          {(c) => (
            <>
              {formatTokens(c().tokens)}
              <Show when={c().window}>{(w) => <span class="context-of"> / {formatTokens(w())}</span>}</Show>
            </>
          )}
        </Show>
      </span>
    </span>
  );
}

/**
 * The context readout of every session head (chat, watch, workspace pane, both overseers):
 * never a bar alone, never animated, always in the head row. Its visible parts are aria-hidden;
 * AT gets the one #context-desc sentence.
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
 * subagents pane's view head), in its compact form: the list's ring and the percent, the full
 * sentence in the `title`. Without a ring to draw (no window, or just compacted) it keeps the
 * gauge's words. The sentence rides inline, visually hidden, for AT.
 */
export function ContextReadout(props: { state: ContextInfo | "compacted"; class?: string }) {
  const ring = () => (props.state !== "compacted" && props.state.window ? props.state : null);
  return (
    <span class="context-readout">
      <Show
        when={ring()}
        fallback={
          <span class={`context-gauge ${props.state === "compacted" ? "context-compacted" : ""} ${props.class ?? ""}`.trim()} title={contextSentence(props.state)}>
            <span class="context-label" aria-hidden="true">
              Context
            </span>
            <span class="context-value" aria-hidden="true">
              {shortText(props.state)}
            </span>
          </span>
        }
      >
        {(c) => (
          <span class={`context-compact ${stepOf(c())} ${props.class ?? ""}`.trim()} title={contextSentence(c())}>
            <ContextRing info={c()} />
            <span class="context-pct" aria-hidden="true">
              {shortText(c())}
            </span>
          </span>
        )}
      </Show>
      <span class="visually-hidden">{contextSentence(props.state)}</span>
    </span>
  );
}

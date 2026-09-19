import { createSignal, For, Show } from "solid-js";
import type { OutlineTopic, SessionOutline } from "../../shared/protocol";
import { relativeTime, stampTime } from "../lib/format";
import { Icon } from "./ui";

const OPEN_KEY = "pi-web:outline-open:";

const STATE_CLAUSE: Partial<Record<SessionOutline["state"], string>> = {
  stale: "behind the latest messages",
  "failed-keeping-last": "the last update failed, so this is the previous outline",
};

/** The rendered transcript row for a session entry (assistant blocks are `<entryId>:<i>`). */
function entryElement(entryId: string): HTMLElement | null {
  const root = document.getElementById("transcript");
  if (!root) return null;
  const esc = CSS.escape(entryId);
  const wrap = root.querySelector<HTMLElement>(`[data-entry="${esc}"], [data-entry^="${esc}:"]`);
  return (wrap?.firstElementChild as HTMLElement | null) ?? null;
}

function Topic(props: { topic: OutlineTopic }) {
  // Whether the anchor is in the transcript is checked when the topic opens: it may have been
  // compacted away, and the transcript renders after this strip.
  const [target, setTarget] = createSignal(false);
  const jump = () => {
    const el = props.topic.entryId ? entryElement(props.topic.entryId) : null;
    if (!el) return setTarget(false);
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const at = () => new Date(props.topic.at).toISOString();
  return (
    <li>
      <details class="outline-topic" onToggle={(e) => e.currentTarget.open && setTarget(!!props.topic.entryId && !!entryElement(props.topic.entryId))}>
        <summary class="outline-topic-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="outline-topic-heading">
            <Show when={props.topic.manual}>
              <span class="outline-hash" aria-hidden="true">
                #
              </span>
            </Show>
            {props.topic.heading}
          </span>
          <Show when={props.topic.at > 0}>
            <span class="outline-topic-time" title={at()}>
              {stampTime(at())}
            </span>
          </Show>
        </summary>
        <Show when={props.topic.bullets.length > 0}>
          <ul class="outline-bullets">
            <For each={props.topic.bullets}>{(b) => <li>{b}</li>}</For>
          </ul>
        </Show>
        <Show when={target()}>
          <button type="button" class="button button-sm button-ghost outline-jump" onClick={jump}>
            Jump to Message
          </button>
        </Show>
      </details>
    </li>
  );
}

/**
 * topic-outline for the open session, under `.session-head`. Collapsed it shows the "now" line;
 * open, the overall gist and topics. The open state is kept per session for the tab.
 */
export function OutlineStrip(props: { path: string; outline: SessionOutline; now: number }) {
  const key = () => OPEN_KEY + props.path;
  const topics = () => props.outline.topics.length;
  /** A summarizer is running now. */
  const updating = () => props.outline.state === "updating" || props.outline.state === "drafting";
  const updated = () => (props.outline.generatedAt > 0 ? new Date(props.outline.generatedAt).toISOString() : null);
  return (
    <details
      class="outline"
      open={sessionStorage.getItem(key()) === "1"}
      onToggle={(e) => sessionStorage.setItem(key(), e.currentTarget.open ? "1" : "0")}
    >
      <summary class="outline-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="outline-label">Outline</span>
        <Show when={updating()}>
          <span class="live-dot" />
        </Show>
        <span class="outline-now" title={props.outline.now}>
          <Show when={props.outline.now}>· {props.outline.now}</Show>
        </span>
        <span class="outline-count">
          {topics()} {topics() === 1 ? "topic" : "topics"}
        </span>
      </summary>
      <div class="outline-body">
        <Show when={props.outline.overall}>
          <p class="outline-overall">{props.outline.overall}</p>
        </Show>
        <Show
          when={!updating()}
          fallback={<p class="outline-state">Updating</p>}
        >
          <Show when={updated()}>
            {(u) => (
              <p class="outline-state">
                <span title={u()}>Updated {relativeTime(u(), props.now)}</span>
                <Show when={STATE_CLAUSE[props.outline.state]}>{(c) => <> · {c()}</>}</Show>
              </p>
            )}
          </Show>
        </Show>
        <ol class="outline-topics">
          <For each={props.outline.topics}>{(t) => <Topic topic={t} />}</For>
        </ol>
      </div>
    </details>
  );
}

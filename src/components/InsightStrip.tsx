import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ExplanationInfo, OutlineTopic, SessionOutline } from "../../shared/protocol";
import { newestTopics, topicTime } from "../../shared/outline-order";
import { newestFirst } from "../lib/explain";
import { explanationsHref } from "../lib/insights";
import type { KnownOutline } from "../lib/known-before-mount";
import { hasEntryRow, jumpWhenArrived, rowsOlder, transcriptRoot } from "../lib/jump";
import { relativeTime, stampTime } from "../lib/format";
import { Icon } from "./ui";

const STATE_CLAUSE: Partial<Record<SessionOutline["state"], string>> = {
  stale: "behind the latest messages",
  "failed-keeping-last": "the last update failed, so this is the previous summary",
};

function Topic(props: { topic: OutlineTopic; now: number; open: boolean; path: string }) {
  // Whether the anchor is in the transcript is checked each time the strip opens: it may have been
  // compacted away, and the transcript renders after this strip. It asks the transcript's rows, not
  // the DOM: an older row may not be built yet, and the jump builds it. A topic that arrives while
  // the strip is open mounts with `open` already true, so it is checked too.
  const [target, setTarget] = createSignal(false);
  createEffect(() => {
    // While the transcript may have older rows it doesn't hold, the row may be among them:
    // offered, and the jump fetches them down to it.
    const root = () => transcriptRoot(props.path);
    if (props.open) setTarget(!!props.topic.entryId && (hasEntryRow(props.topic.entryId, root()) || rowsOlder(root())));
  });
  const jump = () => {
    // Gone since the strip opened (compacted away): the button goes rather than scrolling nowhere.
    if (!props.topic.entryId) return setTarget(false);
    jumpWhenArrived(props.topic.entryId, props.path, () => setTarget(false));
  };
  // The topic's own section, not the summarizer's clock (topicTime falls back to it).
  const at = () => new Date(topicTime(props.topic)).toISOString();
  return (
    <li class="outline-topic">
      <div class="outline-topic-head">
        <span class="outline-topic-heading">
          <Show when={props.topic.manual}>
            <span class="outline-hash" aria-hidden="true">
              #
            </span>
          </Show>
          {props.topic.heading}
        </span>
        <Show when={topicTime(props.topic) > 0}>
          {/* Delta, not a clock: the same formatter the session rows use, fed the strip's shared `now`. */}
          <span class="outline-topic-time" title={`${stampTime(at(), props.now)} · ${at()}`}>
            {relativeTime(at(), props.now)}
          </span>
        </Show>
      </div>
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
    </li>
  );
}

/**
 * The one insight row under `.session-head`: the session's current goal (the newest topic-outline
 * summary) and its /explain artifacts merged into a single disclosure, so the head costs one row
 * instead of two. Collapsed it shows the "now" line and whichever counts exist; open — one click,
 * nothing nested — the overall gist, every topic flat with its bullets, a ghost button that opens
 * the session pane's Timeline tab, where the past summaries live, and, when this session has
 * explanations, a link to the Explanations page filtered to this session. The open state is never
 * persisted: a click away, Esc from inside, or leaving the session all leave it closed again.
 *
 * With explanations but no outline the row still discloses, labelled "Explained": the
 * Explanations link is what's inside. With neither, nothing renders.
 *
 * Until the session's insight lands, `known` stands in for the outline: the session list's
 * snapshot, so the row is there at its full height from the view's first frame. It fills the
 * collapsed row and the gist; the topics come with the insight.
 */
export function InsightStrip(props: {
  /** The session this strip summarises: which transcript a topic's jump lands in. */
  path: string;
  /** The session's id: the Explanations page's filter for it (`#/explanations/<id>`). */
  sessionId: string;
  outline: SessionOutline | null;
  /** The outline as the session list has it, while `outline` is not loaded yet (null: none). */
  known?: KnownOutline | null;
  explanations: ExplanationInfo[] | undefined;
  now: number;
  /** Opens the session pane's Timeline tab, where these topics are chapters on the session's axis. */
  onOpenTimeline?(): void;
}) {
  // Not persisted: the session view is keyed, so navigating anywhere remounts this closed, while
  // an insight reload keeps a deliberate open.
  const [open, setOpen] = createSignal(false);
  onMount(() => {
    const away = (e: PointerEvent) => {
      const target = e.target;
      if (!open() || !(target instanceof Element)) return;
      // On press, not click: the strip goes the moment you reach elsewhere.
      if (target.closest(".outline")) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only an Esc that started inside the strip is ours — the pane, Inputs and dialogs keep theirs.
      const target = e.target;
      if (target instanceof Element && target.closest(".outline")) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    });
  });
  const items = () => newestFirst(props.explanations ?? []);
  const latest = () => items()[0];
  /** The collapsed row's outline: the loaded one, else what the list knows of it. */
  const head = () => (props.outline ? { now: props.outline.now, topics: props.outline.topics.length } : (props.known ?? null));
  const topics = () => head()?.topics ?? 0;
  /** A summarizer is running now. */
  const updating = () => props.outline?.state === "updating" || props.outline?.state === "drafting";
  const generated = () => props.outline?.generatedAt ?? 0;
  const updated = () => (generated() > 0 ? new Date(generated()).toISOString() : null);
  return (
    <Show when={head() || items().length > 0}>
      <details class="outline" open={open()} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary class="outline-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="outline-label">{head() ? "Current goal" : "Explained"}</span>
          <Show when={updating()}>
            <span class="live-dot" />
          </Show>
          <Show
            when={head()}
            // No outline: the row reads as the explain strip did — count, then the latest topic
            // in the line that ellipsizes.
            fallback={
              <>
                <span class="outline-count">· {items().length}</span>
                <Show when={latest()}>{(l) => <span class="outline-now">· {l().topic}</span>}</Show>
              </>
            }
          >
            {(o) => (
              <>
                <span class="outline-now" title={o().now}>
                  <Show when={o().now}>· {o().now}</Show>
                </span>
                <span class="outline-count">
                  {topics()} {topics() === 1 ? "topic" : "topics"}
                </span>
                <Show when={items().length > 0}>
                  <span class="outline-count outline-explained">· Explained {items().length}</span>
                </Show>
              </>
            )}
          </Show>
        </summary>
        <div class="outline-body">
          <div class="outline-column">
            {/* Beside the Explanations link and laid out by the same class: one ghost button rule
                for the two openers this body carries. */}
            <Show when={props.onOpenTimeline}>
              <button type="button" class="button button-sm button-ghost outline-explained-open" onClick={() => props.onOpenTimeline?.()}>
                <Icon name="clock" small />
                Open Timeline
              </button>
            </Show>
            <Show when={items().length > 0}>
              <a class="button button-sm button-ghost outline-explained-open" href={explanationsHref(props.sessionId)}>
                <Icon name="external" small />
                Open {items().length} {items().length === 1 ? "Explanation" : "Explanations"}
              </a>
              <Show when={latest()}>
                {(l) => (
                  <p class="outline-state">
                    Latest · {l().topic}
                    <Show when={l().createdAt}>{(c) => <> · {relativeTime(new Date(c()).toISOString(), props.now)}</>}</Show>
                  </p>
                )}
              </Show>
            </Show>
            <Show when={!props.outline && props.known?.gist}>{(g) => <p class="outline-overall">{g()}</p>}</Show>
            <Show when={props.outline}>
              {(o) => (
                <>
                  <Show when={o().overall}>
                    <p class="outline-overall">{o().overall}</p>
                  </Show>
                  <Show when={!updating()} fallback={<p class="outline-state">Updating</p>}>
                    <Show when={updated()}>
                      {(u) => (
                        <p class="outline-state">
                          <span title={u()}>Updated {relativeTime(u(), props.now)}</span>
                          <Show when={STATE_CLAUSE[o().state]}>{(c) => <> · {c()}</>}</Show>
                        </p>
                      )}
                    </Show>
                  </Show>
                  <ol class="outline-topics">
                    <For each={newestTopics(o().topics)}>{(t) => <Topic topic={t} now={props.now} open={open()} path={props.path} />}</For>
                  </ol>
                </>
              )}
            </Show>
          </div>
        </div>
      </details>
    </Show>
  );
}

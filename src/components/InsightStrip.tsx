import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ExplanationInfo, OutlineTopic, SessionOutline } from "../../shared/protocol";
import { newestFirst } from "../lib/explain";
import { findEntryRow, jumpToEntry } from "../lib/jump";
import { relativeTime, stampTime } from "../lib/format";
import { ExplainGallery } from "./ExplainGallery";
import { Icon } from "./ui";

const STATE_CLAUSE: Partial<Record<SessionOutline["state"], string>> = {
  stale: "behind the latest messages",
  "failed-keeping-last": "the last update failed, so this is the previous outline",
};

function Topic(props: { topic: OutlineTopic; now: number }) {
  // Whether the anchor is in the transcript is checked when the topic opens: it may have been
  // compacted away, and the transcript renders after this strip.
  const [target, setTarget] = createSignal(false);
  const jump = () => {
    // Gone since the strip opened (compacted away): the button goes rather than scrolling nowhere.
    if (!props.topic.entryId || !jumpToEntry(props.topic.entryId)) setTarget(false);
  };
  const at = () => new Date(props.topic.at).toISOString();
  return (
    <li>
      <details class="outline-topic" onToggle={(e) => e.currentTarget.open && setTarget(!!props.topic.entryId && !!findEntryRow(props.topic.entryId))}>
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
            {/* Delta, not a clock: the same formatter the session rows use, fed the strip's shared `now`. */}
            <span class="outline-topic-time" title={`${stampTime(at(), props.now)} · ${at()}`}>
              {relativeTime(at(), props.now)}
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
 * The one insight row under `.session-head`: the session's topic-outline and its /explain
 * artifacts merged into a single disclosure, so the head costs one row instead of two.
 * Collapsed it shows the "now" line and whichever counts exist; open, the overall gist, the
 * topics, a ghost button that opens the session pane's Timeline tab — the same topics as
 * chapters on one axis — and, when this session has explanations, one that opens the gallery
 * dialog. The open state is never persisted: a click away, Esc from inside, or leaving the
 * session all leave it closed again.
 *
 * With explanations but no outline the row still discloses, labelled "Explained": the gallery
 * button is what's inside. With neither, nothing renders.
 */
export function InsightStrip(props: {
  outline: SessionOutline | null;
  explanations: ExplanationInfo[] | undefined;
  now: number;
  /** Opens the session pane's Timeline tab, where these topics are chapters on the session's axis. */
  onOpenTimeline?(): void;
}) {
  const [galleryOpen, setGalleryOpen] = createSignal(false);
  // Not persisted: the session view is keyed, so navigating anywhere remounts this closed, while
  // an insight reload keeps a deliberate open.
  const [open, setOpen] = createSignal(false);
  let strip: HTMLDetailsElement | undefined;
  /** The one close path: every dismissal collapses the topics too, so the next open lands on headings. */
  const close = () => {
    setOpen(false);
    // `Topic`'s onToggle only reacts on open, so closing them from here is a no-op for it.
    for (const t of strip?.querySelectorAll<HTMLDetailsElement>("details.outline-topic[open]") ?? []) t.open = false;
  };
  onMount(() => {
    const away = (e: PointerEvent) => {
      const target = e.target;
      if (!open() || !(target instanceof Element)) return;
      // On press, not click: the strip goes the moment you reach elsewhere. The gallery dialog is
      // portalled out of the strip, so its shell and scrim count as inside.
      if (target.closest(".outline, .modal, .scrim")) return;
      close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only an Esc that started inside the strip is ours — the pane, Inputs and dialogs keep theirs.
      const target = e.target;
      if (target instanceof Element && target.closest(".outline")) close();
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
  const topics = () => props.outline?.topics.length ?? 0;
  /** A summarizer is running now. */
  const updating = () => props.outline?.state === "updating" || props.outline?.state === "drafting";
  const generated = () => props.outline?.generatedAt ?? 0;
  const updated = () => (generated() > 0 ? new Date(generated()).toISOString() : null);
  return (
    <Show when={props.outline || items().length > 0}>
      <details ref={strip} class="outline" open={open()} onToggle={(e) => (e.currentTarget.open ? setOpen(true) : close())}>
        <summary class="outline-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="outline-label">{props.outline ? "Outline" : "Explained"}</span>
          <Show when={updating()}>
            <span class="live-dot" />
          </Show>
          <Show
            when={props.outline}
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
          {/* Beside the gallery button and laid out by the same class: one ghost button rule for
              the two openers this body carries. */}
          <Show when={props.onOpenTimeline}>
            <button type="button" class="button button-sm button-ghost outline-explained-open" onClick={() => props.onOpenTimeline?.()}>
              <Icon name="clock" small />
              Open Timeline
            </button>
          </Show>
          <Show when={items().length > 0}>
            <button
              type="button"
              class="button button-sm button-ghost outline-explained-open"
              aria-haspopup="dialog"
              onClick={() => setGalleryOpen(true)}
            >
              <Icon name="external" small />
              Open {items().length} {items().length === 1 ? "Explanation" : "Explanations"}
            </button>
            <Show when={latest()}>
              {(l) => (
                <p class="outline-state">
                  Latest · {l().topic}
                  <Show when={l().createdAt}>{(c) => <> · {relativeTime(new Date(c()).toISOString(), props.now)}</>}</Show>
                </p>
              )}
            </Show>
          </Show>
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
                  <For each={o().topics}>{(t) => <Topic topic={t} now={props.now} />}</For>
                </ol>
              </>
            )}
          </Show>
        </div>
      </details>
      <Show when={galleryOpen()}>
        <ExplainGallery explanations={items()} scope="session" now={props.now} onClose={() => setGalleryOpen(false)} />
      </Show>
    </Show>
  );
}

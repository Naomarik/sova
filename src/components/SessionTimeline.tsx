import { createSignal, For, onCleanup, Show } from "solid-js";
import type { SessionOutline, TranscriptItem } from "../../shared/protocol";
import { clockTime, relativeTime } from "../lib/format";
import { jumpToEntry } from "../lib/jump";
import { absoluteTime } from "../lib/spend";
import { timelineRows, timelineState, type TimelineRow } from "../lib/timeline";
import { toast } from "../lib/ui-state";
import { capTitle } from "../lib/workers";

const DRAWER = "(max-width: 1279px)";
/** Below the column band the pane is a drawer over the transcript, so a jump would land behind it
    (the same read the Inputs tab makes). */
const isDrawer = () => window.matchMedia(DRAWER).matches;

/**
 * The Timeline tab: one time axis for the whole session, oldest first. Every user message is a
 * row that jumps to it in the transcript, with a density line under it; the outline's topics sit
 * beside the message each is anchored to; compactions, subagents spawned and retired, and
 * model/thinking/mode changes are markers; a quiet stretch becomes a dotless "idle 38m".
 *
 * The rhythm is fixed — a row is a row, whatever the span before it — so a long night and a long
 * afternoon read the same. Read-only throughout: Inputs stays the pane's only writing surface,
 * and every decision behind these rows is in src/lib/timeline.ts.
 */
export function SessionTimeline(props: {
  /** The shared transcript read, from the pane; null until the first load settles. */
  items: TranscriptItem[] | null;
  outline: SessionOutline | null;
  /** True until the pane's insight has settled: the empty state waits for it. */
  pending: boolean;
  now: number;
  /** Closes the pane: a jump from the drawer band would otherwise land behind it. */
  onClose(): void;
}) {
  const rows = () => timelineRows(props.items ?? [], props.outline);
  const state = () => timelineState(props.outline, props.now);

  // The foot line tells the reader the pane closes on a jump only where it does. Live, so a
  // window resized across the band doesn't leave the wrong sentence standing.
  const query = window.matchMedia(DRAWER);
  const [drawer, setDrawer] = createSignal(query.matches);
  const onBand = (e: MediaQueryListEvent) => setDrawer(e.matches);
  query.addEventListener("change", onBand);
  onCleanup(() => query.removeEventListener("change", onBand));

  const jump = (entryId: string | undefined) => {
    if (!entryId || !jumpToEntry(entryId)) return toast("That message isn't in the transcript on screen.");
    if (isDrawer()) props.onClose();
  };

  return (
    <div class="session-panel-scroll" tabindex="0">
      <Show when={state()}>
        {(s) => (
          <p class="timeline-state" title={s().title || undefined}>
            {s().text}
          </p>
        )}
      </Show>
      <Show
        when={rows().length > 0}
        fallback={
          <Show when={props.items && !props.pending}>
            <div class="empty subagents-empty">
              <p class="empty-title">0 messages in this session yet.</p>
              <p class="empty-body">The timeline draws itself as you and the agent work.</p>
            </div>
          </Show>
        }
      >
        <ol class="timeline" aria-label="Session timeline">
          <For each={rows()}>{(row) => <Row row={row} now={props.now} onJump={jump} />}</For>
        </ol>
        <p class="usage-note text-muted">Oldest first, active branch only. A row jumps to its message{drawer() ? " and closes this pane" : ""}.</p>
      </Show>
    </div>
  );
}

/**
 * One row. A gap and a density line are text — nothing to jump to, and a gap has no dot, since it
 * is the space between two events rather than an event. Everything else is a dot, a clock and a
 * button whose accessible name starts with what pressing it does.
 */
function Row(props: { row: TimelineRow; now: number; onJump(entryId: string | undefined): void }) {
  const row = () => props.row;
  /** A chapter that fell back to its summary's clock: the time is not the event's, and says so. */
  const flagged = () => row().flagged === true;
  /** The clock shows the hour; the title pairs it with the date and the delta, so a row three
      days up the axis doesn't have to be counted back to. */
  const clockTitle = () => {
    const at = row().at;
    if (!at) return undefined;
    return `${absoluteTime(at, props.now)} · ${relativeTime(at, props.now)}${flagged() ? " · summary time, not the message's" : ""}`;
  };

  return (
    <li class="timeline-row" classList={{ "timeline-row-flagged": flagged() }} data-kind={row().kind}>
      <Show when={row().kind === "gap"}>
        <span class="timeline-gap">{row().title}</span>
      </Show>
      <Show when={row().kind === "density"}>
        <span class="timeline-meta">{row().title}</span>
      </Show>
      <Show when={row().kind !== "gap" && row().kind !== "density"}>
        <Show when={row().at}>
          {(at) => (
            <span class="timeline-time" classList={{ "timeline-time-flagged": flagged() }} title={clockTitle()}>
              {clockTime(at())}
            </span>
          )}
        </Show>
        <span class="timeline-dot" aria-hidden="true" />
        <button type="button" class="timeline-body" title={capTitle(row().full ?? "") || undefined} onClick={() => props.onJump(row().entryId)}>
          <span class="visually-hidden">Jump to this message: </span>
          {/* A chapter heading has its own class, not `.timeline-title`: one line, never two. */}
          <span class={row().kind === "chapter" ? "timeline-chapter" : "timeline-title"}>
            <Show when={row().manual}>
              <span class="outline-hash" aria-hidden="true">
                #
              </span>
            </Show>
            {row().title}
          </span>
          {/* A flagged chapter's meta is the words "summary time": the dimmed clock alone would
              leave the flag to colour. */}
          <Show when={row().meta}>{(meta) => <span class="timeline-meta">{meta()}</span>}</Show>
        </button>
      </Show>
    </li>
  );
}

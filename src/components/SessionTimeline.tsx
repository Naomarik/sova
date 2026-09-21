import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { OutlineSnapshot, RewindInfo, SessionOutline, SessionSummary, TranscriptItem } from "../../shared/protocol";
import { clockTime, relativeTime } from "../lib/format";
import {
  IDLE,
  inputRows,
  rewoundAt,
  rowAction,
  sentSince,
  stepRewind,
  viewRows,
  type RewindBlock,
  type RewindControl,
  type RewindPhase,
  type RewindStep,
  type Rewound,
} from "../lib/inputs";
import { jumpToEntry } from "../lib/jump";
import { absoluteTime } from "../lib/spend";
import { GAP_MS, timelineRows, timelineState, type TimelineRow } from "../lib/timeline";
import { toast } from "../lib/ui-state";
import { capTitle } from "../lib/workers";
import { Icon } from "./ui";

const DRAWER = "(max-width: 1279px)";
/** Below the column band the pane is a drawer over the transcript, so a jump would land behind it. */
const isDrawer = () => window.matchMedia(DRAWER).matches;

/**
 * The Timeline tab: one time axis for the whole session, oldest first. Every user message is a
 * row that jumps to it in the transcript, with a density line under it, and a Rewind that takes
 * the chat back to just before it; the outline's topics sit beside the message each is anchored
 * to; compactions, subagents spawned and retired, model/thinking/mode changes and past summaries
 * are markers; a quiet stretch becomes a dotless "idle 38m". "Inputs Only" narrows it to your own
 * messages and the gaps between them.
 *
 * The rhythm is fixed — a row is a row, whatever the span before it — so a long night and a long
 * afternoon read the same. Every decision behind the rows is in src/lib/timeline.ts, and every
 * rewind rule in src/lib/inputs.ts; the rewind itself goes through `rewind`, the open chat's hook.
 * Without one — watching, open in a terminal, not a chat here — the rows still show and every
 * Rewind says why it is off. After a rewind, whoever started it, the rows it left behind stay,
 * greyed, until the next send.
 */
export function SessionTimeline(props: {
  path: string;
  /** The shared transcript read, from the pane; null until the first load settles. The pane
      reloads it when the session's file moved and after a rewind. */
  items: TranscriptItem[] | null;
  outline: SessionOutline | null;
  /** Every past outline summary, oldest first, from the insight; the newest is the strip's. */
  outlines?: OutlineSnapshot[];
  /** The branch's rewind markers, from the insight; absent when the session has none. */
  rewinds?: RewindInfo[];
  /** App's last successful rewind, from any origin: a row here, the composer's undo. `changed`
      moves once per rewind, and never on a refusal. App gates it on the path; we check it again,
      since a refresh aimed at another chat would drop rows that are live. */
  rewound?: { path: string; entryId: string; changed: number } | null;
  summary: SessionSummary | undefined;
  rewind: RewindControl | undefined;
  /** The "Inputs Only" filter. App holds it, in memory, for as long as the pane is open: /tree
      and the composer's inputs row open the tab with it on. */
  inputsOnly: boolean;
  onInputsOnly(on: boolean): void;
  /** True until the pane's insight has settled: the empty state waits for it. */
  pending: boolean;
  now: number;
  /** Asks the pane to re-read the transcript, for the one path that has no `rewound` to do it. */
  onReload?(): void;
  /** Closes the pane: a jump from the drawer band would otherwise land behind it. */
  onClose(): void;
}) {
  const [shadow, setShadow] = createSignal<Rewound | null>(null);
  const [phase, setPhase] = createSignal<RewindPhase>(IDLE);

  const live = createMemo(() => inputRows(props.items ?? []));
  /** Oldest first, with each message's standing against the latest rewind. */
  const view = createMemo(() => viewRows(live(), shadow()));
  // Once the user sends again, the greyed rows have had their turn.
  createEffect(() => {
    const s = shadow();
    if (s && sentSince(live(), s)) setShadow(null);
  });

  const axis = (inputsOnly: boolean) =>
    timelineRows(props.items ?? [], props.outline, props.rewinds ?? [], GAP_MS, { outlines: props.outlines, view: view(), inputsOnly });
  const rows = createMemo(() => axis(props.inputsOnly));
  const state = () => timelineState(props.outline, props.now);
  /** Rows keyed, so a refetch or a phase change never remounts one under focus. */
  const byKey = createMemo(() => new Map(rows().map((r) => [r.key, r])));

  /** One rewind, one refresh, whoever started it: App's signal is the only thing that rebuilds
      the shadow, and the pane re-reads the transcript off the same signal. */
  createEffect(
    on(
      () => props.rewound?.changed,
      (changed) => {
        const ev = props.rewound;
        if (!changed || !ev || ev.path !== props.path) return;
        setShadow(rewoundAt(view().filter((r) => r.state === "active"), ev.entryId) ?? shadow());
      },
      { defer: true },
    ),
  );

  const blocked = (): RewindBlock | null => (props.rewind ? props.rewind.blocked() : props.summary?.live ? "live" : "no-chat");

  let list: HTMLOListElement | undefined;
  /** Focus follows the step: into the question, back to Rewind out of it, onto the new boundary. */
  const focus = (id: string, what: "confirm" | "rewind" | "note") =>
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-input="${CSS.escape(id)}"] [data-focus="${what}"]`)?.focus());
  const step = (s: RewindStep) => {
    const was = phase();
    const next = stepRewind(was, s);
    setPhase(next);
    if (next.kind === "confirm") focus(next.id, "confirm");
    else if (was.kind === "confirm" && next.kind === "idle") focus(was.id, "rewind");
  };
  const confirm = async () => {
    const p = phase();
    if (p.kind !== "confirm" || !props.rewind || blocked()) return;
    step({ type: "confirm" });
    const result = await props.rewind.rewind(p.id);
    step({ type: "settled", result });
    // ChatView announces both outcomes in the polite region — it owns the composer the text lands
    // in. The row shows a refusal inline, where Rewind's aria-describedby points, so it reads out
    // as focus returns there.
    focus(p.id, result.ok ? "note" : "rewind");
    // Without App's `rewound` wiring, do the refresh here. The test is `undefined` (never passed),
    // not falsy: App passes null until the first rewind of a session.
    if (result.ok && props.rewound === undefined) {
      setShadow(rewoundAt(view().filter((r) => r.state === "active"), p.id) ?? shadow());
      props.onReload?.();
    }
  };

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

  /** Filtered to nothing while the whole axis has rows: the filter is the reason, so say that. */
  const filteredOut = () => props.inputsOnly && axis(false).length > 0;

  return (
    <div class="session-panel-scroll" tabindex="0">
      <div class="spread" style={{ "margin-bottom": "var(--space-3)" }}>
        <Show when={state()} fallback={<span />}>
          {(s) => (
            <p class="timeline-state" style={{ margin: 0 }} title={s().title || undefined}>
              {s().text}
            </p>
          )}
        </Show>
        {/* The only control the filter has: one press on, one press off. The check is the
            pressed state's shape, so it never rests on colour. */}
        <button type="button" class="button button-sm button-ghost" aria-pressed={props.inputsOnly ? "true" : "false"} onClick={() => props.onInputsOnly(!props.inputsOnly)}>
          <Show when={props.inputsOnly}>
            <Icon name="check" small />
          </Show>
          Inputs Only
        </button>
      </div>
      <Show
        when={rows().length > 0}
        fallback={
          <Show when={props.items && !props.pending}>
            <Show
              when={filteredOut()}
              fallback={
                <div class="empty subagents-empty">
                  <p class="empty-title">0 messages in this session yet.</p>
                  <p class="empty-body">The timeline draws itself as you and the agent work.</p>
                </div>
              }
            >
              <div class="empty subagents-empty">
                <p class="empty-title">0 messages from you in this session yet.</p>
                <p class="empty-body">Turn off Inputs Only to see the rest of its timeline.</p>
              </div>
            </Show>
          </Show>
        }
      >
        <ol class="timeline" aria-label={props.inputsOnly ? "Session timeline, your messages only" : "Session timeline"} ref={list}>
          <For each={rows().map((r) => r.key)}>
            {(key) => (
              <Show when={byKey().get(key)}>
                {(row) => <Row row={row()} now={props.now} phase={phase()} blocked={blocked()} onStep={step} onConfirm={confirm} onJump={jump} />}
              </Show>
            )}
          </For>
        </ol>
        <p class="usage-note text-muted">
          {props.inputsOnly ? "Your messages only, oldest first" : "Oldest first"}, active branch only. A row jumps to its message
          {drawer() ? " and closes this pane" : ""}; Rewind takes the chat back to just before it.
        </p>
      </Show>
    </div>
  );
}

/**
 * One row. A gap and a density line are text — nothing to jump to, and a gap has no dot, since it
 * is the space between two events rather than an event. Everything else is a dot, a clock and a
 * button whose accessible name starts with what pressing it does; an input row adds its Rewind.
 */
function Row(props: {
  row: TimelineRow;
  now: number;
  phase: RewindPhase;
  blocked: RewindBlock | null;
  onStep(s: RewindStep): void;
  onConfirm(): void;
  onJump(entryId: string | undefined): void;
}) {
  const row = () => props.row;
  /** A row with no `entryId` is about no single message — a rewind marker, a past summary — so
      it is text, not a control that could only toast. */
  const jumps = () => row().entryId !== undefined;
  /** An input row built with its rewind state: the only kind that can act. */
  const input = () => row().kind === "input" && row().state !== undefined;
  /** A chapter that fell back to its summary's clock: the time is not the event's, and says so. */
  const flagged = () => row().flagged === true;
  /** The clock shows the hour; the title pairs it with the date and the delta, so a row three
      days up the axis doesn't have to be counted back to. */
  const clockTitle = () => {
    const at = row().at;
    if (!at) return undefined;
    return `${absoluteTime(at, props.now)} · ${relativeTime(at, props.now)}${flagged() ? " · summary time, not the message's" : ""}`;
  };
  const asking = () => props.phase.kind === "confirm" && props.phase.id === row().entryId;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !asking()) return;
    e.preventDefault();
    props.onStep({ type: "cancel" });
  };

  return (
    <li
      class="timeline-row"
      classList={{
        "timeline-row-flagged": flagged(),
        "input-row-boundary": row().state === "boundary",
        "input-row-abandoned": row().state === "abandoned",
      }}
      data-kind={row().kind}
      data-input={input() ? row().entryId : undefined}
      onKeyDown={input() ? onKeyDown : undefined}
    >
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
        <Show
          when={input()}
          fallback={
            <Show
              when={jumps()}
              fallback={
                <span class="timeline-body timeline-body-static" title={capTitle(row().full ?? "") || undefined}>
                  {/* No visually-hidden prefix: it names what pressing does, and there is nothing to press. */}
                  <Body row={row()} />
                </span>
              }
            >
              <button type="button" class="timeline-body" title={capTitle(row().full ?? "") || undefined} onClick={() => props.onJump(row().entryId)}>
                <span class="visually-hidden">Jump to this message: </span>
                <Body row={row()} />
              </button>
            </Show>
          }
        >
          <InputBody row={row()} phase={props.phase} blocked={props.blocked} onStep={props.onStep} onConfirm={props.onConfirm} onJump={props.onJump} />
        </Show>
      </Show>
    </li>
  );
}

/** A row's title and meta, the same either way: only the element around them changes. */
function Body(props: { row: TimelineRow }) {
  return (
    <>
      {/* A chapter heading has its own class, not `.timeline-title`: one line, never two. The
          input title also wears `.input-row-title`, so an abandoned row's title goes muted. */}
      <span class={props.row.kind === "chapter" ? "timeline-chapter" : props.row.kind === "input" ? "timeline-title input-row-title" : "timeline-title"}>
        <Show when={props.row.manual}>
          <span class="outline-hash" aria-hidden="true">
            #
          </span>
        </Show>
        {props.row.title}
      </span>
      {/* A flagged chapter's meta is the words "summary time": the dimmed clock alone would
          leave the flag to colour. */}
      <Show when={props.row.meta}>{(meta) => <span class="timeline-meta">{meta()}</span>}</Show>
    </>
  );
}

/**
 * One message you sent: the body jumps to it — the safe half, and the whole of its hit area — and
 * Rewind sits apart at the end and asks before it acts, so the destructive half stays explicit.
 * It is the Inputs tab's row, moved onto the axis: the same rules (inputs.ts `rowAction`), the
 * same two steps, the same notes.
 */
function InputBody(props: {
  row: TimelineRow;
  phase: RewindPhase;
  blocked: RewindBlock | null;
  onStep(s: RewindStep): void;
  onConfirm(): void;
  onJump(entryId: string | undefined): void;
}) {
  const id = () => props.row.entryId!;
  const state = () => props.row.state ?? "active";
  /** `rowAction` decides from the row's state alone; the rest of the ViewRow it takes is filler. */
  const action = () => rowAction({ id: id(), preview: "", text: "", images: 0, at: undefined, state: state() }, props.blocked, props.phase);
  const asking = () => props.phase.kind === "confirm" && props.phase.id === id();
  const pending = () => props.phase.kind === "pending" && props.phase.id === id();
  const failure = () => (props.phase.kind === "failed" && props.phase.id === id() ? props.phase.error : null);
  const reasonId = () => `timeline-reason-${id()}`;
  const errorId = () => `timeline-error-${id()}`;

  return (
    // The third grid column, like `.timeline-body`: the body and its actions share one line,
    // and the notes sit under both.
    <div style={{ "grid-column": "3", "min-width": "0" }}>
      <div class="input-row-line">
        <button type="button" class="timeline-body input-row-body" title={capTitle(props.row.full ?? "") || undefined} onClick={() => props.onJump(id())}>
          <span class="visually-hidden">Jump to this message: </span>
          <Body row={props.row} />
        </button>
        <Show when={state() === "active"}>
          <span class="input-row-actions">
            <Show
              when={asking()}
              fallback={
                <>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    data-focus="rewind"
                    aria-label="Rewind to before this message"
                    aria-disabled={action().enabled ? undefined : "true"}
                    aria-busy={pending() ? "true" : undefined}
                    aria-describedby={[action().reason && !pending() ? reasonId() : "", failure() ? errorId() : ""].filter(Boolean).join(" ") || undefined}
                    title={pending() ? undefined : action().reason ?? "Rewind to before this message"}
                    onClick={() => action().enabled && props.onStep({ type: "ask", id: id() })}
                  >
                    {pending() ? "Rewinding…" : "Rewind"}
                  </button>
                  <Show when={action().reason && !pending()}>
                    <span class="visually-hidden" id={reasonId()}>
                      {action().reason}
                    </span>
                  </Show>
                </>
              }
            >
              <button
                type="button"
                class="button button-sm button-destructive"
                data-focus="confirm"
                aria-label="Confirm: rewind to before this message"
                aria-disabled={action().enabled ? undefined : "true"}
                aria-describedby={action().reason ? reasonId() : undefined}
                title={action().reason ?? undefined}
                onClick={() => action().enabled && props.onConfirm()}
              >
                Rewind Here
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => props.onStep({ type: "cancel" })}>
                Cancel
              </button>
              <Show when={action().reason}>
                <span class="visually-hidden" id={reasonId()}>
                  {action().reason}
                </span>
              </Show>
            </Show>
          </span>
        </Show>
      </div>
      <Show when={state() === "boundary"}>
        <p class="input-row-note" tabindex="-1" data-focus="note">
          Rewound to just before this message. Its text is in the composer.
        </p>
      </Show>
      <Show when={state() === "abandoned"}>
        <span class="visually-hidden">Left behind by the rewind.</span>
      </Show>
      <Show when={asking()}>
        <p class="input-row-note">This message and every reply after it leave the branch. The session file keeps them.</p>
      </Show>
      <Show when={failure()}>
        {(msg) => (
          <p class="input-row-note" id={errorId()}>
            <span class="text-error">{msg()}</span>
          </p>
        )}
      </Show>
    </div>
  );
}

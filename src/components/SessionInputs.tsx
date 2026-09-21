import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { SessionSummary, TranscriptItem } from "../../shared/protocol";
import { relativeTime } from "../lib/format";
import {
  displayRows,
  IDLE,
  inputPreview,
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
  type ViewRow,
} from "../lib/inputs";
import { jumpToEntry } from "../lib/jump";
import { toast } from "../lib/ui-state";
import { capTitle } from "../lib/workers";
import { absoluteTime } from "../lib/spend";

/** Below the column band (spec/11-subagents-pane.md §11) the pane is a drawer over the transcript, so a jump
    would land behind it. */
const isDrawer = () => window.matchMedia("(max-width: 1279px)").matches;

/**
 * The Inputs tab: this session's messages on the active branch, newest first, so the one you just
 * sent is at the top and the history grows downwards. A row's body jumps
 * to that message in the transcript; its Rewind action, two-step and inline, takes the chat back
 * to just before it. The rows come from the same transcript read as the Session tab; the rewind
 * goes through `rewind`, the open chat's hook. Without one — watching, open in a terminal, not a
 * chat here — the list still shows and every action says why it is off. After a rewind, whoever
 * started it, the rows it left behind stay, greyed, until the next send.
 */
export function SessionInputs(props: {
  path: string;
  /** The pane's shared transcript read: null until the first load settles. The pane reloads it
      when the session's file moved and after a rewind, so this tab makes no fetch of its own. */
  items: TranscriptItem[] | null;
  /** App's last successful rewind, from any origin: the pane's own rows, the composer's undo,
      /tree. `changed` moves once per rewind, and never on a refusal. App gates it on the path;
      we check it again here, since a refresh aimed at another chat would drop rows that are live. */
  rewound?: { path: string; entryId: string; changed: number } | null;
  summary: SessionSummary | undefined;
  rewind: RewindControl | undefined;
  now: number;
  /** Asks the pane to re-read the transcript, for the one path that has no `rewound` to do it. */
  onReload?(): void;
  /** Closes the pane: a jump from the drawer band would otherwise land behind it. */
  onClose(): void;
}) {
  const [shadow, setShadow] = createSignal<Rewound | null>(null);
  const [phase, setPhase] = createSignal<RewindPhase>(IDLE);

  const items = () => props.items;
  const live = () => inputRows(items() ?? []);
  /** Oldest first: the order a rewind reasons in (everything after the target is abandoned). */
  const rows = () => viewRows(live(), shadow());
  /** Newest first: the order the list renders in. */
  const shown = () => displayRows(live(), shadow());
  // Once the user sends again, the greyed rows have had their turn.
  createEffect(() => {
    const s = shadow();
    if (s && sentSince(live(), s)) setShadow(null);
  });

  /** One rewind, one refresh, whoever started it: App's signal is the only thing that rebuilds
      the shadow, and the pane re-reads the rows off the same signal. A refusal never bumps
      `changed`, so it refreshes nothing. */
  createEffect(
    on(
      () => props.rewound?.changed,
      (changed) => {
        const ev = props.rewound;
        if (!changed || !ev || ev.path !== props.path) return;
        // The rows come back with the pane's own reload, on the same signal.
        setShadow(rewoundAt(rows().filter((r) => r.state === "active"), ev.entryId) ?? shadow());
      },
      { defer: true },
    ),
  );

  const blocked = (): RewindBlock | null =>
    props.rewind ? props.rewind.blocked() : props.summary?.live ? "live" : "no-chat";

  let list: HTMLUListElement | undefined;
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
    // in, and it speaks a refusal too, so "Rewound." can't stand as the latest news. The row shows
    // the refusal inline, where the Rewind button's aria-describedby points, so it reads out as
    // focus returns there.
    focus(p.id, result.ok ? "note" : "rewind");
    // The refresh and the shadow come from App's `rewound` signal, so this path and the composer's
    // undo behave the same. Without that wiring, fall back to doing it here. The test is `undefined`
    // (the prop was never passed), not falsy: App passes null until the first rewind of a session,
    // and reading that as unwired would refetch twice for that first one.
    if (result.ok && props.rewound === undefined) {
      setShadow(rewoundAt(rows().filter((r) => r.state === "active"), p.id) ?? shadow());
      props.onReload?.();
    }
  };

  const jump = (id: string) => {
    if (!jumpToEntry(id)) return toast("That message isn't in the transcript on screen.");
    if (isDrawer()) props.onClose();
  };

  /** Rows keyed by id, so a refetch or a state change never remounts one under focus. */
  const byId = () => new Map(shown().map((r) => [r.id, r]));

  return (
    <div class="session-panel-scroll" tabindex="0">
      <Show
        when={shown().length > 0}
        fallback={
          <Show when={items()}>
            <div class="empty subagents-empty">
              <p class="empty-title">0 messages on this branch.</p>
              <p class="empty-body">Messages you send show up here, and each can rewind the chat to just before it.</p>
            </div>
          </Show>
        }
      >
        <ul class="list input-list" aria-label="Your messages" ref={list}>
          <For each={shown().map((r) => r.id)}>
            {(id) => (
              <Show when={byId().get(id)}>
                {(row) => (
                  <InputItem row={row()} phase={phase()} blocked={blocked()} now={props.now} onStep={step} onConfirm={confirm} onJump={jump} />
                )}
              </Show>
            )}
          </For>
        </ul>
        <p class="usage-note text-muted">Newest first, active branch only. A row jumps to its message; Rewind takes the chat back to just before it.</p>
      </Show>
    </div>
  );
}

/**
 * One message. The body is a button that jumps to the message in the transcript — the safe half
 * of the row, and the whole of its hit area; Rewind sits apart at the end, and asks before it
 * acts, so the destructive half stays explicit.
 */
function InputItem(props: {
  row: ViewRow;
  phase: RewindPhase;
  blocked: RewindBlock | null;
  now: number;
  onStep(s: RewindStep): void;
  onConfirm(): void;
  onJump(id: string): void;
}) {
  const id = () => props.row.id;
  const action = () => rowAction(props.row, props.blocked, props.phase);
  const asking = () => props.phase.kind === "confirm" && props.phase.id === id();
  const pending = () => props.phase.kind === "pending" && props.phase.id === id();
  const failure = () => (props.phase.kind === "failed" && props.phase.id === id() ? props.phase.error : null);
  const reasonId = () => `input-reason-${id()}`;
  const errorId = () => `input-error-${id()}`;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !asking()) return;
    e.preventDefault();
    props.onStep({ type: "cancel" });
  };

  return (
    <li
      class="input-row"
      classList={{ "input-row-boundary": props.row.state === "boundary", "input-row-abandoned": props.row.state === "abandoned" }}
      data-input={id()}
      onKeyDown={onKeyDown}
    >
      <div class="input-row-line">
        <button type="button" class="input-row-body" title={capTitle(props.row.text) || undefined} onClick={() => props.onJump(id())}>
          <span class="visually-hidden">Jump to this message: </span>
          <span class="input-row-title">{inputPreview(props.row)}</span>
          <Show when={props.row.at}>
            {(at) => (
              <span class="input-row-meta" title={absoluteTime(at(), props.now) || undefined}>
                {relativeTime(at(), props.now)}
              </span>
            )}
          </Show>
        </button>
        <Show when={props.row.state === "active"}>
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
      <Show when={props.row.state === "boundary"}>
        <p class="input-row-note" tabindex="-1" data-focus="note">
          Rewound to just before this message. Its text is in the composer.
        </p>
      </Show>
      <Show when={props.row.state === "abandoned"}>
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
    </li>
  );
}

import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import { ACTION_CONFIRM, ACTION_LABEL, type MessageActionKind } from "../lib/message-actions";
import { acquireMessageReveal } from "../lib/message-reveal";
import { confirmActivate } from "../lib/confirm-step";
import { Icon, type IconName } from "./ui";

const ICON: Record<MessageActionKind, IconName> = {
  copy: "copy",
  fork: "branch",
  rewind: "undo",
  regenerate: "refresh",
  remove: "close",
};

/** How long Copy's button shows it worked (the code-block button's own interval). */
const COPIED_MS = 1500;

/** One button in a strip. `reason` is the whole disabled state: a sentence, or null for enabled. */
export interface MessageActionItem {
  kind: MessageActionKind;
  /** Replaces the default accessible name, for an action whose row says more than its kind. */
  label?: string;
  reason: string | null;
  run(): void | Promise<void>;
}

/**
 * The strip of actions under one delivered message, and under one queued message (where it holds
 * a single Remove). One component for both, so a message never grows a second row of controls
 * with its own idea of size, order or focus.
 *
 * Always in the DOM, always tabbable, and its height is always reserved — what the message region
 * reveals is only the PAINT (base.css: opacity and pointer-events, never `display`), so a strip
 * appearing moves nothing. Every input has its own door: hover over the message for a mouse,
 * `:focus-within` for a keyboard, and a tap on the message for touch (src/lib/message-reveal.ts).
 * A hidden strip takes no pointer, so the tap that reveals it can never also press a button.
 * The buttons are visually small and 44×44 to the finger: the box extends past the icon rather
 * than pushing every message 44px apart.
 *
 * Three states outlive the pointer, and say so with `.message-actions-open`: an armed confirm,
 * Copy's check, and a refusal the row is keeping. None of them may vanish because a mouse moved.
 *
 * An action that changes the branch (Rewind, Regenerate) is two-step: the first press arms it and
 * the strip becomes the sentence plus `Rewind Here` / `Cancel`; Esc cancels, and focus follows
 * each step so a keyboard user is never left on a button that disappeared.
 */
export function MessageActions(props: {
  /** The strip's accessible name: whose message these act on. */
  label: string;
  /** Where the strip sits under the bubble; user messages are end-aligned like their head. */
  align?: "start" | "end";
  items: MessageActionItem[];
  /** A refusal from the last attempt, shown inline (the owner announces it; the row keeps it). */
  note?: string | null;
}) {
  /** The armed action's kind, or null. One at a time — two armed confirms is two questions. */
  const [armed, setArmed] = createSignal<MessageActionKind | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));
  // Tap-to-reveal is one document listener for however many strips are on screen; the last strip
  // to leave takes it with it.
  onCleanup(acquireMessageReveal());

  /** The strip itself, and the kind whose button focus goes back to when a confirm is dropped.
      The trigger ELEMENT can't be kept: arming replaces the icon row, so the button that was
      pressed is detached by the time Cancel or Esc runs, and focusing it would silently do
      nothing — which is how a keyboard user loses their place in the thread. */
  let strip!: HTMLDivElement;
  let confirmButton: HTMLButtonElement | undefined;

  const item = (kind: MessageActionKind | null) => props.items.find((i) => i.kind === kind);
  const armedItem = () => item(armed());
  const confirmOf = (kind: MessageActionKind) => ACTION_CONFIRM[kind];

  /** Ids for the reason text of each disabled button, so a screen reader can read it: a `title`
      is ignored whenever an `aria-label` is present, which every icon button here has. */
  const reasonId = createUniqueId();
  const describe = (kind: MessageActionKind) => `${reasonId}-${kind}`;
  /** The armed step's sentence, associated with the button that acts on it — the consequence has
      to be ANNOUNCED before activation, not merely printed beside it. */
  const noteId = `${reasonId}-note`;

  const disarm = (refocus = true) => {
    const kind = armed();
    if (!kind) return;
    setArmed(null);
    // The icon row is back in the DOM by now (Solid renders the change synchronously); find the
    // button this confirm came from and put focus on it.
    if (refocus) strip?.querySelector<HTMLButtonElement>(`[data-action="${kind}"]`)?.focus();
  };

  // An action that became impossible while it was armed (a turn started, the socket dropped) must
  // not keep standing there as a live question: the reason takes the strip back.
  createEffect(
    on(
      () => armedItem()?.reason ?? null,
      // Focus still follows: the button is back (disabled, but focusable — aria-disabled, not
      // the attribute), and dropping focus to <body> would restart Tab at the top of the pane.
      (reason) => reason && disarm(),
      { defer: true },
    ),
  );
  // Focus follows the step: the confirm is a new button where the old one was.
  createEffect(on(armed, (kind) => kind && confirmButton?.focus(), { defer: true }));

  const press = (it: MessageActionItem) => {
    if (it.reason) return; // aria-disabled: it answers with its reason, it doesn't act
    if (confirmOf(it.kind)) {
      const step = confirmActivate(armed() === it.kind);
      if (step.armed) setArmed(it.kind);
      else disarm();
      if (!step.run) return;
    }
    void run(it);
  };

  const run = async (it: MessageActionItem) => {
    if (running()) return; // one press, one request: a double click is not two forks
    setRunning(true);
    try {
      await it.run();
      if (it.kind === "copy") {
        clearTimeout(copiedTimer);
        setCopied(true);
        copiedTimer = setTimeout(() => setCopied(false), COPIED_MS);
      }
    } finally {
      setRunning(false);
    }
  };

  const confirmRun = () => {
    const it = armedItem();
    setArmed(null);
    if (it && !it.reason) void run(it);
  };

  return (
    <div
      ref={strip}
      class="message-actions"
      classList={{
        "message-actions-end": props.align === "end",
        "message-actions-armed": !!armed(),
        // Held open regardless of the pointer: a question waiting for an answer, the 1.5s proof
        // that Copy worked, and a refusal this row is keeping.
        "message-actions-open": !!armed() || copied() || !!props.note,
      }}
      role="group"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === "Escape" && armed()) {
          e.stopPropagation(); // Esc here answers the confirm, it doesn't close the pane behind it
          disarm();
        }
      }}
    >
      <Show
        when={armedItem()}
        fallback={
          <For each={props.items}>
            {(it) => (
              <button
                type="button"
                class="button button-icon button-ghost message-action"
                aria-label={it.label ?? ACTION_LABEL[it.kind]}
                title={it.reason ?? it.label ?? ACTION_LABEL[it.kind]}
                aria-disabled={it.reason ? "true" : undefined}
                aria-describedby={it.reason ? describe(it.kind) : undefined}
                data-action={it.kind}
                onClick={() => press(it)}
              >
                <Icon name={it.kind === "copy" && copied() ? "check" : ICON[it.kind]} small />
                <Show when={it.reason}>
                  <span class="visually-hidden" id={describe(it.kind)}>
                    {it.reason}
                  </span>
                </Show>
              </button>
            )}
          </For>
        }
      >
        {(it) => (
          <>
            <span class="message-actions-note" id={noteId}>
              {confirmOf(it().kind)!.note}
            </span>
            <button
              ref={confirmButton}
              type="button"
              class="button button-sm button-destructive"
              aria-describedby={noteId}
              onClick={confirmRun}
            >
              {confirmOf(it().kind)!.label}
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => disarm()}>
              Cancel
            </button>
          </>
        )}
      </Show>
      <Show when={props.note}>
        <span class="message-actions-note message-actions-refusal" role="note">
          {props.note}
        </span>
      </Show>
    </div>
  );
}

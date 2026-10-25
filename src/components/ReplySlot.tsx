import { createSignal, ErrorBoundary, For, onCleanup, Show } from "solid-js";
import { frameLoadGuard, walledSrcdoc, WALLED_FRAME_ATTRS, type ReplyChip, type ReplyContent, type SlotPolicy, type SlotState } from "../lib/reply-slot";
import { announce } from "../lib/ui-state";
import { Icon } from "./ui";
import "../extensions.css";

const TONE_CLASS: Record<ReplyChip["tone"], string> = { ok: " chip-success", warn: " chip-warn", error: " chip-error", info: " chip-info", muted: "" };

/**
 * What extensions add under one reply (§app.commands/reply-slot), drawn after Sova's own message
 * actions in the reply place (src/lib/reply-place.ts), never among them. It is only ever given an
 * answer already validated; anything that throws while drawing is caught by the boundary and draws
 * nothing, while the reply draws as before. Every addition names its extension.
 */
export function ReplySlot(props: {
  state: SlotState;
  policy: SlotPolicy;
  /** Runs a chip's declared action; resolves to null, or what went wrong. A chip with a `confirm`
      asks it here first, inline. */
  run?: (chip: ReplyChip) => Promise<string | null>;
}) {
  return (
    <ErrorBoundary fallback={null}>
      <ReplySlotInner {...props} />
    </ErrorBoundary>
  );
}

function ReplySlotInner(props: { state: SlotState; policy: SlotPolicy; run?: (chip: ReplyChip) => Promise<string | null> }) {
  /** The chip whose confirm is showing. */
  const [armed, setArmed] = createSignal<ReplyChip | null>(null);
  const [running, setRunning] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  let confirmButton: HTMLButtonElement | undefined;
  let alive = true;
  onCleanup(() => (alive = false));

  const run = async (chip: ReplyChip) => {
    if (running() || !props.run) return;
    setArmed(null);
    setRunning(true);
    setNote(null);
    try {
      const why = await props.run(chip);
      if (!alive) return;
      setNote(why);
      if (why) announce(why);
    } finally {
      if (alive) setRunning(false);
    }
  };
  const press = (chip: ReplyChip) => {
    if (!chip.confirm) return void run(chip);
    setArmed(chip);
    queueMicrotask(() => confirmButton?.focus());
  };

  return (
    <Show when={props.state.chips.length || props.state.contents.length}>
      <div
        class="reply-slot"
        role="group"
        aria-label="Added by extensions"
        onKeyDown={(e) => {
          if (e.key === "Escape" && armed()) {
            e.stopPropagation();
            setArmed(null);
          }
        }}
      >
        <Show
          when={armed()}
          fallback={
            <Show when={props.state.chips.length}>
              <div class="reply-slot-chips">
                <For each={props.state.chips}>
                  {(chip) => {
                    const name = `${chip.label}, from ${chip.extensionTitle}`;
                    const body = (
                      <>
                        <Show when={chip.icon}>{(icon) => <Icon name={icon()} small />}</Show>
                        <span class={`chip${TONE_CLASS[chip.tone]}`}>
                          <Show when={chip.tone !== "muted"}>
                            <i class="chip-dot" />
                          </Show>
                          {chip.label}
                        </span>
                      </>
                    );
                    return chip.href ? (
                      <a class="button button-sm button-ghost reply-slot-chip" href={chip.href} target="_blank" rel="noopener noreferrer" aria-label={name} title={name}>
                        {body}
                      </a>
                    ) : (
                      <button type="button" class="button button-sm button-ghost reply-slot-chip" aria-label={name} title={name} aria-disabled={running() ? "true" : undefined} onClick={() => press(chip)}>
                        {body}
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          }
        >
          {(chip) => (
            <div class="reply-slot-chips reply-slot-armed">
              <span class="reply-slot-note" id={`reply-slot-confirm-${chip().extension}`}>
                {chip().confirm} <span class="reply-slot-from">({chip().extensionTitle})</span>
              </span>
              <button ref={confirmButton} type="button" class="button button-sm" aria-describedby={`reply-slot-confirm-${chip().extension}`} onClick={() => void run(chip())}>
                {chip().label}
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setArmed(null)}>
                Cancel
              </button>
            </div>
          )}
        </Show>
        <Show when={note()}>
          <span class="reply-slot-note reply-slot-refusal" role="note">
            {note()}
          </span>
        </Show>
        <For each={props.state.contents}>{(c) => <WalledFrame content={c} policy={props.policy} />}</For>
      </div>
    </Show>
  );
}

/** The walled-off frame: a picture (src/lib/reply-slot.ts WALLED_FRAME_ATTRS says why each wall). */
function WalledFrame(props: { content: ReplyContent; policy: SlotPolicy }) {
  /** It navigated (frameLoadGuard): it leaves at once, before the mute redraws the place. */
  const [gone, setGone] = createSignal(false);
  return (
    <Show when={!gone()}>
      <iframe
        class="reply-slot-frame"
        sandbox={WALLED_FRAME_ATTRS.sandbox}
        referrerpolicy={WALLED_FRAME_ATTRS.referrerpolicy}
        tabindex={WALLED_FRAME_ATTRS.tabindex}
        title={`Added by ${props.content.extensionTitle}`}
        // The wall first, then the document: `sandbox` (set here too, since an absent attribute
        // would be no sandbox at all) and `csp` (no JSX type for it) are in place before the
        // frame has anything to load, and an iframe loads nothing until it is connected.
        ref={(el) => {
          el.setAttribute("sandbox", WALLED_FRAME_ATTRS.sandbox);
          el.setAttribute("csp", WALLED_FRAME_ATTRS.csp);
          el.srcdoc = walledSrcdoc(props.content.html);
        }}
        onLoad={frameLoadGuard(props.content.extension, props.policy, () => setGone(true))}
        style={{ ...WALLED_FRAME_ATTRS.style, height: `${props.content.height}px` }}
      />
    </Show>
  );
}

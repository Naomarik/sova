import { createSignal, createUniqueId, For, onCleanup, Show, type JSX } from "solid-js";
import { ACCEPT_CHANGE, CHANGED_LINE, GROUP_WORD, NEW_WORD, PARTIAL_FINGERPRINT_LINE, UNDO, type GroupState, type Mark } from "../lib/approvals";
import { placeHelpCard } from "../lib/help-popover";
import { Toggle } from "./form";
import { Icon } from "./ui";
import "./approval-switches.css";

/**
 * The pieces every list of context files and skills draws the same way (the new chat's setup card,
 * a project's Context Files and Skills cards, the folder list dialog): one switch per row with its
 * word, a group's switch (mixed between) with the line its press leaves, a row's New or Changed
 * mark, and a skill's size detail.
 */

/** A row's switch (the form kit's), its word before it ("On", "Off"). The input carries the row's own spoken name. */
export function RowSwitch(props: { label: string; on: boolean; disabled?: boolean; class?: string; onFlip(on: boolean, input: HTMLInputElement): void }) {
  return (
    <Toggle
      switch
      class={`approval-switch${props.class ? ` ${props.class}` : ""}`}
      label={<span class="approval-switch-word" aria-hidden="true">{props.on ? "On" : "Off"}</span>}
      ariaLabel={props.label}
      checked={props.on}
      disabled={props.disabled}
      onChange={(on, el) => props.onFlip(on, el)}
    />
  );
}

/** A group's switch: on, off, or mixed (an indeterminate input, knob halfway) when its rows differ. A press
    decides from the group's state; the input is drawn from that state again at once. */
export function GroupSwitch(props: { label: string; state: GroupState; disabled?: boolean; onPress(): void }) {
  return (
    <Toggle
      switch
      class="approval-switch"
      label={<span class="approval-switch-word" aria-hidden="true">{GROUP_WORD[props.state]}</span>}
      ariaLabel={props.label}
      checked={props.state === "on"}
      mixed={props.state === "mixed"}
      disabled={props.disabled}
      onChange={(_, el) => {
        el.checked = props.state === "on";
        el.indeterminate = props.state === "mixed";
        props.onPress();
      }}
    />
  );
}

/** The in-flow line a group switch's press leaves under its heading, with Undo, until the next change in that group. */
export function UndoLine(props: { text: string; busy?: boolean; onUndo(): void }) {
  return (
    <p class="approval-undo" role="status">
      <Icon name="undo" small />
      <span>{props.text}</span>
      <button type="button" class="button button-sm button-ghost approval-undo-button" disabled={props.busy} onClick={() => props.onUndo()}>
        {UNDO}
      </button>
    </p>
  );
}

/** The New chip beside a row's name: a dot and the word. */
export function NewChip() {
  return (
    <span class="chip chip-info approval-new">
      <i class="chip-dot" />
      {NEW_WORD}
    </span>
  );
}

/** The line under a changed row: what happened, and its one button. */
export function ChangedLine(props: { name: string; busy?: boolean; onAccept(): void }) {
  return (
    <span class="approval-changed">
      <span class="approval-changed-text">
        <span class="approval-changed-mark" aria-hidden="true">
          ◆
        </span>
        {CHANGED_LINE}
      </span>
      <button type="button" class="button button-sm" aria-label={`${ACCEPT_CHANGE} to ${props.name}`} disabled={props.busy} onClick={() => props.onAccept()}>
        {ACCEPT_CHANGE}
      </button>
    </span>
  );
}

/** A skill folder not fully fingerprinted: a quiet note. */
export function PartialNote() {
  return (
    <span class="approval-note">
      <Icon name="info" small />
      {PARTIAL_FINGERPRINT_LINE}
    </span>
  );
}

/** Whether a row draws its mark (the New chip goes beside the name; Changed under it). */
export const showsNew = (m: Mark | null) => m === "new";
export const showsChanged = (m: Mark | null) => m === "changed";

/** One fact in a size detail: what, when, and its figure. */
export interface SizeFact {
  label: string;
  when: string;
  value: string;
  sub?: string;
}

/**
 * A skill's figure as a button: hovering or focusing it shows its size detail, a press pins it
 * (a phone has no hover). The detail is the design system's popover, in the top layer so no
 * scrolling pane clips it; Escape, a press outside or the button again close it.
 */
export function SizeButton(props: { text: string; title: string; facts: SizeFact[] }) {
  const id = createUniqueId();
  let button!: HTMLButtonElement;
  let card!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  const place = () => {
    if (!open()) return;
    const at = placeHelpCard(button.getBoundingClientRect(), card.getBoundingClientRect(), { width: innerWidth, height: innerHeight });
    card.style.setProperty("--size-top", `${at.top}px`);
    card.style.setProperty("--size-left", `${at.left}px`);
  };
  const show = (pin: boolean) => {
    if (!open()) {
      card.showPopover();
      setOpen(true);
      place();
    }
    if (pin) setPinned(true);
  };
  const hide = () => {
    if (!open()) return;
    if (card.isConnected && card.matches(":popover-open")) card.hidePopover();
    setOpen(false);
    setPinned(false);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (!open()) return;
    const t = e.target as Node | null;
    if (t && (card.contains(t) || button.contains(t))) return;
    hide();
  };
  addEventListener("pointerdown", onPointerDown, true);
  addEventListener("resize", hide);
  addEventListener("scroll", place, true);
  onCleanup(() => {
    removeEventListener("pointerdown", onPointerDown, true);
    removeEventListener("resize", hide);
    removeEventListener("scroll", place, true);
    hide();
  });
  return (
    <>
      <button
        ref={button}
        type="button"
        class="approval-size"
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id}
        onClick={(e) => {
          e.preventDefault();
          if (pinned()) hide();
          else show(true);
        }}
        onMouseEnter={() => show(false)}
        onMouseLeave={() => !pinned() && hide()}
        onFocus={() => show(false)}
        onBlur={() => !pinned() && hide()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open()) {
            e.preventDefault();
            e.stopPropagation();
            hide();
          }
        }}
      >
        {props.text}
      </button>
      <div ref={card} id={id} class="popover approval-size-pop" popover="manual" role="dialog" aria-label={props.title}>
        <p class="approval-size-title">{props.title}</p>
        <For each={props.facts}>
          {(f) => (
            <div class="approval-size-row">
              <span class="approval-size-k">
                {f.label}
                <small>{f.when}</small>
              </span>
              <span class="approval-size-v">
                {f.value}
                <Show when={f.sub}>{(s) => <small>{s()}</small>}</Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

/** A group's heading row: its eyebrow and count, its figures, and its switch. */
export function GroupHead(props: { title: string; facts?: JSX.Element; children?: JSX.Element }) {
  return (
    <div class="approval-group-head">
      <span class="approval-group-title">
        <h3 class="text-eyebrow approval-group-label">{props.title}</h3>
        <Show when={props.facts}>
          <span class="approval-group-facts">{props.facts}</span>
        </Show>
      </span>
      {props.children}
    </div>
  );
}

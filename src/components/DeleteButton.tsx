import { createUniqueId, Show } from "solid-js";
import { createArm } from "../lib/two-step";
import { announce } from "../lib/ui-state";
import "../delete-button.css";

/**
 * A link's Delete: the first press asks (`confirm`, "Delete?") and shows `note` right after the
 * button (that the link stops working for good), also announced; the second press runs it; leaving
 * it disarms. `busy` replaces the label while the delete runs ("Deleting…").
 */
export function DeleteButton(props: {
  label: string;
  confirm: string;
  note: string;
  title?: string;
  /** The accessible name while unarmed, when the visible label leans on its row ("Delete Link" beside a name). */
  name?: string;
  class?: string;
  busy?: string | null;
  disabled?: boolean;
  onRun(): void;
}) {
  const { armed, arm, reset, disarm } = createArm<true>();
  const id = createUniqueId();
  return (
    <>
      <button
        type="button"
        class={`button button-sm button-destructive${props.class ? ` ${props.class}` : ""}`}
        title={props.title}
        aria-label={armed() || props.busy ? undefined : props.name}
        aria-describedby={armed() ? id : undefined}
        aria-disabled={props.disabled || props.busy ? "true" : undefined}
        onClick={() => {
          if (props.disabled || props.busy) return;
          if (!armed()) {
            arm(true);
            announce(props.note);
            return;
          }
          reset();
          props.onRun();
        }}
        onBlur={() => disarm(true)}
      >
        {props.busy ?? (armed() ? props.confirm : props.label)}
      </button>
      <Show when={armed()}>
        <p class="delete-note" id={id}>
          {props.note}
        </p>
      </Show>
    </>
  );
}

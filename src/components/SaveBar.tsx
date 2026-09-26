import type { JSX } from "solid-js";

/**
 * The action row every Save-gated Settings form ends in: the form's own Reset (if it has one)
 * leading, then Discard Changes and Save Changes, both disabled until the form differs from what's
 * saved; Save also until the form is valid (`canSave`). The primary stays at the trailing edge when
 * the row wraps (base.css, `.settings-delegate-actions`).
 */
export function SaveBar(props: {
  dirty: boolean;
  saving: boolean;
  /** The form is complete and valid; Save waits for it. Default true. */
  canSave?: boolean;
  onSave(): void;
  onDiscard(): void;
  /** Leading controls: a form's Reset button, a status hint. */
  leading?: JSX.Element;
}) {
  return (
    <div class="settings-delegate-actions">
      {props.leading}
      <span class="modal-spacer" />
      <button type="button" class="button button-ghost" disabled={props.saving || !props.dirty} onClick={() => props.onDiscard()}>
        Discard Changes
      </button>
      <button
        type="button"
        class="button button-primary"
        disabled={props.saving || !props.dirty || props.canSave === false}
        onClick={() => props.onSave()}
      >
        {props.saving ? "Saving…" : "Save Changes"}
      </button>
    </div>
  );
}

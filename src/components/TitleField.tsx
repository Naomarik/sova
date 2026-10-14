import { createSignal } from "solid-js";
import { SESSION_TITLE_MAX } from "../../shared/protocol";
import { inPlaceTitleEnd } from "../lib/title-field";

/**
 * One inline title field for a session (the Agents board's Rename…; the title is kept in Sova's
 * own title store, never in the session file). Enter saves, Escape cancels, and an EMPTY field clears the user's title so the
 * session goes back to the one derived from its first message — which is why this can't be
 * `GroupNameField`, where empty means cancel.
 */
export function TitleField(props: {
  initial: string;
  label: string;
  onDone(title: string | null): void;
  onCancel(): void;
  /** The id of the hint the field is described by. */
  describedBy: string;
  /** Leaving the field saves what's in it, and cancels when it's empty — the in-place rename of a
      row, where a field left open under a moving list would be lost. Without it the field stays
      open until Enter or Escape. Such a field also cancels, on Enter or leaving, when it still
      holds the title it opened with (`inPlaceTitleEnd`): the row's title may have moved under it. */
  blurSaves?: boolean;
}) {
  const opened = props.initial;
  const [value, setValue] = createSignal(props.initial);
  const end = (via: "enter" | "leave") => {
    const r = inPlaceTitleEnd(opened, value(), via);
    return () => (r ? props.onDone(r.save) : props.onCancel());
  };
  let input!: HTMLInputElement;
  let settled = false;
  const finish = (act: () => void) => {
    if (settled) return;
    settled = true;
    act();
  };
  return (
    <form
      class="group-field session-title-field"
      aria-label={props.label}
      onSubmit={(e) => {
        e.preventDefault();
        finish(props.blurSaves ? end("enter") : () => props.onDone(value().trim() ? value().trim() : null));
      }}
    >
      <input
        ref={(el) => {
          input = el;
          queueMicrotask(() => {
            input.focus();
            input.select();
          });
        }}
        class="input"
        type="text"
        maxlength={SESSION_TITLE_MAX}
        placeholder="Session title"
        aria-label={props.label}
        aria-describedby={props.describedBy}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation(); // Escape belongs to the field while it is open, not to the page
          finish(() => props.onCancel());
        }}
        onBlur={(e) => {
          if (!props.blurSaves) return;
          // Onto the field's own Save button: the submit settles it.
          if (e.relatedTarget instanceof Node && e.currentTarget.form?.contains(e.relatedTarget)) return;
          finish(end("leave"));
        }}
      />
      <button type="submit" class="button button-sm">
        Save
      </button>
    </form>
  );
}

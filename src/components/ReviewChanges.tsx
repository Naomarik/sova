import { createSignal, Show } from "solid-js";
import type { DiffScope } from "../../shared/protocol";
import { ChangesDialog } from "./ChangesViewer";

/** What a row's Review Changes says on hover: the branch against where it lands, uncommitted files marked. */
export const REVIEW_CHANGES_TITLE =
  "The branch against the branch it lands on, its uncommitted files included and marked, or, once merged, what its merge brought in. Nothing is changed.";

/**
 * A row's Review Changes (§chat.changes/entry): opens the changes viewer over the page on `scope`, and gives focus
 * back to this button when it closes. Its click never reaches the row (a Merge Queue row opens its chat).
 */
export function ReviewChangesButton(props: { branch: string; scope: () => DiffScope; cwd?: string; stepsFrom?: string; class?: string; title?: string }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  const close = () => {
    setOpen(false);
    queueMicrotask(() => button?.isConnected && button.focus());
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        class={`button button-sm button-ghost review-changes${props.class ? ` ${props.class}` : ""}`}
        aria-label={`Review Changes on ${props.branch}`}
        aria-haspopup="dialog"
        title={props.title ?? REVIEW_CHANGES_TITLE}
        onClick={() => setOpen(true)}
      >
        Review Changes
      </button>
      <Show when={open()}>
        <ChangesDialog scope={props.scope()} cwd={props.cwd} stepsFrom={props.stepsFrom} onClose={close} />
      </Show>
    </>
  );
}

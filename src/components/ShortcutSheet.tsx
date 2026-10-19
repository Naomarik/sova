import { createUniqueId, For } from "solid-js";
import { Portal } from "solid-js/web";
import { KEYS } from "../commands/keys";
import { trapFocus } from "./ui";
import "../command-palette.css";

/** The palette's own keys, after the app-wide ones (§app.command-palette/shortcut-sheet). */
const PALETTE_KEYS: readonly { keys: string; does: string }[] = [
  { keys: "↑ ↓", does: "In the command palette: chooses a row." },
  { keys: "Enter", does: "In the command palette: acts on the chosen row, and only that one." },
  { keys: "Esc", does: "In the command palette: goes back from a command, then closes." },
];

/**
 * The shortcut sheet (§app.command-palette/shortcut-sheet): every app-wide key in the one table
 * (commands/keys), then the palette's own. Loaded on the first "?" (App's `lazy`).
 */
export default function ShortcutSheet(props: { onClose(): void }) {
  const uid = createUniqueId();
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`shortcuts-title-${uid}`}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={`shortcuts-title-${uid}`}>
            Keyboard Shortcuts
          </h2>
        </div>
        <div class="modal-body">
          <dl class="shortcut-list">
            <For each={[...KEYS.map((k) => ({ keys: k.label, does: k.does })), ...PALETTE_KEYS]}>
              {(k) => (
                <div class="shortcut-row">
                  <dt>
                    <kbd class="palette-option-keys">{k.keys}</kbd>
                  </dt>
                  <dd>{k.does}</dd>
                </div>
              )}
            </For>
          </dl>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}

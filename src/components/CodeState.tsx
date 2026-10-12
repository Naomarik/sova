import { Show } from "solid-js";
import { codeChip, reloadButton, type CodeControl } from "../lib/code-state";
import { Chip } from "./ui";

/**
 * A chat process on older code, in its head (§app.chat-processes/code-pickup): the muted chip and
 * Reload Now beside it. Nothing while the chat is current or hosted in the server.
 */
export function CodeState(props: { control: CodeControl | null }) {
  const chip = () => (props.control ? codeChip(props.control.view()) : null);
  const button = () => (props.control ? reloadButton(props.control.view(), props.control.quiet()) : null);
  return (
    <Show when={chip()}>
      {(c) => (
        <span class="code-state">
          <Chip title={c().title}>{c().label}</Chip>
          <Show when={button()}>
            {(b) => (
              <button
                type="button"
                class="button button-sm button-ghost"
                aria-disabled={b().waiting ? "true" : undefined}
                title={b().waiting ? "It reloads at its next quiet moment, without cutting anything off." : "Reloads on the current code. A reply in progress finishes first."}
                onClick={() => {
                  if (!b().waiting) props.control?.reload();
                }}
              >
                {b().label}
              </button>
            )}
          </Show>
        </span>
      )}
    </Show>
  );
}

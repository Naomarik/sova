import { createEffect, createSignal, on, onMount, Show } from "solid-js";
import { drafts } from "../lib/ui-state";
import { Icon, type IconName } from "./ui";

export interface ComposerReason {
  icon: IconName;
  text: string;
}

/**
 * Prompt input (DESIGN_NOTES §4). Enter sends, Shift+Enter adds a newline. While `running`,
 * Send becomes Steer and Stop Turn appears. `readOnly` disables the textarea and hides Send;
 * `blocked` keeps typing allowed but makes Send aria-disabled, with the reason read out.
 * Drafts live per session path and survive every state change.
 */
export function Composer(props: {
  path: string;
  readOnly?: ComposerReason | null;
  blocked?: ComposerReason | null;
  running: boolean;
  stopping: boolean;
  /** "running bash" / "thinking" / "writing" / "Compacting context" … */
  detail: string | null;
  autofocus?: boolean;
  onSend(text: string, steer: boolean): boolean;
  onAbort(): void;
}) {
  const [text, setText] = createSignal(drafts.get(props.path) ?? "");
  let input!: HTMLTextAreaElement;

  const setDraft = (v: string) => {
    setText(v);
    if (v) drafts.set(props.path, v);
    else drafts.delete(props.path);
  };

  // Auto-grow fallback where `field-sizing: content` isn't supported.
  const grow = () => {
    if (CSS.supports("field-sizing", "content")) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };
  createEffect(on(text, () => queueMicrotask(grow)));
  onMount(() => {
    // After the frame, so a closing dialog's focus handling has already run.
    if (props.autofocus && !props.readOnly) requestAnimationFrame(() => input.focus());
  });

  const reason = () => props.readOnly ?? props.blocked ?? null;
  const canSend = () => !reason() && text().trim().length > 0;

  const send = (e?: Event) => {
    e?.preventDefault();
    if (!canSend()) return;
    if (props.onSend(text().trim(), props.running)) setDraft("");
    input.focus();
  };

  return (
    <footer class="composer">
      <form class="composer-inner" aria-label="Message the agent" onSubmit={send}>
        <Show when={props.running}>
          <p class="run-status">
            <span class="live-dot" />
            <Show when={!props.stopping} fallback="Stopping…">
              Working
              <Show when={props.detail}>
                <span class="run-status-detail">· {props.detail}</span>
              </Show>
            </Show>
          </p>
        </Show>

        <div class="composer-row">
          <label class="visually-hidden" for="composer-input">
            Message
          </label>
          <textarea
            ref={input}
            class="input textarea composer-input"
            id="composer-input"
            rows={1}
            placeholder={props.running ? "Steer the current turn…" : "Ask pi to…"}
            aria-describedby="composer-reason"
            value={text()}
            disabled={!!props.readOnly}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) send(e);
            }}
          />
          <div class="composer-actions">
            <Show when={props.running && !props.readOnly}>
              <button
                type="button"
                class="button button-destructive"
                aria-disabled={props.stopping ? "true" : undefined}
                onClick={() => {
                  if (!props.stopping) props.onAbort();
                  input.focus();
                }}
              >
                <Icon name="pause" small />
                Stop Turn
              </button>
            </Show>
            <Show when={!props.readOnly}>
              <button
                type="submit"
                class="button button-primary"
                aria-disabled={canSend() ? undefined : "true"}
                aria-describedby="composer-reason"
              >
                <Icon name="arrow-right" small />
                {props.running ? "Steer" : "Send"}
              </button>
            </Show>
          </div>
        </div>

        <div class="composer-foot">
          <span class="composer-reason" id="composer-reason">
            <Show when={reason()}>
              {(r) => (
                <>
                  <Icon name={r().icon} small />
                  {r().text}
                </>
              )}
            </Show>
          </span>
          <Show when={!props.readOnly}>
            <span class="composer-hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
            </span>
          </Show>
        </div>
      </form>
    </footer>
  );
}

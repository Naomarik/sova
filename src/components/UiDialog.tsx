import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { isObj, str } from "../lib/message";
import { trapFocus } from "./ui";

/**
 * An extension dialog bridged from the server (DESIGN_NOTES §6). `onAnswer(value)` sends
 * ui_response: a string for select/input/editor, true for confirm, null to cancel (the server
 * then applies the extension's default, which is false for confirm).
 */
export function UiDialog(props: { request: unknown; onAnswer(value: unknown): void }) {
  const req = () => (isObj(props.request) ? props.request : {});
  const method = () => str(req().method) ?? "";
  const options = () => (Array.isArray(req().options) ? (req().options as unknown[]).map(String) : []);
  const [text, setText] = createSignal(str(req().prefill) ?? "");
  let first: HTMLElement | undefined;
  onMount(() => first?.focus());
  const cancel = () => props.onAnswer(null);

  return (
    <>
      <div class="scrim" onClick={cancel} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="ui-title">
            {str(req().title) ?? "An extension is asking"}
          </h2>
        </div>
        <div class="modal-body">
          <Switch>
            <Match when={method() === "confirm"}>
              <Show when={str(req().message)}>
                <p class="message-text">{str(req().message)}</p>
              </Show>
            </Match>
            <Match when={method() === "select"}>
              <ul class="list" role="listbox" aria-labelledby="ui-title">
                <For each={options()}>
                  {(opt, i) => (
                    <li
                      class="list-row list-row-interactive"
                      role="option"
                      tabindex="0"
                      aria-selected="false"
                      ref={(el) => {
                        if (i() === 0) first = el;
                      }}
                      onClick={() => props.onAnswer(opt)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          props.onAnswer(opt);
                        }
                      }}
                    >
                      <span class="list-title">{opt}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Match>
            <Match when={method() === "input" || method() === "editor"}>
              <div class="field">
                <label class="field-label" for="ui-input">
                  {method() === "editor" ? "Text" : "Answer"}
                </label>
                <Show
                  when={method() === "editor"}
                  fallback={
                    <input
                      id="ui-input"
                      class="input"
                      ref={(el) => (first = el)}
                      placeholder={str(req().placeholder) ?? ""}
                      value={text()}
                      onInput={(e) => setText(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") props.onAnswer(text());
                      }}
                    />
                  }
                >
                  <textarea
                    id="ui-input"
                    class="input textarea input-mono"
                    rows={10}
                    ref={(el) => (first = el)}
                    value={text()}
                    onInput={(e) => setText(e.currentTarget.value)}
                  />
                </Show>
              </div>
            </Match>
          </Switch>
          <Show when={typeof req().timeout === "number"}>
            <p class="field-hint">Answers itself with the extension's default after {Math.round((req().timeout as number) / 1000)}s.</p>
          </Show>
        </div>
        <div class="modal-foot">
          <Switch>
            <Match when={method() === "confirm"}>
              <button type="button" class="button button-primary" ref={(el) => (first = el)} onClick={() => props.onAnswer(true)}>
                Confirm
              </button>
            </Match>
            <Match when={method() === "input" || method() === "editor"}>
              <button type="button" class="button button-primary" onClick={() => props.onAnswer(text())}>
                Submit
              </button>
            </Match>
          </Switch>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

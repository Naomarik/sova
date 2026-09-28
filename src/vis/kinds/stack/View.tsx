/** `vis stack` view: HTML bands, top layer first; items wrap. */
import { For, Show } from "solid-js";
import { looksLikePath } from "../../core/text";
import type { ViewProps } from "../../types";
import type { StackSpec } from "./parse";
import "./stack.css";

export default function StackView(props: ViewProps<StackSpec>) {
  return (
    <ol class="vis-stack" aria-label={props.label}>
      <For each={props.spec.layers}>
        {(l) => (
          <li class={`vis-stack-layer vis-tone-${l.tone ?? "none"}`}>
            <span class="vis-stack-label">{l.label}</span>
            <span class="vis-stack-body">
              <Show when={l.items.length}>
                <ul class="vis-stack-items">
                  <For each={l.items}>{(item) => <li classList={{ "vis-mono": looksLikePath(item) }}>{item}</li>}</For>
                </ul>
              </Show>
              <Show when={l.note}>
                <span class="vis-stack-note">{l.note}</span>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

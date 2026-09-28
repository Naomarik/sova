/** `vis layers` view: HTML bands, top layer first; items wrap. */
import { For, Show } from "solid-js";
import { looksLikePath } from "../../core/text";
import type { ViewProps } from "../../types";
import type { LayersSpec } from "./parse";
import "./layers.css";

export default function LayersView(props: ViewProps<LayersSpec>) {
  return (
    <ol class="vis-layers" aria-label={props.label}>
      <For each={props.spec.layers}>
        {(l) => (
          <li class={`vis-layers-layer vis-tone-${l.tone ?? "none"}`}>
            <span class="vis-layers-label">{l.label}</span>
            <span class="vis-layers-body">
              <Show when={l.items.length}>
                <ul class="vis-layers-items">
                  <For each={l.items}>{(item) => <li classList={{ "vis-mono": looksLikePath(item) }}>{item}</li>}</For>
                </ul>
              </Show>
              <Show when={l.note}>
                <span class="vis-layers-note">{l.note}</span>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

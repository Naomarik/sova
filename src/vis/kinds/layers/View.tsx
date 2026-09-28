/** `vis layers` view: HTML bands, top layer first; items wrap. */
import { For, Show, createMemo } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import { looksLikePath } from "../../core/text";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import type { LayersSpec } from "./parse";
import "./layers.css";

export default function LayersView(props: ViewProps<LayersSpec>) {
  const em = createMemo(() => emphasisMap(props.spec));
  return (
    <ol class="vis-layers" aria-label={props.label}>
      <For each={props.spec.layers}>
        {(l, i) => {
          const e = () => em().get(String(i()));
          return (
            <li class={`vis-layers-layer ${e() ? emClass(e()) : `vis-tone-${l.tone ?? "none"}`}`}>
              <span class="vis-layers-label">
                <EmBadge e={e()} />
                {l.label}
              </span>
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
          );
        }}
      </For>
    </ol>
  );
}

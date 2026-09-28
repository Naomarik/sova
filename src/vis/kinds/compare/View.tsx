/** `vis compare` view: an HTML table; marks are a glyph plus a hidden word, never hue alone. */
import { For, Show } from "solid-js";
import type { ViewProps } from "../../types";
import type { CompareSpec, Mark } from "./parse";
import "./compare.css";

const MARK_TEXT: Record<Mark, string> = { yes: "Yes", no: "No", partial: "Partly" };

export default function CompareView(props: ViewProps<CompareSpec>) {
  return (
    <div class="vis-compare-wrap" tabindex="0" role="region" aria-label={`${props.label} (scrolls sideways)`}>
      <table class="vis-compare">
        <thead>
          <tr>
            <th scope="col">
              <span class="visually-hidden">Criterion</span>
            </th>
            <For each={props.spec.columns}>{(c) => <th scope="col">{c}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.spec.rows}>
            {(r) => (
              <tr>
                <th scope="row">{r.label}</th>
                <For each={r.cells}>
                  {(c) => (
                    <td>
                      <Show when={c.mark}>
                        <span class={`vis-mark vis-mark-${c.mark}`} aria-hidden="true" />
                        <span class="visually-hidden">{MARK_TEXT[c.mark!]}</span>
                      </Show>
                      <Show when={c.text}>
                        <span class="vis-cell-text">{c.text}</span>
                      </Show>
                      <Show when={!c.mark && !c.text}>
                        <span class="vis-cell-empty" aria-label="None">—</span>
                      </Show>
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

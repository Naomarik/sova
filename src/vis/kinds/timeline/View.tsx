/** `vis timeline` view: an HTML ordered list on a vertical spine. */
import { For, Show } from "solid-js";
import type { ViewProps } from "../../types";
import type { TimelineSpec } from "./parse";
import "./timeline.css";

export default function TimelineView(props: ViewProps<TimelineSpec>) {
  return (
    <ol class="vis-timeline" aria-label={props.label}>
      <For each={props.spec.items}>
        {(it) =>
          it.type === "section" ? (
            <li class="vis-timeline-section">{it.label}</li>
          ) : (
            <li class={`vis-timeline-row vis-tone-${it.tone ?? "none"}`}>
              <span class="vis-timeline-when">{it.when}</span>
              <span class="vis-timeline-dot" aria-hidden="true" />
              <span class="vis-timeline-text">
                <span class="vis-timeline-label">{it.label}</span>
                <Show when={it.note}>
                  <span class="vis-timeline-note">{it.note}</span>
                </Show>
              </span>
            </li>
          )
        }
      </For>
    </ol>
  );
}

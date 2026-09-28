/**
 * `vis timeline` view: an HTML ordered list on a vertical spine. The list is one grid, and each row
 * a subgrid, so every `when` lines up in one column; below 420px the when moves above its label.
 */
import { For, Show, createMemo } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import type { TimelineSpec } from "./parse";
import "./timeline.css";

export default function TimelineView(props: ViewProps<TimelineSpec>) {
  const em = createMemo(() => emphasisMap(props.spec));
  return (
    <ol class="vis-timeline" aria-label={props.label}>
      <For each={props.spec.items}>
        {(it, i) => {
          if (it.type === "section") {
            return (
              <li class="vis-timeline-section">
                <span class="vis-timeline-rail" aria-hidden="true" />
                <span class="vis-timeline-section-label">{it.label}</span>
              </li>
            );
          }
          const e = () => em().get(String(i()));
          return (
            <li class={`vis-timeline-row ${e() ? emClass(e()) : `vis-tone-${it.tone ?? "none"}`}`} classList={{ "vis-timeline-toned": !!(e() || it.tone) }}>
              <span class="vis-timeline-when">{it.when}</span>
              <span class="vis-timeline-rail" aria-hidden="true">
                <span class="vis-timeline-dot" />
              </span>
              <span class="vis-timeline-text">
                <span class="vis-timeline-label">
                  <EmBadge e={e()} />
                  {it.label}
                </span>
                <Show when={it.note}>
                  <span class="vis-timeline-note">{it.note}</span>
                </Show>
              </span>
            </li>
          );
        }}
      </For>
    </ol>
  );
}

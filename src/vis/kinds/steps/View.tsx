/**
 * `vis steps` view: HTML rows, each its status mark and label, then its steps as chips joined by
 * arrows that wrap with the pane; lane heads between groups of rows. Below 420px the label sits
 * above its chain.
 */
import { For, Show, createMemo } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import type { Tone } from "../../core/grammar";
import { looksLikePath } from "../../core/text";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import type { StepsSpec } from "./parse";
import "./steps.css";

/** A status never rests on hue alone: the tones that carry one also carry a shape. */
const ICON: Partial<Record<Tone, string>> = { ok: "check-circle", warn: "alert-circle", error: "x-circle", info: "info" };

export default function StepsView(props: ViewProps<StepsSpec>) {
  const em = createMemo(() => emphasisMap(props.spec));
  return (
    <div class="vis-steps" role="list" aria-label={props.label}>
      <For each={props.spec.items}>
        {(it, i) => {
          if (it.type === "lane") return <div class="vis-steps-lane" role="listitem">{it.label}</div>;
          const e = () => em().get(String(i()));
          return (
            <div role="listitem" class={`vis-steps-row ${e() ? emClass(e()) : `vis-tone-${it.tone ?? "none"}`}`}>
              <span class="vis-steps-head">
                <span class={`vis-steps-status vis-tone-${it.tone ?? "none"}`} classList={{ "vis-steps-status-plain": !it.tone || !ICON[it.tone] }} role={it.tone ? "img" : undefined} aria-label={it.tone}>
                  <Show when={it.tone && ICON[it.tone]}>
                    <span class="icon icon-sm" style={{ "--icon": `url(/icons/${ICON[it.tone!]}.svg)` }} aria-hidden="true" />
                  </Show>
                </span>
                <span class="vis-steps-label">
                  <EmBadge e={e()} />
                  {it.label}
                </span>
              </span>
              <ol class="vis-steps-chain">
                <For each={it.steps}>
                  {(step, k) => (
                    <li>
                      <Show when={k() > 0}>
                        <span class="vis-steps-arrow icon" style={{ "--icon": "url(/icons/arrow-right.svg)" }} aria-hidden="true" />
                      </Show>
                      <span class="vis-steps-chip" classList={{ "vis-mono": looksLikePath(step) }}>{step}</span>
                    </li>
                  )}
                </For>
              </ol>
            </div>
          );
        }}
      </For>
    </div>
  );
}

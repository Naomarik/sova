import { For, createMemo } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import type { ChartSpec } from "./parse";
import { partsOf } from "./parts";
import "./parts.css";

/**
 * `vis chart` `type: parts`: the total first (against the capacity, when there is one), then one
 * bar split into the parts in order, then a legend row per part. The bar is decoration for the
 * numbers (aria-hidden, as a meter's track is); a tiny part keeps a sliver and its legend row.
 */
export default function PartsView(props: ViewProps<ChartSpec>) {
  const data = createMemo(() => partsOf(props.spec));
  const em = createMemo(() => emphasisMap(props.spec));
  const unit = () => (props.spec.unit && props.spec.unit !== "%" ? ` ${props.spec.unit}` : "");
  return (
    <div class="vis-parts" classList={{ "vis-parts-capped": props.spec.of !== undefined }}>
      <p class="vis-parts-head">
        <span class="vis-parts-total">{data().head.value}</span>
        <span class="vis-parts-of">{data().head.rest}</span>
      </p>
      <div class="vis-parts-bar" aria-hidden="true">
        <For each={data().parts}>
          {(p) => (
            <span
              class={`vis-parts-seg ${p.row < 0 ? "vis-parts-free" : p.color}`}
              classList={{ "vis-parts-zero": p.value === 0, "vis-parts-em": p.row >= 0 && em().has(String(p.row)) }}
              style={{ "flex-grow": String(p.value) }}
              title={`${p.label}: ${p.valueText}${unit()} (${p.pctText})`}
            />
          )}
        </For>
      </div>
      <ol class="vis-parts-legend" aria-label={props.label}>
        <For each={data().parts}>
          {(p) => {
            const e = () => (p.row >= 0 ? em().get(String(p.row)) : undefined);
            return (
              <li class={`vis-parts-row ${emClass(e())}`} classList={{ "vis-parts-row-free": p.row < 0 }}>
                <span class={`vis-parts-swatch ${p.row < 0 ? "vis-parts-free" : p.color}`} aria-hidden="true" />
                <span class="vis-parts-label">
                  <EmBadge e={e()} />
                  {p.label}
                </span>
                <span class="vis-parts-value">{p.valueText}</span>
                <span class="vis-parts-pct">{p.pctText}</span>
              </li>
            );
          }}
        </For>
      </ol>
    </div>
  );
}

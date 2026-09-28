import { Show } from "solid-js";
import type { Emphasis } from "./core/grammar";

/**
 * The emphasis marks a View puts on an item (see core/emphasis.ts). The item itself gets
 * `emClass(e)` — `vis-em vis-tone-<tone>` — and, when the mark has a note, the numbered badge that
 * matches the figure's notes list. Styles are in vis.css; a View adds nothing of its own for them.
 */
export const emClass = (e: Emphasis | undefined) => (e ? `vis-em vis-tone-${e.tone}` : "");

/** The note's number, inline in HTML (a row, a line, a tree item). */
export function EmBadge(props: { e: Emphasis | undefined }) {
  return (
    <Show when={props.e?.n}>
      <span class="vis-em-badge" aria-label={`note ${props.e!.n}`}>
        {props.e!.n}
      </span>
    </Show>
  );
}

/** The note's number in SVG, centred on (x, y) — a View puts it on its item's top-right corner. */
export function SvgEmBadge(props: { e: Emphasis | undefined; x: number; y: number }) {
  return (
    <Show when={props.e?.n}>
      <g class={`vis-em-badge-svg vis-tone-${props.e!.tone}`} role="img" aria-label={`note ${props.e!.n}`}>
        <circle cx={props.x} cy={props.y} r="9" />
        <text x={props.x} y={props.y} text-anchor="middle" dominant-baseline="central" font-size="11">
          {props.e!.n}
        </text>
      </g>
    </Show>
  );
}

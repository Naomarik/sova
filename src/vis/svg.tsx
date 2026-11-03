import { For, createSignal, type JSX } from "solid-js";

// Bumped when a web font finishes loading. canvasMeasure drops its cached widths then
// (core/text.ts), so a layout memo that reads this re-measures its text in the real font.
const [fonts, setFonts] = createSignal(0);
if (typeof document !== "undefined" && document.fonts) document.fonts.addEventListener("loadingdone", () => setFonts((n) => n + 1));
/** Read inside any layout memo that measures text with canvasMeasure: it re-runs once fonts load. */
export const fontsLoaded = fonts;

let markerSeq = 0;
/** A document-unique id for an SVG <marker>: several visuals share one page. */
export const useMarkerId = () => `vis-arrow-${++markerSeq}`;

/**
 * A drawing at its natural size that shrinks with the pane down to 80% of that size, then scrolls
 * sideways inside its own box: text stays legible on a phone and the pane never widens.
 * `controls`: its shapes are buttons and an ancestor is the drawing's one Tab stop (flow's
 * View), so the box is no Tab stop of its own (-1: Chrome would make a scrolling box one) and the
 * drawing is a group, not an image.
 */
export function SvgScroll(props: { width: number; height: number; label: string; controls?: boolean; children: JSX.Element }) {
  return (
    <div class="vis-scroll" tabindex={props.controls ? "-1" : "0"} role={props.controls ? undefined : "region"} aria-label={props.controls ? undefined : `${props.label} (scrolls sideways)`}>
      <svg
        class="vis-svg"
        viewBox={`0 0 ${props.width} ${props.height}`}
        width={props.width}
        style={{ width: "100%", "max-width": `${props.width}px`, "min-width": `${Math.round(props.width * 0.8)}px` }}
        role={props.controls ? "group" : "img"}
        aria-label={props.label}
      >
        {props.children}
      </svg>
    </div>
  );
}

/**
 * Centered multi-line SVG text. `y` is the middle of the block, or with `top` the middle of the
 * first line.
 */
export function Lines(props: { lines: string[]; x: number; y: number; size: number; lh: number; top?: boolean; class?: string; anchor?: "start" | "middle" | "end" }) {
  const first = () => (props.top ? props.y : props.y - ((props.lines.length - 1) * props.lh) / 2);
  return (
    <text class={props.class} x={props.x} y={first()} font-size={String(props.size)} text-anchor={props.anchor ?? "middle"} dominant-baseline="central">
      <For each={props.lines}>{(l, i) => <tspan x={props.x} y={first() + i() * props.lh}>{l}</tspan>}</For>
    </text>
  );
}

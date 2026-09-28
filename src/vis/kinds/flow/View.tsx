import { For, Show, createMemo, type JSX } from "solid-js";
import { canvasMeasure } from "../../core/text";
import { Lines, SvgScroll, useMarkerId } from "../../svg";
import type { ViewProps } from "../../types";
import { FLOW_FONT, layoutFlow, type PlacedFlowNode } from "./layout";
import type { FlowSpec } from "./parse";
import "./flow.css";

/** `vis flow` / `vis state`: boxes and arrows, laid out by lib/vis/flow-layout. */
export default function FlowView(props: ViewProps<FlowSpec>) {
  const layout = createMemo(() => layoutFlow(props.spec, canvasMeasure));
  const arrow = useMarkerId();
  return (
    <SvgScroll width={layout().width} height={layout().height} label={props.label}>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" class="vis-arrowhead" />
        </marker>
      </defs>
      <g class="vis-edges">
        <For each={layout().edges}>
          {(e) => (
            <path
              d={e.path}
              class="vis-edge"
              classList={{ "vis-dashed": e.dashed }}
              marker-end={`url(#${arrow})`}
              marker-start={e.both ? `url(#${arrow})` : undefined}
            />
          )}
        </For>
      </g>
      <For each={layout().edges.filter((e) => e.label)}>
        {(e) => (
          <g class="vis-edge-label">
            <rect x={e.label!.x - e.label!.w / 2} y={e.label!.y - e.label!.h / 2} width={e.label!.w} height={e.label!.h} rx="4" />
            <Lines lines={e.label!.lines} x={e.label!.x} y={e.label!.y} size={FLOW_FONT.edge} lh={15} />
          </g>
        )}
      </For>
      <For each={layout().nodes}>{(n) => <Node n={n} />}</For>
    </SvgScroll>
  );
}

function Node(props: { n: PlacedFlowNode }) {
  const n = props.n;
  const x0 = n.x - n.w / 2;
  const y0 = n.y - n.h / 2;
  let shape: JSX.Element;
  switch (n.shape) {
    case "round":
      shape = <rect x={x0} y={y0} width={n.w} height={n.h} rx={Math.min(n.h / 2, 18)} />;
      break;
    case "decision":
      shape = <polygon points={`${n.x},${y0} ${x0 + n.w},${n.y} ${n.x},${y0 + n.h} ${x0},${n.y}`} />;
      break;
    case "circle":
      shape = <circle cx={n.x} cy={n.y} r={n.w / 2} />;
      break;
    case "start":
      shape = <circle cx={n.x} cy={n.y} r={n.w / 2} class="vis-solid" />;
      break;
    case "end":
      shape = (
        <>
          <circle cx={n.x} cy={n.y} r={n.w / 2} />
          <circle cx={n.x} cy={n.y} r={n.w / 2 - 5} class="vis-solid" />
        </>
      );
      break;
    case "store": {
      const ry = 5;
      shape = (
        <>
          <path d={`M${x0},${y0 + ry} A${n.w / 2},${ry} 0 0 0 ${x0 + n.w},${y0 + ry} V${y0 + n.h - ry} A${n.w / 2},${ry} 0 0 1 ${x0},${y0 + n.h - ry} Z`} />
          <path d={`M${x0},${y0 + ry} A${n.w / 2},${ry} 0 0 1 ${x0 + n.w},${y0 + ry}`} class="vis-cap" />
        </>
      );
      break;
    }
    default:
      shape = <rect x={x0} y={y0} width={n.w} height={n.h} rx="6" />;
  }
  const textH = n.lines.length * 17 + n.noteLines.length * 15;
  const top = n.y - textH / 2 + (n.shape === "store" ? 3 : 0);
  return (
    <g class={`vis-node vis-tone-${n.tone ?? "none"}`}>
      <title>{n.full}</title>
      {shape}
      <Lines lines={n.lines} x={n.x} y={top + 17 / 2} size={FLOW_FONT.label} lh={17} top class="vis-node-label" />
      <Show when={n.noteLines.length}>
        <Lines lines={n.noteLines} x={n.x} y={top + n.lines.length * 17 + 15 / 2} size={FLOW_FONT.note} lh={15} top class="vis-node-note" />
      </Show>
    </g>
  );
}

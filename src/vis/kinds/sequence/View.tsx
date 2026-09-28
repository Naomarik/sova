import { For, Match, Switch, createMemo } from "solid-js";
import { canvasMeasure } from "../../core/text";
import { Lines, SvgScroll, useMarkerId } from "../../svg";
import type { ViewProps } from "../../types";
import { SEQ_FONT, layoutSequence } from "./layout";
import type { SequenceSpec } from "./parse";
import "./sequence.css";

/** `vis sequence`: actors across the top, lifelines down, one row per message, note or divider. */
export default function SequenceView(props: ViewProps<SequenceSpec>) {
  const layout = createMemo(() => layoutSequence(props.spec, canvasMeasure));
  const solid = useMarkerId();
  const open = useMarkerId();
  return (
    <SvgScroll width={layout().width} height={layout().height} label={props.label}>
      <defs>
        <marker id={solid} viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" class="vis-arrowhead" />
        </marker>
        <marker id={open} viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M1,1 L9,5 L1,9" class="vis-arrowhead-open" />
        </marker>
      </defs>
      <For each={layout().actors}>
        {(a) => (
          <g class={`vis-actor vis-tone-${a.tone ?? "none"}`}>
            <line x1={a.x} x2={a.x} y1={12 + layout().headH} y2={layout().lifelineEnd} class="vis-lifeline" />
            <rect x={a.x - a.w / 2} y={12} width={a.w} height={layout().headH} rx="6" />
            <Lines lines={a.lines} x={a.x} y={12 + layout().headH / 2} size={SEQ_FONT.actor} lh={15} class="vis-node-label" />
          </g>
        )}
      </For>
      <For each={layout().rows}>
        {(r) => (
          <Switch>
            <Match when={r.type === "msg" && r}>
              {(m) => (
                <g class="vis-msg">
                  {m().self ? (
                    <path
                      d={`M${m().x1} ${m().y} h28 v18 h-26`}
                      class="vis-edge"
                      classList={{ "vis-dashed": m().dashed }}
                      marker-end={`url(#${m().dashed ? open : solid})`}
                    />
                  ) : (
                    <line
                      x1={m().x1}
                      x2={m().x2 + (m().x2 > m().x1 ? -1 : 1)}
                      y1={m().y}
                      y2={m().y}
                      class="vis-edge"
                      classList={{ "vis-dashed": m().dashed }}
                      marker-end={`url(#${m().dashed ? open : solid})`}
                    />
                  )}
                  <Lines
                    lines={m().lines}
                    x={m().self ? m().x1 + 36 : (m().x1 + m().x2) / 2}
                    y={m().labelY + 7}
                    size={SEQ_FONT.msg}
                    lh={15}
                    top
                    anchor={m().self ? "start" : "middle"}
                    class="vis-msg-label"
                  />
                </g>
              )}
            </Match>
            <Match when={r.type === "note" && r}>
              {(n) => (
                <g class="vis-note">
                  <rect x={n().x - n().w / 2} y={n().y} width={n().w} height={n().h} rx="4" />
                  <Lines lines={n().lines} x={n().x} y={n().y + 5 + 15 / 2} size={SEQ_FONT.note} lh={15} top />
                </g>
              )}
            </Match>
            <Match when={r.type === "divider" && r}>
              {(d) => (
                <g class="vis-divider">
                  <line x1={4} x2={layout().width - 4} y1={d().y} y2={d().y} />
                  <rect x={layout().width / 2 - d().labelW / 2} y={d().y - 10} width={d().labelW} height={20} rx="10" />
                  <text x={layout().width / 2} y={d().y} font-size={String(SEQ_FONT.msg)} text-anchor="middle" dominant-baseline="central">
                    {d().label}
                  </text>
                </g>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </SvgScroll>
  );
}

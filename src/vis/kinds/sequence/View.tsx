import { For, Match, Show, Switch, createEffect, createMemo, on } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import { canvasMeasure } from "../../core/text";
import { emClass, SvgEmBadge } from "../../emphasis";
import { createStepper } from "../../stepper";
import { Lines, SvgScroll, useMarkerId } from "../../svg";
import type { ViewProps } from "../../types";
import { useWidth } from "../flow/width";
import { SELF_LOOP, SEQ_FONT, SEQ_LINE, layoutSequence, seqFit } from "./layout";
import type { SequenceSpec } from "./parse";
import "./sequence.css";

/**
 * `vis sequence`: actors across the top, lifelines down, one row per message, note or divider.
 * The step-through control (stepper.tsx) walks the messages — step k is message k, the number a
 * `mark k` names — dimming what comes later and bringing the current one into view. A marked actor
 * (key `actor:<id>`) takes its tone on its head and lifeline; a marked message (`step:<row>`) gets
 * a tinted band, a heavier arrow and its note's badge.
 */
export default function SequenceView(props: ViewProps<SequenceSpec>) {
  const [width, measure] = useWidth();
  // Fit the pane, counting SvgScroll's shrink to 80%; past that, it scrolls.
  const layout = createMemo(() => layoutSequence(props.spec, canvasMeasure, seqFit(width())));
  const em = createMemo(() => emphasisMap(props.spec));
  const stepper = createStepper(() => layout().steps);
  const solid = useMarkerId();
  const open = useMarkerId();
  // Arrowheads don't take their line's colour, so each tone a marked message uses has its own pair.
  const tones = createMemo(() => [...new Set((props.spec.emphasis ?? []).filter((e) => e.key.startsWith("step:")).map((e) => e.tone))]);
  const toneMarkers = new Map(["accent", "ok", "warn", "error", "info", "muted"].map((t) => [t, { solid: useMarkerId(), open: useMarkerId() }]));
  const actorName = (id: string) => props.spec.actors.find((a) => a.id === id)?.label ?? id;
  const rowEls: SVGGElement[] = [];

  const current = () => stepper.at();
  const isCurrent = (row: number) => current() !== null && layout().stepOf[row] === current();
  // What the current step says, for a screen reader: the stepper announces only its number.
  const said = createMemo(() => {
    const at = current();
    if (at === null) return "";
    return props.spec.steps
      .filter((_, i) => layout().stepOf[i] === at)
      .map((s) => (s.type === "msg" ? `${actorName(s.from)} to ${actorName(s.to)}${s.label ? `: ${s.label}` : ""}` : s.type === "note" ? `Note: ${s.text}` : s.label))
      .join(". ");
  });
  createEffect(
    on(current, (at) => {
      if (at === null) return;
      const l = layout();
      let row = l.rows.findIndex((r, i) => l.stepOf[i] === at && r.type === "msg");
      if (row === -1) row = l.stepOf.indexOf(at);
      rowEls[row]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }, { defer: true }),
  );

  return (
    <div ref={measure} class="vis-seq">
      <stepper.Controls />
      <div class="visually-hidden" aria-live="polite">
        {said()}
      </div>
      <SvgScroll width={layout().width} height={layout().height} label={props.label}>
        <defs>
          <Head id={solid} />
          <Head id={open} open />
          <For each={tones()}>
            {(t) => (
              <>
                <Head id={toneMarkers.get(t)!.solid} tone={t} />
                <Head id={toneMarkers.get(t)!.open} tone={t} open />
              </>
            )}
          </For>
        </defs>
        <For each={layout().actors}>
          {(a) => {
            const e = () => em().get(`actor:${a.id}`);
            return (
              <g class={`vis-actor ${e() ? emClass(e()) : `vis-tone-${a.tone ?? "none"}`}`}>
                <line x1={a.x} x2={a.x} y1={layout().headY + layout().headH} y2={layout().lifelineEnd} class="vis-lifeline" />
                <rect x={a.x - a.w / 2} y={layout().headY} width={a.w} height={layout().headH} rx="6" />
                <Lines lines={a.lines} x={a.x} y={layout().headY + layout().headH / 2} size={SEQ_FONT.actor} lh={SEQ_LINE} class="vis-node-label" />
                <SvgEmBadge e={e()} x={a.x + a.w / 2 - 3} y={layout().headY + 3} />
              </g>
            );
          }}
        </For>
        <For each={layout().rows}>
          {(r, i) => {
            const e = () => em().get(`step:${i()}`);
            const heads = () => (e() ? toneMarkers.get(e()!.tone)! : { solid, open });
            return (
              <g
                ref={(el) => (rowEls[i()] = el)}
                class={`vis-seq-row ${emClass(e())}`}
                classList={{ "vis-future": !stepper.shown(layout().stepOf[i()]!), "vis-seq-current": isCurrent(i()) }}
              >
                <Switch>
                  <Match when={r.type === "msg" && r}>
                    {(m) => (
                      <>
                        <Show when={e()}>
                          <rect class="vis-seq-band" x={m().box.x} y={m().box.y} width={m().box.w} height={m().box.h} rx="6" />
                        </Show>
                        {m().self ? (
                          <path
                            d={`M${m().x1} ${m().y} h${m().left ? -SELF_LOOP : SELF_LOOP} v${m().box.h - 16} h${m().left ? SELF_LOOP - 2 : 2 - SELF_LOOP}`}
                            class="vis-edge vis-msg-line"
                            classList={{ "vis-dashed": m().dashed }}
                            marker-end={`url(#${m().dashed ? heads().open : heads().solid})`}
                          />
                        ) : (
                          <line
                            x1={m().x1}
                            x2={m().x2 + (m().x2 > m().x1 ? -1 : 1)}
                            y1={m().y}
                            y2={m().y}
                            class="vis-edge vis-msg-line"
                            classList={{ "vis-dashed": m().dashed }}
                            marker-end={`url(#${m().dashed ? heads().open : heads().solid})`}
                          />
                        )}
                        <Lines
                          lines={m().lines}
                          x={m().self ? m().x1 + (m().left ? -1 : 1) * (SELF_LOOP + 8) : (m().x1 + m().x2) / 2}
                          y={m().labelY + 7}
                          size={SEQ_FONT.msg}
                          lh={SEQ_LINE}
                          top
                          anchor={m().self ? (m().left ? "end" : "start") : "middle"}
                          class="vis-msg-label"
                        />
                        <SvgEmBadge e={e()} x={m().box.x + m().box.w - 2} y={m().box.y + 2} />
                      </>
                    )}
                  </Match>
                  <Match when={r.type === "note" && r}>
                    {(n) => (
                      <g class="vis-note">
                        <rect x={n().x - n().w / 2} y={n().y} width={n().w} height={n().h} rx="4" />
                        <Lines lines={n().lines} x={n().x} y={n().y + 5 + SEQ_LINE / 2} size={SEQ_FONT.note} lh={SEQ_LINE} top />
                      </g>
                    )}
                  </Match>
                  <Match when={r.type === "divider" && r}>
                    {(d) => (
                      <g class="vis-divider">
                        <line x1={4} x2={layout().width - 4} y1={d().y} y2={d().y} />
                        <rect x={d().box.x} y={d().box.y} width={d().box.w} height={d().box.h} rx="10" />
                        <text x={layout().width / 2} y={d().y} font-size={String(SEQ_FONT.msg)} text-anchor="middle" dominant-baseline="central">
                          {d().label}
                        </text>
                      </g>
                    )}
                  </Match>
                </Switch>
              </g>
            );
          }}
        </For>
      </SvgScroll>
    </div>
  );
}

/** An arrowhead marker: solid for a call, open for a reply; a tone's colour for a marked message. */
function Head(props: { id: string; open?: boolean; tone?: string }) {
  // Markers scale with their line's stroke: a marked message's 2.5 line would otherwise get heads 5/3 the size.
  const size = () => ((props.open ? 8 : 7) * (props.tone ? 1.5 / 2.5 : 1)).toFixed(2);
  return (
    <marker
      id={props.id}
      class={props.tone ? `vis-tone-${props.tone} vis-seq-head-em` : undefined}
      viewBox="0 0 10 10"
      refX="9.5"
      refY="5"
      markerWidth={String(size())}
      markerHeight={String(size())}
      orient="auto-start-reverse"
    >
      {props.open ? <path d="M1,1 L9,5 L1,9" class="vis-arrowhead-open" /> : <path d="M0,1 L9,5 L0,9 z" class="vis-arrowhead" />}
    </marker>
  );
}

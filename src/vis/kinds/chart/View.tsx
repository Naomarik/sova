import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import { canvasMeasure } from "../../core/text";
import { emClass, SvgEmBadge } from "../../emphasis";
import { fontsLoaded, Lines } from "../../svg";
import type { ViewProps } from "../../types";
import { axisTitle as titleOf, chartWidth, FONT, layoutChart, legendBreaks, type Bar } from "./layout";
import type { ChartSpec } from "./parse";
import PartsView from "./PartsView";
import "./chart.css";

/**
 * `vis chart`: bars (grouped or stacked, upright or sideways), lines and scatter, laid out by
 * layout.ts at the width the figure has. Colours are CSS classes (`vis-chart-s<n>` per series, a
 * tone class per row), so a theme switch needs no re-render. Series never rely on hue alone: lines
 * add a dash and a marker shape, and the legend names every series. `type: parts` is its own HTML
 * View (PartsView.tsx).
 */
export default function ChartView(props: ViewProps<ChartSpec>) {
  // A spec never changes type while mounted (a new fence is a new drawing).
  if (props.spec.type === "parts") return <PartsView {...props} />;
  let box!: HTMLDivElement;
  // The first layout happens in onMount, before the browser paints: the box is in the page by then.
  const [width, setWidth] = createSignal(560);
  const fit = () => setWidth(Math.floor(box.clientWidth || 560));
  onMount(() => {
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    fit();
    onCleanup(() => ro.disconnect());
  });
  // Re-measured once the web font loads, so the drawing matches estimateHeight's (canvas) text widths.
  const g = createMemo(() => (fontsLoaded(), layoutChart(props.spec, chartWidth(width()), canvasMeasure)));
  const em = createMemo(() => emphasisMap(props.spec));
  const breaks = createMemo(() => (fontsLoaded(), legendBreaks(props.spec, width(), canvasMeasure)));
  const multi = () => props.spec.series.length > 1;
  const single = () => !multi();
  /** A bar's colour: its series, else a mark's tone, else the row's own tone, else the accent. */
  const barClass = (b: Bar) => {
    if (multi()) return `vis-chart-s${b.series}`;
    const e = em().get(String(b.row));
    if (e) return `vis-chart-toned vis-tone-${e.tone}`;
    const tone = props.spec.rows[b.row]!.tone;
    return tone ? `vis-chart-toned vis-tone-${tone}` : "vis-chart-s0";
  };
  const pointClass = (row: number, series: number) => {
    if (multi()) return `vis-chart-s${series}`;
    const tone = em().get(String(row))?.tone ?? props.spec.rows[row]!.tone;
    return tone ? `vis-chart-toned vis-tone-${tone}` : "vis-chart-s0";
  };
  const axisTitle = () => titleOf(props.spec);
  return (
    <div class="vis-chart" ref={box}>
      <Show when={multi()}>
        <ul class="vis-legend" aria-label="Series">
          <For each={props.spec.series}>
            {(name, i) => (
              <>
              <Show when={breaks().includes(i())}>
                <li class="vis-legend-break" aria-hidden="true" />
              </Show>
              <li>
                <svg width="22" height="12" aria-hidden="true" class={`vis-chart-s${i()}`}>
                  {g().mode === "line" ? (
                    <>
                      <line class="vis-chart-line" x1="1" x2="21" y1="6" y2="6" stroke-dasharray={DASH[i()]} />
                      <Marker kind={i()} x={11} y={6} />
                    </>
                  ) : (
                    <rect class="vis-chart-fill" x="5" y="1" width="12" height="10" rx="2" />
                  )}
                </svg>
                {name}
              </li>
              </>
            )}
          </For>
        </ul>
      </Show>
      <Show when={axisTitle()}>
        <div class="vis-axis-title">{axisTitle()}</div>
      </Show>
      <svg class="vis-svg vis-chart-svg" viewBox={`0 0 ${g().W} ${g().H}`} width={g().W} style={{ "max-width": "100%" }} role="img" aria-label={props.label}>
        <For each={g().bands}>
          {(b) => <rect class={`vis-chart-band vis-tone-${em().get(String(b.row))!.tone}`} x={b.x} y={b.y} width={b.w} height={b.h} rx="4" />}
        </For>
        <g class="vis-grid">
          <For each={g().yTicks}>
            {(t) => (
              <>
                <line x1={g().plot.x0} x2={g().plot.x1} y1={t.pos} y2={t.pos} classList={{ "vis-grid-zero": t.zero, "vis-grid-minor": t.minor }} />
                <Show when={t.label}>
                  <text x={g().plot.x0 - 6} y={t.pos} text-anchor="end" dominant-baseline="central" font-size={String(FONT.tick)}>
                    {t.label}
                  </text>
                </Show>
              </>
            )}
          </For>
          <For each={g().xTicks}>
            {(t) => (
              <>
                <line y1={g().plot.y0} y2={g().plot.y1} x1={t.pos} x2={t.pos} classList={{ "vis-grid-zero": t.zero, "vis-grid-minor": t.minor }} />
                <Show when={t.label}>
                  <text y={g().plot.y1 + 14} x={t.pos} text-anchor="middle" font-size={String(FONT.tick)}>
                    {t.label}
                  </text>
                </Show>
              </>
            )}
          </For>
          {/* The baseline bars stand on, or the plot's floor for lines and points. */}
          <Show when={g().mode !== "hbar"}>
            <line class="vis-grid-base" x1={g().plot.x0} x2={g().plot.x1} y1={g().plot.y1} y2={g().plot.y1} />
          </Show>
          <Show when={g().mode === "hbar" || g().mode === "scatter"}>
            <line class="vis-grid-base" x1={g().plot.x0} x2={g().plot.x0} y1={g().plot.y0} y2={g().plot.y1} />
          </Show>
        </g>
        <For each={g().cats}>
          {(c) => (
            <g class={`vis-chart-cat ${emClass(em().get(String(c.row)))}`}>
              <title>{props.spec.rows[c.row]!.label}</title>
              <Lines lines={c.lines} x={c.x} y={c.y} size={g().mode === "hbar" ? FONT.hcat : FONT.cat} lh={13} top anchor={c.anchor} class="vis-tick" />
            </g>
          )}
        </For>
        <For each={g().bars}>
          {(b) => (
            <g class={`vis-chart-bar ${barClass(b)}`} classList={{ "vis-chart-em": em().has(String(b.row)) }}>
              <title>{b.title}</title>
              <rect class="vis-chart-fill" x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(2, b.w / 2, b.h / 2)} />
            </g>
          )}
        </For>
        <For each={g().paths}>
          {(p) => (
            <g class={`vis-chart-s${multi() ? p.series : 0}`}>
              <path class="vis-chart-line" d={p.d} stroke-dasharray={multi() ? DASH[p.series] : undefined} />
            </g>
          )}
        </For>
        <For each={g().leaders}>{(l) => <line class="vis-chart-leader" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />}</For>
        <For each={g().rings}>{(r) => <circle class={`vis-chart-ring ${emClass(em().get(String(r.row)))}`} cx={r.x} cy={r.y} r="8" />}</For>
        <For each={g().points}>
          {(p) => (
            <g class={pointClass(p.row, p.series)}>
              <title>{p.title}</title>
              <Marker kind={single() ? 0 : p.series} x={p.x} y={p.y} big={g().mode === "scatter"} />
            </g>
          )}
        </For>
        <For each={g().values}>
          {(v) => (
            <text class={v.inside ? "vis-value vis-value-inside" : "vis-value"} classList={{ "vis-value-em": !v.inside && em().has(String(v.row)) }} x={v.x} y={v.y} text-anchor={v.anchor} dominant-baseline="central" font-size={String(FONT.value)}>
              {v.text}
            </text>
          )}
        </For>
        <For each={g().badges}>{(b) => <SvgEmBadge e={em().get(String(b.row))} x={b.x} y={b.y} />}</For>
      </svg>
      <Show when={props.spec.x}>
        <div class="vis-axis-title vis-axis-x">{props.spec.x}</div>
      </Show>
    </div>
  );
}

const DASH = ["", "6 3", "2 3", "8 3 2 3", "4 4", "1 3"];

/** Circle, square, triangle, diamond, cross, ring: a series' shape, so its points never rely on hue. */
function Marker(props: { kind: number; x: number; y: number; big?: boolean }) {
  const k = props.big ? 1.25 : 1;
  const { x, y } = props;
  switch (props.kind % 6) {
    case 1:
      return <rect class="vis-chart-mark" x={x - 3.5 * k} y={y - 3.5 * k} width={7 * k} height={7 * k} />;
    case 2:
      return <path class="vis-chart-mark" d={`M${x},${y - 4.5 * k} L${x + 4.5 * k},${y + 3.5 * k} L${x - 4.5 * k},${y + 3.5 * k} Z`} />;
    case 3:
      return <path class="vis-chart-mark" d={`M${x},${y - 4.5 * k} L${x + 4.5 * k},${y} L${x},${y + 4.5 * k} L${x - 4.5 * k},${y} Z`} />;
    case 4:
      return <path class="vis-chart-mark vis-chart-mark-stroke" d={`M${x - 4},${y - 4} L${x + 4},${y + 4} M${x + 4},${y - 4} L${x - 4},${y + 4}`} />;
    case 5:
      return <circle class="vis-chart-mark vis-chart-mark-open" cx={x} cy={y} r={3.5 * k} />;
    default:
      return <circle class="vis-chart-mark" cx={x} cy={y} r={3.5 * k} />;
  }
}

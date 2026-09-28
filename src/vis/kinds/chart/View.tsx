import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Tone } from "../../core/grammar";
import { linearScale, logScale, shortNumber, type Scale } from "../../core/scale";
import { canvasMeasure, wrap } from "../../core/text";
import type { ViewProps } from "../../types";
import type { ChartSpec } from "./parse";
import "./chart.css";

/**
 * Series colours. There is no categorical palette in the tokens, so series borrow the accent and
 * status hues in an order that keeps neighbours apart; every series also has its own marker and
 * dash, and the legend names it, so no series is told apart by hue alone.
 */
const SERIES = ["var(--color-accent)", "var(--status-warn)", "var(--status-success)", "var(--status-error)", "var(--status-info)", "var(--color-ink-muted)"];
const DASH = ["", "6 3", "2 3", "8 3 2 3", "4 4", "1 3"];
const TONE: Record<Tone, string> = {
  accent: "var(--color-accent)",
  ok: "var(--status-success)",
  warn: "var(--status-warn)",
  error: "var(--status-error)",
  info: "var(--status-info)",
  muted: "var(--color-ink-muted)",
};
const TICK = 11;
const VALUE = 11;

/** `vis chart`: bar, hbar, stacked and line, laid out at the width it is given. */
export default function ChartView(props: ViewProps<ChartSpec>) {
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(560);
  onMount(() => {
    const ro = new ResizeObserver(() => setWidth(Math.max(260, Math.min(760, Math.floor(box.clientWidth)))));
    ro.observe(box);
    setWidth(Math.max(260, Math.min(760, Math.floor(box.clientWidth || 560))));
    onCleanup(() => ro.disconnect());
  });
  const multi = () => props.spec.series.length > 1;
  // Vertical bars whose labels can't sit under them turn sideways: long names read better as rows.
  const type = createMemo(() => {
    const s = props.spec;
    if (s.type !== "bar") return s.type;
    const band = (width() - 60) / s.rows.length;
    const widest = Math.max(...s.rows.map((r) => canvasMeasure(r.label, TICK)));
    return widest > band * 1.9 || band < 22 ? "hbar" : "bar";
  });
  return (
    <div class="vis-chart" ref={box}>
      <Show when={multi()}>
        <ul class="vis-legend" aria-label="Series">
          <For each={props.spec.series}>
            {(name, i) => (
              <li>
                <svg width="22" height="10" aria-hidden="true">
                  {type() === "line" ? (
                    <>
                      <line x1="1" x2="21" y1="5" y2="5" stroke={SERIES[i()]} stroke-width="2" stroke-dasharray={DASH[i()]} />
                      <Marker kind={i()} x={11} y={5} color={SERIES[i()]!} />
                    </>
                  ) : (
                    <rect x="5" y="0" width="12" height="10" rx="2" fill={SERIES[i()]} />
                  )}
                </svg>
                {name}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.spec.y || props.spec.unit}>
        <div class="vis-axis-title">{props.spec.y ?? props.spec.unit}</div>
      </Show>
      {type() === "hbar" ? <HBars spec={props.spec} width={width()} label={props.label} /> : <Columns spec={props.spec} type={type() as "bar" | "stacked" | "line"} width={width()} label={props.label} />}
      <Show when={props.spec.x}>
        <div class="vis-axis-title vis-axis-x">{props.spec.x}</div>
      </Show>
    </div>
  );
}

const fmt = (v: number, unit?: string) => `${shortNumber(v)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
const colorOf = (spec: ChartSpec, row: number, series: number) =>
  spec.series.length > 1 ? SERIES[series]! : spec.rows[row]!.tone ? TONE[spec.rows[row]!.tone!] : SERIES[0]!;

function valueScale(spec: ChartSpec, stacked: boolean, from: number, to: number): Scale {
  const vals = spec.rows.flatMap((r) => (stacked ? [r.values.reduce<number>((s, v) => s + (v ?? 0), 0)] : r.values.filter((v): v is number => v !== null)));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return spec.scale === "log" && !stacked ? logScale(lo, hi, from, to) : linearScale(lo, hi, from, to);
}

/** Vertical bars (grouped or stacked) and lines share one frame: categories along x. */
function Columns(props: { spec: ChartSpec; type: "bar" | "stacked" | "line"; width: number; label: string }) {
  const g = createMemo(() => {
    const spec = props.spec;
    const W = props.width;
    const H = Math.round(Math.min(300, Math.max(180, W * 0.5)));
    const y = valueScale(spec, props.type === "stacked", 0, 1);
    const tickW = Math.max(...y.ticks.map((t) => canvasMeasure(shortNumber(t), TICK)));
    const left = Math.ceil(tickW) + 10;
    const top = props.type === "line" ? 10 : 18;
    const labelLines = spec.rows.map((r) => wrap(r.label, Math.max(40, (W - left) / spec.rows.length - 6), 2, TICK, canvasMeasure));
    const lines = Math.max(...labelLines.map((l) => l.length));
    const bottom = 10 + lines * 13;
    const plotH = H - top - bottom;
    const scale = valueScale(spec, props.type === "stacked", top + plotH, top);
    const band = (W - left - 8) / spec.rows.length;
    // Every k-th category label when they would collide (lines with many points).
    const widestLabel = Math.max(...labelLines.map((l) => Math.max(...l.map((s) => canvasMeasure(s, TICK)))));
    const every = Math.max(1, Math.ceil((widestLabel + 8) / band));
    return { W, H, left, top, plotH, scale, band, labelLines, every, bottom };
  });
  const cx = (i: number) => g().left + g().band * (i + 0.5);
  const zero = () => g().scale.at(Math.max(g().scale.min, Math.min(g().scale.max, 0)));
  return (
    <svg class="vis-svg" viewBox={`0 0 ${g().W} ${g().H}`} width="100%" role="img" aria-label={props.label}>
      <For each={g().scale.ticks}>
        {(t) => (
          <g class="vis-grid">
            <line x1={g().left} x2={g().W - 4} y1={g().scale.at(t)} y2={g().scale.at(t)} classList={{ "vis-grid-zero": t === 0 }} />
            <text x={g().left - 6} y={g().scale.at(t)} text-anchor="end" dominant-baseline="central" font-size={String(TICK)}>
              {shortNumber(t)}
            </text>
          </g>
        )}
      </For>
      <For each={props.spec.rows}>
        {(row, i) => (
          <>
            <Show when={i() % g().every === 0}>
              <text class="vis-tick" x={cx(i())} y={g().top + g().plotH + 14} text-anchor="middle" font-size={String(TICK)}>
                <For each={g().labelLines[i()]}>{(l, j) => <tspan x={cx(i())} dy={j() === 0 ? 0 : 13}>{l}</tspan>}</For>
              </text>
            </Show>
            <Show when={props.type !== "line"}>
              <Bars spec={props.spec} row={i()} x={cx(i())} band={g().band} scale={g().scale} zero={zero()} stacked={props.type === "stacked"} />
            </Show>
          </>
        )}
      </For>
      <Show when={props.type === "line"}>
        <For each={props.spec.series.length ? props.spec.series : [""]}>
          {(name, s) => {
            const pts = () => props.spec.rows.map((r, i) => (r.values[s()] === null ? null : { x: cx(i), y: g().scale.at(r.values[s()]!), v: r.values[s()]!, label: r.label }));
            const d = () => {
              let out = "";
              let pen = false;
              for (const p of pts()) {
                if (!p) {
                  pen = false;
                  continue;
                }
                out += `${pen ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
                pen = true;
              }
              return out;
            };
            const color = SERIES[s()]!;
            return (
              <g class="vis-series">
                <path d={d()} fill="none" stroke={color} stroke-width="2" stroke-dasharray={DASH[s()]} stroke-linejoin="round" />
                <For each={pts()}>
                  {(p) => (
                    <Show when={p}>
                      <g>
                        <title>{`${name ? `${name}, ` : ""}${p!.label}: ${fmt(p!.v, props.spec.unit)}`}</title>
                        <Marker kind={s()} x={p!.x} y={p!.y} color={color} />
                      </g>
                    </Show>
                  )}
                </For>
              </g>
            );
          }}
        </For>
      </Show>
    </svg>
  );
}

function Bars(props: { spec: ChartSpec; row: number; x: number; band: number; scale: Scale; zero: number; stacked: boolean }) {
  const r = () => props.spec.rows[props.row]!;
  const n = () => (props.stacked ? 1 : Math.max(1, props.spec.series.length));
  const bw = () => Math.min(44, (props.band * 0.7) / n());
  const showValues = () => !props.stacked && props.spec.rows.length * n() <= 14 && bw() >= 16;
  const stackTops = () => {
    let acc = 0;
    return r().values.map((v) => {
      const from = acc;
      acc += v ?? 0;
      return [from, acc] as const;
    });
  };
  return (
    <For each={r().values}>
      {(v, s) => (
        <Show when={v !== null}>
          {(() => {
            const x = () => (props.stacked ? props.x - bw() / 2 : props.x - (bw() * n()) / 2 + bw() * s());
            const y1 = () => (props.stacked ? props.scale.at(stackTops()[s()]![1]) : props.scale.at(v!));
            const y0 = () => (props.stacked ? props.scale.at(stackTops()[s()]![0]) : props.zero);
            const label = () => `${props.spec.series[s()] ? `${props.spec.series[s()]}, ` : ""}${r().label}: ${fmt(v!, props.spec.unit)}`;
            return (
              <g>
                <title>{label()}</title>
                <rect x={x() + 1} width={Math.max(1, bw() - 2)} y={Math.min(y0(), y1())} height={Math.max(v === 0 ? 0 : 1, Math.abs(y0() - y1()))} rx="2" fill={colorOf(props.spec, props.row, s())} />
                <Show when={showValues()}>
                  <text class="vis-value" x={x() + bw() / 2} y={v! >= 0 ? y1() - 5 : y1() + 12} text-anchor="middle" font-size={String(VALUE)}>
                    {shortNumber(v!)}
                  </text>
                </Show>
              </g>
            );
          })()}
        </Show>
      )}
    </For>
  );
}

/** Horizontal bars: a row per category, the label on its left. Reads well at phone width. */
function HBars(props: { spec: ChartSpec; width: number; label: string }) {
  const g = createMemo(() => {
    const spec = props.spec;
    const W = props.width;
    const n = Math.max(1, spec.series.length);
    const stacked = spec.type === "stacked";
    const rowH = stacked || n === 1 ? 26 : n * 12 + 10;
    const labelMax = Math.round(W * 0.34);
    const labels = spec.rows.map((r) => wrap(r.label, labelMax, 2, TICK + 1, canvasMeasure));
    const left = Math.ceil(Math.min(labelMax, Math.max(...labels.map((l) => Math.max(...l.map((s) => canvasMeasure(s, TICK + 1))))))) + 12;
    const valueRoom = Math.max(...spec.rows.flatMap((r) => r.values.map((v) => (v === null ? 0 : canvasMeasure(fmt(v, spec.unit), VALUE))))) + 10;
    const scale = valueScale(spec, stacked, left, W - valueRoom);
    const top = 4;
    const H = top + spec.rows.length * rowH + 22;
    const rows = spec.rows.map((row, i) => {
      const y = top + i * rowH;
      let acc = 0;
      const bars = row.values.flatMap((v, s) => {
        if (v === null) return [];
        const from = stacked ? acc : 0;
        if (stacked) acc += v;
        const to = stacked ? acc : v;
        const h = stacked || n === 1 ? 16 : 10;
        const last = !stacked || s === row.values.length - 1;
        return [{
          x0: scale.at(Math.min(from, to)),
          x1: scale.at(Math.max(from, to)),
          y: stacked || n === 1 ? y + (rowH - h) / 2 : y + 5 + s * 12,
          h,
          zero: v === 0,
          color: colorOf(spec, i, s),
          value: last ? fmt(stacked ? acc : v, spec.unit) : "",
          title: `${spec.series[s] ? `${spec.series[s]}, ` : ""}${row.label}: ${fmt(v, spec.unit)}`,
        }];
      });
      return { y, lines: labels[i]!, bars };
    });
    return { W, H, left, rowH, scale, rows, top };
  });
  return (
    <svg class="vis-svg" viewBox={`0 0 ${g().W} ${g().H}`} width="100%" role="img" aria-label={props.label}>
      <For each={g().scale.ticks}>
        {(t) => (
          <g class="vis-grid">
            <line y1={g().top} y2={g().H - 18} x1={g().scale.at(t)} x2={g().scale.at(t)} classList={{ "vis-grid-zero": t === 0 }} />
            <text y={g().H - 4} x={g().scale.at(t)} text-anchor="middle" font-size={String(TICK)}>
              {shortNumber(t)}
            </text>
          </g>
        )}
      </For>
      <For each={g().rows}>
        {(row) => (
          <g>
            <text class="vis-tick vis-hbar-label" x={g().left - 8} y={row.y + g().rowH / 2 - ((row.lines.length - 1) * 13) / 2} text-anchor="end" dominant-baseline="central" font-size={String(TICK + 1)}>
              <For each={row.lines}>{(l, j) => <tspan x={g().left - 8} dy={j() === 0 ? 0 : 13}>{l}</tspan>}</For>
            </text>
            <For each={row.bars}>
              {(b) => (
                <g>
                  <title>{b.title}</title>
                  <rect x={b.x0} y={b.y} width={Math.max(b.zero ? 0 : 1, b.x1 - b.x0)} height={b.h} rx="2" fill={b.color} />
                  <Show when={b.value}>
                    <text class="vis-value" x={b.x1 + 5} y={b.y + b.h / 2} dominant-baseline="central" font-size={String(VALUE)}>
                      {b.value}
                    </text>
                  </Show>
                </g>
              )}
            </For>
          </g>
        )}
      </For>
    </svg>
  );
}

/** Circle, square, triangle, diamond, cross, ring: a series' shape, so its points never rely on hue. */
function Marker(props: { kind: number; x: number; y: number; color: string }) {
  const { x, y } = props;
  switch (props.kind % 6) {
    case 1:
      return <rect x={x - 3.5} y={y - 3.5} width="7" height="7" fill={props.color} />;
    case 2:
      return <path d={`M${x},${y - 4.5} L${x + 4.5},${y + 3.5} L${x - 4.5},${y + 3.5} Z`} fill={props.color} />;
    case 3:
      return <path d={`M${x},${y - 4.5} L${x + 4.5},${y} L${x},${y + 4.5} L${x - 4.5},${y} Z`} fill={props.color} />;
    case 4:
      return <path d={`M${x - 4},${y - 4} L${x + 4},${y + 4} M${x + 4},${y - 4} L${x - 4},${y + 4}`} stroke={props.color} stroke-width="2" />;
    case 5:
      return <circle cx={x} cy={y} r="3.5" fill="var(--color-surface)" stroke={props.color} stroke-width="2" />;
    default:
      return <circle cx={x} cy={y} r="3.5" fill={props.color} />;
  }
}

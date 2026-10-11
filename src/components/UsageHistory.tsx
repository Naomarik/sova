import { createEffect, createMemo, createResource, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import type { UsageHistoryPeriod, UsageHistoryPoint, UsageWindow } from "../../shared/protocol";
import { fetchUsageHistory, fetchUsageStrip } from "../lib/api";
import { FLOAT_GAP_MOUSE, FLOAT_GAP_TOUCH, floatAbove } from "../lib/float-card";
import { meterTone } from "../lib/insights";
import {
  alignedLast,
  type BurnLine,
  chartAxis,
  nowWords,
  pastPeriodLine,
  pastReadoutAt,
  periodNoun,
  periodSpan,
  periodTitle,
  projection,
  readoutAt,
  type Span,
  stripCaption,
  stripLayout,
  stripReadout,
  weekdayTime,
} from "../lib/usage-burn";
import { Chip, Icon } from "./ui";

/**
 * The bar under a meter's number: aria-hidden (the number is the value), never animated. With
 * `at` (0..1), the pace tick: the share of the window gone (§app.insights/pace-tick).
 */
export function Track(props: { pct: number; at?: number | null }) {
  const tone = () => meterTone({ label: "", pct: props.pct });
  return (
    <div class="meter-track-wrap" aria-hidden="true">
      <div class="meter-track">
        <span
          class="meter-fill"
          classList={{ "meter-fill-warn": tone() === "warn", "meter-fill-error": tone() === "error" }}
          style={{ "--meter-pct": `${Math.min(100, Math.max(0, props.pct))}%` }}
        />
      </div>
      <Show when={props.at !== undefined && props.at !== null}>
        <span class="meter-tick" style={{ "--meter-at": `${props.at! * 100}%` }} />
      </Show>
    </div>
  );
}

/** A meter's burn lines (§app.insights/usage-burn), figures in mono, a run-out's chip at its end. */
export function BurnLines(props: { lines: BurnLine[] }) {
  return (
    <For each={props.lines}>
      {(line) => (
        <p class="meter-context usage-burn-line">
          <For each={line.parts}>{(p) => (typeof p === "string" ? p : <span class="text-mono usage-burn-mono">{p.mono}</span>)}</For>
          <Show when={line.chip}>
            {(c) => (
              <>
                {" "}
                <Chip tone="warn">{c()}</Chip>
              </>
            )}
          </Show>
        </p>
      )}
    </For>
  );
}

/** The chart's plot height, and the room above its 100% line. */
const PLOT_H = 64;
const PLOT_TOP = 4;
const yOf = (pct: number) => PLOT_TOP + (1 - Math.min(100, Math.max(0, pct)) / 100) * (PLOT_H - PLOT_TOP - 1);
/** Rough width of a micro label, to keep the "now" and pin labels inside the chart. */
const textWidth = (s: string) => s.length * 6.4 + 4;
const clampLeft = (x: number, w: number, width: number) => Math.max(0, Math.min(x - w / 2, width - w));

/** A readout picked by a pointer: where the card goes, and whether a finger or pen holds it (the card sits higher). */
type Pick<T> = { at: T; x: number; y: number; touch: boolean };

/**
 * The anchor a readout card is placed above: the pointer, or the whole `block` (a chart with its
 * run-out pin's label, a strip), whichever is higher, so the card never hides what it reads.
 */
function anchorY(e: PointerEvent, block: Element): number {
  const gap = e.pointerType !== "mouse" ? FLOAT_GAP_TOUCH : FLOAT_GAP_MOUSE;
  return Math.min(e.clientY, block.getBoundingClientRect().top - FLOAT_GAP_MOUSE + gap);
}

/**
 * Hover (a mouse) or press and drag (a finger or pen) on a scrubbed plot: `pick` on each move, `end`
 * when the pointer leaves or the touch ends. The plot's `touch-action: pan-y` leaves vertical
 * scrolling to the page, which cancels the pointer.
 */
function scrubbing(pick: (e: PointerEvent) => void, held: () => boolean, end: () => void) {
  return {
    onPointerMove: (e: PointerEvent) => (e.pointerType === "mouse" || held()) && pick(e),
    onPointerDown: (e: PointerEvent & { currentTarget: HTMLElement }) => {
      if (e.pointerType === "mouse") return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Already gone: the release that follows ends it.
      }
      pick(e);
    },
    onPointerUp: (e: PointerEvent) => e.pointerType !== "mouse" && end(),
    onPointerCancel: end,
    onPointerLeave: (e: PointerEvent) => e.pointerType === "mouse" && end(),
  };
}

/**
 * A readout card: the velocity scrub's floating card (§app.insights/velocity-scrub), fixed to the
 * window above its anchor by `floatAbove` (8px inside the window's edges) and never taking the
 * pointer. `aria-hidden`: the lines and captions say it in words. `measureKey` re-measures it when
 * its words change.
 */
function FloatReadout(props: { x: number; y: number; touch: boolean; measureKey: unknown; children: JSX.Element }) {
  let el: HTMLDivElement | undefined;
  /** Its own size, measured once its words are in: offsetWidth ignores the lift's scale. */
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  createEffect(() => {
    props.measureKey;
    if (el) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  });
  const at = createMemo(() =>
    floatAbove({ x: props.x, y: props.y }, size(), { width: innerWidth, height: innerHeight }, props.touch ? FLOAT_GAP_TOUCH : FLOAT_GAP_MOUSE),
  );
  return (
    <Portal>
      <div ref={el} class="velocity-scrub" classList={{ "velocity-scrub-below": at().y > props.y }} style={{ transform: `translate3d(${at().x}px, ${at().y}px, 0)` }} aria-hidden="true">
        <div class="float-card float-card-neutral velocity-scrub-card">{props.children}</div>
      </div>
    </Portal>
  );
}

/** A chart readout's words: the time, the figure (number first, semibold), the last period at that point. */
function BurnReadout(props: { reading: ReturnType<typeof readoutAt> }) {
  const v = () => props.reading.value;
  const figure = () => {
    const x = v();
    return "pct" in x ? `${Math.round(x.pct)}%` : "";
  };
  return (
    <>
      <span class="velocity-scrub-span usage-burn-mono">{props.reading.time}</span>
      <Switch>
        <Match when={v().kind === "past"}>
          <span class="agents-readout">
            <b class="text-num">{figure()}</b> <span>used</span>
          </span>
        </Match>
        <Match when={v().kind === "pace"}>
          <span class="agents-readout">
            <span>at this pace ≈</span>
            <b class="text-num">{figure()}</b> <span>used</span>
          </span>
        </Match>
        <Match when={v().kind === "used-up"}>
          <span class="agents-readout">
            <span>used up by then, at this pace</span>
          </span>
        </Match>
        <Match when={v().kind === "unrecorded"}>
          <span class="velocity-scrub-caption">Not recorded</span>
        </Match>
      </Switch>
      <Show when={props.reading.last}>{(l) => <span class="velocity-scrub-caption">{l()}</span>}</Show>
    </>
  );
}

/** A zero-only first period needs no plot; every closed period stays browsable, even at zero. */
export function zeroOnlyHistory(pct: number, current: readonly UsageHistoryPoint[], past: readonly UsageHistoryPeriod[]): boolean {
  return pct === 0 && current.every((p) => p.pct === 0) && past.length === 0;
}

/**
 * A day-plus window's history chart (§app.insights/usage-burn): this period, the last one aligned
 * by share, the line at this pace, now, the run-out pin and a labelled day axis. Its periods come
 * from the history route, asked again when the reading changes. The stepper swaps in a past period
 * against the one before it. Hovering (a mouse) or pressing and dragging (a finger or pen) reads
 * one point out in the velocity scrub's floating card.
 */
export function BurnChart(props: { w: UsageWindow; span: Span; now: number }) {
  let box: HTMLDivElement | undefined;
  /** The plot with its axis and run-out pin label: the readout card floats just above it. */
  let figure: HTMLDivElement | undefined;
  const [width, setWidth] = createSignal(0);
  /** The plot measures its own width, in whole pixels, and follows it. */
  const measure = (el: HTMLDivElement) => {
    box = el;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  const source = createMemo(() => {
    const k = props.w.history ?? props.w.burn;
    if (!k) return null;
    const anchor = props.w.startsAt ?? props.w.resetsAt;
    return `${k.series}\u0000${k.window}\u0000${anchor ? Date.parse(anchor) : ""}\u0000${props.w.pct}`;
  });
  const [history] = createResource(source, (key) => {
    const [series, window, at] = key.split("\u0000");
    return fetchUsageHistory(series!, window!, at ? Number(at) : null).catch(() => null);
  });
  const past = () => (history()?.past ?? []).filter((p) => periodSpan(props.w.label, p) !== null);
  /** 0: the current period; n: the n-th closed one back. */
  const [step, setStep] = createSignal(0);
  const at = () => Math.min(step(), past().length);
  const shown = createMemo(() => {
    const s = at();
    if (s === 0) return { span: props.span, period: null as UsageHistoryPeriod | null };
    const p = past()[s - 1]!;
    return { span: periodSpan(props.w.label, p)!, period: p };
  });
  const span = () => shown().span;
  const live = () => at() === 0;
  const len = () => span().end - span().start;
  const xOf = (t: number) => ((t - span().start) / len()) * width();
  const noun = () => periodNoun(props.w, span());
  const current = (): UsageHistoryPoint[] => history()?.current?.points.filter((p) => p.t >= props.span.start && p.t <= props.now) ?? [];
  const points = (): UsageHistoryPoint[] => (live() ? (current().length ? [...current(), { t: props.now, pct: props.w.pct }] : []) : (shown().period?.points ?? []));
  const before = createMemo(() => alignedLast(span(), props.w.label, past()[at()] ?? null));
  const recorded = () => current().length > 0 || past().length > 0;
  const line = (pts: readonly UsageHistoryPoint[]) => pts.map((p) => `${xOf(p.t).toFixed(1)},${yOf(p.pct).toFixed(1)}`).join(" ");
  const pace = () => (live() ? projection(props.w, props.span, props.now) : null);
  const pin = () => (live() ? props.w.burn?.runsOutAt : undefined);
  const axis = createMemo(() => chartAxis(span(), width()));
  const nowText = () => nowWords(props.span, props.now);
  const title = () => periodTitle(props.w, span());
  const thisName = () => (live() ? `this ${noun()}` : title().charAt(0).toLowerCase() + title().slice(1));
  const beforeName = () => (live() ? `last ${noun()}` : `${noun()} before`);

  const [pick, setPick] = createSignal<Pick<number> | null>(null);
  const pickAt = (e: PointerEvent) => {
    if (!box || !width()) return;
    const r = box.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    setPick({ at: span().start + (x / r.width) * len(), x: e.clientX, y: anchorY(e, figure ?? box), touch: e.pointerType !== "mouse" });
  };
  const reading = createMemo(() => {
    const p = pick();
    if (!p) return null;
    return live() ? readoutAt(props.w, props.span, props.now, p.at, current(), before(), noun()) : pastReadoutAt(span(), p.at, points(), before(), beforeName());
  });
  const end = () => setPick(null);
  const go = (d: number) => {
    setPick(null);
    setStep(Math.max(0, Math.min(past().length, at() + d)));
  };

  return (
    <Show when={recorded()}>
      <Show when={!zeroOnlyHistory(props.w.pct, current(), past())} fallback={<p class="meter-context usage-history-empty">0% used · {title()}</p>}>
      <div class="usage-burn-chart">
        <div class="usage-burn-stepper">
          <button type="button" class="button button-ghost button-icon usage-burn-step" aria-label={`Earlier ${noun()}`} aria-disabled={at() >= past().length ? "true" : undefined} onClick={() => go(1)}>
            <Icon name="chevron-left" />
          </button>
          <span class="usage-burn-period" aria-live="polite">
            {title()}
          </span>
          <button type="button" class="button button-ghost button-icon usage-burn-step" aria-label={`Later ${noun()}`} aria-disabled={live() ? "true" : undefined} onClick={() => go(-1)}>
            <Icon name="chevron-right" />
          </button>
        </div>
        <Show when={!live() && shown().period}>
          {(p) => (
            <>
              <BurnLines lines={[pastPeriodLine(p(), span(), props.now)]} />
              <Show when={p().coarse}>
                <p class="meter-context">Older than 30 days, so drawn at tenths of the {noun()}.</p>
              </Show>
            </>
          )}
        </Show>
        <div ref={figure} class="usage-burn-figure" classList={{ "usage-burn-chart-pinned": pin() !== undefined }} aria-hidden="true">
          <Show when={pin() !== undefined && width() > 0}>
            <span class="usage-burn-pin-label text-mono usage-burn-mono" style={{ left: `${clampLeft(xOf(pin()!), textWidth(`used up ${weekdayTime(pin()!)}`), width())}px` }}>
              used up {weekdayTime(pin()!)}
            </span>
          </Show>
          <div ref={measure} class="usage-burn-plot" {...scrubbing(pickAt, () => pick()?.touch === true, end)}>
            <Show when={width() > 0}>
              <svg class="usage-burn-svg" width={width()} height={PLOT_H} viewBox={`0 0 ${width()} ${PLOT_H}`}>
                <For each={axis().grid}>{(g) => <line class="usage-burn-grid" x1={Math.round(g * width()) + 0.5} x2={Math.round(g * width()) + 0.5} y1={PLOT_TOP} y2={PLOT_H} />}</For>
                <line class="usage-burn-guide" x1="0" x2={width()} y1={yOf(100) + 0.5} y2={yOf(100) + 0.5} />
                <line class="usage-burn-base" x1="0" x2={width()} y1={PLOT_H - 0.5} y2={PLOT_H - 0.5} />
                <Show when={before().length > 1}>
                  <polyline class="usage-burn-last" points={line(before())} />
                </Show>
                <Show when={points().length > 0}>
                  <polyline class="usage-burn-this" points={line(points())} />
                </Show>
                <Show when={pace()}>
                  {(p) => <line class="usage-burn-pace" x1={xOf(p().from.t)} y1={yOf(p().from.pct)} x2={xOf(p().to.t)} y2={yOf(p().to.pct)} />}
                </Show>
                <Show when={live()}>
                  <line class="usage-burn-now" x1={Math.round(xOf(props.now)) + 0.5} x2={Math.round(xOf(props.now)) + 0.5} y1={PLOT_TOP} y2={PLOT_H} />
                </Show>
                <Show when={pin()}>{(t) => <circle class="usage-burn-pin" cx={xOf(t())} cy={yOf(100)} r="3.5" />}</Show>
                <Show when={pick()}>
                  {(p) => <rect class="usage-burn-cursor" x={Math.round(xOf(p().at))} y={PLOT_TOP} width="1" height={PLOT_H - PLOT_TOP} />}
                </Show>
              </svg>
            </Show>
          </div>
          <div class="usage-burn-axis">
            <For each={axis().labels}>
              {(l) => (
                <span class={`usage-burn-tick usage-burn-tick-${l.align}`} style={{ left: `${l.x * 100}%` }}>
                  {l.text}
                </span>
              )}
            </For>
          </div>
          <div class="usage-burn-nowrow">
            <Show when={live()}>
              <span style={{ left: `${clampLeft(xOf(props.now), textWidth(nowText()), width())}px` }}>{nowText()}</span>
            </Show>
          </div>
          <p class="usage-burn-legend">
            <span>
              <svg width="16" height="6"><line class="usage-burn-this" x1="0" x2="16" y1="3" y2="3" /></svg>
              {thisName()}
            </span>
            <Show when={before().length > 1}>
              <span>
                <svg width="16" height="6"><line class="usage-burn-last" x1="0" x2="16" y1="3" y2="3" /></svg>
                {beforeName()}
              </span>
            </Show>
            <Show when={pace()}>
              <span>
                <svg width="16" height="6"><line class="usage-burn-pace" x1="1" x2="16" y1="3" y2="3" /></svg>
                at this pace
              </span>
            </Show>
          </p>
        </div>
      </div>
      <Show when={pick() && reading()}>
        <FloatReadout x={pick()!.x} y={pick()!.y} touch={pick()!.touch} measureKey={reading()}>
          <BurnReadout reading={reading()!} />
        </FloatReadout>
      </Show>
      </Show>
    </Show>
  );
}

const STRIP_H = 24;

/**
 * A 5-hour meter's strip (§app.insights/usage-burn): one bar per past window of the last 30 days,
 * as tall as its final percent, warn at 100%, from the history route's summaries. The same
 * floating readout as the charts: the window's time range, final percent, ≈rate and 100% time.
 */
export function BurnStrip(props: { w: UsageWindow; now: number }) {
  let box: HTMLDivElement | undefined;
  let block: HTMLDivElement | undefined;
  const [width, setWidth] = createSignal(0);
  const measure = (el: HTMLDivElement) => {
    box = el;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  // Asked again when the window's reset moves: the one before has just closed.
  const source = createMemo(() => (props.w.history ? `${props.w.history.series}\u0000${props.w.history.window}\u0000${props.w.resetsAt ?? ""}` : null));
  const [strip] = createResource(source, (key) => {
    const [series, window] = key.split("\u0000");
    return fetchUsageStrip(series!, window!).catch(() => null);
  });
  const windows = () => strip()?.windows ?? [];
  const layout = createMemo(() => stripLayout(windows().length, width()));
  const shown = () => windows().slice(layout().from);
  const [pick, setPick] = createSignal<Pick<number> | null>(null);
  const pickAt = (e: PointerEvent) => {
    if (!box || !shown().length) return;
    const r = box.getBoundingClientRect();
    const i = Math.max(0, Math.min(shown().length - 1, Math.floor((e.clientX - r.left) / layout().pitch)));
    setPick({ at: i, x: e.clientX, y: anchorY(e, block ?? box), touch: e.pointerType !== "mouse" });
  };
  const reading = createMemo(() => {
    const p = pick();
    const win = p ? shown()[p.at] : undefined;
    return win ? stripReadout(win, props.now) : null;
  });
  return (
    <Show when={windows().length > 0}>
      <div ref={block} class="usage-burn-strip">
        <div ref={measure} class="usage-burn-plot usage-burn-strip-plot" aria-hidden="true" {...scrubbing(pickAt, () => pick()?.touch === true, () => setPick(null))}>
          <Show when={width() > 0}>
            <svg width={width()} height={STRIP_H} viewBox={`0 0 ${width()} ${STRIP_H}`}>
              <line class="usage-burn-base" x1="0" x2={width()} y1={STRIP_H - 0.5} y2={STRIP_H - 0.5} />
              <For each={shown()}>
                {(win, i) => {
                  const h = () => Math.max(1, Math.round((Math.min(100, win.final) / 100) * (STRIP_H - 1)));
                  return (
                    <rect
                      class="usage-burn-bar"
                      classList={{ "usage-burn-bar-hit": win.final >= 100 || win.hitAt !== undefined, "usage-burn-bar-picked": pick()?.at === i() }}
                      x={i() * layout().pitch}
                      y={STRIP_H - 1 - h()}
                      width={layout().bar}
                      height={h()}
                    />
                  );
                }}
              </For>
            </svg>
          </Show>
        </div>
        <p class="meter-context">{stripCaption(windows())}</p>
      </div>
      <Show when={pick() && reading()}>
        {(_) => (
          <FloatReadout x={pick()!.x} y={pick()!.y} touch={pick()!.touch} measureKey={reading()}>
            <span class="velocity-scrub-span usage-burn-mono">{reading()!.time}</span>
            <span class="agents-readout">
              <b class="text-num">{reading()!.pct}%</b> <span>used</span>
            </span>
            <span class="velocity-scrub-caption">{reading()!.rate}</span>
            <Show when={reading()!.hit}>{(h) => <span class="velocity-scrub-caption">hit 100% at {h()}</span>}</Show>
          </FloatReadout>
        )}
      </Show>
    </Show>
  );
}

import { createEffect, createMemo, createResource, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import type { UsageBalance, UsageClaudeLogin, UsageHistoryPeriod, UsageHistoryPoint, UsageInsight, UsageProvider, UsageWindow } from "../../shared/protocol";
import { fetchUsageHistory, fetchUsageStrip, putUsageResetDay, refreshUsage } from "../lib/api";
import { FLOAT_GAP_MOUSE, FLOAT_GAP_TOUCH, floatAbove } from "../lib/float-card";
import {
  alignedLast,
  balanceBurnLine,
  type BurnLine,
  burnLines,
  chartAxis,
  chartSpan,
  nowWords,
  pastPeriodLine,
  pastReadoutAt,
  periodNoun,
  periodSpan,
  periodTitle,
  projection,
  readoutAt,
  shortSpan,
  type Span,
  stripCaption,
  stripLayout,
  stripReadout,
  weekdayTime,
} from "../lib/usage-burn";
import { duration, relativeIn, relativeTime } from "../lib/format";
import { activityMetrics, activityTrend, currentIncluded, endpointPrevious, includedCreditPct, reportedMoney } from "../lib/ollama-usage";
import {
  accountReading,
  authCaption,
  balanceBreakdown,
  claudeAccountLoginsCaption,
  claudeAccounts,
  claudeAccountSubtitle,
  claudeLoginHolder,
  claudeLoginName,
  claudeLoginNote,
  claudePastNote,
  claudeLoginStanding,
  claudeLoginTitle,
  extraUsageMeter,
  meterReset,
  meterTone,
  money,
  pct,
  planLabel,
  PROVIDER_NAME,
  providerChip,
  providerProblem,
  usageSummary,
  type UsageLine,
  usesLine,
  windowLabel,
  windowPace,
} from "../lib/insights";
import type { Poll } from "../lib/poll";
import { InsightsPage, iso, ListSkeleton } from "./InsightsPage";
import { Banner, Chip, CountChip, Icon } from "./ui";

/**
 * The bar under a meter's number: aria-hidden (the number is the value), never animated. With
 * `at` (0..1), the pace tick: the share of the window gone (§app.insights/pace-tick).
 */
function Track(props: { pct: number; at?: number | null }) {
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

/** Ollama's declared reset day on its card: the day (null: none set) and how to save one. */
interface ResetDayControl {
  day: number | null;
  save(day: number | null): Promise<void>;
}

/**
 * "Set" / "Change" and the inline day-of-month field it opens (§app.insights/usage-reset-day):
 * Enter or Save sends a day of 1–31, Escape or Cancel closes, Clear (once set) removes it.
 */
function ResetDay(props: { c: ResetDayControl }) {
  const [open, setOpen] = createSignal(false);
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const start = () => {
    setValue(props.c.day !== null ? String(props.c.day) : "");
    setError(null);
    setOpen(true);
    queueMicrotask(() => input?.focus());
  };
  const send = async (day: number | null) => {
    setBusy(true);
    try {
      await props.c.save(day);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const v = value().trim();
    const day = Number(v);
    if (!/^\d{1,2}$/.test(v) || day < 1 || day > 31) return setError("Enter a day from 1 to 31.");
    void send(day);
  };
  return (
    <Show
      when={open()}
      fallback={
        <button type="button" class="usage-reset-day-link" onClick={start}>
          {props.c.day === null ? "Set" : "Change"}
        </button>
      }
    >
      <form
        class="usage-reset-day-field"
        // Our own message, not the browser's bubble: a day outside 1–31 says it in the card.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy()) submit();
        }}
      >
        <label for="usage-reset-day-input">Reset day</label>
        <input
          ref={input}
          id="usage-reset-day-input"
          class="input"
          type="number"
          inputmode="numeric"
          min="1"
          max="31"
          value={value()}
          aria-invalid={error() ? "true" : undefined}
          aria-describedby={error() ? "usage-reset-day-error" : undefined}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        <button type="submit" class="button button-sm" aria-disabled={busy() ? "true" : undefined}>
          Save
        </button>
        <Show when={props.c.day !== null}>
          <button type="button" class="button button-sm button-ghost" aria-disabled={busy() ? "true" : undefined} onClick={() => !busy() && void send(null)}>
            Clear
          </button>
        </Show>
        <button type="button" class="button button-sm button-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </form>
      <Show when={error()}>
        {(m) => (
          <p class="usage-reset-day-error" id="usage-reset-day-error" role="alert">
            {m()}
          </p>
        )}
      </Show>
    </Show>
  );
}

/** A meter's burn lines (§app.insights/usage-burn), figures in mono, a run-out's chip at its end. */
function BurnLines(props: { lines: BurnLine[] }) {
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

/**
 * A day-plus window's history chart (§app.insights/usage-burn): this period, the last one aligned
 * by share, the line at this pace, now, the run-out pin and a labelled day axis. Its periods come
 * from the history route, asked again when the reading changes. The stepper swaps in a past period
 * against the one before it. Hovering (a mouse) or pressing and dragging (a finger or pen) reads
 * one point out in the velocity scrub's floating card.
 */
function BurnChart(props: { w: UsageWindow; span: Span; now: number }) {
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
  );
}

const STRIP_H = 24;

/**
 * A 5-hour meter's strip (§app.insights/usage-burn): one bar per past window of the last 30 days,
 * as tall as its final percent, warn at 100%, from the history route's summaries. The same
 * floating readout as the charts: the window's time range, final percent, ≈rate and 100% time.
 */
function BurnStrip(props: { w: UsageWindow; now: number }) {
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

function Meter(props: { w: UsageWindow; now: number; past?: string; resetDay?: ResetDayControl }) {
  const reset = () => meterReset(props.w, props.now, props.past);
  /** The window already reset: the reading describes a window that's gone. */
  const past = () => Boolean(reset()?.time);
  /** The pace tick, while the window has a known span and its reset is ahead. */
  const at = () => (past() ? null : (windowPace(props.w, props.now)?.elapsed ?? null));
  return (
    <div class="meter" classList={{ "meter-ghost": past() }}>
      <p class="meter-head">
        <span class="meter-label">
          {windowLabel(props.w)}
          <Show when={props.w.active}>
            {" "}
            <CountChip title="The window your current model counts against">Active</CountChip>
          </Show>
        </span>
        <span class="meter-value">
          {pct(props.w)}%<span class="meter-of"> used</span>
        </span>
      </p>
      <Track pct={props.w.pct} at={at()} />
      <Show
        when={reset()}
        fallback={
          <Show when={props.resetDay}>
            {(c) => (
              <div class="meter-context">
                Reset day unknown · <ResetDay c={c()} />
              </div>
            )}
          </Show>
        }
      >
        {(r) => (
          <div class="meter-context" title={props.w.resetsAt}>
            {r().lead}
            <Show when={r().time}>
              <span class="text-mono">{r().time}</span>
              {r().rest}
            </Show>
            <Show when={props.resetDay}>
              {(c) => (
                <>
                  {" · "}
                  <ResetDay c={c()} />
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={usesLine(props.w)}>{(u) => <p class="meter-context">{u()}</p>}</Show>
      {/* How fast it is going, and, a day or more long, its history (§app.insights/usage-burn). */}
      <BurnLines lines={burnLines(props.w, props.now)} />
      <Show when={(props.w.history || props.w.burn) && chartSpan(props.w, props.now)}>{(span) => <BurnChart w={props.w} span={span()} now={props.now} />}</Show>
      {/* Under a day (the 5-hour window): no chart, a strip of its past windows instead. */}
      <Show when={props.w.history && shortSpan(props.w)}>
        <BurnStrip w={props.w} now={props.now} />
      </Show>
    </div>
  );
}

/**
 * Claude's pay-as-you-go spend past the plan: a quota fill against the extra-usage cap, or, when
 * the source only says it's switched on, the head alone reading "On" (no bar, like a balance).
 */
function ExtraMeter(props: { x: { pct: number } | { on: true } }) {
  const fill = () => ("pct" in props.x ? props.x.pct : null);
  return (
    <div class="meter">
      <p class="meter-head">
        <span class="meter-label">Extra usage</span>
        <Show when={fill() !== null} fallback={<span class="meter-value">On</span>}>
          <span class="meter-value">
            {Math.round(fill()!)}%<span class="meter-of"> used</span>
          </span>
        </Show>
      </p>
      <Show when={fill() !== null}>
        <Track pct={fill()!} />
        <p class="meter-context">Of your extra-usage spend cap</p>
      </Show>
    </div>
  );
}

/**
 * A prepaid credit provider (DeepSeek) reports money left, not windows: the meter's number
 * without the bar, and no reset — there's nothing to reset.
 */
function Balance(props: { b: UsageBalance }) {
  return (
    <>
      <div class="meter">
        <p class="meter-head">
          <span class="meter-label">Balance</span>
          <span class="meter-value">{money(props.b.total, props.b.currency)}</span>
        </p>
        <Show when={balanceBreakdown(props.b)}>{(b) => <p class="meter-context">{b()}</p>}</Show>
        <Show when={balanceBurnLine(props.b)}>{(l) => <BurnLines lines={[l()]} />}</Show>
      </div>
      <Show when={!props.b.available}>
        <p class="usage-note">This balance can't fund calls. They'll fail until it's topped up.</p>
      </Show>
    </>
  );
}

/** Ollama sources are separate from quota windows and the device's API-price ledger. */
function OllamaSections(props: { p: UsageProvider; now: number; resetDay?: ResetDayControl }) {
  const activity = () => props.p.activity;
  const credits = () => props.p.credits;
  const period = () => credits()?.data?.included?.period;
  const previousCredits = () => endpointPrevious(credits(), props.now) || !!period() && (Date.parse(period()!.from) > props.now || Date.parse(period()!.until) <= props.now);
  const time = (t: number | undefined) => t === undefined ? "time unknown" : new Date(t).toISOString();
  const trend = () => activity()?.data ? activityTrend(activity()!.data!) : [];
  const scale = () => Math.max(0.01, ...trend().map((b) => b.usd ?? 0));
  return <>
    <Show when={credits()} fallback={<section class="stack stack-2" aria-labelledby="u-ollama-credits"><h4 id="u-ollama-credits" class="text-heading-s">Included credits</h4><p class="meter-context">No balance reading yet.</p><p class="meter-head"><span class="meter-label">Included remaining</span><span class="meter-value">Unknown</span></p><p class="meter-head"><span class="meter-label">Included allowance</span><span class="meter-value">Unknown</span></p><p class="meter-head"><span class="meter-label">Purchased remaining</span><span class="meter-value">Unknown</span></p></section>}>{(r) => <section class="stack stack-2" aria-labelledby="u-ollama-credits">
      <h4 id="u-ollama-credits" class="text-heading-s">Included credits</h4>
      <p class="usage-card-caption text-caption text-muted">{previousCredits() ? "Previous reading · as of " : "As of "}{time(r().fetchedAt)}<Show when={r().error}> · {r().error}</Show></p>
      <div class="meter">
        <p class="meter-head"><span class="meter-label">Included remaining</span><span class="meter-value">{reportedMoney(r().data?.included?.balance_usd)}</span></p>
        <p class="meter-head"><span class="meter-label">Included allowance</span><span class="meter-value">{reportedMoney(r().data?.included?.allowance_usd)}</span></p>
        <Show when={includedCreditPct(r().data) !== undefined}>
          <p class="meter-context">{Math.round(includedCreditPct(r().data)!)}% included credits used</p>
          <Show when={currentIncluded(props.p, props.now)}>
            <div class="meter-track" aria-hidden="true"><span class="meter-fill" style={{ "--meter-pct": `${includedCreditPct(r().data)}%` }} /></div>
          </Show>
        </Show>
        <Show when={period()} fallback={<p class="meter-context">Included period: Unknown</p>}>{(p) => <p class="meter-context text-mono">{p().from} → {p().until} UTC · end exclusive</p>}</Show>
      </div>
      <p class="meter-head"><span class="meter-label">Purchased remaining</span><span class="meter-value">{reportedMoney(r().data?.purchased?.balance_usd)}</span></p>
      <For each={(["session", "weekly"] as const).filter((k) => r().data?.[k])}>{(k) => <p class="meter-context">{k === "session" ? "Session" : "Weekly"}: {r().data![k]!.remaining_percent}% remaining<Show when={r().data![k]!.resets_at}> · resets {r().data![k]!.resets_at}</Show></p>}</For>
    </section>}</Show>
    <Show when={activity()}>{(r) => <section class="stack stack-2" aria-labelledby="u-ollama-activity">
      <h4 id="u-ollama-activity" class="text-heading-s">Activity</h4>
      <p class="usage-card-caption text-caption text-muted">{endpointPrevious(r(), props.now) ? "Previous reading · as of " : "As of "}{time(r().fetchedAt)}<Show when={r().error}> · {r().error}</Show></p>
      <Show when={r().data}>{(a) => <>
        <p class="meter-context text-mono">{a().from} → {a().until} UTC · end exclusive · {a().scope}</p>
        <For each={activityMetrics(a())}>{(m) => <p class="meter-head"><span class="meter-label">{m.label}</span><span class="meter-value">{m.value}</span></p>}</For>
        <p class="meter-context">Request value, including plan and purchased credits—not subscription spend. Usage may be delayed.</p>
        <h4 class="text-caption">Daily reported USD</h4>
        <svg viewBox={`0 0 ${Math.max(1, trend().length) * 20} 64`} width="100%" height="64" aria-hidden="true">
          <For each={trend()}>{(b, i) => <Show when={b.usd !== undefined} fallback={<path d={`M${i() * 20 + 3},62 h14`} stroke="var(--color-ink-muted)" stroke-dasharray="2 2" />}>
            <rect x={i() * 20 + 3} y={62 - Math.max(1, b.usd! / scale() * 60)} width="14" height={Math.max(1, b.usd! / scale() * 60)} fill={b.partial ? "var(--color-ink-muted)" : "var(--color-ink-2)"} />
          </Show>}</For>
        </svg>
        <ul class="meter-context" style={{ "list-style": "none", padding: "0" }}>
          <For each={trend()}>{(b) => <li title={`${b.from} → ${b.until} UTC`}><span class="text-mono">{b.date}</span> · {reportedMoney(b.usd)}{b.partial ? " · Partial" : ""}</li>}</For>
        </ul>
      </>}</Show>
    </section>}</Show>
    <Show when={!period() && props.p.windows.length === 0 && props.resetDay}>{(c) => <p class="meter-context">Declared subscription reset: {c().day === null ? "Unknown" : `day ${c().day} of each month`} · <ResetDay c={c()} /></p>}</Show>
  </>;
}

/** A note or caption's words, its command (if any) in `<code>`. */
function UsageText(props: { line: UsageLine }) {
  return (
    <>
      {props.line.lead}
      <Show when={props.line.code}>
        <code>{props.line.code}</code>
      </Show>
      {props.line.rest}
    </>
  );
}

/**
 * One provider's card: name, plan subtitle and chip in the head; its meters (or balance) and
 * notes in the body, or the one note that replaces them when the provider isn't ok.
 */
export function UsageCard(props: {
  p: UsageProvider;
  now: number;
  /** A Claude login's card: its own title, caption and id instead of the provider's. */
  title?: string;
  plan?: string;
  headId?: string;
  /** Before the meters: a login's standing. */
  lead?: JSX.Element;
  /** Replaces the provider's own note when the card has no meters for a reason of its own. */
  note?: string | null;
  /** After the sign-in caption. */
  foot?: JSX.Element;
  /** No sign-in caption: the reading is one of several logins', each with its own sign-in. */
  noSignIn?: boolean;
  /** A ghost meter's sentence in place of "New reading at the next refresh." (a free login's figures). */
  past?: string;
  /** Ollama's declared reset day, on its monthly meter. */
  resetDay?: ResetDayControl;
}) {
  const problem = (): UsageLine | null => (props.note ? { rest: props.note } : providerProblem(props.p, props.now));
  const signIn = () => (props.noSignIn ? null : authCaption(props.p, props.now));
  const headId = () => props.headId ?? `u-${props.p.id}`;
  return (
    <article class="card usage-card" aria-labelledby={headId()}>
      <header class="card-head">
        <div class="usage-card-heading">
          <h3 class="card-title" classList={{ "usage-login-title": !!props.title }} id={headId()}>
            {props.title ?? PROVIDER_NAME[props.p.id]}
          </h3>
          <Show when={props.plan ?? planLabel(props.p)}>{(plan) => <p class="usage-card-plan text-caption text-muted">{plan()}</p>}</Show>
        </div>
        <Show when={providerChip(props.p, props.now)}>{(c) => <Chip tone={c().tone}>{c().text}</Chip>}</Show>
      </header>
      <div class="card-body">
        {props.lead}
        <Show
          when={problem()}
          fallback={
            <>
              <Show when={props.p.balance} fallback={<For each={props.p.windows}>{(w) => <Meter w={w} now={props.now} past={props.past} resetDay={w.label === "month" ? props.resetDay : undefined} />}</For>}>
                {(b) => <Balance b={b()} />}
              </Show>
              <Show when={props.p.id === "ollama" && (props.p.activity || props.p.credits)}><OllamaSections p={props.p} now={props.now} resetDay={props.resetDay} /></Show>
              <Show when={extraUsageMeter(props.p)}>{(x) => <ExtraMeter x={x()} />}</Show>
              <Show when={props.p.limitReached}>
                <p class="usage-note">Usage limit reached. Calls may fail until it resets.</p>
              </Show>
              <Show when={props.p.lastKnown}>
                <p class="usage-card-caption text-caption text-muted" title={props.p.error}>
                  Last stored reading — an older pi session is rewriting the cache.
                </p>
              </Show>
            </>
          }
        >
          {(pr) => (
            <p class="usage-note">
              <UsageText line={pr()} />
            </p>
          )}
        </Show>
        <Show when={signIn()}>
          {(c) => (
            <p class="usage-card-caption text-caption text-muted">
              <UsageText line={c()} />
            </p>
          )}
        </Show>
        {props.foot}
      </div>
    </article>
  );
}

/** A login's standing chip, and "In use for new chats" on the one a new chat starts on. */
function LoginChips(props: { l: UsageClaudeLogin; now: number; reading: UsageProvider }) {
  const standing = () => claudeLoginStanding(props.l, props.now, props.reading);
  return (
    <>
      <Chip tone={standing().tone} title={standing().title}>
        {standing().text}
      </Chip>
      <Show when={claudeLoginHolder(props.l)}>
        {(h) => (
          <Chip tone={h().tone} title="Where this login is">
            {h().text}
          </Chip>
        )}
      </Show>
      <Show when={props.l.inUse}>
        <span class="chip chip-count" title="The first ready login in this device's order: new chats start on it">
          In use for new chats
        </span>
      </Show>
    </>
  );
}

/**
 * One Claude account (§app.insights/usage-cards): its email as the title, its usage once (the
 * freshest reading of its logins, which share one quota), then its logins as compact rows — or,
 * for an account of one login outside the pool, that login's chips above the meters.
 */
function ClaudeAccountCard(props: { account: UsageClaudeLogin[]; now: number }) {
  const reading = () => accountReading(props.account, props.now);
  const first = () => props.account[0]!;
  const caption = () => claudeAccountLoginsCaption(props.account);
  const listed = () => caption() !== null;
  return (
    <UsageCard
      p={reading().usage}
      now={props.now}
      title={claudeLoginTitle(first())}
      plan={claudeAccountSubtitle(props.account)}
      headId={`u-claude-${first().id}`}
      note={claudeLoginNote(reading().login)}
      past={claudePastNote(reading().login)}
      noSignIn={props.account.length > 1}
      lead={
        <Show when={!listed()}>
          <p class="usage-login-standing">
            <LoginChips l={first()} now={props.now} reading={reading().usage} />
          </p>
        </Show>
      }
      foot={
        <Show when={listed()}>
          <div class="usage-logins">
            <p class="usage-logins-caption text-caption text-muted">{caption()}</p>
            <ul class="usage-logins-list">
              <For each={props.account}>
                {(l) => (
                  <li class="usage-logins-row" data-login={l.id}>
                    <span class="usage-logins-name">{claudeLoginName(l, props.account)}</span>
                    <span class="usage-login-standing">
                      <LoginChips l={l} now={props.now} reading={reading().usage} />
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      }
    />
  );
}

/** Claude's cards: one per account, in the order its first login has on this device. */
function ClaudeAccountCards(props: { logins: UsageClaudeLogin[]; now: number }) {
  return <For each={claudeAccounts(props.logins)}>{(account) => <ClaudeAccountCard account={account} now={props.now} />}</For>;
}

/** The page body, directly in `.insights-inner`: the h1 already names it, so no section head. */
function UsageBody(props: {
  usage: Poll<UsageInsight>;
  now: number;
  /** The open chat's recorded Claude login, for the summary lead (as the sidebar foot). */
  claudeLogin?: string | null;
  /** Why the last Refresh Usage failed, until one succeeds. */
  refreshError: string | null;
  refreshing: boolean;
  onRefresh(): void;
}) {
  const u = () => props.usage.data();
  const age = () => props.now - (u()?.fetchedAt ?? props.now);
  /** Ollama's reset-day control, from a server that sends the day (an older one offers none). */
  const resetDay = (d: UsageInsight): ResetDayControl | undefined =>
    d.ollamaResetDay === undefined
      ? undefined
      : { day: d.ollamaResetDay, save: async (day) => props.usage.set(await putUsageResetDay(day)) };
  const retry = () => (
    <button type="button" class="button button-sm" aria-disabled={props.refreshing ? "true" : undefined} onClick={() => !props.refreshing && props.onRefresh()}>
      Retry
    </button>
  );
  return (
    <Switch>
      <Match when={!u() && props.usage.pending()}>
        {/* A head and a row per provider the page can show (claude, openai, ollama, zai, deepseek). */}
        <ListSkeleton groups={5} rows={1} />
      </Match>
      <Match when={u()?.available === false && u()?.reason === "corrupt"}>
        <Banner
          tone="error"
          title="Couldn't read usage."
          body={
            <>
              <code>usage-status.json</code> isn't valid JSON right now. Nothing was changed. It's rewritten at the next refresh.
            </>
          }
          action={retry()}
        />
      </Match>
      <Match when={u()?.available === false}>
        <div class="card">
          <div class="empty">
            <Icon name="gauge" class="empty-mark" />
            <p class="empty-title">No usage data yet.</p>
            <p class="empty-body">Nothing has fetched provider usage on this machine. Refresh Usage fetches it now.</p>
            <button type="button" class="button empty-action" aria-disabled={props.refreshing ? "true" : undefined} onClick={() => !props.refreshing && props.onRefresh()}>
              <Icon name="refresh" />
              Refresh Usage
            </button>
          </div>
        </div>
      </Match>
      <Match when={u()}>
        {(data) => (
          <>
            {/* Old data alone is no banner: Refresh Usage fetches it. It is one when that refresh failed. */}
            <Show when={data().stale && props.refreshError}>
              {(failure) => (
                <Banner tone="warn" icon="clock" title={`Usage is ${duration(age())} old.`} body={`Couldn't refresh: ${failure()}`} action={retry()} />
              )}
            </Show>
            <Show when={usageSummary(data(), props.now, props.claudeLogin)}>{(lead) => <p class="usage-lead">{lead()}</p>}</Show>
            {/* macOS: Claude Code's own login is in a keychain this server can't read (§app.claude-logins/macos-keychain). */}
            <Show when={data().claudeOwnLoginUnreadable}>
              <p class="usage-note">On macOS, add your Claude login under Settings → Accounts.</p>
            </Show>
            <div class="insights-grid">
              <For each={data().providers}>
                {(p) => (
                  <Show when={p.id === "claude" && data().claudeLogins?.length ? data().claudeLogins : null} fallback={<UsageCard p={p} now={props.now} resetDay={p.id === "ollama" ? resetDay(data()) : undefined} />}>
                    {(logins) => <ClaudeAccountCards logins={logins()} now={props.now} />}
                  </Show>
                )}
              </For>
            </div>
          </>
        )}
      </Match>
    </Switch>
  );
}

/** `#/usage`: subscription usage limits, from the usage-status extension's cache file. */
export function UsageView(props: { usage: Poll<UsageInsight>; now: number; claudeLogin?: string | null; titleRef(el: HTMLHeadingElement): void }) {
  const fetchedAt = () => props.usage.data()?.fetchedAt ?? null;
  /** " · next refresh in 3m" while the cache's next fetch is ahead; a passed one says nothing. */
  const nextRefresh = () => {
    const next = props.usage.data()?.nextFetchAt;
    return next ? relativeIn(iso(next), props.now) : null;
  };
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal<string | null>(null);
  /** Refresh Usage: the server fetches every provider now; the result replaces the poll's value. */
  const refresh = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      props.usage.set(await refreshUsage());
      setRefreshError(null);
    } catch (err) {
      setRefreshError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  /** The stale banner carries a failed refresh over old data; the page banner carries the rest. */
  const staleFailure = () => Boolean(props.usage.data()?.stale && refreshError());
  return (
    <InsightsPage
      title="Usage"
      meta={
        <Show when={fetchedAt()} fallback={<span>Not read yet</span>}>
          {(f) => (
            <>
              <span title={iso(f())}>Updated {relativeTime(iso(f()), props.now)}</span>
              <Show when={nextRefresh()}>{(n) => <span title={iso(props.usage.data()!.nextFetchAt!)}> · next refresh {n()}</span>}</Show>
            </>
          )}
        </Show>
      }
      refreshLabel="Refresh Usage"
      onRefresh={() => void refresh()}
      refreshing={refreshing()}
      error={props.usage.error() ?? (staleFailure() ? null : refreshError())}
      errorTitle={props.usage.error() ? "Couldn't load usage." : "Couldn't refresh usage."}
      busy={!props.usage.data() && props.usage.pending()}
      titleRef={props.titleRef}
    >
      <UsageBody usage={props.usage} now={props.now} claudeLogin={props.claudeLogin} refreshError={refreshError()} refreshing={refreshing()} onRefresh={() => void refresh()} />
    </InsightsPage>
  );
}

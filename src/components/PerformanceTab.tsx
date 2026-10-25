import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { PERF_MIN_MS, PERF_MIN_RANGE, PERF_MIN_TOKENS, type PerfEffortRow, type PerfFigure, type PerfModelRow, type UsagePerformance } from "../../shared/usage/perf";
import { getUsagePerformance } from "../lib/api";
import { browserZone, costsApiSearch, providerName } from "../lib/cost-history";
import { compactModel, shortDate } from "../lib/format";
import {
  axisAt,
  byEffort,
  bySort,
  type ChartSlot,
  chartSlots,
  type FigureWords,
  levelWords,
  overallScale,
  perfEmptyTitle,
  perfHref,
  type PerfQuery,
  type PerfSort,
  PERF_SORTS,
  type PlacedBin,
  placeBins,
  repliesWord,
  rowWords,
  scaleAt,
  thoughtWords,
  tpsNum,
  tpsWord,
} from "../lib/perf";
import { createPoll } from "../lib/poll";
import "../projects.css";
import "../costs-tab.css";
import "../performance-tab.css";
import { ActionMenu } from "./ActionMenu";
import { CostsBar } from "./CostsTab";
import { Banner, Icon } from "./ui";

/** Speeds settle slowly; a minute is fresh enough, as on Costs. */
const PERF_POLL_MS = 60_000;

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Change the address (the filters and sort live there), replaced so picking adds no history entry. */
const goTo = (href: string) => {
  if (location.hash !== href) location.replace(href);
};

/**
 * The Agents page's Performance tab: this device's measured reply speeds and thinking times, one
 * row per provider and model, each opening into its effort levels and two spread charts. The Costs
 * tab's range and filters, and a sort, in this tab's own address. `tick` is the page's Refresh.
 */
export function PerformanceTab(props: { query: PerfQuery; now: number; tick: number }) {
  const search = createMemo(() => costsApiSearch(props.query, browserZone()));
  const poll = createPoll(() => getUsagePerformance(search()), PERF_POLL_MS);
  createEffect(on([search, () => props.tick], () => poll.refetch(), { defer: true }));
  const fresh = () => {
    const a = poll.data();
    return !!a && a.range === props.query.range && same(a.providers, props.query.providers) && same(a.models, props.query.models);
  };

  return (
    <div class="costs" id="agents-tabpanel" role="tabpanel" aria-labelledby="agents-tab-performance">
      <CostsBar query={props.query} facets={poll.data()?.facets} href={(q) => perfHref({ ...q, sort: props.query.sort })} />
      <Show when={poll.error()}>
        {(message) => (
          <Banner
            tone="error"
            title="Couldn't load performance."
            body={
              message() === "usage-unavailable"
                ? "The usage counter isn't running yet. Nothing was lost: replies keep being measured, and the figures come back when it starts."
                : `Nothing was changed. ${message()}`
            }
          />
        )}
      </Show>
      <Show
        when={poll.data()}
        fallback={
          <Show when={!poll.error()}>
            <div class="card costs-card" aria-busy="true">
              <span class="skeleton skeleton-title" />
              <span class="skeleton skeleton-line" />
              <span class="skeleton skeleton-line" />
            </div>
          </Show>
        }
      >
        {(a) => (
          <div class="costs" aria-busy={fresh() ? undefined : "true"}>
            <Show
              when={a().rows.length > 0}
              fallback={
                <div class="card">
                  <div class="empty">
                    <p class="empty-title">{perfEmptyTitle(props.query, a().since !== null)}</p>
                    <p class="empty-body">
                      {a().since === null ? "Speeds appear here as models answer." : "Widen the range or clear the filters to see more."}
                    </p>
                  </div>
                </div>
              }
            >
              <ModelTable rows={a().rows} query={props.query} />
            </Show>
          </div>
        )}
      </Show>
      <footer class="costs-foot">
        <p class="cost-note">
          <SinceLine answer={poll.data()} now={props.now} />
        </p>
        <p class="cost-note">
          A range needs {PERF_MIN_RANGE} replies; fewer show their count. A speed needs {PERF_MIN_TOKENS} tokens over {PERF_MIN_MS / 1000} s.
        </p>
      </footer>
    </div>
  );
}

/** "This device only · measured since Oct 6." */
function SinceLine(props: { answer: UsagePerformance | undefined; now: number }) {
  const since = () => props.answer?.since;
  return (
    <>
      This device only
      <Show when={since()}>
        {(iso) => (
          <>
            {" · measured since "}
            <span title={iso()}>{shortDate(Date.parse(iso()), props.now)}</span>
          </>
        )}
      </Show>
      .
    </>
  );
}

/** A muted line that may wrap keeps a number with its unit and a range with its ends: "1.4 to 8.4 s"
    never leaves its "s" on a line of its own. */
const keep = (s: string) => s.replace(/ (?=(?:ms|s|tok\/s)\b)/g, "\u00a0").replace(/(\S) to (?=\S)/g, "$1\u00a0to\u00a0").replace(/^avg /, "avg\u00a0");

/** A figure's median, then its one muted line; a dash's full reason for a screen reader. */
function FigText(props: { words: FigureWords }) {
  return (
    <>
      <span class="cost-figure">{props.words.main}</span>
      <Show when={props.words.sub}>
        {(s) => (
          <span class="perf-fig-sub" aria-hidden={props.words.sr ? "true" : undefined}>
            {keep(s())}
          </span>
        )}
      </Show>
      <Show when={props.words.sr}>{(r) => <span class="visually-hidden">{r()}</span>}</Show>
    </>
  );
}

/** One figure in a cell: the median, then one short muted line. */
function Fig(props: { label: string; words: FigureWords }) {
  return (
    <td align="right" data-label={props.label}>
      <span class="perf-fig">
        <FigText words={props.words} />
      </span>
    </td>
  );
}

// ---- the table ----

const modelId = (r: PerfModelRow) => `${r.provider}/${r.model}`;
const domId = (r: PerfModelRow) => `perf-${modelId(r).replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/** The Sort menu: one check row per order; the pick goes in the address. */
function SortMenu(props: { query: PerfQuery }) {
  const label = () => PERF_SORTS.find((s) => s.id === props.query.sort)?.label ?? PERF_SORTS[0]!.label;
  const rows: HTMLElement[] = [];
  const pick = (id: PerfSort) => goTo(perfHref({ ...props.query, sort: id }));
  return (
    <span class="costs-pick perf-sort">
      <ActionMenu
        label={`Sort models: ${label()}`}
        title="Sort"
        icon={null}
        text={`Sort: ${label()}`}
        align="end"
        onToggle={(open) => open && queueMicrotask(() => rows.find((r) => r.getAttribute("aria-checked") === "true")?.focus())}
      >
        {(menu) => (
          <For each={PERF_SORTS}>
            {(s, i) => (
              <div
                ref={(el) => (rows[i()] = el)}
                class="popover-item"
                role="menuitemradio"
                tabindex="0"
                aria-checked={props.query.sort === s.id ? "true" : "false"}
                onClick={() => menu.run(() => pick(s.id))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  menu.run(() => pick(s.id));
                }}
              >
                <Icon name="check" small class="popover-item-check" />
                <span class="popover-item-text">
                  <span class="popover-item-label">{s.label}</span>
                </span>
              </div>
            )}
          </For>
        )}
      </ActionMenu>
    </span>
  );
}

function ModelTable(props: { rows: PerfModelRow[]; query: PerfQuery }) {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  /** The level each opened row's charts show; absent: All levels. Kept per model id, so a poll keeps it. */
  const [levels, setLevels] = createSignal<ReadonlyMap<string, string>>(new Map());
  const toggle = (id: string) => {
    const closing = open().has(id);
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    // Closing a row picks All levels again.
    if (closing) setLevel(id, null);
  };
  const setLevel = (id: string, level: string | null) =>
    setLevels((m) => {
      const next = new Map(m);
      if (level === null) next.delete(id);
      else next.set(id, level);
      return next;
    });
  // Keyed by id, not by the row objects a poll builds afresh: an opened row stays open, its button keeps focus.
  const ids = createMemo(() => bySort(props.rows, props.query.sort).map(modelId), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const rowOf = (id: string) => props.rows.find((r) => modelId(r) === id);
  const scale = createMemo(() => overallScale(props.rows));
  return (
    <section class="card costs-card" aria-labelledby="perf-models">
      <div class="perf-card-head">
        <div class="perf-card-title">
          <h2 class="costs-h2" id="perf-models">
            By model
          </h2>
          <p class="cost-lede">Medians per reply. Bars show 10–90% of replies, on one scale.</p>
        </div>
        <SortMenu query={props.query} />
      </div>
      <div class="md md-table-wrap cost-table-wrap">
        <table class="cost-table cost-table-stack perf-table">
          <caption class="visually-hidden">Measured reply speeds and thinking times by model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" align="right">Overall speed</th>
              <th scope="col" align="right">Reply speed</th>
              <th scope="col" align="right">Thinking</th>
              <th scope="col" align="right">First token</th>
            </tr>
          </thead>
          <For each={ids()}>
            {(id) => (
              <Show when={rowOf(id)}>
                {(r) => (
                  <ModelRows
                    row={r()}
                    scale={scale()}
                    open={open().has(id)}
                    onToggle={() => toggle(id)}
                    level={levels().get(id) ?? null}
                    onLevel={(l) => setLevel(id, l)}
                  />
                )}
              </Show>
            )}
          </For>
        </table>
      </div>
    </section>
  );
}

/** The main row's spread: a thin bar from the 10th to the 90th percentile with a mark at the median,
    on the scale every row shares. */
function RangeBar(props: { figure: PerfFigure; scale: number }) {
  const at = (v: number) => `${Math.round(scaleAt(v, props.scale) * 1000) / 10}%`;
  const f = () => props.figure;
  return (
    <span
      class="perf-rangebar"
      role="img"
      aria-label={`10–90% of replies ${tpsNum(f().p10!)} to ${tpsWord(f().p90!)}, median ${tpsWord(f().median!)}, on a scale to ${tpsWord(props.scale)}`}
    >
      <span class="perf-rangebar-fill" style={{ left: at(f().p10!), width: `calc(${at(f().p90!)} - ${at(f().p10!)})` }} />
      <span class="perf-rangebar-median" style={{ left: at(f().median!) }} />
    </span>
  );
}

/** A model's row, and its effort levels under it once opened. A tbody per model keeps the pair together. */
function ModelRows(props: { row: PerfModelRow; scale: number; open: boolean; onToggle(): void; level: string | null; onLevel(level: string | null): void }) {
  const name = () => compactModel(props.row.model) ?? props.row.model;
  const detail = () => `${domId(props.row)}-efforts`;
  const meta = () => `${providerName(props.row.provider)} · ${repliesWord(props.row.replies)}`;
  const words = createMemo(() => rowWords(props.row));
  const overall = () => words().overall;
  return (
    <tbody class="perf-model">
      <tr class="perf-row">
        <th scope="row" title={modelId(props.row)} class="perf-model-cell">
          <button type="button" class="perf-open" aria-expanded={props.open ? "true" : "false"} aria-controls={detail()} onClick={() => props.onToggle()}>
            <Icon name="chevron-right" small />
            <span class="perf-open-name">
              <span class="text-mono">{name()}</span>
              <span class="cost-session-meta">{meta()}</span>
            </span>
            <span class="visually-hidden">{props.open ? ", hide effort levels" : ", show effort levels"}</span>
          </button>
          {/* On a phone the full-width button below opens the row; the name is only a name. */}
          <span class="perf-name-plain">
            <span class="text-mono">{name()}</span>
            <span class="cost-session-meta">{meta()}</span>
          </span>
        </th>
        <td align="right" data-label="Overall speed" class="perf-overall">
          <span class="perf-fig">
            <span class="cost-figure perf-headline">{overall().main}</span>
            <Show
              when={overall().ranged && props.scale > 0}
              fallback={
                <Show when={overall().sub}>
                  {(s) => (
                    <span class="perf-fig-sub" aria-hidden={overall().sr ? "true" : undefined}>
                      {s()}
                    </span>
                  )}
                </Show>
              }
            >
              <span class="perf-rangebar-line">
                <RangeBar figure={props.row.overall} scale={props.scale} />
                <span class="perf-fig-sub">{keep(overall().sub ?? "")}</span>
              </span>
            </Show>
            <Show when={overall().sr}>{(r) => <span class="visually-hidden">{r()}</span>}</Show>
          </span>
        </td>
        <Fig label="Reply speed" words={words().reply} />
        <Fig label="Thinking" words={words().thinking} />
        <Fig label="First token" words={words().ttft} />
        <td class="perf-toggle-cell">
          <button type="button" class="button perf-toggle" aria-expanded={props.open ? "true" : "false"} aria-controls={detail()} onClick={() => props.onToggle()}>
            {props.open ? "Hide Effort Levels" : "Show Effort Levels"}
            <span class="visually-hidden">, {name()}</span>
          </button>
        </td>
      </tr>
      <tr class="perf-detail-row" id={detail()} hidden={!props.open}>
        <td colSpan={5}>
          <Show when={props.open}>
            <EffortPanel row={props.row} name={name()} level={props.level} onLevel={props.onLevel} />
          </Show>
        </td>
      </tr>
    </tbody>
  );
}

// ---- the opened row ----

/** The opened row: the model's thinking speed, one line per effort level, then the level switch and
    the two spread charts (or the one sentence that stands in for them). */
function EffortPanel(props: { row: PerfModelRow; name: string; level: string | null; onLevel(level: string | null): void }) {
  const efforts = createMemo(() => byEffort(props.row.efforts));
  /** The picked level's figures; All levels (or a level a poll dropped) is the model's own. */
  const picked = (): PerfEffortRow | null => (props.level ? (efforts().find((e) => e.effort === props.level) ?? null) : null);
  const charts = createMemo(() => chartSlots(props.row, picked()));
  const speed = () => rowWords(props.row).thinkingSpeed;
  const headId = () => `${domId(props.row)}-levels`;
  return (
    <div class="perf-efforts">
      <h3 class="perf-h3" id={headId()}>
        Effort levels
      </h3>
      <p class="perf-speed-line">
        <span class="perf-speed-label">Thinking speed</span>
        <span class="perf-speed-value">
          <FigText words={speed()} />
        </span>
      </p>
      <table class="cost-table cost-table-stack perf-effort-table">
        <caption class="visually-hidden">{props.name} by effort level</caption>
        <thead>
          <tr>
            <th scope="col">Effort</th>
            <th scope="col" align="right">Replies</th>
            <th scope="col" align="right">Thinking per reply</th>
            <th scope="col" align="right">Thinking tokens</th>
            <th scope="col" align="right">Overall speed</th>
          </tr>
        </thead>
        <tbody>
          <For each={efforts()}>
            {(e) => {
              const w = createMemo(() => levelWords(e));
              return (
              <tr class="perf-level" classList={{ "perf-level-on": picked()?.effort === e.effort }} aria-current={picked()?.effort === e.effort ? "true" : undefined}>
                <th scope="row" class="text-mono">
                  {e.effort}
                </th>
                <td align="right" data-label="Replies">
                  <span class="perf-fig">
                    <span class="cost-figure">{e.replies.toLocaleString("en-US")}</span>
                    <span class="perf-fig-sub">{thoughtWords(e)}</span>
                  </span>
                </td>
                <Fig label="Thinking per reply" words={w().thinking} />
                <Fig label="Thinking tokens" words={w().tokens} />
                <Fig label="Overall speed" words={w().overall} />
              </tr>
              );
            }}
          </For>
        </tbody>
      </table>
      <Show when={!charts().gap} fallback={<p class="perf-chart-gap">{charts().gap}</p>}>
        <Show when={efforts().length > 1}>
          <div class="board-filters perf-levels" role="group" aria-label={`Charts for effort level, ${props.name}`}>
            <LevelChip label="All levels" count={props.row.replies} on={!picked()} onPick={() => props.onLevel(null)} />
            <For each={efforts()}>{(e) => <LevelChip label={e.effort} count={e.replies} on={picked()?.effort === e.effort} onPick={() => props.onLevel(e.effort)} />}</For>
          </div>
        </Show>
        <div class="perf-charts">
          <For each={charts().slots}>{(slot) => <SpreadChart slot={slot} level={picked()?.effort} name={props.name} />}</For>
        </div>
      </Show>
    </div>
  );
}

/** One level in the switch: "medium · 12", pressed when picked (a check as well as the tint). */
function LevelChip(props: { label: string; count: number; on: boolean; onPick(): void }) {
  return (
    <button type="button" class="board-filter" aria-pressed={props.on ? "true" : "false"} onClick={() => props.onPick()}>
      <Show when={props.on}>
        <Icon name="check" small />
      </Show>
      <span class={props.label === "All levels" ? undefined : "text-mono"}>{props.label}</span>
      <span class="board-filter-count">· {props.count.toLocaleString("en-US")}</span>
    </button>
  );
}

/**
 * A spread chart: its numbers first, then one bar per band on the whole model's axis, a median line
 * and a 10–90% bracket. Under 5 replies of its own it gives way to one line. The bars are one tab
 * stop: arrow keys, Home and End move between them, and a hovered or focused bar says its band.
 */
function SpreadChart(props: { slot: ChartSlot; level: string | undefined; name: string }) {
  const placed = createMemo(() => {
    const { axis, figure, head } = props.slot;
    return axis && head ? placeBins(figure.bins!, axis).filter((p) => p.bin.n > 0) : [];
  });
  const [active, setActive] = createSignal(0);
  const [shown, setShown] = createSignal<number | null>(null);
  const bars: HTMLLIElement[] = [];
  const unit = (v: number) => props.slot.unit(v);
  const words = (p: PlacedBin) => `${unit(p.bin.lo)} to ${unit(p.bin.hi)}: ${repliesWord(p.bin.n)}`;
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
  const at = (v: number) => (props.slot.axis ? axisAt(props.slot.axis, v) : 0);
  const f = () => props.slot.figure;
  const move = (e: KeyboardEvent) => {
    const last = placed().length - 1;
    const i = Math.min(active(), last);
    const next = e.key === "ArrowRight" ? Math.min(last, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    bars[next]?.focus();
  };
  const where = () => `${props.name}, ${props.level ? `effort ${props.level}` : "all levels"}`;
  return (
    <Show when={props.slot.head} fallback={<p class="perf-chart perf-chart-gap">{props.slot.line}</p>}>
      <figure class="perf-chart">
        <figcaption class="perf-chart-head">
          <span class="perf-chart-title">{props.slot.title}</span>
          <span class="perf-chart-stats">{props.slot.head}</span>
        </figcaption>
        <div class="perf-chart-plot">
          <ol class="perf-bars" aria-label={`${props.slot.title}, ${where()}: replies per band`} onKeyDown={move}>
            <For each={placed()}>
              {(p, i) => (
                <li
                  ref={(el) => (bars[i()] = el)}
                  class="perf-bar"
                  tabindex={i() === Math.min(active(), placed().length - 1) ? 0 : -1}
                  title={words(p)}
                  style={{ left: pct(p.left), width: pct(p.width) }}
                  onFocus={() => (setActive(i()), setShown(i()))}
                  onBlur={() => setShown(null)}
                  onPointerEnter={() => setShown(i())}
                  onPointerLeave={() => setShown(null)}
                >
                  <span class="perf-bar-fill" style={{ height: pct(p.share) }} />
                  <span class="visually-hidden">{words(p)}</span>
                </li>
              )}
            </For>
          </ol>
          <span class="perf-median" style={{ left: pct(at(f().median!)) }} aria-hidden="true">
            <span class="perf-median-label">median</span>
          </span>
        </div>
        <div class="perf-bracket" aria-hidden="true">
          <span class="perf-bracket-span" style={{ left: pct(at(f().p10!)), width: pct(Math.max(0, at(f().p90!) - at(f().p10!))) }} />
        </div>
        <div class="perf-chart-axis" aria-hidden="true">
          <span>{unit(props.slot.axis!.lo)}</span>
          <span>median {unit(f().median!)}</span>
          <span>{unit(props.slot.axis!.hi)}</span>
        </div>
        <p class="perf-chart-readout" aria-hidden="true">
          {(() => {
            const i = shown();
            const p = i === null ? undefined : placed()[i];
            return p ? words(p) : "\u00a0";
          })()}
        </p>
      </figure>
    </Show>
  );
}

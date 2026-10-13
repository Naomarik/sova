import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import { PERF_MIN_MS, PERF_MIN_TOKENS, type PerfEffortRow, type PerfFigure, type PerfFigures, type PerfModelRow, type UsagePerformance } from "../../shared/usage/perf";
import { getUsagePerformance } from "../lib/api";
import { browserZone, costsApiSearch, type CostsQuery, providerName } from "../lib/cost-history";
import { compactModel, shortDate } from "../lib/format";
import { binShares, byEffort, byReplies, type FigureWords, figureWords, msBare, msWord, perfEmptyTitle, perfHref, repliesWord, showsRange, thoughtShare, tpsNum } from "../lib/perf";
import { createPoll } from "../lib/poll";
import { tokens } from "../lib/project-overseer-view";
import "../projects.css";
import "../costs-tab.css";
import "../performance-tab.css";
import { CostsBar } from "./CostsTab";
import { Banner, Icon } from "./ui";

/** Speeds settle slowly; a minute is fresh enough, as on Costs. */
const PERF_POLL_MS = 60_000;

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * The Agents page's Performance tab: this device's measured reply speeds and thinking times, one
 * row per provider and model, each opening into one line per effort level. The Costs tab's range
 * and filters, in this tab's own address. `tick` is the page's Refresh.
 */
export function PerformanceTab(props: { query: CostsQuery; now: number; tick: number }) {
  const search = createMemo(() => costsApiSearch(props.query, browserZone()));
  const poll = createPoll(() => getUsagePerformance(search()), PERF_POLL_MS);
  createEffect(on([search, () => props.tick], () => poll.refetch(), { defer: true }));
  const fresh = () => {
    const a = poll.data();
    return !!a && a.range === props.query.range && same(a.providers, props.query.providers) && same(a.models, props.query.models);
  };

  return (
    <div class="costs" id="agents-tabpanel" role="tabpanel" aria-labelledby="agents-tab-performance">
      <CostsBar query={props.query} facets={poll.data()?.facets} href={perfHref} />
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
              <ModelTable rows={a().rows} />
            </Show>
          </div>
        )}
      </Show>
      <footer class="costs-foot">
        <p class="cost-note">
          <SinceLine answer={poll.data()} now={props.now} />
        </p>
        <p class="cost-note">
          A speed needs {PERF_MIN_TOKENS} tokens over {PERF_MIN_MS / 1000} s in its part; shorter parts count toward times only.
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

/** Speeds as bare numbers: the column's head says tok/s. */
const tps = (f: PerfFigure, opts: { mean?: boolean } = {}) => figureWords(f, tpsNum, opts);
const ms = (f: PerfFigure, opts: { mean?: boolean; slow?: boolean } = {}) => figureWords(f, msWord, { ...opts, bare: msBare(f.p90) });
const tok = (f: PerfFigure) => figureWords(f, (v) => tokens(Math.round(v)));
/** A thinking figure of a group none of whose replies thought says that, not "too short". */
const thinking = (g: PerfFigures, w: FigureWords): FigureWords => (g.thought === 0 && w.main === "—" && !g.thinkingMs.unsupported ? { main: "—", reason: "No reply thought" } : w);

/** One figure in a cell: the median, then what it rests on or why it's a dash. */
function Fig(props: { label: string; words: ReturnType<typeof figureWords> }) {
  return (
    <td align="right" data-label={props.label}>
      <span class="perf-fig">
        <span class="cost-figure">{props.words.main}</span>
        <For each={props.words.details}>{(d) => <span class="perf-fig-detail">{d}</span>}</For>
        <Show when={props.words.reason}>{(r) => <span class="perf-fig-detail perf-fig-reason">{r()}</span>}</Show>
      </span>
    </td>
  );
}

function RepliesCell(props: { row: PerfModelRow | PerfEffortRow }) {
  return (
    <td align="right" data-label="Replies">
      <span class="perf-fig">
        <span class="cost-figure">{props.row.replies.toLocaleString("en-US")}</span>
        <span class="perf-fig-detail">thinks in {thoughtShare(props.row)}</span>
      </span>
    </td>
  );
}

/** A spread chart: one bar per bin, lowest first. Only for a figure with enough replies for a range. */
function Spread(props: { figure: PerfFigure; unit(v: number): string; label: string }) {
  const bins = () => props.figure.bins ?? [];
  const shares = createMemo(() => binShares(bins()));
  const binWords = (i: number) => {
    const b = bins()[i]!;
    return `${props.unit(b.lo)} to ${props.unit(b.hi)}: ${repliesWord(b.n)}`;
  };
  return (
    <Show when={showsRange(props.figure) && bins().length > 0} fallback={<span class="perf-fig-detail perf-fig-reason">Too few replies for a chart</span>}>
      <figure class="perf-spread-figure">
        <ol class="perf-spread" aria-label={props.label}>
          <For each={bins()}>
            {(_, i) => (
              <li class="perf-spread-slot" title={binWords(i())}>
                <span class="perf-spread-fill" style={{ height: `${Math.round(shares()[i()]! * 1000) / 10}%` }} />
                <span class="visually-hidden">{binWords(i())}</span>
              </li>
            )}
          </For>
        </ol>
        <figcaption class="perf-spread-axis" aria-hidden="true">
          <span>{props.unit(bins()[0]!.lo)}</span>
          <span>{props.unit(bins().at(-1)!.hi)}</span>
        </figcaption>
      </figure>
    </Show>
  );
}

const modelId = (r: PerfModelRow) => `${r.provider}/${r.model}`;
const domId = (r: PerfModelRow) => `perf-${modelId(r).replace(/[^a-zA-Z0-9_-]/g, "-")}`;

function ModelTable(props: { rows: PerfModelRow[] }) {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Keyed by id, not by the row objects a poll builds afresh: an opened row stays open, its button keeps focus.
  const ids = createMemo(() => byReplies(props.rows).map(modelId), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const rowOf = (id: string) => props.rows.find((r) => modelId(r) === id);
  return (
    <section class="card costs-card" aria-labelledby="perf-models">
      <h2 class="costs-h2" id="perf-models">
        By model
      </h2>
      <div class="md md-table-wrap cost-table-wrap">
        <table class="cost-table cost-table-stack perf-table">
          <caption class="visually-hidden">Measured reply speeds and thinking times by model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" align="right">Replies</th>
              <th scope="col" align="right">Overall tok/s</th>
              <th scope="col" align="right">Reply tok/s</th>
              <th scope="col" align="right">Thinking tok/s</th>
              <th scope="col" align="right">Thinking per reply</th>
              <th scope="col" align="right">First token</th>
              <th scope="col">Overall spread</th>
            </tr>
          </thead>
          <For each={ids()}>
            {(id) => (
              <Show when={rowOf(id)}>
                {(r) => <ModelRows row={r()} open={open().has(id)} onToggle={() => toggle(id)} />}
              </Show>
            )}
          </For>
        </table>
      </div>
    </section>
  );
}

/** A model's row, and its effort lines under it once opened. A tbody per model keeps the pair together. */
function ModelRows(props: { row: PerfModelRow; open: boolean; onToggle(): void }) {
  const name = () => compactModel(props.row.model) ?? props.row.model;
  const detail = () => `${domId(props.row)}-efforts`;
  return (
    <tbody>
      <tr>
        <th scope="row" title={modelId(props.row)}>
          <button type="button" class="perf-open" aria-expanded={props.open ? "true" : "false"} aria-controls={detail()} onClick={() => props.onToggle()}>
            <Icon name="chevron-right" small />
            <span class="perf-open-name">
              <span class="text-mono">{name()}</span>
              <span class="cost-session-meta">{providerName(props.row.provider)}</span>
            </span>
            <span class="visually-hidden">{props.open ? ", hide effort levels" : ", show effort levels"}</span>
          </button>
        </th>
        <RepliesCell row={props.row} />
        <Fig label="Overall tok/s" words={tps(props.row.overall, { mean: true })} />
        <Fig label="Reply tok/s" words={tps(props.row.reply)} />
        <Fig label="Thinking tok/s" words={thinking(props.row, tps(props.row.thinkingTps))} />
        <Fig label="Thinking per reply" words={thinking(props.row, ms(props.row.thinkingMs))} />
        <Fig label="First token" words={ms(props.row.ttft, { slow: true })} />
        <td data-label="Overall spread" class="perf-spread-cell">
          <Spread figure={props.row.overall} unit={tpsNum} label={`Overall speed spread in tokens per second, ${name()}`} />
        </td>
      </tr>
      <tr class="perf-detail-row" id={detail()} hidden={!props.open}>
        <td colSpan={8}>
          <Show when={props.open}>
            <EffortLines row={props.row} name={name()} />
          </Show>
        </td>
      </tr>
    </tbody>
  );
}

/** One line per effort level the model ran at, then the two spreads per level. */
function EffortLines(props: { row: PerfModelRow; name: string }) {
  const efforts = createMemo(() => byEffort(props.row.efforts));
  return (
    <div class="perf-efforts">
      <table class="cost-table cost-table-stack perf-effort-table">
        <caption class="visually-hidden">{props.name} by effort level</caption>
        <thead>
          <tr>
            <th scope="col">Effort</th>
            <th scope="col" align="right">Replies</th>
            <th scope="col" align="right">Thinking per reply</th>
            <th scope="col" align="right">Thinking tokens</th>
            <th scope="col" align="right">Overall tok/s</th>
            <th scope="col" align="right">First token</th>
          </tr>
        </thead>
        <tbody>
          <For each={efforts()}>
            {(e) => (
              <tr>
                <th scope="row" class="text-mono">{e.effort}</th>
                <RepliesCell row={e} />
                <Fig label="Thinking per reply" words={thinking(e, ms(e.thinkingMs, { mean: true }))} />
                <Fig label="Thinking tokens" words={thinking(e, tok(e.thinkingTokens))} />
                <Fig label="Overall tok/s" words={tps(e.overall)} />
                <Fig label="First token" words={ms(e.ttft, { slow: true })} />
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="perf-charts">
        <ChartGroup title="Thinking time per reply" efforts={efforts()} pick={(e) => e.thinkingMs} unit={msWord} name={props.name} thinking />
        <ChartGroup title="Overall speed (tok/s)" efforts={efforts()} pick={(e) => e.overall} unit={tpsNum} name={props.name} />
      </div>
    </div>
  );
}

function ChartGroup(props: { title: string; efforts: PerfEffortRow[]; pick(e: PerfEffortRow): PerfFigure; unit(v: number): string; name: string; thinking?: boolean }): JSX.Element {
  return (
    <section class="perf-chart-group">
      <h3 class="perf-h3">{props.title}</h3>
      <dl class="perf-chart-list">
        <For each={props.efforts}>
          {(e) => (
            <div class="perf-chart-line">
              <dt class="text-mono">{e.effort}</dt>
              <dd>
                <Show when={!props.pick(e).unsupported && !(props.thinking && e.thought === 0)} fallback={<span class="perf-fig-detail perf-fig-reason">{props.pick(e).unsupported ?? "No reply thought"}</span>}>
                  <Spread figure={props.pick(e)} unit={props.unit} label={`${props.title} spread, ${props.name}, effort ${e.effort}`} />
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </section>
  );
}

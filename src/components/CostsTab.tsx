import { createEffect, createMemo, createResource, createSignal, For, type JSX, on, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import type { PricesInfo, UsageCosts, UsageModelRow, UsageSessionRow, UsageSpend } from "../../shared/usage/wire";
import { getUsageCosts, listProjects, refreshPrices } from "../lib/api";
import {
  barShare,
  browserZone,
  byCost,
  cacheSum,
  COST_RANGES,
  costBars,
  costsApiSearch,
  costsHref,
  type CostsQuery,
  costWord,
  dayKey,
  facetChoices,
  kindName,
  kindOne,
  kindRows,
  modelChoices,
  pickedLabel,
  priceChangeWords,
  priceDate,
  providerChoices,
  providerName,
  projectName,
  toggleModel,
  toggleProvider,
  tokenSum,
} from "../lib/cost-history";
import { usd } from "../lib/costs";
import { compactModel, shortDate, usageModelNote } from "../lib/format";
import { createPoll } from "../lib/poll";
import { tokens } from "../lib/project-overseer-view";
import { announce } from "../lib/ui-state";
import "../projects.css";
import "../costs-tab.css";
import { ActionMenu } from "./ActionMenu";
import { sessionHref } from "./Sidebar";
import { Banner, Icon } from "./ui";

/** Spend moves while agents work, but slowly: a minute is fresh enough, and the helper answers from its rollup. */
const COSTS_POLL_MS = 60_000;

/** Change the filter: the address is the filter, replaced so the picking adds no history entry. */
const go = (q: CostsQuery) => {
  const href = costsHref(q);
  if (location.hash !== href) location.replace(href);
};

/**
 * The Agents page's Costs tab (§app.insights/cost-history): this device's spend at API prices,
 * read from the usage ledger, for the range and the providers and models in the address.
 * `tick` is the page's Refresh.
 */
export function CostsTab(props: { query: CostsQuery; sessions: SessionSummary[] | undefined; now: number; tick: number }) {
  const search = createMemo(() => costsApiSearch(props.query, browserZone()));
  // The poll reads the query when it fires; a new query fetches at once, and the poll drops an
  // older request still in flight.
  const poll = createPoll(() => getUsageCosts(search()), COSTS_POLL_MS);
  createEffect(on([search, () => props.tick], () => poll.refetch(), { defer: true }));
  /** The answer on screen is for the filter on screen; until the new one lands, the old one is marked busy. */
  const fresh = () => {
    const a = poll.data();
    return !!a && a.range === props.query.range && same(a.providers, props.query.providers) && same(a.models, props.query.models);
  };

  // Project names for the project table: the org project's own name, read once.
  const [projects] = createResource(() => listProjects().catch(() => null));
  const projectTitle = (id: string) => projects()?.projects.find((p) => p.id === id)?.name;

  const [pulled, setPulled] = createSignal<PricesInfo | null>(null);
  const [pulling, setPulling] = createSignal(false);
  const [pullError, setPullError] = createSignal<string | null>(null);
  /** The newer of the pull's answer and the poll's. */
  const prices = () => {
    const a = poll.data()?.prices ?? null;
    const b = pulled();
    if (!a || !b) return a ?? b;
    return (Date.parse(b.asOf ?? "") || 0) > (Date.parse(a.asOf ?? "") || 0) ? b : a;
  };
  const pull = async () => {
    if (pulling()) return;
    setPulling(true);
    setPullError(null);
    try {
      const next = await refreshPrices();
      setPulled(next);
      if (next.error) setPullError(next.error);
      else announce(`Prices refreshed${next.asOf ? `, as of ${priceDate(next.asOf, Date.now())}` : ""}.`);
      poll.refetch();
    } catch (err) {
      setPullError((err as Error).message);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div class="costs" id="agents-tabpanel" role="tabpanel" aria-labelledby="agents-tab-costs">
      <CostsBar query={props.query} answer={poll.data()} />
      <Show when={poll.error()}>
        {(message) => (
          <Banner
            tone="error"
            title="Couldn't load costs."
            body={message() === "usage-unavailable" ? "The usage counter isn't running yet. Nothing was lost: calls keep being recorded, and the figures come back when it starts." : `Nothing was changed. ${message()}`}
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
            <CostStats answer={a()} />
            <Show
              when={a().total.calls > 0}
              fallback={
                <div class="card">
                  <div class="empty">
                    <p class="empty-title">{emptyTitle(props.query)}</p>
                    <p class="empty-body">Spend shows up here as agents on this device call models.</p>
                  </div>
                </div>
              }
            >
              <CostChart answer={a()} query={props.query} now={props.now} />
              <div class="costs-tables">
                <ProviderTable answer={a()} />
                <KindTable answer={a()} />
                <ModelTable answer={a()} />
                <ProjectTable answer={a()} name={projectTitle} />
              </div>
              <Show when={a().topSessions.length}>
                <TopSessions rows={a().topSessions} sessions={props.sessions} />
              </Show>
            </Show>
          </div>
        )}
      </Show>
      <footer class="costs-foot">
        <p class="cost-note">This device only, at API prices, subscriptions included.</p>
        <Show when={prices()}>
          {(p) => (
            <p class="cost-note">
              <PricesLine info={p()} now={props.now} />
            </p>
          )}
        </Show>
        <Show when={prices()?.enabled !== false} fallback={<p class="cost-note">Pulling prices is off on this device.</p>}>
          <button
            type="button"
            class="button button-sm"
            aria-disabled={pulling() || prices()?.fetching ? "true" : undefined}
            aria-busy={pulling() ? "true" : undefined}
            onClick={() => !prices()?.fetching && void pull()}
          >
            {pulling() || prices()?.fetching ? "Refreshing Prices…" : "Refresh Prices"}
          </button>
        </Show>
        <Show when={pullError()}>
          {(m) => <p class="cost-note costs-error">Couldn't refresh prices. The prices in use stay as they were. {m()}</p>}
        </Show>
      </footer>
    </div>
  );
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

function emptyTitle(q: CostsQuery): string {
  const span = q.range === "7d" ? "in the last 7 days" : q.range === "30d" ? "in the last 30 days" : "yet";
  return q.providers.length || q.models.length ? `Nothing spent ${span} with these filters.` : `Nothing spent on this device ${span}.`;
}

/** "Prices as of Oct 4 · last change Oct 2: 2 prices changed." */
function PricesLine(props: { info: PricesInfo; now: number }) {
  const asOf = () => priceDate(props.info.asOf, props.now);
  const change = () => priceChangeWords(props.info.lastChange);
  const keys = () => [...(props.info.lastChange?.changed ?? []), ...(props.info.lastChange?.added ?? [])].join("\n");
  return (
    <Show when={asOf()} fallback="Prices from the starter list: not pulled on this device yet.">
      {(d) => (
        <>
          Prices as of <span title={props.info.asOf ?? undefined}>{d()}</span>
          <Show when={props.info.changedAt && change()} fallback=" · no change found yet">
            {(c) => (
              <>
                {" · last change "}
                <span title={keys()}>
                  {priceDate(props.info.changedAt, props.now)}: {c()}
                </span>
              </>
            )}
          </Show>
          .
        </>
      )}
    </Show>
  );
}

/** Range chips, then the provider and model pickers. */
function CostsBar(props: { query: CostsQuery; answer: UsageCosts | undefined }) {
  const choices = createMemo(() => facetChoices(props.answer?.facets));
  const providers = createMemo(() => providerChoices(choices(), props.query));
  const models = createMemo(() => modelChoices(choices(), props.query));
  return (
    <div class="costs-bar">
      <div class="board-filters" role="group" aria-label="Range">
        <For each={COST_RANGES}>
          {(r) => (
            <button type="button" class="board-filter" aria-pressed={props.query.range === r.id ? "true" : "false"} onClick={() => go({ ...props.query, range: r.id })}>
              <Show when={props.query.range === r.id}>
                <Icon name="check" small />
              </Show>
              {r.label}
            </button>
          )}
        </For>
      </div>
      <MultiPick
        name="Provider"
        all="All providers"
        many="providers"
        picked={props.query.providers}
        options={providers().map((p) => ({ id: p, label: providerName(p), note: p !== providerName(p) ? p : undefined }))}
        onToggle={(id) => go(toggleProvider(props.query, id))}
        onClear={() => go({ ...props.query, providers: [], models: [] })}
        empty="Nothing recorded in this range."
      />
      <MultiPick
        name="Model"
        all="All models"
        many="models"
        picked={props.query.models}
        options={models().map((m) => ({ id: m.key, label: compactModel(m.model) ?? m.model, note: providerName(m.provider) }))}
        onToggle={(id) => go(toggleModel(props.query, id))}
        onClear={() => go({ ...props.query, models: [] })}
        empty={props.query.providers.length ? "No model of these providers in this range." : "Nothing recorded in this range."}
      />
    </div>
  );
}

/**
 * A multi-select: a word trigger that says what's picked, opening a menu of check rows that stays
 * open while you pick. The first row picks every option again.
 */
function MultiPick(props: {
  name: string;
  all: string;
  many: string;
  picked: readonly string[];
  options: { id: string; label: string; note?: string }[];
  onToggle(id: string): void;
  onClear(): void;
  empty: string;
}) {
  const labelOf = (id: string) => props.options.find((o) => o.id === id)?.label ?? id;
  const word = () => pickedLabel(props.picked, props.all, props.name.toLowerCase(), props.many, labelOf);
  return (
    <span class="costs-pick">
      <ActionMenu label={`${props.name}: ${word()}`} title={props.name} icon={null} text={word()} align="start" class={props.picked.length ? "costs-pick-on" : undefined}>
        {(menu) => (
          <>
            <menu.Item label={props.all} aria={props.all} icon={<CheckMark on={!props.picked.length} />} stayOpen onRun={props.onClear} />
            <Show when={props.options.length} fallback={<p class="costs-pick-empty">{props.empty}</p>}>
              {/* Keyed by id, not by the option objects a poll or a pick builds afresh: a row keeps
                  its DOM, so the row you just toggled keeps focus. */}
              <For each={props.options.map((o) => o.id)}>
                {(id) => {
                  const o = { id, get label() { return labelOf(id); }, get note() { return props.options.find((x) => x.id === id)?.note; } };
                  const on = () => props.picked.includes(o.id);
                  return (
                    <div
                      class="popover-item"
                      classList={{ "popover-item-detail": !!o.note }}
                      role="menuitemcheckbox"
                      tabindex="0"
                      aria-checked={on() ? "true" : "false"}
                      title={o.note ? `${o.label} · ${o.note}` : o.label}
                      onClick={() => props.onToggle(o.id)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        props.onToggle(o.id);
                      }}
                    >
                      <CheckMark on={on()} />
                      <span class="popover-item-text">
                        <span class="popover-item-label">{o.label}</span>
                        <Show when={o.note}>
                          <span class="popover-item-desc">{o.note}</span>
                        </Show>
                      </span>
                    </div>
                  );
                }}
              </For>
            </Show>
          </>
        )}
      </ActionMenu>
    </span>
  );
}

/** A check row's box: the check when on, an empty box of the same size when off. */
function CheckMark(props: { on: boolean }) {
  return (
    <span class="popover-item-icon" aria-hidden="true">
      <span class="costs-check">
        <Show when={props.on}>
          <Icon name="check" small />
        </Show>
      </span>
    </span>
  );
}

const spendTitle = (s: UsageSpend) => `${tokens(tokenSum(s.tokens))} tokens over ${s.calls} ${s.calls === 1 ? "call" : "calls"}`;

/** Total, and the three ways it was spent. */
function CostStats(props: { answer: UsageCosts }) {
  const stats = (): { label: string; spend: UsageSpend; tip?: string }[] => [
    { label: "Total", spend: props.answer.total },
    { label: "Main sessions", spend: props.answer.main, tip: "Your sessions' own calls, the Overseer's included." },
    { label: "Workers", spend: props.answer.workers },
    { label: "One-shots", spend: props.answer.oneshots, tip: "Single calls made for a session or for Sova: titles, decisions, topic outlines, image descriptions." },
  ];
  return (
    <dl class="costs-stats">
      <For each={stats()}>
        {(s) => (
          <div class="card costs-stat" title={s.tip ? `${s.tip} ${spendTitle(s.spend)}.` : `${spendTitle(s.spend)}.`}>
            <dt class="text-eyebrow">{s.label}</dt>
            <dd class="cost-figure">{usd(s.spend.usd)}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

/** "Oct 4", or "Sep 29 – Oct 5" for a week bar. */
const barWords = (from: string, to: string, now: number) => {
  const at = (k: string) => shortDate(new Date(`${k}T12:00:00`).getTime(), now);
  return from === to ? at(from) : `${at(from)} – ${at(to)}`;
};

/** One bar per day (per week over a long range), the tallest at full height. */
function CostChart(props: { answer: UsageCosts; query: CostsQuery; now: number }) {
  const bars = createMemo(() => costBars(props.answer.daily, props.query.range, props.answer.to || dayKey(new Date(props.now))));
  const weeks = () => bars().some((b) => b.from !== b.to);
  const max = () => Math.max(0, ...bars().map((b) => b.usd));
  return (
    <section class="card costs-card" aria-labelledby="costs-chart">
      <div class="costs-chart-head">
        <h2 class="costs-h2" id="costs-chart">
          {weeks() ? "Cost per week" : "Cost per day"}
        </h2>
        <span class="cost-note">
          Highest <span class="cost-figure">{usd(max())}</span>
        </span>
      </div>
      <ol class="costs-chart" style={{ "--bars": String(bars().length) }}>
        <For each={bars()}>
          {(b) => (
            <li class="costs-bar-slot" title={`${barWords(b.from, b.to, props.now)}: ${usd(b.usd)}`}>
              <span class="costs-bar-fill" style={{ height: `${Math.round(barShare(b, bars()) * 1000) / 10}%` }} />
              <span class="visually-hidden">
                {barWords(b.from, b.to, props.now)}: {usd(b.usd)}
              </span>
            </li>
          )}
        </For>
      </ol>
      <div class="costs-chart-axis cost-note" aria-hidden="true">
        <span>{barWords(bars()[0]!.from, bars()[0]!.from, props.now)}</span>
        <span>{barWords(bars().at(-1)!.to, bars().at(-1)!.to, props.now)}</span>
      </div>
    </section>
  );
}

/** A section card holding one table. */
function TableCard(props: { id: string; title: string; caption: string; class?: string; stack?: boolean; head: JSX.Element; children: JSX.Element }) {
  return (
    <section class={props.class ? `card costs-card ${props.class}` : "card costs-card"} aria-labelledby={props.id}>
      <h2 class="costs-h2" id={props.id}>
        {props.title}
      </h2>
      <div class="md md-table-wrap cost-table-wrap">
        <table class={props.stack ? "cost-table cost-table-stack" : "cost-table"}>
          <caption class="visually-hidden">{props.caption}</caption>
          <thead>
            <tr>{props.head}</tr>
          </thead>
          <tbody>{props.children}</tbody>
        </table>
      </div>
    </section>
  );
}

const Num = (props: { label: string; children: JSX.Element; title?: string }) => (
  <td align="right" data-label={props.label} title={props.title}>
    {props.children}
  </td>
);
const Usd = (props: { n: number }) => <span class="cost-figure">{usd(props.n)}</span>;
/** A sum's cost: "unpriced" when nothing in it has a price; dollars otherwise, its unpriced part in the title. */
function SpendUsd(props: { spend: UsageSpend }) {
  return (
    <Show when={costWord(props.spend) === "usd"} fallback={<span class="cost-unpriced" title="No price on record for these models.">unpriced</span>}>
      <span class="cost-figure" title={props.spend.unpricedTokens > 0 ? `Plus ${tokens(props.spend.unpricedTokens)} tokens with no price.` : undefined}>
        {usd(props.spend.usd)}
      </span>
    </Show>
  );
}
const Tok = (props: { n: number }) => <span class="cost-figure">{tokens(props.n)}</span>;
/** A model's cost cell: unpriced and free say so, in words. */
function ModelUsd(props: { row: UsageModelRow }) {
  return (
    <Show when={props.row.status === "unpriced" || (props.row.status === "free" && props.row.usd === 0)} fallback={<Usd n={props.row.usd} />}>
      <span class="cost-unpriced" title={props.row.why}>
        {props.row.status === "free" ? "free" : "unpriced"}
      </span>
    </Show>
  );
}
const SpendHead = (props: { first: string }) => (
  <>
    <th scope="col">{props.first}</th>
    <th scope="col" align="right">
      Tokens
    </th>
    <th scope="col" align="right">
      Cost
    </th>
  </>
);

function ProviderTable(props: { answer: UsageCosts }) {
  return (
    <TableCard id="costs-providers" title="By provider" caption="Cost by provider" head={<SpendHead first="Provider" />}>
      <For each={byCost(props.answer.byProvider, (r) => r.provider)}>
        {(r) => (
          <tr>
            <th scope="row" title={r.provider}>
              {providerName(r.provider)}
            </th>
            <Num label="Tokens" title={spendTitle(r)}>
              <Tok n={tokenSum(r.tokens)} />
            </Num>
            <Num label="Cost">
              <SpendUsd spend={r} />
            </Num>
          </tr>
        )}
      </For>
    </TableCard>
  );
}

function KindTable(props: { answer: UsageCosts }) {
  return (
    <TableCard id="costs-kinds" title="By kind" caption="Cost by kind" head={<SpendHead first="Kind" />}>
      <For each={kindRows(props.answer.byKind)}>
        {(r) => (
          <tr>
            <th scope="row">{kindName(r.kind)}</th>
            <Num label="Tokens" title={spendTitle(r)}>
              <Tok n={tokenSum(r.tokens)} />
            </Num>
            <Num label="Cost">
              <SpendUsd spend={r} />
            </Num>
          </tr>
        )}
      </For>
    </TableCard>
  );
}

function ModelTable(props: { answer: UsageCosts }) {
  return (
    <TableCard
      id="costs-models"
      title="By model"
      caption="Tokens and cost by model"
      class="costs-wide"
      stack
      head={
        <>
          <th scope="col">Model</th>
          <th scope="col" align="right">
            Input
          </th>
          <th scope="col" align="right">
            Cache
          </th>
          <th scope="col" align="right">
            Output
          </th>
          <th scope="col" align="right">
            Cost
          </th>
        </>
      }
    >
      <For each={byCost(props.answer.byModel, (r) => `${r.provider}/${r.model}${r.asked ? `?asked=${r.asked}` : ""}`)}>
        {(r) => (
          <tr>
            <th
              scope="row"
              title={[r.priceKey && r.priceKey !== `${r.provider}/${r.model}` ? `${r.provider}/${r.model}, priced as ${r.priceKey}` : `${r.provider}/${r.model}`, usageModelNote(r)].filter(Boolean).join(". ")}
            >
              <span class="text-mono">{compactModel(r.model) ?? r.model}{r.asked ? " ⚠" : ""}</span>
              <span class="cost-session-meta">{providerName(r.provider)}</span>
            </th>
            <Num label="Input">
              <Tok n={r.tokens.input} />
            </Num>
            <Num label="Cache" title={`${tokens(r.tokens.cacheRead)} read · ${tokens(r.tokens.cacheWrite)} written`}>
              <Tok n={cacheSum(r.tokens)} />
            </Num>
            <Num label="Output">
              <Tok n={r.tokens.output} />
            </Num>
            <Num label="Cost">
              <ModelUsd row={r} />
            </Num>
          </tr>
        )}
      </For>
    </TableCard>
  );
}

function ProjectTable(props: { answer: UsageCosts; name(id: string): string | undefined }) {
  return (
    <TableCard id="costs-projects" title="By project" caption="Cost by project or folder" class="costs-wide" head={<SpendHead first="Project" />}>
      <For each={byCost(props.answer.byProject, (r) => r.project ?? r.cwd ?? "")}>
        {(r) => (
          <tr>
            <th scope="row" title={r.cwd ?? r.project ?? undefined}>
              {projectName(r, props.name)}
            </th>
            <Num label="Tokens" title={spendTitle(r)}>
              <Tok n={tokenSum(r.tokens)} />
            </Num>
            <Num label="Cost">
              <SpendUsd spend={r} />
            </Num>
          </tr>
        )}
      </For>
    </TableCard>
  );
}

/** The costliest sessions; a click opens the session (a worker's: its parent's). */
function TopSessions(props: { rows: UsageSessionRow[]; sessions: SessionSummary[] | undefined }) {
  const find = (sid: string | null) => (sid ? props.sessions?.find((s) => s.id === sid) : undefined);
  const target = (r: UsageSessionRow) => (r.kind === "worker" && r.parent ? r.parent : r.sid);
  const href = (r: UsageSessionRow) => {
    const s = find(target(r));
    return s ? sessionHref(s.path) : `#/sid/${encodeURIComponent(target(r))}`;
  };
  const name = (r: UsageSessionRow) => {
    if (r.kind === "worker") {
      const parent = find(r.parent)?.title ?? (r.parent ? r.parent.slice(0, 8) : null);
      return `${r.worker ?? "Worker"}${parent ? ` in ${parent}` : ""}`;
    }
    return find(r.sid)?.title ?? r.sid.slice(0, 8);
  };
  return (
    <section class="card costs-card" aria-labelledby="costs-top">
      <h2 class="costs-h2" id="costs-top">
        Top sessions
      </h2>
      <ol class="cost-sessions">
        <For each={props.rows}>
          {(r) => (
            <li class="cost-session">
              <span class="cost-session-main">
                <a href={href(r)}>{name(r)}</a>
                <span class="cost-session-meta">
                  {kindOne(r.kind)}
                  <Show when={r.cwd}>
                    {(cwd) => (
                      <>
                        {" · "}
                        <span class="text-mono">{cwd()}</span>
                      </>
                    )}
                  </Show>
                </span>
              </span>
              <span class="cost-figure" title={spendTitle(r)}>
                {usd(r.usd)}
              </span>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}

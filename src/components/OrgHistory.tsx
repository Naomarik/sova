// The org page's History tab: the coverage line, the filter bar with its
// count, then the timeline (or the Causal View) beside the selected event's detail. Every filter,
// the view and the selection are in the address (lib/org-history-route): a change pushes one history
// entry, so Back restores the previous one, and a reload or a link opens the same view. Nothing here
// acts: it reads, links and copies.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type JSX } from "solid-js";
import { type EventSummary } from "../../shared/org-history";
import type { OrgDetail } from "../../shared/orgs";
import { getHistoryPacket, getOrgHistory } from "../lib/api";
import { clockTime } from "../lib/format";
import { emptyFilters, filtersKey, filtersSet, KIND_GROUP_IDS, queryOf, type HistoryFilters, type HistoryView, type KindGroup } from "../lib/org-history-route";
import { createHistoryList } from "../lib/org-history-source";
import { byDay, countLine, coverageLine, dayLabel, EMPTY_SCOPE, gapSentence, HISTORY_FOOTER, outcomeChip, OUTSIDE_FILTER, projectWords, reasonWords, rowClock, whoLine } from "../lib/org-history-words";
import { orgHistoryHref } from "../lib/orgs-route";
import { historyViewMemos } from "../lib/org-page-route";
import { announce, copyText } from "../lib/ui-state";
import { OrgHistoryChain } from "./OrgHistoryChain";
import { OrgHistoryInspector } from "./OrgHistoryInspector";
import { Banner, Chip, Icon } from "./ui";
import "../org-history.css";

export const KIND_WORDS: Record<KindGroup, string> = {
  requests: "Requests and looks",
  gaps: "Gaps",
  gatherings: "Gatherings",
  decisions: "Decisions and conflicts",
  holds: "Holds, refusals and stops",
  delivery: "Promotions and builds",
  people: "People, projects and settings",
  history: "History notes",
};

const INITIATION_WORDS = { operator: "Operator", overseer: "Overseer", person: "Person", system: "System", unknown: "Not recorded" } as const;

/** Where a filter change goes: one pushed history entry, unless the address is already it. */
const go = (href: string) => {
  if (location.hash !== href) location.hash = href;
};

/** The project ids a reader's filter names, for labelling what lies outside it. */
export const outsideFilter = (e: Pick<EventSummary, "project" | "affected" | "boundary">, projects: readonly string[]): boolean =>
  !!e.boundary || (projects.length > 0 && ![e.project, ...e.affected].some((p) => p && projects.includes(p.id)));

export function OrgHistory(props: { org: OrgDetail; view: HistoryView }) {
  const orgId = props.org.id;
  // Scalars behind equality-gated memos: a re-read of the org or a new route object for the same
  // address changes none of them, so nothing below resets (CLAUDE.md, Method: `on` doesn't gate values).
  const { filtersKey: fKey, filters, selected, chain } = historyViewMemos(() => props.view);
  const list = createHistoryList({ key: fKey, query: () => queryOf(filters()), fetch: (q) => getOrgHistory(orgId, q) });

  const view = (): HistoryView => untrack(() => ({ filters: filters(), ...(selected() ? { event: selected() } : {}), ...(chain() ? { chain: true } : {}) }));
  const hrefWith = (over: Partial<HistoryView>): string => orgHistoryHref(orgId, { ...view(), ...over });
  const setFilters = (f: HistoryFilters) => go(orgHistoryHref(orgId, { filters: f, ...(selected() ? { event: selected() } : {}), ...(chain() ? { chain: true } : {}) }));
  const projects = () => props.org.projectList;

  // Back to History on a narrow pane: the list comes back where it was, the row that was open focused.
  let root: HTMLElement | undefined;
  let scrollAt: number | null = null;
  const scroller = (): HTMLElement | null => {
    for (let el = root?.parentElement ?? null; el; el = el.parentElement) {
      const o = getComputedStyle(el).overflowY;
      if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement as HTMLElement | null;
  };
  const rememberScroll = () => (scrollAt = scroller()?.scrollTop ?? null);
  createEffect(
    on(
      selected,
      (now, before) => {
        if (now || !before) return;
        queueMicrotask(() => {
          const s = scroller();
          if (s && scrollAt !== null) s.scrollTop = scrollAt;
          root?.querySelector<HTMLElement>(`[data-event="${CSS.escape(before)}"]`)?.focus({ preventScroll: true });
        });
      },
      { defer: true },
    ),
  );

  // Say the count once it settles on new filters (the polite region; the bar shows it too).
  createEffect(
    on(
      () => [fKey(), list.loading()] as const,
      ([, loading], prev) => {
        if (loading || !prev || list.total() === null) return;
        announce(list.total() ? countLine(list.items().length, list.total()!) : EMPTY_SCOPE);
      },
      { defer: true },
    ),
  );

  const copyQueryContext = async () => {
    try {
      const p = await getHistoryPacket(orgId, { query: queryOf(filters()) });
      await copyText(p.text, `Copied the context of ${p.events.length} ${p.events.length === 1 ? "event" : "events"}.`);
    } catch (err) {
      announce(`Couldn't make the context: ${(err as Error).message}`);
    }
  };

  return (
    <section class="orghist" ref={root} aria-labelledby="orghist-title" data-selected={selected() ? "" : undefined} data-chain={chain() ? "" : undefined}>
      <div class="orghist-head">
        <div class="orghist-titles">
          <h2 class="orgs-h2" id="orghist-title">
            History
          </h2>
          <Show when={coverageLine(list.coverage())}>{(line) => <p class="orghist-coverage">{line()}</p>}</Show>
        </div>
        <div class="orghist-views" role="group" aria-label="View">
          <a class="orghist-view" href={hrefWith({ chain: undefined })} aria-current={!chain() ? "page" : undefined}>
            Timeline
          </a>
          <Show
            when={selected()}
            fallback={
              <span class="orghist-view" aria-disabled="true" title="Select an event first: the Causal View is one event's chain.">
                Causal View
              </span>
            }
          >
            <a class="orghist-view" href={hrefWith({ chain: true })} aria-current={chain() ? "page" : undefined}>
              Causal View
            </a>
          </Show>
        </div>
      </div>
      <For each={list.coverage()?.gaps ?? []}>{(g) => <Banner tone="warn" title={gapSentence(g)} />}</For>
      <Show when={list.coverage()?.savingSince}>
        {(since) => <Banner tone="error" title={`History can't be saved right now (since ${clockTime(since())}).`} body="Ordinary acts are refused until it can. Stops and cancels still go, and are noted as a gap." />}
      </Show>
      <Show when={list.coverage()?.problems.length}>
        {(n) => <Banner tone="warn" title={`${n()} history ${n() === 1 ? "line" : "lines"} can't be read by this version.`} body="They are kept as they are; the rest of the history reads." />}
      </Show>
      <Show when={list.freshness() && !list.freshness()!.current}>
        <Banner tone="info" title="The index is catching up with the event files: the newest events may not show yet." />
      </Show>

      <FilterBar org={props.org} filters={filters()} total={list.total()} shown={list.items().length} linkedOutside={list.linkedOutside()} onChange={setFilters} onCopyContext={() => void copyQueryContext()} />

      <div class="orghist-split">
        <div class="orghist-main">
          <Show when={chain() && selected()} fallback={<Timeline orgId={orgId} list={list} filters={filters()} selected={selected()} hrefWith={hrefWith} onOpen={rememberScroll} />}>
            {(id) => <OrgHistoryChain orgId={orgId} root={id()} filters={filters()} hrefWith={hrefWith} />}
          </Show>
        </div>
        <Show when={selected()} keyed>
          {(id) => (
            <aside class="orghist-inspector" aria-label="Event detail">
              <a class="button button-ghost orghist-back" href={hrefWith({ event: undefined, chain: undefined })}>
                <Icon name="chevron-left" small />
                Back to History
              </a>
              <OrgHistoryInspector org={props.org} eventId={id} filters={filters()} hrefWith={hrefWith} chain={chain()} />
            </aside>
          )}
        </Show>
      </div>
      {/* Where it lives and what a purge can't reach. */}
      <p class="orghist-caption orghist-foot">
        {HISTORY_FOOTER}
      </p>
    </section>
  );
}

// ---- the filter bar --------------------------------------------------------------------------------

function FilterBar(props: { org: OrgDetail; filters: HistoryFilters; total: number | null; shown: number; linkedOutside?: number; onChange(f: HistoryFilters): void; onCopyContext(): void }) {
  const f = () => props.filters;
  const set = (over: Partial<HistoryFilters>) => {
    const next: HistoryFilters = { ...f(), ...over };
    for (const k of Object.keys(next) as (keyof HistoryFilters)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    props.onChange(next);
  };
  const [q, setQ] = createSignal(f().q ?? "");
  const moreSet = () => (f().actor ? 1 : 0) + (f().from || f().to ? 1 : 0);
  // The address is the truth: Back or a link to other words puts them in the field.
  createEffect(on(() => f().q ?? "", (v) => setQ(v), { defer: true }));
  const actors = createMemo(() => [
    { key: "operator", label: "Operator" },
    { key: "global-overseer", label: "Overseer" },
    ...props.org.projectList.map((p) => ({ key: `project-overseer:${p.id}`, label: `${p.name}'s overseer` })),
    ...props.org.roster.map((p) => ({ key: `person:${p.id}`, label: p.name })),
    { key: "model", label: "A model" },
    { key: "sova", label: "Sova" },
    { key: "system", label: "System" },
  ]);
  return (
    <form
      class="orghist-bar"
      role="search"
      aria-label="Filter history"
      onSubmit={(e) => {
        e.preventDefault();
        set({ q: q().trim() || undefined });
      }}
    >
      <div class="orghist-filters">
        <label class="orghist-search">
          <span class="visually-hidden">Search History</span>
          <Icon name="search" small />
          <input class="input" type="search" placeholder="Search History" value={q()} maxLength={200} onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
        <button type="submit" class="button">
          Search
        </button>
        <ProjectPicker org={props.org} selected={f().projects} onPick={(projects) => set({ projects })} />
        <Select label="Kind" value={f().kind ?? ""} on={!!f().kind} onPick={(v) => set({ kind: (v || undefined) as KindGroup | undefined })}>
          <option value="">All</option>
          <For each={KIND_GROUP_IDS}>{(k) => <option value={k}>{KIND_WORDS[k]}</option>}</For>
        </Select>
        <Select label="Initiation" value={f().initiation ?? ""} on={!!f().initiation} onPick={(v) => set({ initiation: (v || undefined) as HistoryFilters["initiation"] })}>
          <option value="">All</option>
          <For each={Object.entries(INITIATION_WORDS)}>{([k, w]) => <option value={k}>{w}</option>}</For>
        </Select>
        {/* More Filters: who and when, behind one disclosure; open while any of them is set. */}
        <details class="orghist-more-filters" open={moreSet() > 0}>
          <summary class="orghist-pick-button" classList={{ "orghist-filter-on": moreSet() > 0 }}>
            More Filters
            <Show when={moreSet()}>{(n) => <span class="orghist-pick-value">{n()} set</span>}</Show>
            <Icon name="chevron-down" small />
          </summary>
          <div class="orghist-more-panel">
            <Select label="Actor" value={f().actor ?? ""} on={!!f().actor} onPick={(v) => set({ actor: v || undefined })}>
              <option value="">Anyone</option>
              <For each={actors()}>{(a) => <option value={a.key}>{a.label}</option>}</For>
            </Select>
            <label class="orghist-date" classList={{ "orghist-filter-on": !!f().from }}>
              <span class="orghist-filter-label">From</span>
              <input class="input" type="date" value={f().from ?? ""} max={f().to} onChange={(e) => set({ from: e.currentTarget.value || undefined })} />
            </label>
            <label class="orghist-date" classList={{ "orghist-filter-on": !!f().to }}>
              <span class="orghist-filter-label">To</span>
              <input class="input" type="date" value={f().to ?? ""} min={f().from} onChange={(e) => set({ to: e.currentTarget.value || undefined })} />
            </label>
          </div>
        </details>
        <Show when={filtersSet(f())}>
          <button type="button" class="button button-ghost" onClick={() => props.onChange(emptyFilters())}>
            Clear Filters
          </button>
        </Show>
      </div>
      <div class="orghist-bar-end">
        <p class="orghist-count" aria-live="off">
          <Show when={props.total !== null} fallback="Reading…">
            {props.total ? countLine(props.shown, props.total!, props.filters.projects.length ? props.linkedOutside : undefined) : EMPTY_SCOPE}
          </Show>
        </p>
        <button type="button" class="button button-ghost" disabled={!props.total} onClick={() => props.onCopyContext()} title="Copies the context packet of these filters.">
          Copy Context
        </button>
      </div>
    </form>
  );
}

function Select(props: { label: string; value: string; on: boolean; onPick(v: string): void; children: JSX.Element }) {
  return (
    <label class="orghist-select" classList={{ "orghist-filter-on": props.on }}>
      <span class="orghist-filter-label">{props.label}</span>
      <span class="select-wrap">
        <select class="select" value={props.value} onChange={(e) => props.onPick(e.currentTarget.value)}>
          {props.children}
        </select>
        <span class="select-caret" aria-hidden="true">
          <Icon name="chevron-down" small />
        </span>
      </span>
    </label>
  );
}

/** Project: All projects, or any of them (archived ones labelled), picked as a set and applied once,
    so a set of three ticks is one history entry, not three. */
function ProjectPicker(props: { org: OrgDetail; selected: string[]; onPick(projects: string[]): void }) {
  const [open, setOpen] = createSignal(false);
  const [draft, setDraft] = createSignal<string[]>([]);
  let details: HTMLDetailsElement | undefined;
  const name = (id: string) => props.org.projectList.find((p) => p.id === id)?.name ?? "A removed project";
  const value = () => (props.selected.length === 0 ? "All projects" : props.selected.length === 1 ? name(props.selected[0]!) : `${props.selected.length} projects`);
  const close = () => {
    setOpen(false);
    if (details) details.open = false;
  };
  const onDoc = (e: MouseEvent) => {
    if (open() && details && !details.contains(e.target as Node)) close();
  };
  document.addEventListener("click", onDoc);
  onCleanup(() => document.removeEventListener("click", onDoc));
  const sorted = createMemo(() => [...props.org.projectList].sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || a.name.localeCompare(b.name)));
  return (
    <details
      class="orghist-pick"
      ref={details}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (e.currentTarget.open) setDraft([...props.selected]);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open()) {
          e.preventDefault();
          close();
          details?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary class="orghist-pick-button" classList={{ "orghist-filter-on": props.selected.length > 0 }}>
        Project <span class="orghist-pick-value">{value()}</span>
        <Icon name="chevron-down" small />
      </summary>
      <div class="orghist-pick-panel" role="group" aria-label="Projects to show">
        <button
          type="button"
          class="popover-item"
          aria-pressed={draft().length === 0 ? "true" : "false"}
          onClick={() => {
            props.onPick([]);
            close();
          }}
        >
          <Icon name="check" small class="popover-item-check" />
          All projects
        </button>
        <div class="popover-sep" role="separator" />
        <For each={sorted()} fallback={<p class="orgs-empty orghist-pick-empty">This organization has no projects yet.</p>}>
          {(p) => (
            <label class="toggle orghist-pick-row">
              <input
                type="checkbox"
                checked={draft().includes(p.id)}
                onChange={(e) => setDraft((cur) => (e.currentTarget.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
              />
              <span class="toggle-box" />
              <span class="orghist-pick-name">{p.name}</span>
              <Show when={p.archived}>
                <Chip>Archived</Chip>
              </Show>
            </label>
          )}
        </For>
        <div class="button-row orghist-pick-foot">
          <button
            type="button"
            class="button button-primary"
            onClick={() => {
              props.onPick(props.org.projectList.map((p) => p.id).filter((id) => draft().includes(id)));
              close();
            }}
          >
            Show {draft().length === 0 ? "All Projects" : draft().length === 1 ? "1 Project" : `${draft().length} Projects`}
          </button>
          <button type="button" class="button button-ghost" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </details>
  );
}

// ---- the timeline ----------------------------------------------------------------------------------

function Timeline(props: {
  orgId: string;
  list: ReturnType<typeof createHistoryList>;
  filters: HistoryFilters;
  selected?: string;
  hrefWith(over: Partial<HistoryView>): string;
  onOpen(): void;
}) {
  const groups = createMemo(() => byDay(props.list.items()));
  const remaining = () => (props.list.total() ?? 0) - props.list.items().length;
  return (
    <div class="orghist-timeline">
      <Show when={props.list.error()}>
        {(e) => <Banner tone="error" title="Couldn't read the history." body={`${e()} The rows below are from the last read.`} action={<button type="button" class="button button-sm" onClick={() => props.list.refetch()}>Retry</button>} />}
      </Show>
      <Show when={!props.list.loading()} fallback={<div class="skeleton skeleton-row" aria-label="Reading the history" />}>
        <Show when={props.list.items().length} fallback={<p class="orgs-empty orghist-empty">{EMPTY_SCOPE}. Events show here as they are recorded; nothing before capture started is in it unless imported.</p>}>
          <For each={groups()}>
            {(g) => (
              <section class="orghist-day" aria-label={dayLabel(g.at)}>
                <h3 class="list-group-label orghist-day-label">{dayLabel(g.at)}</h3>
                <ol class="orghist-rows">
                  <For each={g.rows}>{(e) => <Row orgId={props.orgId} event={e} filters={props.filters} selected={props.selected === e.id} href={props.hrefWith({ event: e.id })} hrefWith={props.hrefWith} onOpen={props.onOpen} />}</For>
                </ol>
              </section>
            )}
          </For>
          <Show when={props.list.hasMore()}>
            <div class="orghist-more">
              <button type="button" class="button" aria-busy={props.list.loadingMore() ? "true" : undefined} onClick={() => props.list.showMore()}>
                Show More
              </button>
              <span class="orghist-more-note">{remaining() > 0 ? `${remaining().toLocaleString("en-US")} more not loaded yet` : "More not loaded yet"}</span>
              <Show when={props.list.moreError()}>{(e) => <p class="field-error">Couldn't read more: {e()}</p>}</Show>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function Row(props: { orgId: string; event: EventSummary; filters: HistoryFilters; selected: boolean; href: string; hrefWith(over: Partial<HistoryView>): string; onOpen(): void }) {
  const e = () => props.event;
  const chip = () => outcomeChip(e().outcome);
  const reason = () => reasonWords(e());
  const outside = () => outsideFilter(e(), props.filters.projects);
  return (
    <li class="orghist-row-item">
      <a class="orghist-row" classList={{ "orghist-row-selected": props.selected, "orghist-row-boundary": outside() }} href={props.href} aria-current={props.selected ? "true" : undefined} data-event={e().id} onClick={() => props.onOpen()}>
        <span class="orghist-time">{rowClock(e())}</span>
        <span class="orghist-marker" aria-hidden="true" />
        <span class="orghist-row-main">
          <span class="orghist-row-top">
            <span class="orghist-headline">{e().headline}</span>
            <Chip tone={chip().tone}>{chip().word}</Chip>
            <Show when={e().superseded}>
              <Chip tone="warn">Superseded</Chip>
            </Show>
          </span>
          <span class="orghist-row-meta">
            <span class="orghist-project">{projectWords(e())}</span>
            <Show when={outside()}>
              <span class="orghist-outside"> · {OUTSIDE_FILTER}</span>
            </Show>
            <Show when={e().origin === "imported"}> · Imported</Show>
            {" · "}
            {whoLine(e())}
          </span>
          <Show when={e().reasonState !== "not-recorded" || e().kind === "decision.recorded"}>
            <span class="orghist-reason" classList={{ "orghist-muted": reason().muted }}>
              {reason().text}
            </span>
          </Show>
        </span>
      </a>
      <Show when={e().group?.count}>{(n) => <GroupDetails orgId={props.orgId} eventId={e().id} count={n()} hrefWith={props.hrefWith} />}</Show>
    </li>
  );
}

/** Show Details: the lower-level events grouped under a row by recorded links (the server's
    `groupOf` read), read when opened. Its open state lives in the row, which a re-read keeps. */
function GroupDetails(props: { orgId: string; eventId: string; count: number; hrefWith(over: Partial<HistoryView>): string }) {
  const [open, setOpen] = createSignal(false);
  const [rows, setRows] = createSignal<EventSummary[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const id = `orghist-group-${props.eventId}`;
  const toggle = async () => {
    if (open()) return setOpen(false);
    setOpen(true);
    setBusy(true);
    try {
      setRows((await getOrgHistory(props.orgId, { groupOf: props.eventId })).items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="orghist-group">
      <button type="button" class="button button-ghost orghist-group-toggle" aria-expanded={open() ? "true" : "false"} aria-controls={id} aria-busy={busy() ? "true" : undefined} onClick={() => void toggle()}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} small />
        {open() ? "Hide Details" : `Show Details · ${props.count}`}
      </button>
      <Show when={open()}>
        <div id={id}>
          <Show when={error()}>{(e) => <p class="field-error">Couldn't read the details: {e()}</p>}</Show>
          <Show when={rows()}>
            {(r) => (
              <ol class="orghist-group-rows">
                <For each={r()} fallback={<li class="orghist-muted">{EMPTY_SCOPE}</li>}>
                  {(g) => (
                    <li>
                      <a class="orghist-group-row" href={props.hrefWith({ event: g.id, chain: undefined })}>
                        <span class="orghist-mono">{rowClock(g)}</span> {g.headline} <span class="orghist-muted">· {outcomeChip(g.outcome).word}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ol>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

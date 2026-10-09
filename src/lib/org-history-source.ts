// The History tab's list: the first page of the filters in force, more pages
// on Show More, and a background re-read while the browser tab shows. The filters arrive as one
// scalar key (lib/org-history-route `filtersKey`) behind an equality-gated memo, so a re-read of the
// org page, a new route object for the same address, or selecting an event never resets the list:
// only a different filter does. Each re-read is reconciled by id, so rows keep their identity and
// focus, scroll and open disclosures stay. Counts are the server's, never worked out here.
import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { EventSummary, HistoryChain, HistoryCoverage, HistoryPage, HistoryQuery, IndexFreshness } from "../../shared/org-history";
import { mergeChain } from "./org-history-chain";

export const HISTORY_POLL_MS = 10_000;

export interface HistoryList {
  items: Accessor<EventSummary[]>;
  /** The server's count of matching events this reader may see; null until the first answer. */
  total: Accessor<number | null>;
  coverage: Accessor<HistoryCoverage | undefined>;
  /** The server's count of linked events outside the project filter, when it gives one. */
  linkedOutside: Accessor<number | undefined>;
  freshness: Accessor<IndexFreshness | undefined>;
  /** More pages wait behind the cursor. */
  hasMore: Accessor<boolean>;
  /** The first page of these filters hasn't answered yet. */
  loading: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  /** The latest failure (the rows already shown stay), cleared by the next success. */
  error: Accessor<string | null>;
  moreError: Accessor<string | null>;
  showMore(): void;
  refetch(): void;
}

/** The rows of `fresh` (the re-read first page) followed by every row already loaded past it. */
export function mergeFirstPage(loaded: readonly EventSummary[], fresh: readonly EventSummary[], pages: number): EventSummary[] {
  if (pages <= 1) return [...fresh];
  const ids = new Set(fresh.map((e) => e.id));
  return [...fresh, ...loaded.filter((e) => !ids.has(e.id))];
}

/** The rows of the next page appended, none twice. */
export function appendPage(loaded: readonly EventSummary[], next: readonly EventSummary[]): EventSummary[] {
  const ids = new Set(loaded.map((e) => e.id));
  return [...loaded, ...next.filter((e) => !ids.has(e.id))];
}

export function createHistoryList(opts: {
  /** One string per filter set: the list starts over only when it changes. */
  key: Accessor<string>;
  query: () => HistoryQuery;
  fetch: (q: HistoryQuery) => Promise<HistoryPage>;
  intervalMs?: number;
}): HistoryList {
  const key = createMemo(opts.key);
  const [store, setStore] = createStore<{ items: EventSummary[] }>({ items: [] });
  const [total, setTotal] = createSignal<number | null>(null);
  const [coverage, setCoverage] = createSignal<HistoryCoverage>();
  const [linkedOutside, setLinkedOutside] = createSignal<number>();
  const [freshness, setFreshness] = createSignal<IndexFreshness>();
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [moreError, setMoreError] = createSignal<string | null>(null);
  const interval = opts.intervalMs ?? HISTORY_POLL_MS;
  let pages = 0;
  /** Bumped by a filter change: an answer for older filters is dropped. */
  let gen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(() => void first(false), interval);
  };
  const adopt = (page: HistoryPage) => {
    setTotal(page.total);
    setCoverage(page.coverage);
    setLinkedOutside(page.linkedOutside);
    setFreshness(page.freshness);
  };

  /** The first page: `reset` for new filters, else a background re-read that keeps what's loaded. */
  const first = async (reset: boolean) => {
    clearTimeout(timer);
    const mine = reset ? ++gen : gen;
    const q = untrack(opts.query);
    try {
      const page = await opts.fetch(q);
      if (mine !== gen || stopped) return;
      setStore("items", reconcile(reset ? page.items : mergeFirstPage(store.items, page.items, pages), { key: "id" }));
      if (reset || pages <= 1) {
        pages = 1;
        setCursor(page.cursor);
      }
      adopt(page);
      setError(null);
    } catch (err) {
      if (mine !== gen || stopped) return;
      setError((err as Error).message);
    }
    setLoading(false);
    schedule();
  };

  createEffect(
    on(key, () => {
      setLoading(true);
      setMoreError(null);
      setStore("items", []);
      setTotal(null);
      setCursor(null);
      pages = 0;
      void first(true);
    }),
  );

  const onVisibility = () => {
    if (document.hidden) clearTimeout(timer);
    else void first(false);
  };
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  return {
    items: () => store.items,
    total,
    coverage,
    linkedOutside,
    freshness,
    hasMore: () => cursor() !== null,
    loading,
    loadingMore,
    error,
    moreError,
    showMore() {
      const c = cursor();
      if (!c || loadingMore()) return;
      const mine = gen;
      setLoadingMore(true);
      opts
        .fetch({ ...untrack(opts.query), cursor: c })
        .then((page) => {
          if (mine !== gen || stopped) return;
          setStore("items", reconcile(appendPage(store.items, page.items), { key: "id" }));
          pages++;
          setCursor(page.cursor);
          adopt(page);
          setMoreError(null);
        })
        .catch((err: Error) => {
          if (mine === gen && !stopped) setMoreError(err.message);
        })
        .finally(() => {
          if (mine === gen) setLoadingMore(false);
        });
    },
    refetch() {
      void first(false);
    },
  };
}

export interface HistoryChainRead {
  /** The chain of the event in force; null until its first answer. */
  chain: Accessor<HistoryChain | null>;
  error: Accessor<string | null>;
  busy: Accessor<boolean>;
  /** Read again from the start, or from `cursor` to go further (merged into what's shown). */
  read(cursor?: string): void;
}

/**
 * The Causal View's chain. The view stays mounted while the address moves from one event's chain to
 * another's (a chain card's link, Back, Forward), so it is read again whenever the event or the project
 * filter (the boundary is marked against it) changes; an answer for an earlier event or filter is dropped.
 * `more` is how many further pages the address asks for (Expand adds one): the chain is read that far, so
 * Back, Forward and a reload show it as expanded as it was; fewer than are shown reads it again from the start.
 */
export function createHistoryChain(opts: {
  root: Accessor<string>;
  projects: Accessor<string[]>;
  more?: Accessor<number>;
  fetch: (root: string, projects: string[], cursor?: string) => Promise<HistoryChain>;
}): HistoryChainRead {
  const key = createMemo(() => `${opts.root()}?${opts.projects().join(",")}`);
  const more = createMemo(() => opts.more?.() ?? 0);
  const [chain, setChain] = createSignal<HistoryChain | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  /** Bumped by a new event or filter: an answer for older ones is dropped. */
  let gen = 0;
  /** Further pages merged into the chain shown, and whether a read of this generation is out. */
  let loaded = 0;
  let out = false;
  let stopped = false;
  onCleanup(() => (stopped = true));
  /** One page further, while the address asks for more than is shown. */
  const pump = () => {
    const c = untrack(chain);
    if (!out && c?.cursor && loaded < untrack(more)) read(c.cursor);
  };
  const read = (cursor?: string) => {
    const mine = gen;
    out = true;
    setBusy(true);
    untrack(() => opts.fetch(opts.root(), opts.projects(), cursor))
      .then((c) => {
        if (mine !== gen || stopped) return;
        out = false;
        loaded = cursor ? loaded + 1 : 0;
        setChain((cur) => (cursor && cur ? mergeChain(cur, c) : c));
        setError(null);
        pump();
      })
      .catch((err: Error) => {
        if (mine !== gen || stopped) return;
        out = false;
        setError(err.message);
      })
      .finally(() => {
        if (mine === gen && !out) setBusy(false);
      });
  };
  createEffect(
    on([key, more], ([k, n], prev) => {
      // the same chain asked to go further: on from what is shown
      if (prev && prev[0] === k && n >= loaded) return pump();
      gen++;
      loaded = 0;
      out = false;
      setChain(null);
      setError(null);
      read();
    }),
  );
  return { chain, error, busy, read };
}

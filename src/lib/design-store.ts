import { createEffect, createRoot, createSignal, on, onCleanup, type Accessor, type Signal } from "solid-js";
import type { DesignChatView, DesignRecord } from "../../shared/design";
import { designApi, type DesignApi } from "./design-api";
import { socketReconnects } from "./socket";

/** A page being written, as far as this browser has it. */
export interface DesignLive {
  version: number;
  text: string;
}

/** What the chat socket carries for designs (on the wire as SovaEvents). */
export type DesignEvent = { type: "design.live"; label: string; version: number; at: number; text: string; chars?: number } | { type: "design.state"; state: DesignChatView };

export const isDesignEvent = (e: unknown): e is DesignEvent => !!e && typeof e === "object" && ((e as { type?: unknown }).type === "design.live" || (e as { type?: unknown }).type === "design.state");

export interface DesignStore {
  api: DesignApi;
  view: Accessor<DesignChatView | null>;
  error: Accessor<string | null>;
  live(label: string): DesignLive | null;
  refresh(): void;
}

interface Entry {
  store: DesignStore;
  apply(event: DesignEvent): void;
  refs: number;
  dispose(): void;
}

const entries = new Map<string, Entry>();

/** How often a page with something running checks, if no chat socket tells it. */
const FALLBACK_POLL_MS = 4000;
const COALESCE_MS = 150;
/** Finished pages kept in the browser, newest last. */
const PAGE_CACHE = 48;

const active = (view: DesignChatView | null) =>
  !!view && (view.designs.some((d) => d.status === "queued" || d.status === "writing" || d.status === "fixing") || view.runs.some((r) => r.phase === "researching" || r.phase === "brief" || r.phase === "generating") || view.coordinator?.status === "running" || view.coordinator?.status === "starting");

function make(path: string, host: string | null): Entry {
  return createRoot((dispose) => {
    const api = designApi(path, host);
    const [view, setView] = createSignal<DesignChatView | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const pages = new Map<string, Signal<DesignLive | null>>();
    const pageOf = (label: string) => {
      let s = pages.get(label);
      if (!s) pages.set(label, (s = createSignal<DesignLive | null>(null, { equals: false })));
      return s;
    };

    let run = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let lastEvent = 0;
    const syncing = new Set<string>();

    const resync = (label: string) => {
      if (syncing.has(label)) return;
      syncing.add(label);
      void api
        .live(label)
        .then((got) => {
          if (got) pageOf(label)[1](got);
        })
        .catch(() => {})
        .finally(() => syncing.delete(label));
    };

    const load = async () => {
      const mine = ++run;
      try {
        const next = await api.view();
        if (mine !== run) return;
        setView(next);
        setError(null);
        // A page already being written when this browser arrived: fetch what's there.
        for (const d of next.designs) if (d.live && pageOf(d.label)[0]()?.version !== d.live.version) resync(d.label);
      } catch (e) {
        if (mine === run) setError(e instanceof Error ? e.message : "Designs couldn't be loaded.");
      }
      schedule();
    };
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), COALESCE_MS);
    };
    const schedule = () => {
      clearTimeout(poll);
      if (active(view())) poll = setTimeout(() => (Date.now() - lastEvent >= FALLBACK_POLL_MS ? void load() : schedule()), FALLBACK_POLL_MS);
    };

    const apply = (event: DesignEvent) => {
      lastEvent = Date.now();
      if (event.type === "design.state") {
        run++;
        setView(event.state);
        setError(null);
        return schedule();
      }
      const [page, setPage] = pageOf(event.label);
      const held = page();
      if (event.at === 0 && (!held || held.version !== event.version || held.text.length === 0)) setPage({ version: event.version, text: event.text });
      else if (held?.version === event.version && held.text.length === event.at) setPage({ version: event.version, text: held.text + event.text });
      else resync(event.label);
    };

    // A reconnect may have lost updates; a restarted server may hold new state.
    createEffect(on(socketReconnects, refresh, { defer: true }));

    onCleanup(() => {
      run++;
      clearTimeout(timer);
      clearTimeout(poll);
    });
    void load();

    const store: DesignStore = { api, view, error, live: (label) => pageOf(label)[0](), refresh };
    return { store, apply, refs: 0, dispose };
  });
}

/** The chat's designs, for as long as a component wants them: one store per chat, however many cards. */
export function useDesignStore(path: string, host: string | null): DesignStore {
  const key = `${host ?? ""}|${path}`;
  let entry = entries.get(key);
  if (!entry) entries.set(key, (entry = make(path, host)));
  entry.refs++;
  const held = entry;
  onCleanup(() => {
    if (--held.refs > 0) return;
    entries.delete(key);
    held.dispose();
  });
  return held.store;
}

/** The chat socket's way in. A chat nobody is drawing has no store, and its next read fetches the state. */
export function designEvent(path: string, host: string | null, event: DesignEvent): void {
  entries.get(`${host ?? ""}|${path}`)?.apply(event);
}

const pageCache = new Map<string, Promise<string>>();

/**
 * A finished page's text for drawing, its pictures put in at the size the box wants (a grid card's
 * small, an open design's full). Fetched once per browser while it is wanted; a failed fetch is
 * forgotten, so it can retry.
 */
export function designPageText(store: DesignStore, cacheKey: string, label: string, version: number, images: "small" | "full"): Promise<string> {
  const key = `${cacheKey}|${label}|${version}|${images}`;
  const held = pageCache.get(key);
  if (held) {
    pageCache.delete(key);
    pageCache.set(key, held);
    return held;
  }
  const fetched = store.api.page(label, version, images);
  fetched.catch(() => pageCache.delete(key));
  pageCache.set(key, fetched);
  while (pageCache.size > PAGE_CACHE) pageCache.delete(pageCache.keys().next().value!);
  return fetched;
}

/** A model's display name from the Setup card's rows, else the last part of its ref. */
export function designModelName(view: DesignChatView | null, ref: string): string {
  for (const run of view?.runs ?? []) {
    const m = run.setup.models.find((x) => x.ref === ref);
    if (m?.name) return m.name;
  }
  return ref.split("/").pop() ?? ref;
}

export const designsOfRun = (view: DesignChatView | null, runId: string, labels: readonly string[]): DesignRecord[] => {
  const all = view?.designs.filter((d) => d.runId === runId) ?? [];
  const at = new Map(labels.map((l, i) => [l, i]));
  return all.sort((a, b) => (at.get(a.label) ?? 1e6) - (at.get(b.label) ?? 1e6) || a.createdAt.localeCompare(b.createdAt));
};

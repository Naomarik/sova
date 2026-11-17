import { createEffect, createRoot, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { PLAYBOOK_RUN_EVENT, type PlaybookCardEdits, type PlaybookRunView } from "../../shared/playbook-run";
import { ApiError, playbookRunsApi } from "./api";
import { withoutOtherDrafts, type HeldBy } from "./playbook-card";
import { socketReconnects } from "./socket";
import { normalizeRunView } from "./playbook-run-view";

/**
 * A chat's playbook runs, as its docked cards show them: the drafts it opened, the runs started from
 * it and the run it conducts. One store per chat however many cards read it; the chat socket's
 * `playbook.run` events keep it current, and a reconnect reads the list again.
 */
export interface PlaybookRunsStore {
  runs: Accessor<PlaybookRunView[]>;
  error: Accessor<string | null>;
  /** The run that holds this chat, as the server last said (a put-away one included); null: none. */
  holding: Accessor<HeldBy | null>;
  /** A newer view of one run (an answer or an event). An older revision never replaces a newer one. */
  put(run: PlaybookRunView): void;
  /** Opens (or finds) this chat's draft for a playbook; the words typed after its command go with it.
      The chat's other drafts give way to it: a chat shows one card. */
  open(playbook: Pick<PlaybookRunView["playbook"], "source" | "id">, text?: string): Promise<PlaybookRunView>;
  edit(id: string, revision: number, edits: PlaybookCardEdits): Promise<PlaybookRunView>;
  start(id: string, revision: number): Promise<PlaybookRunView>;
  saveDefaults(id: string, revision: number): Promise<void>;
  /** Closes a draft's card, or puts a started run's card away: either leaves the chat's cards. */
  close(id: string): Promise<void>;
  /** One run by its id, in the chat's cards or not: a started run that was put away, as its record. */
  record(id: string): Promise<PlaybookRunView>;
  refresh(): void;
}

export const isPlaybookRunEvent = (e: unknown): e is { type: typeof PLAYBOOK_RUN_EVENT; run: PlaybookRunView } =>
  !!e && typeof e === "object" && (e as { type?: unknown }).type === PLAYBOOK_RUN_EVENT && !!(e as { run?: unknown }).run;

/** Drafts first (newest opened on top), then started runs, newest start first. */
const order = (a: PlaybookRunView, b: PlaybookRunView) => (a.started ? 1 : 0) - (b.started ? 1 : 0) || (b.started?.at ?? "").localeCompare(a.started?.at ?? "");

/** Keeps the newer of two views of one run. */
export function newer(prev: PlaybookRunView | undefined, next: PlaybookRunView): PlaybookRunView {
  if (!prev) return next;
  if (next.revision < prev.revision) return prev;
  // A started run's record outranks a draft view of the same revision that arrives late.
  if (next.revision === prev.revision && prev.state !== "draft" && next.state === "draft") return prev;
  return next;
}

interface Entry {
  store: PlaybookRunsStore;
  refs: number;
  dispose(): void;
}
const entries = new Map<string, Entry>();

function make(path: string, cwd: () => string | null, host: string | null): Entry {
  return createRoot((dispose) => {
    const api = playbookRunsApi(host);
    const [runs, setRuns] = createSignal<PlaybookRunView[]>([]);
    const [error, setError] = createSignal<string | null>(null);
    const [holding, setHolding] = createSignal<HeldBy | null>(null);
    /** Every view comes in whole, an older run's included (its missing lists read as empty). */
    const whole = normalizeRunView;
    const put = (raw: PlaybookRunView) => {
      const run = whole(raw);
      setRuns((list) => {
        // A closed draft's news: its card goes away.
        if (run.closed) return list.filter((r) => r.id !== run.id);
        const i = list.findIndex((r) => r.id === run.id);
        if (i < 0) return [run, ...list].sort(order);
        const kept = newer(list[i], run);
        if (kept === list[i]) return list;
        const next = list.slice();
        next[i] = kept;
        return next;
      });
      return run;
    };
    const drop = (id: string) => setRuns((list) => list.filter((r) => r.id !== id));
    /** A refusal that carries the run as the server now holds it (a stale revision): take that view. */
    const keepRun = (err: unknown) => {
      const run = err instanceof ApiError ? (err.body as { run?: PlaybookRunView } | undefined)?.run : undefined;
      if (run) put(run);
      throw err;
    };
    let reads = 0;
    const load = async () => {
      const mine = ++reads;
      try {
        const got = await api.list(path);
        if (mine !== reads) return;
        setRuns((list) => got.runs.map((r) => newer(list.find((x) => x.id === r.id), whole(r))).sort(order));
        setHolding(got.holding ?? null);
        setError(null);
      } catch (e) {
        if (mine === reads) setError(e instanceof Error ? e.message : "Playbook runs couldn't be loaded.");
      }
    };
    createEffect(on(socketReconnects, () => void load(), { defer: true }));
    onCleanup(() => reads++);
    void load();
    const store: PlaybookRunsStore = {
      runs,
      error,
      holding,
      put,
      open: async (playbook, text) => {
        const run = put(await api.open({ playbook: { source: playbook.source, id: playbook.id }, cwd: cwd() ?? "", path, ...(text ? { text } : {}) }));
        setRuns((list) => withoutOtherDrafts(list, run.id));
        return run;
      },
      edit: (id, revision, edits) => api.edit(id, revision, edits).then(put, keepRun),
      start: (id, revision) => api.start(id, revision).then(put, keepRun),
      saveDefaults: (id, revision) => api.defaults(id, revision).then(() => undefined, keepRun),
      close: (id) => api.close(id).then(() => void drop(id)),
      record: (id) => api.get(id).then(whole),
      refresh: () => void load(),
    };
    return { store, refs: 0, dispose };
  });
}

/** The chat's playbook runs, for as long as a component wants them. */
export function usePlaybookRuns(path: string, cwd: () => string | null, host: string | null): PlaybookRunsStore {
  const key = `${host ?? ""}|${path}`;
  let entry = entries.get(key);
  if (!entry) entries.set(key, (entry = make(path, cwd, host)));
  entry.refs++;
  const held = entry;
  onCleanup(() => {
    if (--held.refs > 0) return;
    entries.delete(key);
    held.dispose();
  });
  return held.store;
}

/** A `playbook.run` event from a chat's socket, to that chat's store if anything shows it. */
export function playbookRunEvent(path: string, host: string | null, run: PlaybookRunView): void {
  entries.get(`${host ?? ""}|${path}`)?.store.put(run);
}

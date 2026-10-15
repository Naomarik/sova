// A session view's side of older rows on demand (lib/older-rows): the signals, the loader wired to
// the view's list, what the thread reads (`api`), and the hello or snapshot handling. ChatView and
// WatchView each make one.

import { type Accessor, batch, createSignal, onCleanup } from "solid-js";
import type { OlderSummary, TranscriptItem, TranscriptRows } from "../../shared/protocol";
import { fetchTranscriptRows } from "./api";
import { afterRows, helloRows, type Older, OlderLoader } from "./older-rows";
import type { OlderRowsApi } from "../components/Thread";

/** Runs `fn` when the browser is idle; Safari has no idle callback. */
const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 1_000 });
  else setTimeout(fn, 50);
};

export function createOlderRows(o: {
  path: string;
  items: Accessor<TranscriptItem[] | null>;
  setItems(items: TranscriptItem[]): void;
  /** False: never fetch the rest in the background, whatever the hello says; only what is
      scrolled to or jumped to (the Overseer, §app.overseer/transcript-window). */
  prefetch?: boolean;
  /** What was known to be above the rows the view opened on, kept with them (lib/transcript-cache
      `keptOlder`): only for laying out the page before the hello (`api.known`). */
  kept?: () => Older | null;
}) {
  /** Null until this connection's hello or snapshot says what's above the list. */
  const [older, setOlder] = createSignal<Older | null>(null);
  const [slow, setSlow] = createSignal(false);
  /** A hello or snapshot has landed: rows read from the file before it are no longer news. */
  let answered = false;

  /** The newest rows (`items`, with `count` rows above them) onto the list on screen; `also` in the
      same update. */
  const land = (items: TranscriptItem[], count?: number, summary?: OlderSummary, also?: () => void) => {
    const next = helloRows(o.items(), items, count, summary);
    batch(() => {
      o.setItems(next.items);
      setOlder(next.older);
      also?.();
    });
    return next.older;
  };

  /** The branch moved under the list (or fetched rows didn't add up): a fresh tail from the file,
      keeping the rows above it that are still its ancestors. */
  const reload = async () => {
    loader.reset();
    try {
      const r = await fetchTranscriptRows(o.path, { tail: true });
      if ("code" in r) return;
      land(r.items, r.older, r.olderSummary);
    } catch {
      // The socket's next hello says it all again.
    }
  };

  const loader: OlderLoader = new OlderLoader({
    fetch: (ask, leaf) => fetchTranscriptRows(o.path, ask, leaf),
    list: o.items,
    older,
    apply: (items, next, also) =>
      batch(() => {
        o.setItems(items);
        setOlder(next);
        also?.();
      }),
    moved: () => void reload(),
    slow: setSlow,
    idle,
  });
  onCleanup(() => loader.reset());

  const api: OlderRowsApi = {
    left: () => older()?.left ?? null,
    known: () => (older() ?? o.kept?.() ?? null)?.left ?? null,
    more: () => void loader.more(),
    // Never waits on the chat, never throws: before its hello or snapshot (a chat still starting,
    // or failing to) the file's newest rows say what's above; a load that can't land says "stale",
    // and a jump still "stale" on its retry says it can't land (lib/jump jumpWhenArrived).
    load: async (target) => {
      if (!older()) {
        const r = await fetchTranscriptRows(o.path, { tail: true }).catch(() => null);
        if (r && !("code" in r) && !older()) land(r.items, r.older, r.olderSummary);
      }
      return older() ? loader.to(target).catch(() => "stale" as const) : "stale";
    },
    slow,
  };

  return {
    older,
    /** The list reaches the top of the branch. */
    whole: () => older()?.left === 0,
    api,
    /** A hello or snapshot: its rows (newest only, with `count` above them), and a prefetch of the
        rest when the server says this browser may as well have them all. A chat's hello that
        continues after a row the view named (`after`, §chat.transcript/instant-open) keeps the rows
        up to that one; one whose row the list no longer holds leaves the list as it is and reads
        the file's newest rows again. */
    hello(msg: { items: TranscriptItem[]; older?: number; olderSummary?: OlderSummary; prefetch?: boolean; after?: string }): void {
      answered = true;
      loader.reset();
      if (msg.after !== undefined) {
        const placed = afterRows(o.items(), msg.items, msg.after, msg.older, msg.olderSummary);
        if (!placed) {
          void reload();
          return;
        }
        batch(() => {
          o.setItems(placed.items);
          setOlder(placed.older);
        });
        if (msg.prefetch && o.prefetch !== false && placed.older.left > 0) void loader.prefetch();
        return;
      }
      const next = land(msg.items, msg.older, msg.olderSummary);
      if (msg.prefetch && o.prefetch !== false && next.left > 0) void loader.prefetch();
    },
    /** The newest rows read from the session file before the chat has answered
        (§chat.transcript/instant-open): painted as a hello's would be, with what's above them. A
        read that lands after a hello or snapshot is ignored (false): that said it all, and newer. */
    paint(r: TranscriptRows): boolean {
      if (answered) return false;
      land(r.items, r.older, r.olderSummary);
      return true;
    },
    /** The rows held, again from the file (a turn ended), with the context fill; the newest rows
        when it holds none (a new session's first turn). `also` runs in the same update as the rows
        landing, only if they land. Throws when the server can't be reached. */
    refresh: async (also?: () => void): Promise<TranscriptRows | "stale"> => {
      if (o.items()?.length) return loader.refresh(also);
      const r = await fetchTranscriptRows(o.path, { tail: true });
      if ("code" in r) return "stale";
      land(r.items, r.older, r.olderSummary, also);
      return r;
    },
  };
}

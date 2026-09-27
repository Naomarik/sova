import { batch, createEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js";
import type { SessionSummary, TranscriptItem, WatchContext, WatchServerMessage } from "../../shared/protocol";
import { createFork, fetchTranscriptWithContext, wsUrl } from "../lib/api";
import { contextFromItems, contextStateFor } from "../lib/context";
import { createReconnectingSocket } from "../lib/socket";
import { landExplainJump } from "../lib/jump";
import { type Arriving, helloItems, historyApplier, historyItems, newRows, tailFirst } from "../lib/tail-hello";
import { hostOf, sessionViewKey } from "../lib/mesh";
import { cachedTranscript, cacheItems, cacheSpot, reconcileItems } from "../lib/transcript-cache";
import { copyText, hideThinking, hideTools, setSessionContext, toast } from "../lib/ui-state";
import { openCreated, stageFork } from "../lib/fork-stage";
import { usePaneAnnounce } from "../lib/pane-scope";
import { visibleCount } from "../lib/hidden-rows";
import type { WorkingSplit } from "../lib/workers";
import { Composer, type ComposerReason } from "./Composer";
import { FlyoutSession } from "./ComposerMenu";
import { ConnectionBanner } from "./ConnectionBanner";
import { type ForkMarker, HistoryItems, type MessageActionsProvider, ThreadScroller, TranscriptSkeleton } from "./Thread";
import type { MessageActionItem } from "./MessageActions";
import {
  actionReason,
  actionsFor,
  COPIED,
  copyable,
  forkRefusalText,
  forkSentence,
  type ActionState,
  type MessageStrip,
} from "../lib/message-actions";
import { Banner } from "./ui";

/** SR announcements of appended entries are throttled to one per this interval. */
const ANNOUNCE_MS = 5000;

/**
 * Read-only live tail of a session (`/ws/watch`). Never sends anything. `stateBanner` holds only
 * notices with a way out (an unknown writer → Chat Anyway, the TUI closed → Open for Chat); a
 * TUI-owned session has no banner, just the head's Live chip and the composer's read-only reason.
 */
export function WatchView(props: {
  path: string;
  /** The session's id: what an "Open in Session" jump names when it linked by id. */
  sessionId?: string;
  author: string;
  /** A TUI is running this session, so tools without results may still be running. */
  streaming: boolean;
  stateBanner: JSX.Element;
  readOnly: ComposerReason;
  /** Rows were appended: data derived from the session file may have changed. */
  onAppend?(): void;
  /** Subagents working now (live record); the composer shows them as a status row. */
  workersWorking?: number;
  /** Every subagent the session has, so that row survives all of them settling. */
  workersTotal?: number;
  /** How that count divides into team members and plain subagents; null: it can't be split. */
  workersSplit?: WorkingSplit | null;
  /** Makes that row a button that toggles the subagents pane. */
  onShowWorkers?(): void;
  workersOpen?: boolean;
  /** Where this member was forked from, when it is one. */
  fork?: ForkMarker;
  /** A session this view just created (a Fork): the app adopts and opens it (see ChatView). */
  onCreated?(session: SessionSummary): void;
}) {
  const announce = usePaneAnnounce();
  // Rows kept from the last visit paint at once; the snapshot reconciles them (lib/transcript-cache).
  const cacheKey = sessionViewKey(hostOf(props.path), props.path);
  const cached = cachedTranscript(cacheKey);
  const [items, setItems] = createSignal<TranscriptItem[] | null>(cached?.items ?? null);
  createEffect(on(items, (list) => list && cacheItems(cacheKey, list)));
  /** The snapshot's older rows still on their way (lib/tail-hello); null once they're all here. */
  const [arriving, setArriving] = createSignal<Arriving | null>(null);
  /** The list is this connection's whole branch (as ChatView's `whole`). */
  const [whole, setWhole] = createSignal(false);
  /** The last snapshot's first row: rows that arrive above it are history, never "N new". */
  const [newFrom, setNewFrom] = createSignal<string | null>(null);
  // "Open in Session" from an Explanations card: land on that explanation's row once the snapshot
  // is here. Only a jump waiting for this session is claimed, and only once; one whose row isn't
  // here yet waits until the list is whole.
  createEffect(on([items, whole], ([list, w]) => list && landExplainJump({ path: props.path, sessionId: props.sessionId }, list, toast, w)));
  /** The chunks didn't add up: the whole branch from disk instead. */
  const reload = () =>
    void fetchTranscriptWithContext(props.path)
      .then((r) => {
        history.drop();
        setItems((prev) => reconcileItems(prev, r.items));
        setArriving(null);
        setWhole(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  const [error, setError] = createSignal<string | null>(null);
  const [lastUpdate, setLastUpdate] = createSignal<string | null>(null);

  // Context fill: the model's window comes from the snapshot's own context (pi files name the
  // reply's model); the fill itself follows the watched items (last assistant usage on the branch;
  // a compaction after it → null). Only a snapshot that names no window (no reply yet, compacted,
  // an unknown model, a server that predates it) asks the transcript response for one, once: that
  // download is the whole transcript again.
  const [contextWindow, setContextWindow] = createSignal<number | null | undefined>(undefined);
  let askedWindow = false;
  const askWindow = () => {
    if (askedWindow) return;
    askedWindow = true;
    void fetchTranscriptWithContext(props.path)
      .then((r) => {
        if (!contextWindow()) setContextWindow(r.context?.window ?? null);
        if (!items()) setSessionContext(props.path, contextStateFor(r.context, r.items));
      })
      .catch(() => contextWindow() === undefined && setContextWindow(null)); // the meter just stays without a window
  };
  const windowOf = (ctx: WatchContext | undefined) => (ctx && ctx !== "compacted" ? ctx.window : null);
  createEffect(() => {
    const list = items();
    const window = contextWindow();
    if (list && window !== undefined) setSessionContext(props.path, contextFromItems(list, window));
  });

  let unannounced = 0;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(announceTimer));
  const noteAppended = (n: number) => {
    unannounced += n;
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = undefined;
      if (unannounced > 0) announce(`${unannounced} new ${unannounced === 1 ? "entry" : "entries"}.`);
      unannounced = 0;
    }, ANNOUNCE_MS);
  };

  // ---- Per-message actions, read-only ------------------------------------------------------
  /**
   * Watching is reading, so Copy works exactly as it does in a chat — the text is on the screen
   * and nothing owns the clipboard. Fork works too: it READS this session into a new one, and the
   * only thing that stops it is another process writing the file. Rewind and Regenerate would
   * write here, so they carry their reason rather than disappearing — a control that vanishes in
   * one view and exists in another teaches nothing about why.
   */
  const [actionNote, setActionNote] = createSignal<{ entryId: string; text: string } | null>(null);
  const [forking, setForking] = createSignal(false);
  const watchState = (wake = false, link = false): ActionState => ({
    chat: false,
    live: props.streaming,
    streaming: false,
    compacting: false,
    pending: forking(),
    paused: null,
    wake,
    link,
  });

  const forkFrom = async (strip: MessageStrip) => {
    if (forking()) return;
    setActionNote(null);
    setForking(true);
    try {
      const out = await createFork({ path: props.path, entryId: strip.entryId, position: strip.role === "user" ? "before" : "at" });
      if (!out.ok) {
        const text = forkRefusalText(out.code, out.message);
        setActionNote({ entryId: strip.entryId, text });
        announce(text);
        return;
      }
      const target = out.session.path;
      // What actually landed in the new composer decides what we say landed there.
      const sentence = forkSentence(await stageFork(target, out.editor));
      setActionNote(null);
      toast(sentence);
      announce(sentence);
      openCreated(out.session, props.onCreated);
    } finally {
      setForking(false);
    }
  };

  const watchActions: MessageActionsProvider = {
    items(strip) {
      return actionsFor(strip.role, { copyable: copyable(strip) }).map((kind): MessageActionItem => {
        switch (kind) {
          case "copy":
            return { kind, reason: null, run: async () => void (await copyText(strip.text, COPIED)) };
          case "fork":
            return { kind, reason: actionReason("fork", watchState()), run: () => forkFrom(strip) };
          default:
            return { kind, reason: actionReason(kind, watchState(!!strip.fromWake, !!strip.fromLink)), run: () => {} };
        }
      });
    },
    note: (entryId) => (actionNote()?.entryId === entryId ? actionNote()!.text : null),
  };

  // The snapshot's older rows, applied a few at a time (lib/tail-hello).
  const history = historyApplier((chunks) => {
    let list = items();
    let next: ReturnType<typeof historyItems> | null = null;
    for (const c of chunks) {
      if (!list) return;
      next = historyItems(list, next ? next.arriving : arriving(), c.items, c.left);
      if (next.broken) {
        setArriving(null);
        reload();
        return;
      }
      list = next.items;
    }
    if (!next) return;
    const done = next;
    batch(() => {
      setItems(done.items);
      setArriving(done.arriving);
      if (!done.arriving) setWhole(true);
    });
  });
  onCleanup(history.drop);
  const socket = createReconnectingSocket<WatchServerMessage>(tailFirst(wsUrl("/ws/watch", props.path)), {
    onMessage(msg) {
      switch (msg.type) {
        case "snapshot": {
          // May repeat if the file is rewritten: always replace. Newest rows first: older rows
          // may follow as `history` (lib/tail-hello).
          setError(null);
          history.drop();
          const w = windowOf(msg.context);
          if (w) setContextWindow(w);
          else askWindow();
          const next = helloItems(items(), msg.items, msg.older);
          batch(() => {
            setItems(next.items);
            setArriving(next.arriving);
            // Rows kept above the hello's first row are that row's ancestors, entries that never
            // change: a list that was whole stays whole while the same rows arrive again (a
            // rewind, a reconnect), so its counts and Fan Out don't blink.
            setWhole(!next.arriving || (next.arriving.mode === "buffer" && whole()));
            setNewFrom(msg.items[0]?.id ?? null);
          });
          setLastUpdate(new Date().toISOString());
          break;
        }
        case "history":
          history.push(msg);
          break;
        case "append": {
          const w = windowOf(msg.context);
          if (w && !contextWindow()) setContextWindow(w);
          setItems((prev) => [...(prev ?? []), ...msg.items]);
          setLastUpdate(new Date().toISOString());
          noteAppended(msg.items.length);
          props.onAppend?.();
          break;
        }
        case "error":
          setError(msg.message);
          break;
      }
    },
  });

  return (
    <>
      <ThreadScroller
        path={props.path}
        restore={cached?.spot}
        onSpot={(spot) => cacheSpot(cacheKey, spot)}
        count={visibleCount(newRows(items() ?? [], newFrom()), { tools: hideTools(props.path), thinking: hideThinking(props.path) })}
        busy={!items()}
        banner={
          <div class="stack-2">
            {props.stateBanner}
            <ConnectionBanner socket={socket} watch lastUpdate={lastUpdate()} />
            <Show when={error()}>
              <Banner
                tone="error"
                title="Couldn't load this transcript."
                body={
                  <>
                    The file at <code>{props.path}</code> wasn't changed. {error()}
                  </>
                }
                action={
                  <button type="button" class="button button-sm" onClick={() => socket.reconnect()}>
                    Retry
                  </button>
                }
              />
            </Show>
          </div>
        }
      >
        <Show when={items()} fallback={<TranscriptSkeleton />}>
          {(list) => (
            <Show
              when={list().length > 0 || !whole()}
              fallback={
                <div class="empty">
                  <p class="empty-title">0 entries in this session so far.</p>
                  <p class="empty-body">They show up here as pi writes them.</p>
                </div>
              }
            >
              <HistoryItems
                items={list()}
                author={props.author}
                streaming={props.streaming}
                hideTools={hideTools(props.path)}
                hideThinking={hideThinking(props.path)}
                fork={props.fork}
                actions={watchActions}
                arriving={!!arriving()}
              />
            </Show>
          )}
        </Show>
      </ThreadScroller>
      <FlyoutSession.Provider value={() => props.path}>
        <Composer
          path={props.path}
          readOnly={props.readOnly}
          running={false}
          stopping={false}
          detail={null}
          workersWorking={props.workersWorking}
          workersTotal={props.workersTotal}
          workersSplit={props.workersSplit}
          onShowWorkers={props.onShowWorkers}
          workersOpen={props.workersOpen}
          onSend={() => false}
          onAbort={() => {}}
        />
      </FlyoutSession.Provider>
    </>
  );
}

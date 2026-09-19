import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import type { TranscriptItem, WatchServerMessage } from "../../shared/protocol";
import { wsUrl } from "../lib/api";
import { createReconnectingSocket } from "../lib/socket";
import { announce } from "../lib/ui-state";
import { Composer, type ComposerReason } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { HistoryItems, ThreadScroller, TranscriptSkeleton } from "./Thread";
import { Banner } from "./ui";

/** SR announcements of appended entries are throttled to one per this interval. */
const ANNOUNCE_MS = 5000;

/**
 * Read-only live tail of a session (`/ws/watch`). Never sends anything. `stateBanner` says why
 * it's read-only (TUI owns it, or an unknown process wrote it recently) and offers the way out.
 */
export function WatchView(props: {
  path: string;
  author: string;
  /** A TUI is running this session, so tools without results may still be running. */
  streaming: boolean;
  stateBanner: JSX.Element;
  readOnly: ComposerReason;
}) {
  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [lastUpdate, setLastUpdate] = createSignal<string | null>(null);

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

  const socket = createReconnectingSocket<WatchServerMessage>(wsUrl("/ws/watch", props.path), {
    onMessage(msg) {
      switch (msg.type) {
        case "snapshot": // may repeat if the file is rewritten: always replace
          setError(null);
          setItems(msg.items);
          setLastUpdate(new Date().toISOString());
          break;
        case "append":
          setItems((prev) => [...(prev ?? []), ...msg.items]);
          setLastUpdate(new Date().toISOString());
          noteAppended(msg.items.length);
          break;
        case "error":
          setError(msg.message);
          break;
      }
    },
  });

  return (
    <>
      <ThreadScroller
        count={items()?.length ?? 0}
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
              when={list().length > 0}
              fallback={
                <div class="empty">
                  <p class="empty-title">0 entries in this session so far.</p>
                  <p class="empty-body">They show up here as pi writes them.</p>
                </div>
              }
            >
              <HistoryItems items={list()} author={props.author} streaming={props.streaming} />
            </Show>
          )}
        </Show>
      </ThreadScroller>
      <Composer path={props.path} readOnly={props.readOnly} running={false} stopping={false} detail={null} onSend={() => false} onAbort={() => {}} />
    </>
  );
}

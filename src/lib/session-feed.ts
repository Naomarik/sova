// The live session feed (WS /ws/watch?feed=sessions): the server pushes each session's decision
// marks — attention signals and tags — as they change, so a row's mark appears or clears at once
// instead of at the next list poll. This host's feed only; a peer's rows keep their list fields.

import { createEffect, createSignal, onCleanup } from "solid-js";
import type { SessionFeedMessage, TagsBackfillProgress } from "../../shared/protocol";
import { applyMarks, createNudgeThrottle, EMPTY_OVERLAY, type MarksOverlay } from "./signals";
import { createReconnectingSocket } from "./socket";

const [overlay, setOverlay] = createSignal<MarksOverlay>(EMPTY_OVERLAY);
/** What the feed has said, for `overlaid` (src/lib/signals.ts). Empty while the socket is down. */
export const marksOverlay = overlay;

const [backfill, setBackfill] = createSignal<TagsBackfillProgress | null>(null);
/** The tags backfill's progress as last pushed; null until a backfill has reported on this page. */
export const pushedBackfill = backfill;

export const sessionFeedUrl = () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/watch?feed=sessions`;

/**
 * Opens the feed for as long as the calling owner lives (the sidebar, which lives as long as the
 * page). Every (re)connect starts from nothing: the server's first message is a full snapshot, and
 * until it lands the list is the truth. A feed that gave up retrying tries again when the window
 * regains focus — the same moment the list itself is re-read.
 *
 * `refreshList` re-reads the session list. The feed calls it (throttled, `createNudgeThrottle`)
 * when the server says the list changed beyond the marks — a session a TUI just started, one that
 * went away, a live/busy flip — which no poll would catch: the list is otherwise re-read only on
 * focus, while a row is busy, and after this tab's own actions. A reconnect re-reads it too: the
 * list may have changed while the socket was down.
 */
export function openSessionFeed(refreshList: () => void): void {
  const nudges = createNudgeThrottle(refreshList);
  onCleanup(() => nudges.cancel());
  const socket = createReconnectingSocket<SessionFeedMessage>(sessionFeedUrl(), {
    onOpen: (isReconnect) => {
      setOverlay(EMPTY_OVERLAY);
      if (isReconnect) nudges.nudge();
    },
    onMessage: (msg) => {
      if (msg.type === "marks") setOverlay((o) => applyMarks(o, msg));
      else if (msg.type === "tags_backfill") setBackfill(msg.progress);
      else if (msg.type === "list_changed") nudges.nudge();
    },
  });
  const onFocus = () => {
    if (socket.status() === "failed") socket.retry();
  };
  addEventListener("focus", onFocus);
  onCleanup(() => {
    removeEventListener("focus", onFocus);
    setOverlay(EMPTY_OVERLAY);
  });
  // Down is down: stale marks must not outlive the socket that kept them current.
  createEffect(() => {
    if (socket.status() !== "open") setOverlay(EMPTY_OVERLAY);
  });
}

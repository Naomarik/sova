// The transports this page follows (§app.transport/dialog): one read every 1.5 s of each while it is under way, shared
// by the Transport dialog and the chat's head, so both show the same step and neither polls on its own. It stops at
// the end (done, cancelled) or at Needs you; Retry follows it again.
import { createSignal } from "solid-js";
import { type TransportView, transportOf, transportsOf } from "./transport-api";
import { announce, toast } from "./ui-state";

const POLL_MS = 1_500;
const [byTid, setByTid] = createSignal<ReadonlyMap<string, TransportView>>(new Map());
const timers = new Map<string, ReturnType<typeof setInterval>>();

const over = (t: TransportView) => t.state === "done" || t.state === "cancelled" || t.state === "needs-you";

/** "Moved to Laptop." / "Copied to Laptop; setting up a and b there…": the done line. */
export const doneLine = (t: TransportView): string => {
  const setting = t.ext?.settingUp ?? [];
  const did = t.mode === "move" ? "Moved" : "Copied";
  const list = setting.length <= 2 ? setting.join(" and ") : `${setting.slice(0, 2).join(", ")} and ${setting.length - 2} more`;
  return setting.length ? `${did} to ${t.peerLabel}; setting up ${list} there…` : `${did} to ${t.peerLabel}.`;
};

/** Put what the page now knows of a transport (a start's answer, a Cancel's end). */
export function putTransport(t: TransportView): void {
  const was = byTid().get(t.tid);
  setByTid((m) => new Map(m).set(t.tid, t));
  if (t.state === "done" && was && was.state !== "done") {
    const line = doneLine(t);
    toast(line);
    announce(line);
  }
  if (over(t)) stopPolling(t.tid);
}

function stopPolling(tid: string): void {
  clearInterval(timers.get(tid));
  timers.delete(tid);
}

/** Follow `t` until it ends or needs you (again, after a Retry). */
export function followTransport(t: TransportView): void {
  putTransport(t);
  if (over(t) || timers.has(t.tid)) return;
  timers.set(
    t.tid,
    setInterval(() => {
      void transportOf(t.tid)
        .then(putTransport)
        .catch(() => {});
    }, POLL_MS),
  );
}

/** Follow again a transport that stopped (Retry pressed): its next reads show it going on. */
export function followAgain(tid: string): void {
  const t = byTid().get(tid);
  if (!t) return;
  stopPolling(tid);
  followTransport({ ...t, state: t.state === "needs-you" ? "preparing" : t.state, needsYou: undefined });
}

/** A transport by its id, as last read. */
export const transportById = (tid: string | null | undefined): TransportView | null => (tid ? (byTid().get(tid) ?? null) : null);

/** The transport of chat `chatId` from this device that is under way or needs you, as last read. */
export function liveTransportOf(chatId: string | null | undefined): TransportView | null {
  if (!chatId) return null;
  let best: TransportView | null = null;
  for (const t of byTid().values()) if (t.side === "source" && t.chatId === chatId && t.state !== "done" && t.state !== "cancelled") best = t;
  return best;
}

const asked = new Map<string, Promise<TransportView | null>>();

/** Ask once whether chat `chatId` has a transport under way here (or needing you) and follow it. */
export function lookForTransport(chatId: string, again = false): Promise<TransportView | null> {
  const had = asked.get(chatId);
  if (had && !again) return had;
  const p = transportsOf(chatId)
    .then(({ transports }) => {
      const t = [...transports].reverse().find((x) => x.side === "source" && x.state !== "done" && x.state !== "cancelled") ?? null;
      if (t) followTransport(t);
      return t;
    })
    .catch(() => null);
  asked.set(chatId, p);
  return p;
}

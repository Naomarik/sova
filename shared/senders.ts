// Who sent a user message, when it wasn't the person at this keyboard: another session
// (§chat.profiles/delivery), the Overseer (§app.overseer/sent-marker, and its briefs) or a teammate
// in a shared session (§app.baton/attribution). Read only off the invisible sender markers, never
// off the message's text, so the transcript (src/components/Thread.tsx), the Timeline
// (src/lib/timeline.ts) and the counts of what the user typed (shared/row-counts.ts, server and
// client alike) can't drift apart. A marker may arrive before or after the row it names, so every
// reader resolves by id over the whole list. Pure; imports only the protocol and the profile header.

import { OVERSEER_BRIEF_PREFIX, OVERSEER_PING_PREFIX, type TranscriptItem } from "./protocol";
import { stripSessionHeader } from "./profiles";
import { isMergeQueueText, MERGE_QUEUE_SENT_PREFIX } from "./merge-queue";

/** A user message's sender, by its marker. `baton` with `by: "operator"` is the user's own. */
export type Sender =
  | { kind: "session"; sessionId: string; title: string; hop: number }
  /** A note the Overseer passed on from the session that pinged (its `sova-relay-sent` marker, §app.overseer-pings/relay). */
  | { kind: "relay"; sessionId: string; title: string; hop: number }
  | { kind: "overseer" }
  /** A turn the merge queue started (Needs a fix, Send Back), by its prefix. */
  | { kind: "merge-queue" }
  | { kind: "baton"; by: string };

/** The merge queue's sender, in one place: the id its wakes carry in their "another session" marker, and the prefix
    their text starts with (defined beside the cards' shape in shared/merge-queue.ts, re-exported here). Server and page
    import both from this module. pi-config's worktree tool spells the prefix again (it imports nothing of Sova). */
export const MERGE_QUEUE_SESSION = "merge-queue";
export { isMergeQueueText, MERGE_QUEUE_SENT_PREFIX };
/** A merge queue wake's words: without a session header line, if any, and without its prefix. */
export const mergeQueueBody = (text: string): string => {
  const t = stripSessionHeader(text).trimStart();
  return (t.startsWith(MERGE_QUEUE_SENT_PREFIX) ? t.slice(MERGE_QUEUE_SENT_PREFIX.length) : t).trim();
};

/** A proactive "Brief me" prompt (the Overseer's), by its prefix: never the user's own words. */
export const isBriefText = (text: string | undefined): boolean => !!text && text.trimStart().startsWith(OVERSEER_BRIEF_PREFIX);
/** The brief's own words, without the prefix. */
export const briefBody = (text: string): string => text.trimStart().slice(OVERSEER_BRIEF_PREFIX.length).trim();
/** An Overseer ping turn (§app.overseer-pings/wake), by its prefix: never the user's own words. */
export const isPingText = (text: string | undefined): boolean => !!text && text.trimStart().startsWith(OVERSEER_PING_PREFIX);
/** The ping turn's own words, without the prefix. */
export const pingTurnBody = (text: string): string => text.trimStart().slice(OVERSEER_PING_PREFIX.length).trim();

/** The first line of a note the Overseer passed on (server/overseer-relay.ts relayText). */
const RELAY_HEADER = "[passed on by the Overseer";
/** A passed-on note's words as the views show them: without its `[passed on by the Overseer …]` line. */
export function relayBody(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith(RELAY_HEADER)) return text;
  const nl = t.indexOf("\n");
  return nl < 0 ? "" : t.slice(nl + 1).trimStart();
}

/** The entry a row id belongs to (`<entryId>:<i>` for a reply's later blocks). */
const entryOf = (rowId: string): string => {
  const i = rowId.indexOf(":");
  return i < 0 ? rowId : rowId.slice(0, i);
};

/** Target entry id → sender, from every sender marker in `items`, in either arrival order. When two
    markers name one row, a note the Overseer passed on wins over everything, then another session over
    the Overseer, and the Overseer over a baton participant (the transcript's own precedence). */
export function sendersOf(items: readonly TranscriptItem[]): Map<string, Sender> {
  // The merge queue's wakes carry the "another session" marker (so no tool reads them as the user's word),
  // named merge-queue: they are the queue's, never a link to a session of that name.
  const rank: Record<Sender["kind"], number> = { relay: 5, "merge-queue": 4, session: 3, overseer: 2, baton: 1 };
  const out = new Map<string, Sender>();
  const put = (id: string, s: Sender) => {
    const was = out.get(id);
    if (!was || rank[s.kind] > rank[was.kind]) out.set(id, s);
  };
  for (const it of items) {
    if (it.sessionMark?.kind === "sent")
      put(it.sessionMark.targetId, it.sessionMark.from.sessionId === MERGE_QUEUE_SESSION ? { kind: "merge-queue" } : { kind: "session", ...it.sessionMark.from, hop: it.sessionMark.hop });
    if (it.relayMark?.kind === "sent") put(it.relayMark.targetId, { kind: "relay", ...it.relayMark.from, hop: it.relayMark.hop });
    if (it.overseerMark?.kind === "sent") put(it.overseerMark.targetId, { kind: "overseer" });
    if (it.batonMark?.kind === "sent") put(it.batonMark.targetId, { kind: "baton", by: it.batonMark.by });
  }
  return out;
}

/** The sender of the row `rowId`, when someone other than the user sent it; the user's own baton
    messages (`operator`) have none. */
export function otherSender(senders: ReadonlyMap<string, Sender>, rowId: string): Sender | undefined {
  const s = senders.get(entryOf(rowId));
  return s && !(s.kind === "baton" && s.by === "operator") ? s : undefined;
}

/** The row's sender for the views: a marker's, else the Overseer's for a brief or a ping turn. */
export function rowSender(row: Pick<TranscriptItem, "id" | "kind" | "text">, senders: ReadonlyMap<string, Sender>): Sender | undefined {
  return (
    otherSender(senders, row.id) ??
    (row.kind === "user" && (isBriefText(row.text) || isPingText(row.text)) ? { kind: "overseer" } : row.kind === "user" && isMergeQueueText(row.text) ? { kind: "merge-queue" } : undefined)
  );
}

/** What the user typed: a user row no marker names as someone else's, and never a brief or a ping turn. A wake
    nudge (kind "wake") and a link message aren't user rows, so they never are. */
export const isOwnInput = (row: Pick<TranscriptItem, "id" | "kind" | "text">, senders: ReadonlyMap<string, Sender>): boolean =>
  row.kind === "user" && !rowSender(row, senders);

/** The ids of the rows the user typed among `rows`, oldest first, judged by the markers in `rows`. */
export function ownInputIds(rows: readonly TranscriptItem[]): string[] {
  const senders = sendersOf(rows);
  return rows.filter((r) => isOwnInput(r, senders)).map((r) => r.id);
}

/** A message's body as the views show it: without another session's header line, a passed-on note's header line,
    or the brief's or a ping turn's tag. */
export function messageBody(text: string, sender: Sender | undefined, brief = false): string {
  if (sender?.kind === "session") return stripSessionHeader(text);
  if (sender?.kind === "relay") return relayBody(text);
  if (brief) return isPingText(text) ? pingTurnBody(text) : briefBody(text);
  if (sender?.kind === "merge-queue") return mergeQueueBody(text);
  return text;
}

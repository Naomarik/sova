// Rows and messages per wire (WireVersion, shared/protocol.ts). The row builder makes wire-1 rows, an
// entry's facts as `meta` on its first row; a consumer that asked for wire 2 (`wire=2`) gets each such
// row with `facts` (shared/wire-v1.ts factsFromMeta) where `meta` was, and its live events as wire-2
// frames. A wire-1 consumer gets the very rows and messages it always got, so their JSON is unchanged
// byte for byte. Cuts (tail, history chunks, older rows) are always measured on wire-1 JSON, so both
// wires cut at the same rows.

import type { ChatServerMessage, TranscriptItem, V1EventFrame, V2EventFrame, WatchServerMessage, WireVersion } from "../shared/protocol";
import { WIRE_PARAM } from "../shared/protocol";
import { factsFromMeta } from "../shared/wire-v1";
import { v2Frames } from "./harness/pi/wire";

/** The wire a request asked for: 2 for `wire=2`, anything else (absent included) 1. */
export const wireOf = (search: URLSearchParams | { get(name: string): string | null | undefined }): WireVersion =>
  search.get(WIRE_PARAM) === "2" ? 2 : 1;

/** A row on `wire`: on wire 1 the row itself; on wire 2, a row with `meta` gets `facts` in its place. */
export function rowFor(it: TranscriptItem, wire: WireVersion): TranscriptItem {
  if (wire === 1 || it.meta === undefined) return it;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it)) {
    if (k === "meta") out.facts = factsFromMeta(it.meta);
    else out[k] = v;
  }
  return out as unknown as TranscriptItem;
}

/** Rows on `wire` (the same array on wire 1). */
export const rowsFor = (items: TranscriptItem[], wire: WireVersion): TranscriptItem[] => (wire === 1 ? items : items.map((it) => rowFor(it, 2)));

type RowsMessage = { type: "hello" | "snapshot" | "append" | "history"; items: TranscriptItem[] };
const ROWS_MESSAGES = new Set(["hello", "snapshot", "append", "history"]);

/** A message's rows on `wire`: a hello, snapshot, append or history with its rows mapped (rowFor); any
    other message, and every message on wire 1, as it is. */
export function withRows<M extends ChatServerMessage | WatchServerMessage>(msg: M, wire: WireVersion): M {
  if (wire === 1 || !ROWS_MESSAGES.has(msg.type)) return msg;
  const m = msg as unknown as RowsMessage;
  return { ...msg, items: rowsFor(m.items, 2) };
}

/** What a chat message is on `wire`: on wire 2 a live event is its wire-2 frames (none, one or more),
    any other message its rows mapped; on wire 1 the message itself. */
export function onWire(msg: ChatServerMessage, wire: WireVersion): (ChatServerMessage | V2EventFrame)[] {
  if (wire === 1) return [msg];
  if (msg.type === "event") return v2Frames(msg as V1EventFrame);
  return [withRows(msg, 2)];
}

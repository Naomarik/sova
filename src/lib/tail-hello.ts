// Newest rows first over the wire (server/tail-hello.ts). A view that asks with `?tail=1` gets a
// `hello` or `snapshot` holding the transcript's newest rows and `older`, the count of rows before
// them, and then those rows as `history` messages, newest chunk first. This file puts the list back
// together; the views keep what it returns. Pure, for tsx --test.
//
// Two ways the older rows land:
// - "prepend": nothing on screen reaches above the hello's first row (a cold open, or a rewind that
//   removed it), so each chunk goes on the front of the list as it arrives. The thread builds it
//   above the view while idle (lib/tail-render), like any row not built yet.
// - "buffer": the list on screen (kept from the last visit, or before a reconnect) already has rows
//   above the hello's first row. They stay, as they were, until every chunk is here; then the whole
//   list is reconciled once, so rows that didn't change keep their objects and nothing is rebuilt.

import type { TranscriptItem } from "../../shared/protocol";
import { reconcileItems } from "./transcript-cache";

/** Older rows still on their way after a tail-first hello or snapshot. */
export interface Arriving {
  /** Rows the hello said come before its first row. */
  older: number;
  /** The hello's first row: from it on, the list is the hello's (plus what was appended since). */
  seam: string;
  mode: "prepend" | "buffer";
  /** Rows received so far. */
  got: number;
  /** "buffer" only: the chunks received, oldest first. */
  chunks: TranscriptItem[][];
}

export interface Assembled {
  items: TranscriptItem[];
  /** Null: the list is whole. */
  arriving: Arriving | null;
  /** The chunks didn't add up (a count or a repeated row): the view reloads the list whole. */
  broken?: boolean;
}

/** The list after a `hello` or `snapshot`: `older` absent or 0 means it is whole, as from a
    server or a client that never cut it. Any older rows still arriving for the last one are
    dropped: this hello starts again. */
export function helloItems(prev: TranscriptItem[] | null | undefined, items: TranscriptItem[], older?: number): Assembled {
  if (!older || older <= 0 || items.length === 0) return { items: reconcileItems(prev, items), arriving: null };
  const seam = items[0]!.id;
  const j = prev ? prev.findIndex((it) => it.id === seam) : -1;
  if (j > 0) return { items: reconcileItems(prev, [...prev!.slice(0, j), ...items]), arriving: { older, seam, mode: "buffer", got: 0, chunks: [] } };
  return { items: reconcileItems(prev, items), arriving: { older, seam, mode: "prepend", got: 0, chunks: [] } };
}

/** A view's socket URL, asking for newest rows first (`?tail=1`). A server that predates it ignores
    the parameter and sends the whole transcript, which `helloItems` reads as whole. */
export const tailFirst = (url: string): string => `${url}&tail=1`;

const hasRepeats = (items: readonly TranscriptItem[]): boolean => new Set(items.map((it) => it.id)).size !== items.length;

/** The list after one `history` message. One that comes with nothing arriving is ignored. */
export function historyItems(list: TranscriptItem[], arriving: Arriving | null, chunk: TranscriptItem[], left: number): Assembled {
  if (!arriving) return { items: list, arriving: null };
  const got = arriving.got + chunk.length;
  if (got + left !== arriving.older || left < 0) return { items: list, arriving: null, broken: true };
  if (arriving.mode === "prepend") {
    const items = [...chunk, ...list];
    if (left > 0) return { items, arriving: { ...arriving, got } };
    return hasRepeats(items) ? { items: list, arriving: null, broken: true } : { items, arriving: null };
  }
  const chunks = [chunk, ...arriving.chunks];
  if (left > 0) return { items: list, arriving: { ...arriving, got, chunks } };
  const at = list.findIndex((it) => it.id === arriving.seam);
  if (at < 0) return { items: list, arriving: null, broken: true };
  const whole = [...chunks.flat(), ...list.slice(at)];
  if (hasRepeats(whole)) return { items: list, arriving: null, broken: true };
  return { items: reconcileItems(list, whole), arriving: null };
}

/**
 * The rows that count as new for Jump to Latest's "N new": the hello's first row and after. Rows
 * that arrive above it are history, never new (§chat.transcript/rendering). A list without that
 * row (a whole reload after a rewind) counts whole.
 */
export function newRows(items: TranscriptItem[], from: string | null): TranscriptItem[] {
  if (!from) return items;
  const at = items.findIndex((it) => it.id === from);
  return at <= 0 ? items : items.slice(at);
}

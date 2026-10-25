// Older rows on demand (server/transcript-rows.ts). A view asks its socket for the newest rows
// alone (`?tail=rest`): the hello or snapshot carries them, `older` (how many rows come before
// them) and `olderSummary` (what the complete-list readers need of those rows), and nothing more
// arrives on the socket but live traffic. The older rows come over REST when they're wanted: the
// chunk above the list as the reader scrolls toward its top, the whole range down to a jump's
// target in one request, and, for a browser on this machine (`prefetch`), all of them in the
// background. This file is the list arithmetic and the fetching; the views keep the signals.
// No Solid, for tsx --test.

import { HAVE_MAX_CHARS, HAVE_PARAM, type OlderSummary, type TranscriptItem, type TranscriptRows } from "../../shared/protocol";
import { entryOfRow, isInput, isReplyRow, messageCount } from "../../shared/row-counts";
import { isOwnInput, otherSender, sendersOf } from "../../shared/senders";
import type { RowsAsk } from "./api";
import { reconcileItems } from "./transcript-cache";

/** The rows above a view's list that it doesn't hold. */
export interface Older {
  /** How many; 0: the list reaches the top of the branch. */
  left: number;
  /** About them (OlderSummary). `replies` may also count rows kept above a hello's first row:
      it's read OR'ed with the list, where that makes no difference. */
  summary: OlderSummary;
}

const NONE: OlderSummary = { inputs: [], messages: 0, replies: false };
/** A list that reaches the top. */
export const WHOLE: Older = { left: 0, summary: NONE };

/** A view's socket URL, asking for the newest rows alone. A server that predates it sends the
    whole transcript, which `helloRows` reads as whole. */
export const newestOnly = (url: string): string => `${url}&tail=rest`;

/** A chat socket URL that names the last row the view holds (`have`, §chat.transcript/instant-open),
    so its hello carries only the rows after it. Nothing named (or too long a name): the usual hello. */
export const withHave = (url: string, have: string | null | undefined): string =>
  have && have.length <= HAVE_MAX_CHARS ? `${url}&${HAVE_PARAM}=${encodeURIComponent(have)}` : url;

/** Whether rows kept `asOf` (ISO; null or undefined: a view keeps them current, or unknown) are older
    than the session's file, last written at `lastActiveAt` (unknown: not older). */
export const keptBehind = (asOf: string | null | undefined, lastActiveAt: string | undefined): boolean =>
  !!asOf && !!lastActiveAt && Date.parse(asOf) < Date.parse(lastActiveAt);

/**
 * The list after a `hello` or `snapshot`. Rows the list on screen already has above the hello's
 * first row (kept from the last visit, or before a reconnect or rewind) stay: they are that row's
 * ancestors, so they're the rows just above it, unless the inputs among them don't match the
 * summary's newest (then they're dropped and only the hello's rows are kept).
 */
export function helloRows(
  prev: readonly TranscriptItem[] | null | undefined,
  items: TranscriptItem[],
  older?: number,
  summary?: OlderSummary,
): { items: TranscriptItem[]; older: Older } {
  if (!older || older <= 0 || items.length === 0) return { items: reconcileItems(prev, items), older: WHOLE };
  const s = summary ?? NONE;
  const j = prev ? prev.findIndex((it) => it.id === items[0]!.id) : -1;
  return (j > 0 && keepAbove(prev!, j, items, older, s)) || { items: reconcileItems(prev, items), older: { left: older, summary: s } };
}

/**
 * The list after a `hello` that continues after a row the view named (`after`,
 * §chat.transcript/instant-open): the rows on screen up to and including that one, then the
 * hello's (possibly none). Null when the list doesn't hold that row, or its inputs don't match the
 * summary's newest: the hello's rows alone are not a list to show, so the view reads the file again.
 */
export function afterRows(
  prev: readonly TranscriptItem[] | null | undefined,
  items: TranscriptItem[],
  after: string,
  older?: number,
  summary?: OlderSummary,
): { items: TranscriptItem[]; older: Older } | null {
  const m = prev ? prev.findIndex((it) => it.id === after) : -1;
  if (m < 0 || !older || older <= 0) return null;
  return keepAbove(prev!, m + 1, items, older, summary ?? NONE);
}

/** `prev`'s first `j` rows above `items`, when they can be the last `j` of the `older` rows the
    summary sums up (its newest inputs are theirs); else null. */
function keepAbove(prev: readonly TranscriptItem[], j: number, items: TranscriptItem[], older: number, s: OlderSummary): { items: TranscriptItem[]; older: Older } | null {
  if (j > older) return null;
  const kept = prev.slice(0, j);
  const inputs = kept.filter(isInput).map((r) => r.id);
  const at = s.inputs.length - inputs.length;
  if (at < 0 || !inputs.every((id, i) => s.inputs[at + i] === id)) return null;
  // The rows the user typed above the kept ones: what the summary said of those still above.
  const above = new Set(s.inputs.slice(0, at));
  const ownInputs = s.ownInputs?.filter((id) => above.has(id));
  // An alignment whose newest revision is a kept row is now the list's to count.
  const keptIds = new Set(kept.map((it) => it.id));
  const aligns = s.aligns?.filter((a) => !keptIds.has(a.rowId));
  // So is a card whose newest snapshot is a kept row.
  const cards = s.cards?.filter((c) => !keptIds.has(c.rowId));
  return {
    items: reconcileItems(prev, [...kept, ...items]),
    older: {
      left: older - j,
      summary: {
        inputs: s.inputs.slice(0, at),
        ...(ownInputs ? { ownInputs } : {}),
        messages: Math.max(0, s.messages - messageCount(kept)),
        replies: s.replies,
        ...(aligns?.length ? { aligns } : {}),
        ...(cards?.length ? { cards } : {}),
      },
    },
  };
}

/** The list with a chunk (or range) of older rows on top, or null when they don't end right above
    it (a count that doesn't add up, or a row it already has): the view starts again. */
export function prependRows(list: readonly TranscriptItem[], older: Older, r: TranscriptRows): { items: TranscriptItem[]; older: Older } | null {
  if (r.older + r.items.length !== older.left) return null;
  const ids = new Set(list.map((it) => it.id));
  if (r.items.some((it) => ids.has(it.id))) return null;
  return { items: [...r.items, ...list], older: { left: r.older, summary: r.olderSummary } };
}

// ---- The complete-list readers: the list the view holds, plus the summary of the rest ---------

export const inputTotal = (list: readonly TranscriptItem[], older: Older): number => list.filter(isInput).length + older.summary.inputs.length;
/** The messages the user typed on the branch: the composer's input count, exactly the rows the
    Timeline's Inputs Only lists (shared/senders.ts `isOwnInput`). Above the list, the summary's own
    inputs (an older server's summary has none: its every input), less any a sender marker the list
    holds names: a marker always comes after its row, so one for a row above can be in the list. */
export function ownInputTotal(list: readonly TranscriptItem[], older: Older): number {
  const senders = sendersOf(list);
  const above = older.summary.ownInputs ?? older.summary.inputs;
  return list.filter((r) => isOwnInput(r, senders)).length + above.filter((id) => !otherSender(senders, id)).length;
}
export const messageTotal = (list: readonly TranscriptItem[], older: Older): number => messageCount(list) + older.summary.messages;
export const anyReply = (list: readonly TranscriptItem[], older: Older): boolean => list.some(isReplyRow) || older.summary.replies;
/** The newest input on the branch: in the list, else the newest of those above it. */
export function lastInput(list: readonly TranscriptItem[], older: Older): string | null {
  for (let i = list.length - 1; i >= 0; i--) if (isInput(list[i]!)) return list[i]!.id;
  return older.summary.inputs.at(-1) ?? null;
}

// ---- Fetching --------------------------------------------------------------------------------

/** A fetch slower than this shows the top edge's loading indicator. */
export const SLOW_MS = 400;
/** Chunk size for a background prefetch (a browser on this machine): fewer, larger requests. */
export const PREFETCH_CHARS = 1024 * 1024;

type Fetched = TranscriptRows | { code: "moved" | "missing" };

export interface LoaderDeps {
  fetch(ask: RowsAsk, leaf: string | null): Promise<Fetched>;
  list(): TranscriptItem[] | null;
  /** Null until this connection's hello or snapshot. */
  older(): Older | null;
  /** Rows the loader fetched, as the list and what's above it now; `also` runs in the same update
      (one batch), so nothing renders or lays out between them. */
  apply(items: TranscriptItem[], older: Older, also?: () => void): void;
  /** The branch moved under the list (or rows didn't add up): start again from a fresh tail. */
  moved(): void;
  /** A fetch (scrolling up, a jump's range) has been pending SLOW_MS (true), or is over (false). */
  slow?(on: boolean): void;
  /** Runs `fn` when the browser is idle (the prefetch's pace). */
  idle?(fn: () => void): void;
}

/** What a jump asks for: an entry (or row) id, or an explanation's report row. */
export type RowTarget = { entry: string } | { explain: string };

/** Whether the list has the target's row, as the thread's lookup finds it (lib/tail-render
    `rowIndexFor`): the entry's own row or first block, then, for a block id, its entry's. */
function hasTarget(list: readonly TranscriptItem[], t: RowTarget): boolean {
  if ("explain" in t) return list.some((it) => it.report?.explain?.id === t.explain);
  const own = (id: string) => list.some((it) => it.id === id || it.id.startsWith(`${id}:`));
  return own(t.entry) || (t.entry.includes(":") && own(entryOfRow(t.entry)));
}

/**
 * One view's older-row fetching. Requests go one at a time, in order; a new hello (`reset`)
 * makes anything still in flight land nowhere.
 */
export class OlderLoader {
  private gen = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingMore: Promise<void> | null = null;
  private prefetching = false;
  constructor(
    private readonly d: LoaderDeps,
    private readonly slowMs = SLOW_MS,
  ) {}

  /** A new hello or snapshot, or the view going away: what's in flight is for another list. */
  reset(): void {
    this.gen++;
    this.pendingMore = null;
    this.prefetching = false;
    this.d.slow?.(false);
  }

  /** `job` after the requests before it, unless the list changed generation meanwhile. */
  private run<T>(job: () => Promise<T>): Promise<T | "stale"> {
    const gen = this.gen;
    const next = this.chain.then((): Promise<T | "stale"> | "stale" => (gen === this.gen ? job() : "stale"));
    this.chain = next.catch(() => {});
    return next;
  }

  /** Lands fetched rows on the list if it's still the list they were asked for. */
  private land(gen: number, before: string, r: Fetched): "here" | "missing" | "stale" {
    if (gen !== this.gen) return "stale";
    if ("code" in r) {
      if (r.code === "missing") return "missing";
      this.d.moved();
      return "stale";
    }
    const list = this.d.list();
    const older = this.d.older();
    if (!list || !older || list[0]?.id !== before) return "stale";
    if (r.items.length === 0) return "here";
    const next = prependRows(list, older, r);
    if (!next) {
      this.d.moved();
      return "stale";
    }
    this.d.apply(next.items, next.older);
    return "here";
  }

  /** The chunk above the list, if there is one and none is on its way already. */
  more(chars?: number): Promise<void> {
    if (this.pendingMore) return this.pendingMore;
    const gen = this.gen;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p = this.run(async () => {
      const list = this.d.list();
      const older = this.d.older();
      if (!list?.length || !older || older.left <= 0) return;
      timer = setTimeout(() => gen === this.gen && this.d.slow?.(true), this.slowMs);
      const before = list[0]!.id;
      this.land(gen, before, await this.d.fetch({ before, ...(chars ? { chars } : {}) }, leafOf(list)));
    })
      .then(() => {})
      .finally(() => {
        clearTimeout(timer);
        if (gen === this.gen) {
          this.pendingMore = null;
          this.d.slow?.(false);
        }
      });
    this.pendingMore = p;
    return p;
  }

  /** Makes the list hold `target`, fetching the range down to it in one request. "missing": the
      branch has no such row; "stale": a newer list came meanwhile (its own hello decides). */
  to(target: RowTarget): Promise<"here" | "missing" | "stale"> {
    const gen = this.gen;
    return this.run(async (): Promise<"here" | "missing" | "stale"> => {
      const list = this.d.list();
      const older = this.d.older();
      if (list && hasTarget(list, target)) return "here";
      if (!list?.length || !older) return "stale";
      if (older.left <= 0) return "missing";
      const before = list[0]!.id;
      const ask = "explain" in target ? { before, explain: target.explain } : { before, from: target.entry };
      const timer = setTimeout(() => gen === this.gen && this.d.slow?.(true), this.slowMs);
      try {
        return this.land(gen, before, await this.d.fetch(ask, leafOf(list)));
      } finally {
        clearTimeout(timer);
        if (gen === this.gen && !this.pendingMore) this.d.slow?.(false);
      }
    });
  }

  /** The rows the list holds, again (a turn ended: rows may have changed), and what's above them.
      Resolves to the answer (its `context` included), once applied. `also` runs in the same update
      as the rows landing (a turn's streamed rows leaving as its saved rows come), only if they land. */
  refresh(also?: () => void): Promise<TranscriptRows | "stale"> {
    const gen = this.gen;
    return this.run(async (): Promise<TranscriptRows | "stale"> => {
      const list = this.d.list();
      if (!list?.length) return "stale";
      const first = list[0]!.id;
      const r = await this.d.fetch({ from: first }, leafOf(list));
      if (gen !== this.gen) return "stale";
      if ("code" in r) {
        this.d.moved();
        return "stale";
      }
      this.d.apply(reconcileItems(this.d.list(), r.items), { left: r.older, summary: r.olderSummary }, also);
      return r;
    });
  }

  /** Every older row, a large chunk at a time while the browser is idle. */
  async prefetch(chars = PREFETCH_CHARS): Promise<void> {
    if (this.prefetching) return;
    this.prefetching = true;
    const gen = this.gen;
    try {
      while (gen === this.gen && (this.d.older()?.left ?? 0) > 0) {
        await new Promise<void>((r) => (this.d.idle ? this.d.idle(r) : r()));
        if (gen !== this.gen) return;
        const left = this.d.older()?.left ?? 0;
        await this.more(chars);
        if ((this.d.older()?.left ?? 0) >= left) return; // nothing landed (an error, a reset): stop
      }
    } finally {
      if (gen === this.gen) this.prefetching = false;
    }
  }
}

/** The last entry a list renders: the leaf the server checks the branch against. */
const leafOf = (list: readonly TranscriptItem[]): string | null => (list.length ? entryOfRow(list[list.length - 1]!.id) : null);

/**
 * The rows that count as new for Jump to Latest's "N new": the hello's first row and after. Rows
 * that land above it are older rows, never new (§chat.transcript/rendering). A list without that
 * row (a reload after a rewind) counts whole.
 */
export function newRows(items: TranscriptItem[], from: string | null): TranscriptItem[] {
  if (!from) return items;
  const at = items.findIndex((it) => it.id === from);
  return at <= 0 ? items : items.slice(at);
}

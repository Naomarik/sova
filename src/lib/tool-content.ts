// A tool call's whole arguments and output, which its row doesn't carry (only its folded line):
// fetched in batches from GET /api/transcript/tool and kept here, outside the rows, so a refetch
// that brings new row objects keeps what was fetched. The thread asks for a card's content before
// it is opened — as it nears the view, or under the pointer — so opening it draws the body at once.
//
// A slot is keyed by the session, the row asked for and the result row it was asked with: a call
// asked about while it was still running is asked again once its result is on the list. A call that
// finished while this tab watched it stream is seeded with what the stream carried, until the
// fetch says what the session file holds.

import { createSignal, type Accessor, type Setter } from "solid-js";
import { TOOL_CONTENT_MAX_IDS, type ToolContent } from "../../shared/protocol";
import { fetchToolContent, type ToolSource } from "./api";

export type { ToolSource };

export type ToolBody =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; content: ToolContent }
  /** The session no longer holds the row (a rewind moved the branch). */
  | { state: "missing" }
  | { state: "error"; message: string };

/** The most content (characters of JSON, as the rows announce it) kept for cards not open now. */
export const TOOL_CONTENT_BUDGET = 20_000_000;

interface Slot {
  get: Accessor<ToolBody>;
  set: Setter<ToolBody>;
  source: ToolSource;
  rowId: string;
  size: number;
  /** Cards drawing it now: never dropped while any does. */
  holds: number;
}

export const sourceKey = (s: ToolSource): string => `${s.host ?? ""}\u0000${s.kind === "pi" ? `pi:${s.path}` : `claude:${s.sessionId}`}`;

/**
 * The content store. Plain module state with one signal per slot: a card reads its own slot, and
 * nothing else re-renders when another lands.
 */
export class ToolContentStore {
  /** Least recently used first (Map order). */
  private readonly slots = new Map<string, Slot>();
  /** Content the stream carried, by session and tool call id. */
  private readonly seeds = new Map<string, Map<string, ToolContent>>();
  private readonly queued = new Map<string, { source: ToolSource; keys: Set<string> }>();
  private flushing: Promise<void> | null = null;
  private total = 0;
  constructor(
    private readonly fetcher: (source: ToolSource, ids: readonly string[]) => Promise<{ items: Record<string, ToolContent> }> = fetchToolContent,
    readonly budget = TOOL_CONTENT_BUDGET,
    private readonly defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
  ) {}

  private slot(source: ToolSource, rowId: string, resultId: string | undefined, size: number): [string, Slot] {
    const key = `${sourceKey(source)}\u0000${rowId}\u0000${resultId ?? ""}`;
    let s = this.slots.get(key);
    if (s) {
      // Most recently used goes last.
      this.slots.delete(key);
      this.slots.set(key, s);
      return [key, s];
    }
    const [get, set] = createSignal<ToolBody>({ state: "idle" }, { equals: false });
    s = { get, set, source, rowId, size: Math.max(size, 1), holds: 0 };
    this.slots.set(key, s);
    return [key, s];
  }

  /**
   * A card's content: what it reads (`body`), asking for it (`want`, cheap to call again), keeping
   * it while drawn (`hold`, returns the release) and asking again after a failure (`retry`).
   * `callId` finds what the stream carried; `size` is the row's announced size (ToolRowInfo.bytes).
   */
  handle(source: ToolSource, rowId: string, opts: { resultId?: string; callId?: string; size?: number } = {}) {
    const [key, s] = this.slot(source, rowId, opts.resultId, opts.size ?? 0);
    const seed = opts.callId && opts.resultId ? this.seeds.get(sourceKey(source))?.get(opts.callId) : undefined;
    const body = (): ToolBody => {
      const b = s.get();
      return b.state !== "ready" && seed ? { state: "ready", content: seed } : b;
    };
    return {
      body,
      want: () => this.want(key, s),
      hold: () => {
        s.holds++;
        let done = false;
        return () => {
          if (done) return;
          done = true;
          s.holds--;
          this.trim();
        };
      },
      retry: () => {
        if (s.get().state !== "error") return;
        s.set({ state: "idle" });
        this.want(key, s);
      },
    };
  }

  /**
   * Every row's content at once (the Changes viewer), in batches; resolves when each has landed or
   * failed. A row the branch doesn't hold has no entry.
   */
  async load(source: ToolSource, rows: readonly { rowId: string; resultId?: string; size?: number }[]): Promise<Map<string, ToolContent>> {
    const slots = rows.map((r) => this.slot(source, r.rowId, r.resultId, r.size ?? 0));
    // Held until read: a trim meanwhile must not take what was just fetched for this answer.
    for (const [key, s] of slots) {
      s.holds++;
      if (s.get().state === "error") s.set({ state: "idle" });
      this.want(key, s);
    }
    try {
      while (this.flushing) await this.flushing;
      const out = new Map<string, ToolContent>();
      for (const [, s] of slots) {
        const b = s.get();
        if (b.state === "ready") out.set(s.rowId, b.content);
        else if (b.state === "error") throw new Error(b.message);
      }
      return out;
    } finally {
      for (const [, s] of slots) s.holds--;
      this.trim();
    }
  }

  /** What a finished call carried while it streamed, under its tool call id. */
  seed(source: ToolSource, callId: string, content: ToolContent): void {
    const k = sourceKey(source);
    let m = this.seeds.get(k);
    if (!m) this.seeds.set(k, (m = new Map()));
    m.set(callId, content);
    // A turn's worth at most: the fetch replaces them as their cards are asked about.
    if (m.size > 200) m.delete(m.keys().next().value!);
  }

  private want(key: string, s: Slot): void {
    const b = s.get().state;
    if (b === "ready" || b === "loading" || b === "missing") return;
    if (b === "error") return; // asked again only by `retry`
    s.set({ state: "loading" });
    // A slot trimmed while a card still had it comes back.
    if (!this.slots.has(key)) this.slots.set(key, s);
    const k = sourceKey(s.source);
    let q = this.queued.get(k);
    if (!q) this.queued.set(k, (q = { source: s.source, keys: new Set() }));
    q.keys.add(key);
    if (!this.flushing) this.flushing = new Promise((resolve) => this.defer(() => void this.flush().finally(resolve)));
  }

  private async flush(): Promise<void> {
    while (this.queued.size) {
      const batches = [...this.queued.values()];
      this.queued.clear();
      await Promise.all(
        batches.flatMap(({ source, keys }) => {
          const list = [...keys];
          const chunks: string[][] = [];
          for (let i = 0; i < list.length; i += TOOL_CONTENT_MAX_IDS) chunks.push(list.slice(i, i + TOOL_CONTENT_MAX_IDS));
          return chunks.map((chunk) => this.fetchChunk(source, chunk));
        }),
      );
    }
    this.flushing = null;
    this.trim();
  }

  private async fetchChunk(source: ToolSource, keys: string[]): Promise<void> {
    const slots = keys.map((k) => this.slots.get(k)).filter((s): s is Slot => !!s);
    const ids = [...new Set(slots.map((s) => s.rowId))];
    try {
      const { items } = await this.fetcher(source, ids);
      for (const s of slots) {
        const c = items[s.rowId];
        if (c) {
          this.total += s.size;
          s.set({ state: "ready", content: c });
        } else s.set({ state: "missing" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const s of slots) s.set({ state: "error", message });
    }
  }

  /** Drops the least recently used content no card draws now, down to the budget. */
  private trim(): void {
    if (this.total <= this.budget) return;
    for (const [key, s] of this.slots) {
      if (this.total <= this.budget) break;
      if (s.holds > 0 || s.get().state !== "ready") continue;
      this.total -= s.size;
      this.slots.delete(key);
      s.set({ state: "idle" });
    }
  }
}

/** This tab's store. */
export const toolContent = new ToolContentStore();

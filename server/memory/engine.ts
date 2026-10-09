// One chat's memory (§chat/memory): the log derived from its branch, the summary tree, the views, the queue
// of nodes to build and the status. Harness-neutral: it reads neutral history (HEntry) handed in by its
// host and never touches a session file; its own files are its sidecar (store.ts).
import type { HEntry } from "../../shared/harness";
import type { MemoryLine, MemoryMessage, MemoryStatus } from "../../shared/protocol";
import { memoryViewContent } from "../../pi-config/extensions/claude-code/provider/memory-view.ts";
import { inputStart, messagesBefore, messagesOf, type LogMessage } from "./log";
import { COMPACTION_GUIDE, leafTask, mergeTask, TURN_GUIDE, zoomableSummary } from "./prompts";
import { MemoryStore, type MemoryFileState } from "./store";
import type { SummaryCall, SummaryResult } from "./summarizer";
import { problemOf } from "./summarizer";
import {
  acceptLine,
  builtPrefix,
  bytes,
  count,
  covered,
  cutView,
  end,
  extendView,
  first,
  key,
  LIMIT,
  lineOf,
  mergeView,
  parentReady,
  readyMerges,
  splitView,
  viewBytes,
  type NodeRef,
  type Tree,
  type TreeNode,
} from "./tree";

/** How long a turn (or a zoomable compaction) waits for the newest messages' summaries (§chat.memory/turn). */
export const WAIT_MS = 20_000;
/** The summarizer's own view (its context), Taelin §4: merged down to 16 KB once past 32 KB. */
export const CVIEW_MAX = 32_000;
export const CVIEW_MIN = 16_000;
/** More unbuilt leaves than this before a turn: the chat is still being prepared, and the turn goes out
    without memory (§chat.memory/preparing). */
export const PREPARE_SLACK = 16;
export const CONCURRENCY = 4;
/** Consecutive failed summaries after which the queue pauses until the next message. */
export const FAILURE_PAUSE = 3;

export interface EngineDeps {
  summarize(call: SummaryCall): Promise<SummaryResult>;
  /** Every status change, throttled by the host as it likes. */
  onStatus?(status: MemoryStatus): void;
  cwd?: string;
  concurrency?: number;
  now?(): number;
  /** The wait a turn allows (tests shorten it). */
  waitMs?: number;
}

/** What a turn sends in place of its history (§chat.memory/turn). */
export interface TurnView {
  /** The view message's content blocks (memory-view.ts's declared shape). */
  content: { type: "text"; text: string }[];
  /** Messages the view covers: the turn's own start. */
  messages: number;
  bytes: number;
  lines: number;
  rebased: boolean;
  merges: number;
  waitedMs: number;
  /** Leaves still unbuilt when the turn went on. */
  pending: number;
}

export class MemoryEngine implements Tree {
  private nodes = new Map<string, TreeNode>();
  private state: MemoryFileState;
  private log: LogMessage[] = [];
  private leafQueue: number[] = [];
  private mergeQueue: NodeRef[] = [];
  private queued = new Set<string>();
  private running = new Set<string>();
  /** Bumped by every invalidation: a summary started before one is dropped. */
  private generation = 0;
  private failures = 0;
  private problem: string | undefined;
  private waiters = new Set<() => void>();
  private preparing = false;
  private updating: number | undefined;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    private readonly store: MemoryStore,
    private readonly deps: EngineDeps,
  ) {
    for (const n of store.loadNodes()) this.nodes.set(key(n.l, n.i), n);
    this.state = store.loadState();
  }

  get(l: number, i: number): TreeNode | undefined {
    return this.nodes.get(key(l, i));
  }

  get messages(): readonly LogMessage[] {
    return this.log;
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  // ---- the log ------------------------------------------------------------------------------------

  /**
   * Bring the engine in step with `branch`: derive the log again, drop every summary from the first
   * message that no longer matches (a rewind or a fork), queue what is new, and start building.
   */
  sync(branch: readonly HEntry[]): void {
    if (this.disposed) return;
    this.log = messagesOf(branch);
    let d = this.log.length;
    for (const n of this.nodes.values()) {
      if (n.l !== 0) continue;
      const m = this.log[n.i];
      if (!m || m.src !== n.src) d = Math.min(d, n.i);
    }
    const stale = [...this.nodes.values()].some((n) => end([n.l, n.i]) > d);
    if (stale || covered(this.state.view) > this.log.length || covered(this.state.cview) > this.log.length) this.invalidate(d);
    for (let i = 0; i < this.log.length; i++) if (!this.get(0, i)) this.enqueueLeaf(i);
    for (const ref of readyMerges(this.nodes.values(), this)) this.enqueueMerge(ref);
    this.failures = 0;
    this.pump();
    this.emit();
  }

  /** Everything from message `d` on is gone (or differs): its summaries, and the views' lines past it. */
  private invalidate(d: number): void {
    this.generation++;
    for (const [k, n] of this.nodes) if (end([n.l, n.i]) > d) this.nodes.delete(k);
    this.store.rewriteNodes(this.nodes.values());
    this.state = {
      ...this.state,
      view: cutView(this, this.state.view, d),
      merging: false,
      cview: cutView(this, this.state.cview, d),
      cmerging: false,
    };
    delete this.state.prefix;
    delete this.state.cprefix;
    this.store.saveState(this.state);
    this.leafQueue = this.leafQueue.filter((i) => i < d);
    this.mergeQueue = this.mergeQueue.filter((r) => end(r) <= d);
    this.queued = new Set([...this.leafQueue.map((i) => key(0, i)), ...this.mergeQueue.map(([l, i]) => key(l, i))]);
  }

  /** Turned on in a chat with history: until the leaves are built, turns go out without memory. */
  startPreparing(): void {
    this.preparing = this.unbuiltLeaves(this.log.length) > PREPARE_SLACK;
    this.emit();
  }

  // ---- building -----------------------------------------------------------------------------------

  private enqueueLeaf(i: number): void {
    const k = key(0, i);
    if (this.queued.has(k) || this.running.has(k)) return;
    this.queued.add(k);
    // Leaves in message order: each one's context is the lines before it.
    if (!this.leafQueue.length || this.leafQueue[this.leafQueue.length - 1]! < i) this.leafQueue.push(i);
    else {
      this.leafQueue.push(i);
      this.leafQueue.sort((a, b) => a - b);
    }
  }

  private enqueueMerge(ref: NodeRef): void {
    const k = key(ref[0], ref[1]);
    if (this.queued.has(k) || this.running.has(k) || this.get(ref[0], ref[1])) return;
    this.queued.add(k);
    this.mergeQueue.push(ref);
  }

  private next(): NodeRef | undefined {
    const leaf = this.leafQueue.shift();
    if (leaf !== undefined) return [0, leaf];
    return this.mergeQueue.shift();
  }

  /** Start ready nodes up to the concurrency; never a scan of the tree (Taelin §4). */
  pump(): void {
    if (this.disposed) return;
    const limit = this.deps.concurrency ?? CONCURRENCY;
    while (this.running.size < limit && this.failures < FAILURE_PAUSE) {
      const ref = this.next();
      if (!ref) break;
      const k = key(ref[0], ref[1]);
      this.queued.delete(k);
      if (this.get(ref[0], ref[1])) continue;
      this.running.add(k);
      const generation = this.generation;
      this.build(ref, generation)
        .then(() => {
          this.failures = 0;
          this.problem = undefined;
        })
        .catch((err) => {
          this.failures++;
          this.problem = problemOf(err);
        })
        .finally(() => {
          this.running.delete(k);
          this.wake();
          this.pump();
          this.emit();
        });
    }
    this.wake();
  }

  private put(n: TreeNode, generation: number): void {
    if (generation !== this.generation || this.disposed) return;
    this.nodes.set(key(n.l, n.i), n);
    this.store.appendNode(n);
    const parent = parentReady(this, [n.l, n.i]);
    if (parent) this.enqueueMerge(parent);
    if (n.l === 0) this.extendCview();
  }

  private async build([l, i]: NodeRef, generation: number): Promise<void> {
    if (l === 0) {
      const m = this.log[i];
      if (!m) return;
      const short = `${m.kind}: ${m.text}`;
      // A message that fits is its own line, word for word, with no model call.
      if (bytes(short) <= LIMIT) return this.put({ l, i, text: short, size: bytes(short), src: m.src }, generation);
      const text = await this.summarizeNode(i, leafTask(i, m.kind, m.text));
      return this.put({ l, i, text, size: bytes(text), src: m.src }, generation);
    }
    const a = this.get(l - 1, 2 * i);
    const b = this.get(l - 1, 2 * i + 1);
    if (!a || !b) return;
    const joined = `${a.text}\n${b.text}`;
    if (bytes(joined) <= LIMIT) return this.put({ l, i, text: joined, size: bytes(joined) }, generation);
    const half = 2 ** (l - 1);
    const text = await this.summarizeNode(end([l, i]), mergeTask(first([l, i]), half, a.text.replace(/\n/g, " "), b.text.replace(/\n/g, " ")));
    return this.put({ l, i, text, size: bytes(text) }, generation);
  }

  /** One summary with the compaction view up to message `cut` as its context, cached by its stable prefix. */
  private async summarizeNode(cut: number, task: string): Promise<string> {
    const lines = this.state.cview.filter((r) => end(r) <= cut).map((r) => lineOf(this, r));
    const { system, newer } = this.cviewSplit(lines);
    const prompt = newer.length ? `<chat> (continued: the newest lines)\n${newer.join("\n")}\n</chat>\n\n${task}` : `${task}`;
    const result = await this.deps.summarize({ system, prompt, sessionId: this.sessionId, ...(this.deps.cwd ? { cwd: this.deps.cwd } : {}) });
    const line = acceptLine(result.text);
    if (!line) throw new Error("the summarizer returned an empty line");
    return line;
  }

  /**
   * The summarizer's system prompt and the context lines after it: the saved prefix while it leads these
   * lines and the rest stays small, else a rebase onto them. A node older than the prefix's end gets the
   * guide alone (its context must end at the node).
   */
  private cviewSplit(lines: string[]): { system: string; newer: string[] } {
    const prev = this.state.cprefix;
    const prefixOf = (p: readonly string[]) => `${COMPACTION_GUIDE}\n\n<chat>\n${p.length ? `${p.join("\n")}\n` : ""}</chat>`;
    if (prev && prev.length > lines.length && lines.every((l, k) => l === prev[k])) return { system: COMPACTION_GUIDE, newer: lines };
    const split = splitView(lines, prev, lines.length);
    if (split.rebased) {
      this.state = { ...this.state, cprefix: split.prefix };
      this.store.saveState(this.state);
    }
    return { system: prefixOf(split.prefix), newer: split.tail };
  }

  /** The compaction view takes each built leaf in order, and merges past CVIEW_MAX down to CVIEW_MIN. */
  private extendCview(): void {
    let view = this.state.cview;
    let T = covered(view);
    while (this.get(0, T) && T < this.log.length) T++;
    if (T === covered(view)) return;
    view = extendView(view, T);
    const merged = mergeView(this, view, T, CVIEW_MAX, CVIEW_MIN, this.state.cmerging);
    this.state = { ...this.state, cview: merged.view, cmerging: merged.merging };
    this.store.saveState(this.state);
  }

  private unbuiltLeaves(T: number): number {
    let n = 0;
    for (let i = 0; i < T; i++) if (!this.get(0, i)) n++;
    return n;
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Wait until every leaf before `T` is built, at most `ms`; resolves to the leaves still unbuilt. */
  async waitForLeaves(T: number, ms: number): Promise<number> {
    const deadline = (this.deps.now?.() ?? Date.now()) + ms;
    for (;;) {
      const left = this.unbuiltLeaves(T);
      if (left === 0 || this.disposed) return left;
      // Nothing running and nothing queued: no summary will arrive (paused after failures).
      if (this.running.size === 0 && (this.leafQueue.length === 0 || this.failures >= FAILURE_PAUSE)) return left;
      const remaining = deadline - (this.deps.now?.() ?? Date.now());
      if (remaining <= 0) return left;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        timer.unref?.();
        this.waiters.add(done);
      });
    }
  }

  // ---- a turn -------------------------------------------------------------------------------------

  /**
   * The view a UniiChat turn sends in place of its history (§chat.memory/turn): every message before the
   * turn's input, once the newest leaves are built (at most the wait), merged per the chat's size, and
   * split for the cache. undefined while the chat is still being prepared: the turn goes out as usual.
   */
  async turnView(branch: readonly HEntry[], sizeKB: number): Promise<TurnView | undefined> {
    this.sync(branch);
    const T = messagesBefore(branch, inputStart(branch));
    if (this.preparing && this.unbuiltLeaves(T) > PREPARE_SLACK) return undefined;
    this.preparing = false;
    const started = this.deps.now?.() ?? Date.now();
    let pending = this.unbuiltLeaves(T);
    if (pending > 0) {
      this.updating = pending;
      this.emit();
      try {
        pending = await this.waitForLeaves(T, this.deps.waitMs ?? WAIT_MS);
      } finally {
        this.updating = undefined;
      }
    }
    const waitedMs = (this.deps.now?.() ?? Date.now()) - started;
    let view = covered(this.state.view) > T ? cutView(this, this.state.view, T) : this.state.view;
    view = extendView(view, T);
    const max = sizeKB * 1024;
    const merged = mergeView(this, view, T, max, max / 2, this.state.merging);
    const lines = merged.view.map((r) => lineOf(this, r));
    const split = splitView(lines, this.state.prefix, builtPrefix(this, merged.view).length);
    this.state = { ...this.state, view: merged.view, merging: merged.merging, prefix: split.prefix };
    this.store.saveState(this.state);
    this.emit();
    return {
      content: memoryViewContent(TURN_GUIDE, split.prefix, split.tail),
      messages: T,
      bytes: viewBytes(this, merged.view),
      lines: lines.length,
      rebased: split.rebased,
      merges: merged.merges,
      waitedMs,
      pending,
    };
  }

  // ---- zoomable compaction -----------------------------------------------------------------------

  /**
   * A zoomable compaction's summary (§chat.memory/zoomable): the view of the messages from entries
   * `branch[0..keptAt)`, merged down to the chat's size, under the explanation of its lines. undefined when
   * nothing is compacted, or the view can't come within twice the size (pi's own summary then).
   */
  async compactionSummary(branch: readonly HEntry[], keptAt: number, sizeKB: number): Promise<{ summary: string; messages: number; lines: NodeRef[] } | undefined> {
    this.sync(branch);
    const T = messagesBefore(branch, keptAt);
    if (T === 0) return undefined;
    this.updating = this.unbuiltLeaves(T) || undefined;
    if (this.updating) this.emit();
    try {
      await this.waitForLeaves(T, this.deps.waitMs ?? WAIT_MS);
    } finally {
      this.updating = undefined;
    }
    const size = sizeKB * 1024;
    const merged = mergeView(this, extendView([], T), T, size, size, true);
    if (viewBytes(this, merged.view) > 2 * size) return undefined;
    this.emit();
    return { summary: zoomableSummary(merged.view.map((r) => lineOf(this, r)), T), messages: T, lines: merged.view };
  }

  // ---- recall -------------------------------------------------------------------------------------

  /** zoom(id, n) (§chat.memory/recall): the two lines under line id+n, or message id whole. */
  zoom(id: number, n: number): string {
    this.checkRef(id, n);
    if (n === 1) return messageText(this.log[id]!);
    const half = n / 2;
    const l = Math.log2(n) - 1;
    const out = [lineOf(this, [l, id / half])];
    if (id + half < this.log.length) out.push(lineOf(this, [l, id / half + 1]));
    return out.join("\n");
  }

  /** date(id): the message's date and time. */
  date(id: number): string {
    this.checkRef(id, 1);
    return this.log[id]!.at ?? "unknown";
  }

  private checkRef(id: number, n: number): void {
    if (!Number.isInteger(id) || !Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0 || id < 0 || id % n !== 0)
      throw new Error("zoom(id, n): n is a power of 2 and id a multiple of n");
    if (id >= this.log.length) throw new Error(`no message ${id}: the chat has ${this.log.length}`);
  }

  // ---- the web's outline --------------------------------------------------------------------------

  memoryLine(ref: NodeRef): MemoryLine {
    const lastAt = Math.min(end(ref), this.log.length) - 1;
    const n = this.get(ref[0], ref[1]);
    return {
      id: first(ref),
      n: count(ref),
      text: n ? n.text : null,
      entryId: this.log[first(ref)]?.entryId ?? null,
      lastEntryId: this.log[lastAt]?.entryId ?? null,
    };
  }

  /** The view the next turn would send (no merge yet: that happens at the turn). */
  currentView(): NodeRef[] {
    const view = covered(this.state.view) > this.log.length ? cutView(this, this.state.view, this.log.length) : this.state.view;
    return extendView(view, this.log.length);
  }

  viewBytesOf(view: readonly NodeRef[]): number {
    return viewBytes(this, view);
  }

  /** The two lines under line id+n, or message id whole, for the outline. */
  open(id: number, n: number): { lines: MemoryLine[] } | { message: MemoryMessage } {
    this.checkRef(id, n);
    if (n === 1) {
      const m = this.log[id]!;
      return { message: { id, kind: m.kind, text: m.text, entryId: m.entryId, ...(m.at ? { at: m.at } : {}), ...(m.page ? { page: m.page } : {}) } };
    }
    const half = n / 2;
    const l = Math.log2(n) - 1;
    const lines = [this.memoryLine([l, id / half])];
    if (id + half < this.log.length) lines.push(this.memoryLine([l, id / half + 1]));
    return { lines };
  }

  status(): MemoryStatus {
    const extra = this.problem ? { problem: this.problem } : {};
    if (this.preparing) {
      const total = this.log.length;
      return { state: "preparing", done: total - this.unbuiltLeaves(total), total, ...extra };
    }
    if (this.updating !== undefined) return { state: "updating", pending: this.updating, ...extra };
    return { state: "ready", messages: this.log.length, background: this.running.size + this.queued.size, ...extra };
  }

  private emit(): void {
    if (this.disposed) return;
    if (this.preparing && this.unbuiltLeaves(this.log.length) <= PREPARE_SLACK) this.preparing = false;
    this.deps.onStatus?.(this.status());
  }

  /** Idle: nothing queued or running (tests and the backfill's end). */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.disposed || (this.running.size === 0 && (this.queued.size === 0 || this.failures >= FAILURE_PAUSE))) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
  }
}

/** A message whole, as zoom(id, 1) gives it. */
export function messageText(m: LogMessage): string {
  const page = m.page ? ` (page ${m.page.index} of ${m.page.of})` : "";
  return `${m.i}|${m.kind}${page}: ${m.text}`;
}

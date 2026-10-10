// The summary tree and its views (§chat.memory/tree), after Victor Taelin's UniiChat
// (https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449, §2–§4). Pure: no files, no
// model calls. node(0, i) is message i; node(l, i) merges (l-1, 2i) and (l-1, 2i+1) and covers the 2^l
// messages from i·2^l on, named `id+n`. A view is a list of nodes covering messages 0..T-1, oldest first.

/** A line's asked size, bytes; the ruler the summarizer sees is this long. */
export const LIMIT = 512;
/** A reply up to this is accepted as it is; a longer one is cut at a sentence end within it. */
export const ACCEPT = 768;
/** What a line not summarized yet reads in a view. */
export const PLACEHOLDER = "(not summarized yet: zoom it)";

export interface TreeNode {
  l: number;
  i: number;
  text: string;
  size: number;
  /** A leaf's message source (log.ts LogMessage.src): whether it still matches the branch. */
  src?: string;
}

export type NodeRef = readonly [l: number, i: number];

export const key = (l: number, i: number): string => `${l}:${i}`;
export const first = ([l, i]: NodeRef): number => i * 2 ** l;
export const count = ([l]: NodeRef): number => 2 ** l;
/** One past the node's last message. */
export const end = (n: NodeRef): number => first(n) + count(n);
export const bytes = (s: string): number => Buffer.byteLength(s);
export const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ");

/** The tree as the engine holds it: built nodes by key. */
export interface Tree {
  get(l: number, i: number): TreeNode | undefined;
}

/** A view line: `id+n|text` (newlines as spaces), or the placeholder for a node not built yet. */
export function lineOf(tree: Tree, [l, i]: NodeRef): string {
  return `${i * 2 ** l}+${2 ** l}|${oneLine(tree.get(l, i)?.text ?? PLACEHOLDER)}`;
}

/** A view's size: its lines, each with its newline. */
export function viewBytes(tree: Tree, view: readonly NodeRef[]): number {
  let n = 0;
  for (const ref of view) n += bytes(lineOf(tree, ref)) + 1;
  return n;
}

/** The messages a view covers (its lines are contiguous from 0). */
export const covered = (view: readonly NodeRef[]): number => (view.length ? end(view[view.length - 1]!) : 0);

/** The view with a line appended for each message from its end up to `T` (Taelin §3.2: each new
    message appends its line; nothing else changes). */
export function extendView(view: readonly NodeRef[], T: number): NodeRef[] {
  const out = [...view];
  for (let j = covered(view); j < T; j++) out.push([0, j]);
  return out;
}

/** Due of the sibling pair starting with `ref` when the chat has `T` messages: how long ago the pair
    ended, in its own line size. Measured from the pair's LAST message (gist §3.2: from the first, old
    lines churn). */
export function due([l, i]: NodeRef, T: number): number {
  const last = (i + 2) * 2 ** l - 1;
  return (T - last) / 2 ** l;
}

export interface MergeResult {
  view: NodeRef[];
  merges: number;
  /** A batch is still under way (it couldn't reach `min` yet): merge again at the next message. */
  merging: boolean;
}

/**
 * Taelin's batch (§3.2): once the view passes `max` bytes (or a batch is still under way), merge the
 * most due sibling pair whose parent is built, the oldest on a tie, again and again until the view is at
 * most `min`. A batch that can't reach `min` (parents not built yet) stops and stays under way.
 */
export function mergeView(tree: Tree, view: readonly NodeRef[], T: number, max: number, min: number, merging = false): MergeResult {
  const out = [...view];
  let size = viewBytes(tree, out);
  if (!merging && size <= max) return { view: out, merges: 0, merging: false };
  let merges = 0;
  while (size > min) {
    let best = -1;
    let bestDue = -Infinity;
    for (let k = 0; k + 1 < out.length; k++) {
      const [l, i] = out[k]!;
      const [l2, i2] = out[k + 1]!;
      if (l !== l2 || i % 2 !== 0 || i2 !== i + 1 || !tree.get(l + 1, i / 2)) continue;
      const d = due([l, i], T);
      if (d > bestDue) {
        bestDue = d;
        best = k; // strict: the oldest pair wins a tie
      }
    }
    if (best < 0) break;
    const [l, i] = out[best]!;
    size -= bytes(lineOf(tree, out[best]!)) + bytes(lineOf(tree, out[best + 1]!)) + 2;
    out.splice(best, 2, [l + 1, i / 2]);
    size += bytes(lineOf(tree, out[best]!)) + 1;
    merges++;
  }
  return { view: out, merges, merging: size > min };
}

/**
 * The view cut back to messages before `d` (a rewind or fork changed message `d` on): every line that
 * ends by `d` stays, and a line that straddles it is replaced by the largest built nodes that cover its
 * part before `d` (leaves at worst).
 */
export function cutView(tree: Tree, view: readonly NodeRef[], d: number): NodeRef[] {
  const out: NodeRef[] = [];
  for (const ref of view) {
    if (end(ref) <= d) {
      out.push(ref);
      continue;
    }
    out.push(...coverRange(tree, first(ref), Math.min(end(ref), d)));
    break;
  }
  return out;
}

/** Aligned nodes covering messages [from, to), the largest built one at each step (leaves need not be). */
export function coverRange(tree: Tree, from: number, to: number): NodeRef[] {
  const out: NodeRef[] = [];
  let s = from;
  while (s < to) {
    let pick: NodeRef = [0, s];
    for (let l = 1; s % 2 ** l === 0 && s + 2 ** l <= to; l++) if (tree.get(l, s / 2 ** l)) pick = [l, s / 2 ** l];
    out.push(pick);
    s = end(pick);
  }
  return out;
}

/** Built-only prefix of a view: its lines up to the first node not built yet. */
export function builtPrefix(tree: Tree, view: readonly NodeRef[]): NodeRef[] {
  const out: NodeRef[] = [];
  for (const ref of view) {
    if (!tree.get(ref[0], ref[1])) break;
    out.push(ref);
  }
  return out;
}

export interface Split {
  /** The stable prefix's lines: the cached part (a system prompt's end, or the view message's first block). */
  prefix: string[];
  /** The lines after it. */
  tail: string[];
  /** The prefix was renewed at this split. */
  rebased: boolean;
  /** Tail bytes sent since the prefix was last renewed, this split's included (0 without a cost). */
  sent: number;
}

/** What a rebase re-writes and what the tails re-wrote so far, for a split that weighs one against the other. */
export interface SplitCost {
  /** Bytes a rebase re-writes besides the prefix's own lines: what shares its cached block (prompt, guide). */
  fixed: number;
  /** Tail bytes sent since the prefix was last renewed (the previous split's `sent`). */
  sent: number;
}

/** The smallest tail a split keeps a prefix for, bytes. */
export const TAIL_FLOOR = 1536;

/**
 * The cache split (§chat.memory/turn, spike cache-fix): keep the previous prefix while it still leads the
 * view, line for line, and the lines after it stay small; else rebase: the view's built lines up to its
 * first placeholder become the prefix. With a cost (a turn), "small" weighs the two writes: a turn that
 * keeps the prefix re-writes its tail, a rebase re-writes the prefix's whole cached block (`fixed` plus the
 * prefix), so the prefix is kept while the tails sent since it was renewed, this one included, total at
 * most that block (and at least TAIL_FLOOR). Tails growing by g bytes a turn then rebase about every
 * √(2·block/g) turns, the fewest bytes written per turn. Without a cost (the summarizer's compaction
 * view): the tail stays under the larger of TAIL_FLOOR and a quarter of the prefix.
 */
export function splitView(lines: readonly string[], previous: readonly string[] | undefined, builtLines: number, cost?: SplitCost): Split {
  if (previous && previous.length <= lines.length && previous.every((l, k) => l === lines[k])) {
    const tail = lines.slice(previous.length);
    const tailBytes = tail.length ? bytes(tail.join("\n")) : 0;
    const prefixBytes = bytes(previous.join("\n"));
    if (cost) {
      const sent = cost.sent + tailBytes;
      if (sent <= Math.max(TAIL_FLOOR, cost.fixed + prefixBytes)) return { prefix: [...previous], tail, rebased: false, sent };
    } else if (tailBytes <= Math.max(TAIL_FLOOR, prefixBytes / 4)) return { prefix: [...previous], tail, rebased: false, sent: 0 };
  }
  const n = Math.min(builtLines, lines.length);
  const tail = lines.slice(n);
  return { prefix: lines.slice(0, n), tail, rebased: true, sent: cost && tail.length ? bytes(tail.join("\n")) : 0 };
}

/** `s` cut to at most `n` bytes at its last sentence end (else at a word, else anywhere), never inside a
    character. */
export function cutSentence(s: string, n: number): string {
  if (bytes(s) <= n) return s;
  const head = Buffer.from(s).subarray(0, n).toString("utf8").replace(/�$/, "");
  const ends = [". ", "; ", "! ", "? ", ".\n", "!\n", "?\n"].map((p) => head.lastIndexOf(p));
  const at = Math.max(...ends);
  if (at > head.length / 2) return head.slice(0, at + 1).trimEnd();
  if (/[.!?]$/.test(head)) return head;
  const sp = head.lastIndexOf(" ");
  return sp > head.length / 2 ? head.slice(0, sp) : head;
}

/** A summarizer's reply as a line: one line, no `id+n|` head, at most ACCEPT bytes (§chat.memory/tree). */
export function acceptLine(reply: string): string {
  const line = oneLine(reply.trim()).replace(/^\d+\+\d+\|/, "").trim();
  return cutSentence(line, ACCEPT);
}

/** Every ready merge of a tree (both halves built, parent not), for a queue built once at load. */
export function readyMerges(nodes: Iterable<TreeNode>, tree: Tree): NodeRef[] {
  const out: NodeRef[] = [];
  for (const n of nodes) {
    if (n.i % 2 !== 0) continue;
    if (tree.get(n.l, n.i + 1) && !tree.get(n.l + 1, n.i / 2)) out.push([n.l + 1, n.i / 2]);
  }
  return out;
}

/** The parent a newly built node makes ready, if its sibling is built and the parent isn't. */
export function parentReady(tree: Tree, [l, i]: NodeRef): NodeRef | undefined {
  const sib = i ^ 1;
  if (!tree.get(l, sib) || tree.get(l + 1, i >> 1)) return undefined;
  return [l + 1, i >> 1];
}

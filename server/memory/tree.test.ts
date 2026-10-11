// The summary tree and its views (§chat.memory/tree): pure, no files and no model calls.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  acceptLine,
  ACCEPT,
  coverRange,
  cutSentence,
  cutView,
  due,
  extendView,
  lineOf,
  mergeView,
  parentReady,
  PLACEHOLDER,
  splitView,
  viewBytes,
  type NodeRef,
  type Tree,
  type TreeNode,
} from "./tree";

/** A tree where every node exists, each line exactly `w` bytes long with its `id+n|` head. */
function fullTree(w: number): Tree {
  return {
    get(l: number, i: number): TreeNode {
      const head = `${i * 2 ** l}+${2 ** l}|`;
      const text = "x".repeat(Math.max(1, w - head.length));
      return { l, i, text, size: text.length };
    },
  };
}

/** Taelin's rollback push (gist §3.1), verbatim but for names: the states it keeps, newest first. */
type PushList = { keep: number; life: number; state: number; older: PushList } | null;
function push(state: number, states: PushList): PushList {
  if (states === null) return { keep: 0, life: 0, state, older: null };
  const { keep, life, state: s, older } = states;
  if (keep === 0) return { keep: 1, life, state: s, older };
  if (life > 0) return { keep: 0, life: 0, state, older: { keep: 0, life: life - 1, state: s, older } };
  return { keep: 0, life, state, older: push(s, older) };
}
function starts(list: PushList): number[] {
  const out: number[] = [];
  for (let s = list; s; s = s.older) out.push(s.state);
  return out.reverse();
}

describe("the due rule", () => {
  test("measured from the pair's last message, in its own line size", () => {
    // Pairs that ended 3 lines of their own size ago are equally due (gist §3.2).
    assert.equal(due([0, 6], 10), (10 - 7) / 1);
  });

  test("with push's length as the budget, the view merges exactly what push keeps, t = 1..3000", () => {
    const w = 16;
    const tree = fullTree(w);
    let list: PushList = null;
    let view: NodeRef[] = [];
    for (let t = 0; t < 3000; t++) {
      list = push(t, list);
      view = extendView(view, t + 1);
      const budget = starts(list).length * (w + 1);
      view = mergeView(tree, view, t + 1, budget, budget).view;
      assert.deepEqual(view.map(([l, i]) => i * 2 ** l), starts(list), `t=${t}`);
    }
  });

  test("measuring from the FIRST message would differ (the gist's T=10 example): ours merges 8–9", () => {
    const tree = fullTree(16);
    const view: NodeRef[] = [[2, 0], [2, 1], [0, 8], [0, 9]];
    const merged = mergeView(tree, view, 10, 3 * 17, 3 * 17).view;
    assert.deepEqual(merged, [[2, 0], [2, 1], [1, 4]]);
  });
});

describe("the view", () => {
  test("a sawtooth: nothing merges until past max, then one batch down to min", () => {
    const tree = fullTree(100);
    let view: NodeRef[] = [];
    let merging = false;
    const sizes: number[] = [];
    for (let T = 1; T <= 200; T++) {
      view = extendView(view, T);
      const r = mergeView(tree, view, T, 4000, 2000, merging);
      view = r.view;
      merging = r.merging;
      sizes.push(viewBytes(tree, view));
      if (r.merges) assert.ok(viewBytes(tree, view) <= 2000, `T=${T}: a batch ends at min`);
    }
    assert.ok(Math.max(...sizes) <= 4000 + 101);
    assert.ok(sizes.filter((s, k) => k > 0 && s < sizes[k - 1]!).length < 15, "merges come in a few batches, not at every message");
  });

  test("only pairs whose parent is built merge; a batch short of min stays under way", () => {
    const leaves: Tree = { get: (l, i) => (l === 0 ? { l, i, text: "y".repeat(90), size: 90 } : undefined) };
    const view = extendView([], 50);
    const r = mergeView(leaves, view, 50, 1000, 500);
    assert.equal(r.merges, 0);
    assert.equal(r.merging, true);
  });

  test("an unbuilt line reads as the placeholder", () => {
    const empty: Tree = { get: () => undefined };
    assert.equal(lineOf(empty, [3, 5]), `40+8|${PLACEHOLDER}`);
  });

  test("a rewind cuts the view back to the lines before it, covering the cut line with the largest built nodes", () => {
    const tree = fullTree(10);
    const view: NodeRef[] = [[3, 0], [2, 2], [0, 12]];
    assert.deepEqual(cutView(tree, view, 13), [[3, 0], [2, 2], [0, 12]]);
    assert.deepEqual(cutView(tree, view, 11), [[3, 0], [1, 4], [0, 10]]);
    assert.deepEqual(cutView(tree, view, 3), [[1, 0], [0, 2]]);
    const leavesOnly: Tree = { get: (l, i) => (l === 0 ? { l, i, text: "z", size: 1 } : undefined) };
    assert.deepEqual(coverRange(leavesOnly, 4, 7), [[0, 4], [0, 5], [0, 6]]);
  });

  test("a newly built node makes its parent ready only when its sibling is built", () => {
    const built = new Set(["0:0", "0:1", "1:0"]);
    const tree: Tree = { get: (l, i) => (built.has(`${l}:${i}`) ? { l, i, text: "a", size: 1 } : undefined) };
    assert.equal(parentReady(tree, [0, 1]), undefined, "(1,0) is already built");
    assert.equal(parentReady(tree, [1, 0]), undefined, "(1,1) isn't");
    built.add("1:1");
    assert.deepEqual(parentReady(tree, [1, 1]), [2, 0]);
  });
});

describe("the cache split", () => {
  const L = (n: number, from = 0) => Array.from({ length: n }, (_, k) => `${from + k}+1|line ${from + k} ${"p".repeat(60)}`);

  test("the first split puts the built lines in the prefix", () => {
    const s = splitView(L(10), undefined, 8);
    assert.deepEqual([s.prefix.length, s.tail.length, s.rebased], [8, 2, true]);
  });

  test("the prefix is kept while it leads the view and the tail stays under max(1536 B, prefix/4)", () => {
    const prefix = L(40);
    const kept = splitView([...prefix, ...L(10, 40)], prefix, 50);
    assert.deepEqual([kept.prefix.length, kept.tail.length, kept.rebased], [40, 10, false]);
    const grown = splitView([...prefix, ...L(60, 40)], prefix, 100);
    assert.equal(grown.rebased, true, "a tail past its limit rebases");
    assert.equal(grown.prefix.length, 100);
  });

  test("a merge that rewrote a prefix line rebases", () => {
    const prefix = L(20);
    const merged = ["0+2|merged", ...prefix.slice(2), ...L(2, 20)];
    assert.equal(splitView(merged, prefix, merged.length).rebased, true);
    assert.equal(splitView(merged, prefix, merged.length, { fixed: 1e9, sent: 0 }).rebased, true, "whatever a rebase costs");
  });

  /** Turns that each add `perTurn` lines (~73 B each) to a view that never merges: what each split did. */
  const simulate = (turns: number, perTurn: number, fixed: number | undefined) => {
    let prefix: string[] | undefined;
    let sent = 0;
    let lines: string[] = [];
    const out: { rebased: boolean; written: number }[] = [];
    for (let t = 0; t < turns; t++) {
      lines = [...lines, ...L(perTurn, lines.length)];
      const s = splitView(lines, prefix, lines.length, fixed === undefined ? undefined : { fixed, sent });
      const block = (fixed ?? 0) + Buffer.byteLength(s.prefix.join("\n"));
      // Bytes written to the cache this turn: the whole block on a rebase, else the tail.
      out.push({ rebased: s.rebased, written: s.rebased ? block : Buffer.byteLength(s.tail.join("\n")) });
      prefix = s.prefix;
      sent = s.sent;
    }
    return out;
  };

  test("with a cost, the tails sent since a rebase total at most the block a rebase re-writes", () => {
    const prefix = L(40); // 40 lines of 73 B
    const fixed = 4000;
    const block = fixed + Buffer.byteLength(prefix.join("\n"));
    const one = splitView([...prefix, ...L(10, 40)], prefix, 50, { fixed, sent: 0 });
    assert.deepEqual([one.rebased, one.sent], [false, Buffer.byteLength(L(10, 40).join("\n"))], "sent counts this tail");
    const near = splitView([...prefix, ...L(10, 40)], prefix, 50, { fixed, sent: block - one.sent });
    assert.equal(near.rebased, false, "exactly the block: kept");
    const over = splitView([...prefix, ...L(10, 40)], prefix, 50, { fixed, sent: block - one.sent + 1 });
    assert.deepEqual([over.rebased, over.prefix.length, over.sent], [true, 50, 0], "past it: a rebase, the count starts over");
    const placeholders = splitView([...prefix, ...L(10, 40)], undefined, 45, { fixed, sent: 0 });
    assert.equal(placeholders.sent, Buffer.byteLength(L(5, 45).join("\n")), "a rebase's own tail (lines not built yet) counts");
  });

  test("a 35k-token prompt in the block: rebases about every √(2·block/growth) turns, far rarer than the quarter rule", () => {
    const prompt = 120_000; // ≈ 35k tokens of system prompt sharing the prefix's block
    const growth = 20 * 73; // ≈ 1.4 KB of new lines a turn
    const weighed = simulate(60, 20, prompt);
    const quarter = simulate(60, 20, undefined);
    const rebases = (r: { rebased: boolean }[]) => r.filter((x) => x.rebased).length;
    const expected = 60 / Math.sqrt((2 * (prompt + 30 * growth)) / growth);
    assert.ok(rebases(weighed) >= 2 && rebases(weighed) <= Math.ceil(expected) + 2, `weighed: ${rebases(weighed)} rebases (≈${expected.toFixed(1)} expected)`);
    assert.ok(rebases(quarter) >= 2 * rebases(weighed), `weighed ${rebases(weighed)} rebases, the quarter rule ${rebases(quarter)}`);
    // Bytes written with the prompt counted, either rule (the quarter rule's rebases re-write the prompt too).
    const written = (r: { rebased: boolean; written: number }[], fixed: number) => r.reduce((a, x) => a + x.written + (x.rebased ? fixed : 0), 0);
    assert.ok(written(weighed, 0) < 0.7 * written(quarter, prompt), `weighed ${written(weighed, 0)} B vs quarter ${written(quarter, prompt)} B`);
    // Within a quarter of the best fixed rebase period, found by trying them all.
    const periodic = (p: number) => {
      let total = 0;
      for (let t = 0, base = 0; t < 60; t++) {
        if (t % p === 0) (base = (t + 1) * growth), (total += prompt + base);
        else total += (t + 1) * growth - base;
      }
      return total;
    };
    const best = Math.min(...Array.from({ length: 60 }, (_, k) => periodic(k + 1)));
    assert.ok(written(weighed, 0) <= 1.25 * best, `weighed ${written(weighed, 0)} B vs the best period's ${best} B`);
  });

  test("the prompt's size is weighed: a bigger prompt keeps the prefix longer", () => {
    const rebases = (fixed: number) => simulate(60, 20, fixed).filter((x) => x.rebased).length;
    const small = rebases(2_000);
    const big = rebases(120_000);
    assert.ok(big < small, `120 KB prompt: ${big} rebases; 2 KB: ${small}`);
    assert.ok(small < 30, "even a small block keeps the prefix more than every other turn once it holds the view");
  });
});

describe("the line rule", () => {
  test("a reply up to 768 bytes is kept; a longer one is cut at its last sentence end", () => {
    const ok = `user: ${"a".repeat(700)}.`;
    assert.equal(acceptLine(ok), ok);
    const long = `${"First sentence. ".repeat(40)}Tail without end ${"z".repeat(200)}`;
    const cut = acceptLine(long);
    assert.ok(Buffer.byteLength(cut) <= ACCEPT);
    assert.ok(cut.endsWith("."), cut.slice(-20));
  });

  test("never splits a character, drops an id+n head and joins lines", () => {
    assert.equal(acceptLine("4+2|one\ntwo"), "one two");
    const cut = cutSentence("é".repeat(500), 768);
    assert.ok(Buffer.byteLength(cut) <= 768);
    assert.doesNotMatch(cut, /�/);
  });
});

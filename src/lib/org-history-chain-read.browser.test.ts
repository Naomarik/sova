// Run: node scripts/run-tests.mjs src/lib/org-history-chain-read.browser.test.ts (the browser pass: Solid's
// reactive build). The Causal View stays mounted while the address moves from one event's chain to
// another's (a chain card's link, Back, Forward): the chain must be read again for the new event, never
// the old event's chain drawn around a root it doesn't hold, and an answer for the old event is dropped.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");
import type { HistoryChain } from "../../shared/org-history";

(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
const solid = await import("solid-js");
const { createHistoryChain } = await import("./org-history-source");

const flush = () => new Promise<void>((r) => setImmediate(r));
const chainOf = (root: string, cursor: string | null = null, extra: string[] = []): HistoryChain =>
  ({
    root,
    nodes: [root, ...extra].map((id) => ({ id, hop: 0 })),
    edges: [],
    omitted: { before: 0, after: 0 },
    cursor,
    noTrigger: [],
    freshness: { through: null, events: 1, current: true, rebuiltAt: null },
  }) as unknown as HistoryChain;

test("another event's Causal View reads that event's chain; a late answer for the old one is dropped", async () => {
  const calls: { root: string; projects: string[]; cursor?: string; resolve: (c: HistoryChain) => void }[] = [];
  const { c, setRoot, setProjects, dispose } = solid.createRoot((dispose) => {
    const [root, setRoot] = solid.createSignal("he_a");
    const [projects, setProjects] = solid.createSignal<string[]>([]);
    const c = createHistoryChain({
      root,
      projects,
      fetch: (r, p, cursor) => new Promise<HistoryChain>((resolve) => calls.push({ root: r, projects: p, ...(cursor ? { cursor } : {}), resolve })),
    });
    return { c, setRoot, setProjects, dispose };
  });
  await flush();
  assert.deepEqual(calls.map((x) => x.root), ["he_a"]);
  calls[0]!.resolve(chainOf("he_a", "cur_a"));
  await flush();
  assert.equal(c.chain()?.root, "he_a");

  // A chain card's link: the same view, another event.
  setRoot("he_b");
  await flush();
  assert.deepEqual(calls.map((x) => x.root), ["he_a", "he_b"]);
  assert.equal(c.chain(), null, "the old event's chain isn't shown for the new one");
  // Back to he_a and on to he_b again before either answers: only the latest address's answer lands.
  setRoot("he_a");
  setRoot("he_c");
  await flush();
  calls[3]!.resolve(chainOf("he_c"));
  calls[1]!.resolve(chainOf("he_b"));
  calls[2]!.resolve(chainOf("he_a"));
  await flush();
  assert.equal(c.chain()?.root, "he_c");
  assert.equal(c.error(), null);

  // Expanding continues the chain in force; the boundary is marked against the project filter.
  c.read("cur_c");
  setProjects(["p_1"]);
  await flush();
  assert.deepEqual(calls.slice(4).map((x) => [x.root, x.projects, x.cursor]), [["he_c", [], "cur_c"], ["he_c", ["p_1"], undefined]]);
  calls[4]!.resolve(chainOf("he_c", null, ["he_x"]));
  calls[5]!.resolve(chainOf("he_c", null, ["he_y"]));
  await flush();
  assert.deepEqual(c.chain()?.nodes.map((n) => n.id), ["he_c", "he_y"], "the expansion read under the old filter is dropped");
  dispose();
});

test("a failed read says so for its own event only, and the next event clears it", async () => {
  const pending: { root: string; ok: (c: HistoryChain) => void; fail: (e: Error) => void }[] = [];
  const { c, setRoot, dispose } = solid.createRoot((dispose) => {
    const [root, setRoot] = solid.createSignal("he_a");
    const c = createHistoryChain({ root, projects: () => [], fetch: (r) => new Promise<HistoryChain>((ok, fail) => pending.push({ root: r, ok, fail })) });
    return { c, setRoot, dispose };
  });
  await flush();
  pending[0]!.fail(new Error("No such event in this organization."));
  await flush();
  assert.equal(c.error(), "No such event in this organization.");
  setRoot("he_b");
  await flush();
  assert.equal(c.error(), null);
  pending[1]!.ok(chainOf("he_b"));
  await flush();
  assert.equal(c.chain()?.root, "he_b");
  dispose();
});

test("the expansion is the address's: Expand goes one page further, Back to an expanded chain reads it as far again", async () => {
  const calls: { root: string; cursor?: string; resolve: (c: HistoryChain) => void }[] = [];
  const { c, setRoot, setMore, dispose } = solid.createRoot((dispose) => {
    const [root, setRoot] = solid.createSignal("he_g");
    const [more, setMore] = solid.createSignal(1);
    const c = createHistoryChain({ root, projects: () => [], more, fetch: (r, _p, cursor) => new Promise<HistoryChain>((resolve) => calls.push({ root: r, ...(cursor ? { cursor } : {}), resolve })) });
    return { c, setRoot, setMore, dispose };
  });
  const answer = async (i: number, ch: HistoryChain) => {
    calls[i]!.resolve(ch);
    await flush();
  };
  await flush();
  // Opened at more=1 (a link, a reload, Back): the first page, then one further, merged.
  await answer(0, chainOf("he_g", "g1"));
  assert.deepEqual(calls.map((x) => [x.root, x.cursor]), [["he_g", undefined], ["he_g", "g1"]]);
  await answer(1, chainOf("he_g", "g2", ["he_1"]));
  assert.deepEqual(c.chain()?.nodes.map((n) => n.id), ["he_g", "he_1"]);
  // Expand: one page further, nothing read again.
  setMore(2);
  await flush();
  assert.deepEqual(calls.slice(2).map((x) => x.cursor), ["g2"]);
  await answer(2, chainOf("he_g", null, ["he_2"]));
  assert.deepEqual(c.chain()?.nodes.map((n) => n.id), ["he_g", "he_1", "he_2"]);
  // Another event's chain (a card's link: more=0), then Back to this one at more=2: read as far as it was.
  solid.batch(() => {
    setRoot("he_c");
    setMore(0);
  });
  await flush();
  await answer(3, chainOf("he_c", "c1"));
  assert.equal(calls.length, 4, "a chain not expanded reads one page");
  solid.batch(() => {
    setRoot("he_g");
    setMore(2);
  });
  await flush();
  await answer(4, chainOf("he_g", "g1"));
  await answer(5, chainOf("he_g", "g2", ["he_1"]));
  await answer(6, chainOf("he_g", null, ["he_2"]));
  assert.deepEqual(calls.slice(4).map((x) => [x.root, x.cursor]), [["he_g", undefined], ["he_g", "g1"], ["he_g", "g2"]]);
  assert.deepEqual(c.chain()?.nodes.map((n) => n.id), ["he_g", "he_1", "he_2"]);
  // Back within the same event, to fewer pages: read again from the start, only that far.
  setMore(0);
  await flush();
  await answer(7, chainOf("he_g", "g1"));
  assert.equal(calls.length, 8);
  assert.deepEqual(c.chain()?.nodes.map((n) => n.id), ["he_g"]);
  dispose();
});

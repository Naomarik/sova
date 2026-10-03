// Run: pnpm exec tsx --test src/lib/tool-content.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContent } from "../../shared/protocol";
import { ToolContentStore, type ToolSource } from "./tool-content";

const A: ToolSource = { kind: "pi", path: "/s/a.jsonl" };
const B: ToolSource = { kind: "claude", sessionId: "u-1", host: "peer" };

/** A fake route: answers every id it knows, records each call. */
function fake(known: Record<string, ToolContent>, fail = false) {
  const calls: { source: ToolSource; ids: string[] }[] = [];
  const fetcher = async (source: ToolSource, ids: readonly string[]) => {
    calls.push({ source, ids: [...ids] });
    if (fail) throw new Error("The Sova server isn't reachable.");
    return { items: Object.fromEntries(ids.flatMap((id) => (known[id] ? [[id, known[id]!]] : []))) };
  };
  return { calls, fetcher };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("cards asked about together are fetched in one request per session, and only once", async () => {
  const f = fake({ "c1:0": { args: { command: "ls" } }, "c2:0": { args: { path: "x" } }, "w:0": { args: {} } });
  const st = new ToolContentStore(f.fetcher, 1e9, (fn) => setTimeout(fn, 0));
  const a = st.handle(A, "c1:0", { resultId: "r1" });
  const b = st.handle(A, "c2:0", { resultId: "r2" });
  const c = st.handle(B, "w:0");
  a.want();
  b.want();
  c.want();
  a.want();
  assert.equal(a.body().state, "loading");
  await tick();
  assert.deepEqual(f.calls.map((x) => x.ids.sort()), [["c1:0", "c2:0"], ["w:0"]]);
  assert.deepEqual(a.body(), { state: "ready", content: { args: { command: "ls" } } });
  a.want();
  await tick();
  assert.equal(f.calls.length, 2, "a landed card is not asked again");
  // Another handle on the same row and result shares what landed.
  assert.equal(st.handle(A, "c1:0", { resultId: "r1" }).body().state, "ready");
});

test("a call asked about while running is asked again once its result is on the list", async () => {
  const f = fake({ "c:0": { args: {} } });
  const st = new ToolContentStore(f.fetcher, 1e9, (fn) => setTimeout(fn, 0));
  st.handle(A, "c:0").want();
  await tick();
  const done = st.handle(A, "c:0", { resultId: "r" });
  assert.equal(done.body().state, "idle");
  done.want();
  await tick();
  assert.equal(f.calls.length, 2);
});

test("a failure says so and is asked again only on Retry; a row the branch lost is missing", async () => {
  const bad = fake({}, true);
  const st = new ToolContentStore(bad.fetcher, 1e9, (fn) => setTimeout(fn, 0));
  const h = st.handle(A, "c:0", { resultId: "r" });
  h.want();
  await tick();
  assert.deepEqual(h.body(), { state: "error", message: "The Sova server isn't reachable." });
  h.want();
  await tick();
  assert.equal(bad.calls.length, 1, "no retry loop");
  h.retry();
  await tick();
  assert.equal(bad.calls.length, 2);

  const gone = new ToolContentStore(fake({}).fetcher, 1e9, (fn) => setTimeout(fn, 0)).handle(A, "x:0");
  gone.want();
  await tick();
  assert.equal(gone.body().state, "missing");
});

test("what a finished call streamed stands in until the fetch lands, which replaces it", async () => {
  const f = fake({ "e:1": { args: { path: "a" }, result: { output: "from the file", isError: false } } });
  const st = new ToolContentStore(f.fetcher, 1e9, (fn) => setTimeout(fn, 0));
  st.seed(A, "call-7", { args: { path: "a" }, result: { output: "streamed", isError: false } });
  const h = st.handle(A, "e:1", { resultId: "r7", callId: "call-7" });
  assert.equal((h.body() as { content: ToolContent }).content.result?.output, "streamed");
  h.want();
  await tick();
  assert.equal((h.body() as { content: ToolContent }).content.result?.output, "from the file");
  // A row without its result yet never takes the seed: the stream's result isn't the row's.
  assert.equal(st.handle(A, "e:1", { callId: "call-7" }).body().state, "idle");
});

test("past the budget, the least recently used content no card holds goes first", async () => {
  const f = fake({ a: { args: 1 }, b: { args: 2 }, c: { args: 3 } });
  const st = new ToolContentStore(f.fetcher, 250, (fn) => setTimeout(fn, 0));
  const a = st.handle(A, "a", { size: 100 });
  const b = st.handle(A, "b", { size: 100 });
  const release = a.hold();
  a.want();
  b.want();
  await tick();
  const c = st.handle(A, "c", { size: 100 });
  c.want();
  await tick();
  assert.equal(a.body().state, "ready", "held: kept");
  assert.equal(b.body().state, "idle", "the oldest not held: dropped");
  assert.equal(c.body().state, "ready");
  release();
  // Dropped content is fetched again when a card asks.
  b.want();
  await tick();
  assert.equal(b.body().state, "ready");
});

test("load: every row's content for the Changes viewer, in batches of at most 200", async () => {
  const known: Record<string, ToolContent> = {};
  for (let i = 0; i < 450; i++) known[`e${i}`] = { args: { i } };
  const f = fake(known);
  const st = new ToolContentStore(f.fetcher, 1e9, (fn) => setTimeout(fn, 0));
  const got = await st.load(A, Object.keys(known).map((rowId) => ({ rowId, resultId: `${rowId}r` })));
  assert.equal(got.size, 450);
  assert.deepEqual(f.calls.map((c) => c.ids.length), [200, 200, 50]);
  await assert.rejects(new ToolContentStore(fake({}, true).fetcher, 1e9, (fn) => setTimeout(fn, 0)).load(A, [{ rowId: "x" }]), /reachable/);
});

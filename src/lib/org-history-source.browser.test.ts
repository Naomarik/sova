// Run: node scripts/run-tests.mjs src/lib/org-history-source.browser.test.ts (the browser pass: Solid's reactive build)
// with a stub `document`. The bugs these guard live between re-runs of the graph: a re-read or a new
// route object for the same filters must not reset the list, and a slow answer for old filters must
// not land under new ones.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");
import type { EventSummary, HistoryPage, HistoryQuery } from "../../shared/org-history";

(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
const solid = await import("solid-js");
const { createHistoryList, HISTORY_POLL_MS } = await import("./org-history-source");
const { filtersKey, queryOf } = await import("./org-history-route");
type Filters = import("./org-history-route").HistoryFilters;

const ev = (id: string, headline = id): EventSummary =>
  ({ id, kind: "gap.filed", outcome: "recorded", headline, reasonState: "not-recorded", project: null, affected: [], recordedAt: 1, actors: {} as never, initiation: "unknown", origin: "live" }) as EventSummary;
const page = (items: EventSummary[], total: number, cursor: string | null = null): HistoryPage =>
  ({ items, total, cursor, freshness: { through: null, events: total, current: true, rebuiltAt: null }, coverage: { capturedSince: null, importedSince: null, gaps: [], savingSince: null, problems: [] } }) as HistoryPage;
const flush = () => new Promise<void>((r) => setImmediate(r));

function harness(answer: (q: HistoryQuery) => Promise<HistoryPage>) {
  const calls: HistoryQuery[] = [];
  return solid.createRoot((dispose) => {
    // The route hands a NEW filters object on every hash change, equal or not.
    const [filters, setFilters] = solid.createSignal<Filters>({ projects: [] });
    const list = createHistoryList({
      key: () => filtersKey(filters()),
      query: () => queryOf(filters()),
      fetch: (q) => {
        calls.push(q);
        return answer(q);
      },
    });
    return { list, setFilters, calls, dispose };
  });
}

test("the same filters in a new route object keep the list (no refetch, rows kept); new filters start over", async () => {
  const h = harness(async (q) => (q.projects ? page([ev("b1")], 1) : page([ev("a1"), ev("a2")], 2)));
  await flush();
  assert.deepEqual(h.list.items().map((e) => e.id), ["a1", "a2"]);
  const row = h.list.items()[0];
  h.setFilters({ projects: [] }); // an event selected, or a re-read: same filters, new object
  await flush();
  assert.equal(h.calls.length, 1, "no read for the same filters");
  assert.equal(h.list.items()[0], row, "the row object is kept");
  h.setFilters({ projects: ["p_a"] });
  assert.equal(h.list.total(), null, "a new filter set forgets the old count at once");
  await flush();
  assert.deepEqual(h.list.items().map((e) => e.id), ["b1"]);
  assert.equal(h.list.total(), 1);
  h.dispose();
});

test("a background re-read reconciles in place and keeps pages already shown", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let first = page([ev("e3"), ev("e2")], 4, "c1");
    const h = harness(async (q) => (q.cursor ? page([ev("e1"), ev("e0")], 4) : first));
    await flush();
    h.list.showMore();
    await flush();
    assert.deepEqual(h.list.items().map((e) => e.id), ["e3", "e2", "e1", "e0"]);
    assert.equal(h.list.hasMore(), false);
    const kept = h.list.items()[1];
    first = page([ev("e4"), ev("e3"), ev("e2", "e2 renamed")], 5, "c2");
    mock.timers.tick(HISTORY_POLL_MS);
    await flush();
    assert.deepEqual(h.list.items().map((e) => e.id), ["e4", "e3", "e2", "e1", "e0"]);
    assert.equal(h.list.total(), 5);
    assert.equal(h.list.items()[2], kept, "e2 keeps its identity (focus stays on it)");
    assert.equal(h.list.items()[2]!.headline, "e2 renamed");
    assert.equal(h.list.hasMore(), false, "the cursor of the pages loaded stays");
    h.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("an answer for older filters never lands under newer ones", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const h = harness(async (q) => {
    if (!q.projects) {
      await slow;
      return page([ev("old")], 1);
    }
    return page([ev("new")], 1);
  });
  h.setFilters({ projects: ["p_b"] });
  await flush();
  release();
  await flush();
  assert.deepEqual(h.list.items().map((e) => e.id), ["new"]);
  h.dispose();
});

test("a failed read keeps the rows shown and says why; Show More's failure is its own", async () => {
  let fail = false;
  const h = harness(async (q) => {
    if (fail) throw new Error("The Sova server isn't reachable.");
    return q.cursor ? page([], 2) : page([ev("x")], 2, "c");
  });
  await flush();
  fail = true;
  h.list.refetch();
  await flush();
  assert.deepEqual(h.list.items().map((e) => e.id), ["x"]);
  assert.equal(h.list.error(), "The Sova server isn't reachable.");
  h.list.showMore();
  await flush();
  assert.equal(h.list.moreError(), "The Sova server isn't reachable.");
  assert.equal(h.list.hasMore(), true, "the cursor stays for a retry");
  h.dispose();
});

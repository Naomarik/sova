// Run: node scripts/run-tests.mjs src/lib/org-history-view.browser.test.ts (the browser pass: Solid's reactive build)
// with a stub `document`. The spec: "A background re-read keeps the selection, the
// filters, open disclosures and focus." The route hands a new view object on every hash change and
// the list re-reads every 10 s; neither may re-run what hangs off the selection, or rebuild a row
// whose disclosure is open.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");
import type { EventSummary, HistoryPage } from "../../shared/org-history";
import type { HistoryView } from "./org-history-route";

(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
const solid = await import("solid-js");
const { historyViewMemos } = await import("./org-page-route");
const { createHistoryList, HISTORY_POLL_MS } = await import("./org-history-source");
const { queryOf } = await import("./org-history-route");

const flush = () => new Promise<void>((r) => setImmediate(r));
const ev = (id: string, headline = id) =>
  ({ id, kind: "decision.recorded", outcome: "deferred", headline, reasonState: "recorded", project: null, affected: [], recordedAt: 1, initiation: "person", origin: "live" }) as EventSummary;
const page = (items: EventSummary[]): HistoryPage =>
  ({ items, total: items.length, cursor: null, freshness: { through: null, events: items.length, current: true, rebuiltAt: null }, coverage: { capturedSince: null, importedSince: null, gaps: [], savingSince: null, problems: [] } }) as HistoryPage;

test("a new view object for the same address re-runs nothing; a new selection keeps the filters object", () => {
  const counts = { inspectorMounts: 0, listResets: 0 };
  const { m, setView, dispose } = solid.createRoot((dispose) => {
    const [view, setView] = solid.createSignal<HistoryView>({ filters: { projects: ["p_a"] }, event: "he_6" });
    const m = historyViewMemos(view);
    // What the tab hangs off them: the inspector keyed on the selection, the list on the filter key.
    solid.createRenderEffect(() => (m.selected(), counts.inspectorMounts++));
    solid.createRenderEffect(() => (m.filtersKey(), counts.listResets++));
    return { m, setView, dispose };
  });
  {
    const filtersBefore = m.filters();
    // A re-read of the org page, Back to the same address, or the same hash parsed again.
    setView({ filters: { projects: ["p_a"] }, event: "he_6" });
    setView({ filters: { projects: ["p_a"] }, event: "he_6" });
    assert.deepEqual([counts.inspectorMounts, counts.listResets], [1, 1]);
    assert.equal(m.filters(), filtersBefore, "the same filters object, so nothing reading it re-runs");
    // Another event: the inspector moves, the list stays.
    setView({ filters: { projects: ["p_a"] }, event: "he_7" });
    assert.deepEqual([counts.inspectorMounts, counts.listResets], [2, 1]);
    assert.equal(m.filters(), filtersBefore);
    // Another filter: the list starts over.
    setView({ filters: { projects: ["p_b"] }, event: "he_7" });
    assert.deepEqual([counts.inspectorMounts, counts.listResets], [2, 2]);
    assert.notEqual(m.filters(), filtersBefore);
    assert.equal(m.chain(), false);
  }
  dispose();
});

test("control: without the memos, the same address re-runs the inspector on every new view object", () => {
  let runs = 0;
  const { setView, dispose } = solid.createRoot((dispose) => {
    const [view, setView] = solid.createSignal<HistoryView>({ filters: { projects: [] }, event: "he_6" });
    solid.createRenderEffect(() => (view().event, runs++));
    return { setView, dispose };
  });
  setView({ filters: { projects: [] }, event: "he_6" });
  assert.equal(runs, 2, "the check above can tell the two apart");
  dispose();
});

test("a background re-read keeps a row's open disclosure (its row is never rebuilt)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let server = page([ev("he_7"), ev("he_6")]);
    const openState: Record<string, () => boolean> = {};
    let rowsBuilt = 0;
    const dispose = solid.createRoot((dispose) => {
      const list = createHistoryList({ key: () => "", query: () => queryOf({ projects: [] }), fetch: async () => server });
      // The timeline's <For>: each row owns its Show Details state, as GroupDetails does.
      const rows = solid.mapArray(list.items, (e) => {
        rowsBuilt++;
        const [open, setOpen] = solid.createSignal(false);
        openState[e.id] = open;
        if (e.id === "he_6") setOpen(true);
        return e;
      });
      solid.createRenderEffect(() => rows());
      return dispose;
    });
    await flush();
    assert.equal(rowsBuilt, 2);
    assert.equal(openState.he_6!(), true);
    // The next re-read: a new event on top, he_6's headline changed.
    server = page([ev("he_8"), ev("he_7"), ev("he_6", "Bank sync deferred for Q1")]);
    mock.timers.tick(HISTORY_POLL_MS);
    await flush();
    assert.equal(rowsBuilt, 3, "only the new row is built");
    assert.equal(openState.he_6!(), true, "the open disclosure stays open");
    dispose();
  } finally {
    mock.timers.reset();
  }
});

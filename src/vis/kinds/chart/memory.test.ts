import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../../../lib/markdown";
import { fenceKey, recallChoice, rememberChoice, resetChoiceMemory } from "./memory";

const pick = (view: string, more: Partial<{ log: boolean; sort: boolean; pct: boolean }> = {}) => ({ view, log: false, sort: false, pct: false, ...more });

/** A sessionStorage stand-in: what the browser's tab keeps across a reload. */
function fakeStorage() {
  const data = new Map<string, string>();
  const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  (globalThis as { sessionStorage?: unknown }).sessionStorage = s;
  return { data, done: () => delete (globalThis as { sessionStorage?: unknown }).sessionStorage };
}

test("fenceKey is the chat placeholder's data-vis-key for the same fence", () => {
  const fence = "```vis chart\ntype: bar\na 1\nb 2\n```";
  const html = renderMarkdown(fence).html;
  const key = /data-vis-key="([0-9a-f]+)"/.exec(html)?.[1];
  assert.ok(key, html);
  assert.equal(fenceKey(fence), key);
  assert.notEqual(fenceKey(fence), fenceKey(fence.replace("b 2", "b 3")));
});

test("a choice is kept per drawing; forgetting it returns the model's default", () => {
  resetChoiceMemory();
  assert.equal(recallChoice("a"), undefined);
  rememberChoice("a", pick("line", { log: true }));
  rememberChoice("b", pick("parts", { sort: true }));
  assert.deepEqual(recallChoice("a"), pick("line", { log: true }));
  assert.deepEqual(recallChoice("b"), pick("parts", { sort: true }));
  rememberChoice("a", undefined);
  assert.equal(recallChoice("a"), undefined);
  assert.deepEqual(recallChoice("b"), pick("parts", { sort: true }));
});

test("survives a reload of the tab through sessionStorage; a corrupt store costs only the choices", () => {
  const st = fakeStorage();
  try {
    resetChoiceMemory();
    rememberChoice("k", pick("stacked", { pct: true }));
    assert.ok(st.data.get("sova.vis.chart-views"));
    resetChoiceMemory(); // the reload: memory gone, the tab's storage kept
    assert.deepEqual(recallChoice("k"), pick("stacked", { pct: true }));
    st.data.set("sova.vis.chart-views", JSON.stringify({ k: { view: 3 }, j: pick("bar", { sort: true }) }));
    resetChoiceMemory();
    assert.equal(recallChoice("k"), undefined);
    assert.deepEqual(recallChoice("j"), pick("bar", { sort: true }));
    st.data.set("sova.vis.chart-views", "{not json");
    resetChoiceMemory();
    assert.equal(recallChoice("j"), undefined);
  } finally {
    st.done();
    resetChoiceMemory();
  }
});

test("keeps the newest 200 drawings, and a storage that throws still serves the page", () => {
  resetChoiceMemory();
  for (let i = 0; i < 205; i++) rememberChoice(`d${i}`, pick("line"));
  assert.equal(recallChoice("d0"), undefined);
  assert.equal(recallChoice("d4"), undefined);
  assert.deepEqual(recallChoice("d5"), pick("line"));
  assert.deepEqual(recallChoice("d204"), pick("line"));
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  try {
    resetChoiceMemory();
    rememberChoice("x", pick("bar", { log: true }));
    assert.deepEqual(recallChoice("x"), pick("bar", { log: true }));
  } finally {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    resetChoiceMemory();
  }
});

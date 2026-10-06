// Run: pnpm test -- src/lib/older-rows-view.browser.test.ts (Solid's reactive build, a stubbed fetch).
// A turn's end swaps its streamed rows for its saved rows in one update
// (§chat.transcript/turn-end-keeps-reader): whatever `refresh` is given runs in the same batch as
// the rows landing, so nothing that renders or lays out ever sees both copies of the turn.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");
import type { TranscriptItem, TranscriptRows } from "../../shared/protocol";
import { summarize } from "../../shared/row-counts";

const g = globalThis as Record<string, unknown>;
g.location ??= { protocol: "http:", host: "sova.test", origin: "http://sova.test", href: "http://sova.test/" };

const solid = await import("solid-js");
const { createOlderRows } = await import("./older-rows-view");

const row = (id: string, text = "a"): TranscriptItem => ({ id, kind: "assistant-text", text });
const held = [{ id: "u1", kind: "user", text: "q" } as TranscriptItem, row("a1:0")];
const saved = [...held, { id: "u2", kind: "user", text: "q2" } as TranscriptItem, row("a2:0", "the reply")];

/** Answers every /api/transcript request with `answer`, or the error code given. */
function serve(answer: TranscriptRows | { code: string; status: number }) {
  const asked: string[] = [];
  g.fetch = async (url: string) => {
    asked.push(String(url));
    if ("code" in answer) return new Response(JSON.stringify({ error: answer.code, code: answer.code }), { status: answer.status });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return asked;
}

/** A view's list and a stand-in for its live rows; every state a computation sees, in order. */
function view(start: TranscriptItem[] | null) {
  return solid.createRoot((dispose) => {
    const [items, setItems] = solid.createSignal<TranscriptItem[] | null>(null);
    const [live, setLive] = solid.createSignal(2);
    const rows = createOlderRows({ path: "/s.jsonl", items, setItems, prefetch: false });
    if (start) rows.hello({ items: start, older: 0, olderSummary: summarize([]) });
    const seen: string[] = [];
    solid.createComputed(() => seen.push(`${items()?.length ?? 0} saved, ${live()} live`));
    return { rows, seen, setLive, dispose };
  });
}

test("refresh: the hook runs in the same update as the saved rows landing; never both copies at once", async () => {
  serve({ items: saved, older: 0, olderSummary: summarize([]) });
  const v = view(held);
  const r = await v.rows.refresh(() => v.setLive(0));
  assert.notEqual(r, "stale");
  assert.deepEqual(v.seen, ["2 saved, 2 live", "4 saved, 0 live"]);
  v.dispose();
});

test("refresh of an empty list (a new session's first turn): the tail lands with the hook too", async () => {
  serve({ items: saved, older: 0, olderSummary: summarize([]) });
  const v = view(null);
  await v.rows.refresh(() => v.setLive(0));
  assert.deepEqual(v.seen, ["0 saved, 2 live", "4 saved, 0 live"]);
  v.dispose();
});

test("refresh: rows that don't land (the branch moved) never run the hook; the caller clears after", async () => {
  serve({ code: "moved", status: 409 });
  const v = view(held);
  let ran = false;
  const r = await v.rows.refresh(() => (ran = true));
  assert.equal(r, "stale");
  assert.equal(ran, false);
  v.dispose();
});

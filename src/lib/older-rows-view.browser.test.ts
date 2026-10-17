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

// §chat.transcript/instant-open: rows painted from the file, then a hello that continues after them.
const branch: TranscriptItem[] = [
  { id: "u1", kind: "user", text: "q1" } as TranscriptItem,
  row("a1:0"),
  { id: "u2", kind: "user", text: "q2" } as TranscriptItem,
  row("a2:0", "reply"),
];
const fileRows = (n: number): TranscriptRows => ({ items: branch.slice(0, n), older: 0, olderSummary: summarize([]) });

function fresh() {
  return solid.createRoot((dispose) => {
    const [items, setItems] = solid.createSignal<TranscriptItem[] | null>(null);
    const rows = createOlderRows({ path: "/s.jsonl", items, setItems, prefetch: false });
    return { rows, items, dispose };
  });
}

test("paint, then a hello after its last row: every painted row keeps its object, the hello's rows follow", () => {
  const v = fresh();
  assert.equal(v.rows.paint(fileRows(3)), true);
  const painted = v.items()!;
  v.rows.hello({ items: branch.slice(3).map((it) => ({ ...it })), older: 3, olderSummary: summarize(branch.slice(0, 3)), after: "u2" });
  const list = v.items()!;
  assert.deepEqual(list.map((it) => it.id), ["u1", "a1:0", "u2", "a2:0"]);
  assert.ok(painted.every((it, i) => list[i] === it), "the painted rows' elements are kept");
  assert.equal(v.rows.whole(), true);
  v.dispose();
});

test("a hello after the last row with nothing new leaves the very same list (nothing re-renders)", () => {
  const v = fresh();
  v.rows.paint(fileRows(4));
  const painted = v.items();
  v.rows.hello({ items: [], older: 4, olderSummary: summarize(branch), after: "a2:0" });
  assert.equal(v.items(), painted);
  v.dispose();
});

test("a file read that lands after the hello is ignored", () => {
  const v = fresh();
  v.rows.hello({ items: branch, older: 0, olderSummary: summarize([]) });
  const shown = v.items();
  assert.equal(v.rows.paint(fileRows(2)), false);
  assert.equal(v.items(), shown);
  v.dispose();
});

test("a hello after a row the list doesn't hold leaves the list alone and reads the file's newest rows again", async () => {
  const asked = serve({ items: branch, older: 0, olderSummary: summarize([]) });
  const v = fresh();
  v.rows.paint(fileRows(2));
  const painted = v.items();
  v.rows.hello({ items: [branch[3]!], older: 3, olderSummary: summarize(branch.slice(0, 3)), after: "u2" });
  assert.equal(v.items(), painted, "the hello's rows alone are not shown");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(asked.some((u) => u.includes("/api/transcript") && u.includes("tail=1")), asked.join(" "));
  assert.deepEqual(v.items()!.map((it) => it.id), ["u1", "a1:0", "u2", "a2:0"]);
  assert.equal(v.items()![0], painted![0], "rows still the same keep their objects");
  v.dispose();
});

// §chat.timeline/jumping: a load asked before any hello (rows kept in the tab, the chat still
// starting or failing to) never waits on the chat.
function keptView() {
  return solid.createRoot((dispose) => {
    const [items, setItems] = solid.createSignal<TranscriptItem[] | null>(branch.slice(2).map((it) => ({ ...it })));
    return { rows: createOlderRows({ path: "/s.jsonl", items, setItems, prefetch: false }), items, dispose };
  });
}

test("a load before any hello reads the file's newest rows itself, then lands the target", async () => {
  const asked: string[] = [];
  g.fetch = async (url: string) => {
    asked.push(String(url));
    const q = new URL(String(url), "http://sova.test").searchParams;
    const body: TranscriptRows = q.get("tail")
      ? { items: branch.slice(2), older: 2, olderSummary: summarize(branch.slice(0, 2)) }
      : { items: branch.slice(0, 2), older: 0, olderSummary: summarize([]) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const v = keptView();
  assert.equal(v.rows.older(), null, "kept rows, nothing said yet about what's above them");
  assert.equal(await v.rows.api.load({ entry: "u1" }), "here");
  assert.ok(asked.some((u) => u.includes("tail=1")), asked.join(" "));
  assert.deepEqual(v.items()!.map((it) => it.id), ["u1", "a1:0", "u2", "a2:0"]);
  v.dispose();
});

test("a load before any hello whose file read fails says stale (the jump then says it can't land), never hangs", async () => {
  g.fetch = async () => {
    throw new TypeError("offline");
  };
  const v = keptView();
  assert.equal(await v.rows.api.load({ entry: "u1" }), "stale");
  v.dispose();
});

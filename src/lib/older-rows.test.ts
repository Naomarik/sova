import assert from "node:assert/strict";
import { test } from "node:test";
import type { AlignDocInfo, TranscriptItem, TranscriptRows } from "../../shared/protocol";
import { summarize } from "../../shared/row-counts";
import { afterRows, anyReply, helloRows, inputTotal, keptBehind, lastInput, messageTotal, newRows, type Older, OlderLoader, ownInputTotal, prependRows, WHOLE, withHave } from "./older-rows";
import { inputCount } from "./input-count";
import type { RowsAsk } from "./api";

// A branch of 100 rows: an input, then a two-block reply, repeated (r0 user, r1:0/r1:1 reply, ...).
const whole: TranscriptItem[] = [];
for (let i = 0; whole.length < 100; i += 3) {
  whole.push({ id: `r${i}`, kind: "user", text: "q" });
  whole.push({ id: `r${i + 1}:0`, kind: "assistant-text", text: "a" });
  whole.push({ id: `r${i + 1}:1`, kind: "assistant-text", text: "b" });
}
whole.length = 99; // ends on a whole reply
const ids = (items: readonly TranscriptItem[]) => items.map((it) => it.id);
/** What the server answers for rows [from, to). */
const answer = (from: number, to: number): TranscriptRows => ({ items: whole.slice(from, to), older: from, olderSummary: summarize(whole.slice(0, from)) });
const olderAt = (from: number): Older => ({ left: from, summary: summarize(whole.slice(0, from)) });

test("helloRows: no `older` is a whole list; a cut hello onto nothing keeps its rows and says what's above", () => {
  assert.deepEqual(helloRows(null, whole).older, WHOLE);
  const h = helloRows(null, whole.slice(60), 60, summarize(whole.slice(0, 60)));
  assert.deepEqual(ids(h.items), ids(whole.slice(60)));
  assert.deepEqual(h.older, olderAt(60));
});

test("helloRows: rows kept above the hello's first row stay, and the summary drops what they hold", () => {
  const prev = whole.slice(30); // kept from the last visit: 30 rows above the new first row (60)
  const h = helloRows(prev, whole.slice(60), 60, summarize(whole.slice(0, 60)));
  assert.deepEqual(ids(h.items), ids(whole.slice(30)));
  assert.equal(h.items[0], prev[0], "kept rows keep their objects");
  assert.deepEqual(h.older, olderAt(30));
  // A whole list stays whole across a reconnect.
  assert.deepEqual(helloRows(whole, whole.slice(60), 60, summarize(whole.slice(0, 60))).older.left, 0);
});

test("helloRows: kept rows whose inputs don't match the summary, or more of them than the branch has, are dropped", () => {
  const foreign = [{ id: "zz", kind: "user", text: "other branch" } as TranscriptItem, ...whole.slice(60)];
  const h = helloRows(foreign, whole.slice(60), 60, summarize(whole.slice(0, 60)));
  assert.deepEqual(ids(h.items), ids(whole.slice(60)));
  assert.equal(h.older.left, 60);
  const tooMany = helloRows(whole.slice(30), whole.slice(60), 10, summarize(whole.slice(50, 60)));
  assert.deepEqual(ids(tooMany.items), ids(whole.slice(60)));
});

test("the alignments open above the list: a hello keeps them, kept rows take theirs, a fetch's summary replaces them", () => {
  const doc = (id: string, rev: number): AlignDocInfo => ({
    id, title: id, summary: "", findings: [], approach: [], rejected: [], questions: [], phase: "open",
    next: { f: 1, a: 1, x: 1, q: 1 }, rev, createdAt: "", updatedAt: "",
  });
  const align = (id: string, d: AlignDocInfo): TranscriptItem => ({ id, kind: "align", toolCallId: `c-${id}`, align: { v: 1, doc: d, changes: [], line: "" } });
  // al_1 at row 10, al_2 at row 40: both above a hello cut at 60.
  const branch = whole.map((it, i) => (i === 10 ? align("a10", doc("al_1", 1)) : i === 40 ? align("a40", doc("al_2", 1)) : it));
  const s = summarize(branch.slice(0, 60));
  assert.deepEqual(s.aligns?.map((a) => a.rowId), ["a10", "a40"]);
  assert.deepEqual(helloRows(null, branch.slice(60), 60, s).older.summary.aligns, s.aligns, "a hello keeps them");
  // Rows 30.. kept from the last visit hold al_2's row: only al_1 is still above the list.
  const kept = helloRows(branch.slice(30), branch.slice(60), 60, s);
  assert.equal(kept.older.left, 30);
  assert.deepEqual(kept.older.summary.aligns?.map((a) => a.rowId), ["a10"]);
  // Kept rows holding every alignment: none is above the list, and the key goes.
  assert.equal(helloRows(branch.slice(5), branch.slice(60), 60, s).older.summary.aligns, undefined);
  // A fetch's summary is about the rows above IT: the chunk 30..60 brings al_2 into the list.
  const fetched = prependRows(branch.slice(60), { left: 60, summary: s }, { items: branch.slice(30, 60), older: 30, olderSummary: summarize(branch.slice(0, 30)) })!;
  assert.deepEqual(fetched.older.summary.aligns?.map((a) => a.rowId), ["a10"]);
});

test("prependRows: a chunk that ends right above the list lands; one that doesn't add up, or repeats a row, doesn't", () => {
  const list = whole.slice(60);
  const next = prependRows(list, olderAt(60), answer(30, 60))!;
  assert.deepEqual(ids(next.items), ids(whole.slice(30)));
  assert.deepEqual(next.older, olderAt(30));
  assert.equal(prependRows(list, olderAt(60), answer(30, 59)), null, "a gap");
  assert.equal(prependRows(whole.slice(59), olderAt(60), answer(30, 60)), null, "counts don't match");
  assert.equal(prependRows(list, olderAt(61), answer(30, 61)), null, "a row it already has");
});

test("the readers count the rows held plus the summary of the rest, the same as the whole list", () => {
  for (const at of [0, 30, 60, 90]) {
    const list = whole.slice(at);
    const o = olderAt(at);
    assert.equal(inputTotal(list, o), whole.filter((r) => r.kind === "user").length, `at ${at}`);
    assert.equal(messageTotal(list, o), 66, `at ${at}`); // 33 inputs, 33 replies
    assert.equal(anyReply(list, o), true);
    assert.equal(lastInput(list, o), "r96");
  }
  // A list holding no input: the newest one above it.
  assert.equal(lastInput(whole.slice(97), olderAt(97)), "r96");
  assert.equal(lastInput([], WHOLE), null);
});

test("newRows: the hello's first row and after; rows above it are never new", () => {
  const list = whole.slice(30);
  assert.equal(newRows(list, whole[60]!.id).length, 39);
  assert.equal(newRows(list, null).length, 69);
  assert.equal(newRows(list, "gone").length, 69);
});

// ---- The loader, against a fake server ------------------------------------------------------

function harness(opts: { at?: number; slowMs?: number; delay?: number; answer?: (ask: RowsAsk, leaf: string | null) => TranscriptRows | { code: "moved" | "missing" } } = {}) {
  let list: TranscriptItem[] | null = whole.slice(opts.at ?? 90);
  let older: Older | null = olderAt(opts.at ?? 90);
  const asks: { ask: RowsAsk; leaf: string | null }[] = [];
  const slow: boolean[] = [];
  /** Per apply: whether it was handed a hook to run in the same update. */
  const withHook: boolean[] = [];
  let moved = 0;
  const serve = (ask: RowsAsk): TranscriptRows | { code: "moved" | "missing" } => {
    if ("tail" in ask) throw new Error("not here");
    if ("before" in ask) {
      const end = whole.findIndex((r) => r.id === ask.before);
      if ("from" in ask && ask.from !== undefined) {
        const t = whole.findIndex((r) => r.id === ask.from || r.id.startsWith(`${ask.from}:`));
        return t < 0 ? { code: "missing" } : answer(t, end);
      }
      return answer(Math.max(0, end - (ask.chars ? 30 : 12)), end);
    }
    const t = whole.findIndex((r) => r.id === ask.from);
    return answer(t, whole.length);
  };
  const loader = new OlderLoader(
    {
      fetch: async (ask, leaf) => {
        asks.push({ ask, leaf });
        await new Promise((r) => setTimeout(r, opts.delay ?? 1));
        return (opts.answer ?? serve)(ask, leaf);
      },
      list: () => list,
      older: () => older,
      apply: (items, o, also) => {
        list = items;
        older = o;
        withHook.push(!!also);
        also?.();
      },
      moved: () => void moved++,
      slow: (on) => void slow.push(on),
      idle: (fn) => setTimeout(fn, 0),
    },
    opts.slowMs ?? 1000,
  );
  return {
    loader,
    asks,
    slow,
    withHook,
    list: () => list!,
    older: () => older!,
    moved: () => moved,
    replace(l: TranscriptItem[], o: Older) {
      list = l;
      older = o;
    },
  };
}

test("more: the chunk above the list, asked for by its first row and the list's leaf; one at a time", async () => {
  const h = harness();
  const a = h.loader.more();
  const b = h.loader.more();
  assert.equal(a, b, "a second ask while one is on its way is the same request");
  await a;
  assert.equal(h.asks.length, 1);
  assert.deepEqual(h.asks[0], { ask: { before: whole[90]!.id }, leaf: "r97" });
  assert.deepEqual(ids(h.list()), ids(whole.slice(78)));
  assert.deepEqual(h.older(), olderAt(78));
});

test("a new hello while a request is out: its answer lands nowhere", async () => {
  const h = harness({ delay: 20 });
  const p = h.loader.more();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.asks.length, 1, "the request is out");
  h.loader.reset();
  h.replace(whole.slice(60), olderAt(60));
  await p;
  assert.deepEqual(ids(h.list()), ids(whole.slice(60)));
});

test("to: the range down to a target in one request; a row held already needs none; a target off the branch is missing", async () => {
  const h = harness();
  assert.equal(await h.loader.to({ entry: "r3" }), "here");
  assert.equal(h.asks.length, 1);
  assert.deepEqual(h.asks[0]!.ask, { before: whole[90]!.id, from: "r3" });
  assert.deepEqual(ids(h.list()), ids(whole.slice(3)));
  assert.equal(await h.loader.to({ entry: "r4:1" }), "here");
  assert.equal(h.asks.length, 1, "held: no request");
  assert.equal(await h.loader.to({ entry: "nope" }), "missing");
  assert.equal(h.asks.length, 2);
  // Whole: nothing above to fetch, so a row not here isn't there.
  const w = harness({ at: 0 });
  assert.equal(await w.loader.to({ entry: "nope" }), "missing");
  assert.equal(w.asks.length, 0);
});

test("a moved branch, or rows that don't add up, start again (moved) and land nothing", async () => {
  const h = harness({ answer: () => ({ code: "moved" }) });
  await h.loader.more();
  assert.equal(h.moved(), 1);
  assert.deepEqual(ids(h.list()), ids(whole.slice(90)));
  const bad = harness({ answer: () => answer(10, 50) });
  await bad.loader.more();
  assert.equal(bad.moved(), 1);
  assert.deepEqual(ids(bad.list()), ids(whole.slice(90)));
});

test("slow: said only when a scroll-up fetch outlasts the threshold, and unsaid when it's over", async () => {
  const quick = harness({ slowMs: 50, delay: 1 });
  await quick.loader.more();
  assert.deepEqual(quick.slow, [false]);
  const slow = harness({ slowMs: 5, delay: 30 });
  await slow.loader.more();
  assert.deepEqual(slow.slow, [true, false]);
});

test("slow: a jump's range fetch shows the same indicator, only when slow", async () => {
  const quick = harness({ slowMs: 50, delay: 1 });
  assert.equal(await quick.loader.to({ entry: "r3" }), "here");
  assert.deepEqual(quick.slow, [false]);
  const slow = harness({ slowMs: 5, delay: 30 });
  assert.equal(await slow.loader.to({ entry: "r3" }), "here");
  assert.deepEqual(slow.slow, [true, false]);
});

test("prefetch: every older row, large chunks, until the list reaches the top", async () => {
  const h = harness();
  await h.loader.prefetch(1_000_000);
  assert.deepEqual(ids(h.list()), ids(whole));
  assert.equal(h.older().left, 0);
  assert.ok(h.asks.every((a) => "chars" in a.ask && a.ask.chars === 1_000_000));
  assert.equal(h.asks.length, 3); // 90 → 60 → 30 → 0
});

test("refresh: the rows held, again from their first, and what's above them", async () => {
  const h = harness({ at: 60 });
  const r = await h.loader.refresh();
  assert.notEqual(r, "stale");
  assert.deepEqual(h.asks[0]!.ask, { from: whole[60]!.id });
  assert.deepEqual(ids(h.list()), ids(whole.slice(60)));
  assert.deepEqual(h.older(), olderAt(60));
  assert.deepEqual(h.withHook, [false], "no hook asked for, none handed on");
});

test("refresh(also): the hook goes to the same apply as the rows (one update), and only when they land", async () => {
  const h = harness({ at: 60 });
  const order: string[] = [];
  await h.loader.refresh(() => order.push(`hook with ${h.list().length} rows`));
  assert.deepEqual(h.withHook, [true]);
  assert.deepEqual(order, [`hook with ${whole.length - 60} rows`], "run once, inside apply, after the rows are set");
  const moved = harness({ at: 60, answer: () => ({ code: "moved" }) });
  let ran = false;
  assert.equal(await moved.loader.refresh(() => (ran = true)), "stale");
  assert.equal(ran, false, "rows that don't land don't run it: the caller clears on its own");
});

test("the cards open above the list: a hello keeps them, and kept rows take theirs (as aligns)", async () => {
  const { applyCardCall } = await import("../../shared/overseer-card");
  const created = (title: string, from: never[] = []) => applyCardCall(from, { ops: [{ op: "create", title, options: [{ label: "Go" }] }] }, { now: "2026-09-30T10:00:00.000Z", prepared: { items: [], hrefs: [] } }).details;
  const c1 = created("One");
  const c2 = created("Two", [c1.card!] as never[]);
  const callRow = (id: string): TranscriptItem => ({ id, kind: "tool-call", text: "sova_card", toolCallId: `t-${id}` });
  const resultRow = (id: string, details: unknown): TranscriptItem => ({ id: `${id}r`, kind: "tool-result", toolCallId: `t-${id}`, meta: { type: "message", role: "toolResult", toolName: "sova_card" }, tool: { output: "", details } });
  // c_1's call and result at rows 10/11, c_2's at 40/41: both above a hello cut at 60.
  const branch = whole.map((it, i) => (i === 10 ? callRow("k10") : i === 11 ? resultRow("k10", c1) : i === 40 ? callRow("k40") : i === 41 ? resultRow("k40", c2) : it));
  const s = summarize(branch.slice(0, 60));
  assert.deepEqual(s.cards?.map((c) => [c.card.id, c.rowId]), [["c_1", "k10"], ["c_2", "k40"]]);
  assert.deepEqual(helloRows(null, branch.slice(60), 60, s).older.summary.cards, s.cards, "a hello keeps them");
  const kept = helloRows(branch.slice(30), branch.slice(60), 60, s);
  assert.deepEqual(kept.older.summary.cards?.map((c) => c.card.id), ["c_1"], "c_2's row is held now");
  assert.equal(helloRows(branch.slice(5), branch.slice(60), 60, s).older.summary.cards, undefined);
});

// §chat.transcript/instant-open: a hello that continues after the row the view named.
test("afterRows: the rows held up to the named one stay (their objects too), the hello's rows follow, the summary drops what they hold", () => {
  const prev = whole.slice(60, 90); // painted from the file: rows 60..89, the last named
  const h = afterRows(prev, whole.slice(90), prev.at(-1)!.id, 90, summarize(whole.slice(0, 90)))!;
  assert.deepEqual(ids(h.items), ids(whole.slice(60)));
  assert.ok(h.items.slice(0, 30).every((it, i) => it === prev[i]), "every row held keeps its object");
  assert.deepEqual(h.older, olderAt(60));
});

test("afterRows: nothing after the named row keeps the list as it is; rows held past it give way to the hello's", () => {
  const prev = whole.slice(60);
  const same = afterRows(prev, [], prev.at(-1)!.id, 99, summarize(whole.slice(0, 99)))!;
  assert.equal(same.items, prev, "the very same list: nothing re-renders");
  assert.deepEqual(same.older, olderAt(60));
  // The list gained a row after it named its last (an append): the hello's word wins from there on.
  const named = whole[90]!.id;
  const fresh = whole.slice(91).map((it) => ({ ...it }));
  const h = afterRows(prev, fresh, named, 91, summarize(whole.slice(0, 91)))!;
  assert.deepEqual(ids(h.items), ids(whole.slice(60)));
  assert.equal(h.items[31], prev[31], "an unchanged row past the name still keeps its object");
});

test("afterRows: a named row the list doesn't hold, or rows held that don't match the summary, is no list (null)", () => {
  const prev = whole.slice(60, 90);
  assert.equal(afterRows(prev, whole.slice(90), "nope", 90, summarize(whole.slice(0, 90))), null);
  assert.equal(afterRows(null, whole.slice(90), prev.at(-1)!.id, 90, summarize(whole.slice(0, 90))), null);
  const foreign = [{ id: "zz", kind: "user", text: "other branch" } as TranscriptItem, ...prev];
  assert.equal(afterRows(foreign, whole.slice(90), prev.at(-1)!.id, 90, summarize(whole.slice(0, 90))), null);
  // More rows held than the branch has above the hello.
  assert.equal(afterRows(prev, whole.slice(90), prev.at(-1)!.id, 10, summarize(whole.slice(0, 10))), null);
});

test("withHave: names the last row held, encoded; nothing (or too long a name) is the usual URL", () => {
  assert.equal(withHave("ws://h/ws/chat?path=p&tail=rest", "a1:0"), "ws://h/ws/chat?path=p&tail=rest&have=a1%3A0");
  assert.equal(withHave("u", undefined), "u");
  assert.equal(withHave("u", ""), "u");
  assert.equal(withHave("u", "x".repeat(201)), "u");
});

test("keptBehind: kept rows older than the file's last write; unknown either way is not behind", () => {
  assert.equal(keptBehind("2026-10-13T10:00:00Z", "2026-10-13T10:00:01Z"), true);
  assert.equal(keptBehind("2026-10-13T10:00:01Z", "2026-10-13T10:00:01Z"), false);
  assert.equal(keptBehind(null, "2026-10-13T10:00:01Z"), false);
  assert.equal(keptBehind("2026-10-13T10:00:00Z", undefined), false);
});

// ---- The rows the user typed (the composer's count) ---------------------------------------------

/** A branch with every kind of sender: u* typed, s1 from a session, o1 from the Overseer, w1 a wake,
    k1 a teammate's whose marker comes late (after u3). */
const senders: TranscriptItem[] = [
  { id: "u1", kind: "user", text: "q" },
  { id: "s1", kind: "user", text: '[from session "X" (x), hop 1]\nhi' },
  { id: "m1", kind: "info", sessionMark: { kind: "sent", targetId: "s1", from: { sessionId: "x", title: "X" }, hop: 1 } },
  { id: "w1", kind: "wake", text: "[wake_nudge n1] fired" },
  { id: "o1", kind: "user", text: "check" },
  { id: "m2", kind: "info", overseerMark: { kind: "sent", targetId: "o1" } },
  { id: "u2", kind: "user", text: "q" },
  { id: "k1", kind: "user", text: "from Kim" },
  { id: "u3", kind: "user", text: "q" },
  { id: "m3", kind: "info", batonMark: { kind: "sent", targetId: "k1", by: "p_kim" } },
  { id: "a1:0", kind: "assistant-text", text: "a" },
];
const sendersAt = (from: number): Older => ({ left: from, summary: summarize(senders.slice(0, from)) });

test("ownInputTotal: the rows held plus the summary's own, wherever the cut falls, equal the whole branch's count", () => {
  const whole = inputCount(senders);
  assert.equal(whole, 3, "u1, u2, u3");
  for (let at = 0; at <= senders.length; at++) {
    assert.equal(ownInputTotal(senders.slice(at), sendersAt(at)), whole, `cut at ${at}`);
  }
  // Undo last turn still reads every input, whoever sent it.
  assert.equal(inputTotal(senders.slice(4), sendersAt(4)), 7);
});

test("ownInputTotal: a marker the list holds takes its target above the list out of the count", () => {
  // Cut between k1 and its marker: the summary counts k1 (its marker isn't above), the list's marker doesn't.
  const at = senders.findIndex((r) => r.id === "u3");
  assert.ok(sendersAt(at).summary.ownInputs!.includes("k1"));
  assert.equal(ownInputTotal(senders.slice(at), sendersAt(at)), 3);
});

test("ownInputTotal: an older server's summary (no ownInputs) counts its every input above the list", () => {
  const at = 4;
  const { ownInputs: _, ...old } = summarize(senders.slice(0, at));
  assert.equal(ownInputTotal(senders.slice(at), { left: at, summary: old }), 2 + 3, "u1, s1 (its marker is above, unknown to the list), w1, u2, u3");
});

test("kept rows take their own inputs out of the summary's, as they do its inputs", () => {
  const prev = senders.slice(4); // kept from the last visit
  const h = helloRows(prev, senders.slice(7), 7, summarize(senders.slice(0, 7)));
  assert.deepEqual(ids(h.items), ids(senders.slice(4)));
  assert.deepEqual(h.older.summary.ownInputs, ["u1"]);
  assert.equal(ownInputTotal(h.items, h.older), 3);
});

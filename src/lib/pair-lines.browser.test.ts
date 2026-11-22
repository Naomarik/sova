// Run: pnpm test -- src/lib/pair-lines.browser.test.ts (Solid's reactive build).
// §app.overseer/pairs: a chat never shows another chat's Paired with lines, even when reading its own
// pairings fails, or when an answer for the last chat lands after it has moved on. From 3 pairings the
// lines fold into one, with Show All / Hide; each chat opens folded, and a pause shows in the fold.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PairView } from "../../shared/protocol";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { FOLD_AT, pairFold, pairFoldOf, pairLinesOf } = await import("./pair-lines");

const line = (id: string) => ({ id }) as PairView;
const ids = (ps: PairView[]) => ps.map((p) => p.id);
/** Lets the effects and the answers already due run. */
const settled = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The lines over a settable chat id and read; `dispose` ends them. */
function lines(read: (sid: string) => Promise<PairView[]>, first = "A") {
  return solid.createRoot((dispose) => {
    const [id, setId] = solid.createSignal<string | undefined>(first);
    let changes = 0;
    const got = pairLinesOf(id, read, () => changes++);
    return { ...got, setId, dispose, changes: () => changes };
  });
}

test("a failed read keeps this chat's lines; moving to a chat whose read fails shows none of them", async () => {
  let failing = false;
  const reads: string[] = [];
  const l = lines(async (sid) => {
    reads.push(sid);
    if (failing) throw new Error("server away");
    return [line(`of-${sid}`)];
  });
  await settled();
  assert.deepEqual(ids(l.pairs()), ["of-A"]);
  failing = true;
  await l.load();
  assert.deepEqual(ids(l.pairs()), ["of-A"], "the same chat keeps its lines through a failed read");
  l.setId("B");
  await settled();
  assert.deepEqual(reads, ["A", "A", "B"], "the new chat was asked");
  assert.deepEqual(ids(l.pairs()), [], "its read failed, and the last chat's lines are gone");
  l.dispose();
});

test("an answer for the chat just left is dropped, and the new chat's lines stand", async () => {
  const waiting = new Map<string, (ps: PairView[]) => void>();
  const l = lines((sid) => new Promise((res) => waiting.set(sid, res)));
  await settled();
  l.setId("B");
  await settled();
  waiting.get("B")!([line("of-B")]);
  await settled();
  waiting.get("A")!([line("of-A")]);
  await settled();
  assert.deepEqual(ids(l.pairs()), ["of-B"]);
  l.dispose();
});

test("no chat: no lines, no read; each move says so once", async () => {
  const reads: string[] = [];
  const l = lines(async (sid) => {
    reads.push(sid);
    return [line(sid)];
  });
  await settled();
  assert.equal(l.changes(), 1);
  l.setId(undefined);
  await settled();
  assert.deepEqual(ids(l.pairs()), []);
  assert.deepEqual(reads, ["A"]);
  assert.equal(l.changes(), 2);
  l.dispose();
});

test("the fold's rule: plain under 3 pairings whatever Show All says; from 3, folded until opened", () => {
  assert.equal(FOLD_AT, 3);
  for (let n = 0; n <= 10; n++) {
    assert.equal(pairFold(n, false), n < 3 ? "plain" : "folded", `${n}, shut`);
    assert.equal(pairFold(n, true), n < 3 ? "plain" : "open", `${n}, opened`);
  }
});

const side = (paused = false) => ({ paused }) as PairView["a"];
const pairing = (id: string, paused = false) => ({ id, a: side(), b: side(paused) }) as PairView;
const many = (n: number, paused = 0) => Array.from({ length: n }, (_, i) => pairing(`p${i}`, i < paused));

/** The fold over a settable chat id and pairings; `dispose` ends it. */
function folding(start: PairView[]) {
  return solid.createRoot((dispose) => {
    const [id, setId] = solid.createSignal<string | undefined>("A");
    const [pairs, setPairs] = solid.createSignal<PairView[]>(start);
    return { ...pairFoldOf(id, pairs), setId, setPairs, dispose };
  });
}

test("Show All opens the lines and Hide shuts them; with 2 pairings there is nothing to open", () => {
  const f = folding(many(2));
  assert.equal(f.state(), "plain");
  f.toggle();
  assert.equal(f.state(), "plain", "2 lines stay as they are");
  f.setPairs(many(3));
  assert.equal(f.state(), "folded", "the press under 3 left nothing open");
  f.toggle();
  assert.equal(f.state(), "open");
  f.toggle();
  assert.equal(f.state(), "folded");
  f.dispose();
});

test("moving to another chat folds again; so does falling to 2, and rising to 3 comes back folded", () => {
  const f = folding(many(8));
  f.toggle();
  assert.equal(f.state(), "open");
  f.setPairs(many(9));
  assert.equal(f.state(), "open", "a refresh on the same chat keeps it open");
  f.setId("B");
  assert.equal(f.state(), "folded", "the next chat opens folded, with the same count");
  f.toggle();
  f.setPairs(many(2));
  assert.equal(f.state(), "plain");
  f.setPairs(many(3));
  assert.equal(f.state(), "folded");
  f.dispose();
});

test("the folded line counts the pairings and the paused ones: info with none paused, warn with any", () => {
  const f = folding(many(5));
  assert.deepEqual([f.count(), f.paused(), f.tone()], [5, 0, "info"]);
  f.setPairs(many(5, 2));
  assert.deepEqual([f.count(), f.paused(), f.tone()], [5, 2, "warn"]);
  f.setPairs([...many(4), { ...pairing("q"), a: side(true) }]);
  assert.deepEqual([f.paused(), f.tone()], [1, "warn"], "a pause toward either chat counts");
  f.dispose();
});

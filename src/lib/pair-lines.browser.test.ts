// Run: pnpm test -- src/lib/pair-lines.browser.test.ts (Solid's reactive build).
// §app.overseer/pairs: a chat never shows another chat's Paired with lines, even when reading its own
// pairings fails, or when an answer for the last chat lands after it has moved on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PairView } from "../../shared/protocol";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { pairLinesOf } = await import("./pair-lines");

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

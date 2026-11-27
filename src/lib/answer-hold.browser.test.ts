// Run: pnpm test -- src/lib/answer-hold.browser.test.ts (Solid's reactive build).
// Sova's mesh proposal dialog (§mesh.lan/proposals): a click or key press meant for one request, or for what was
// focused before the dialog appeared, never answers a request not yet read. The hold is tied to the request shown,
// not to the dialog mounting: the next waiting request taking the place of one just answered starts it again. The
// project has no DOM in its tests, so the dialog's own wiring (focus on the dialog, aria-disabled) is checked in a
// browser; this checks the rule the dialog's buttons follow.
// Broken as the branch had it (a hold, or none, tied to the dialog mounting: one request replacing another starts
// nothing), the first test fails at mp_b.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { answerCounts, createAnswerHold } = await import("./answer-hold");

const HOLD = 40;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A click on one of the dialog's buttons answers now, as the dialog decides it. */
const clickAnswers = (held: () => boolean) => answerCounts({ isTrusted: true }, { busy: false, held: held() });

function harness() {
  const [key, setKey] = solid.createSignal<string | undefined>(undefined);
  const news: string[] = [];
  let held!: () => boolean;
  const dispose = solid.createRoot((dispose) => {
    held = createAnswerHold(key, { ms: HOLD, onNew: (k) => news.push(k) });
    return dispose;
  });
  return { setKey, held: () => held(), news, dispose };
}

test("each request shown, the first and every one taking another's place, holds the answers and takes the keyboard", async () => {
  const h = harness();
  try {
    assert.equal(h.held(), false, "nothing shown, nothing held");
    for (const [i, id] of ["mp_a", "mp_b", "mp_c"].entries()) {
      h.setKey(id);
      assert.equal(clickAnswers(h.held), false, `${id}: a click the moment it appears doesn't answer it`);
      assert.deepEqual(h.news, ["mp_a", "mp_b", "mp_c"].slice(0, i + 1), `${id}: the dialog is told, so it focuses itself`);
      await wait(HOLD + 30);
      assert.equal(clickAnswers(h.held), true, `${id}: once read, a click answers`);
    }
  } finally {
    h.dispose();
  }
});

test("the same request repeated by the feed starts no new hold; a new one mid-hold starts it again from the full length", async () => {
  const h = harness();
  try {
    h.setKey("mp_a");
    await wait(HOLD + 30);
    h.setKey("mp_a");
    assert.equal(clickAnswers(h.held), true, "the same id again is no new request");
    assert.deepEqual(h.news, ["mp_a"]);
    h.setKey("mp_b");
    await wait(HOLD / 2);
    h.setKey("mp_c");
    await wait(HOLD / 2 + 10);
    assert.equal(clickAnswers(h.held), false, "mp_c's own hold runs its full length, not mp_b's remainder");
    await wait(HOLD);
    assert.equal(clickAnswers(h.held), true);
    h.setKey(undefined);
    assert.equal(h.held(), false, "nothing shown, nothing held");
  } finally {
    h.dispose();
  }
});

test("a script's click and a second click while one answer is in flight never answer, held or not", () => {
  for (const held of [false, true])
    for (const busy of [false, true])
      for (const isTrusted of [false, true]) assert.equal(answerCounts({ isTrusted }, { busy, held }), isTrusted && !busy && !held, JSON.stringify({ isTrusted, busy, held }));
});

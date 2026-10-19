// Run: pnpm test -- src/lib/hand-back.test.ts. A send the chat never took comes back: typed text to the
// composer, a confirm card's click to its card (§app.overseer/confirm, "Clicks compose a message").
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorHandsBack, WAIT_START, waitOnHello, waitOnOpen, waitOnStatus } from "./chat-wait";
import { CardClicks, CLICK_NOT_DELIVERED, handBack, reopenCards, splitHandBack } from "./hand-back";
import { UnackedSends } from "./unacked-sends";

const CLICK = "c_9 a: Register /srv/rakiba as RakibaDesigns in the organization.";

/** ChatView's hand-back as data: the unacked sends, the clicks, the draft and the cards showing "Sent". */
function pane(draft?: string) {
  const unacked = new UnackedSends();
  const clicks = new CardClicks();
  const handedBack = new Set<string>();
  const state = { draft, cardSent: {} as Record<string, string>, notes: [] as string[] };
  let w = WAIT_START;
  let n = 0;
  const apply = (back: ReturnType<UnackedSends["takeAll"]>) => {
    const r = handBack({ draft: state.draft, cardSent: state.cardSent }, back, clicks);
    state.draft = r.draft;
    state.cardSent = r.cardSent;
    if (r.note) state.notes.push(r.note);
  };
  return {
    state,
    unacked,
    clicks,
    open: () => void (w = waitOnOpen(w)),
    hello: () => void (w = waitOnHello(w)),
    /** answer(text, card, sent): send(text, …, card), then the card shows "Sent: a". */
    click: (card: string, letter: string, text = CLICK) => {
      const id = `k${++n}`;
      clicks.note(id, card, text);
      unacked.sent(id, text, w.conn);
      state.cardSent = { ...state.cardSent, [card]: letter };
      return id;
    },
    type: (text: string) => {
      const id = `k${++n}`;
      unacked.sent(id, text, w.conn);
      return id;
    },
    /** The `error` frame code reloaded (or closed): every unacked send comes back. */
    reloaded: () => apply(unacked.takeAll(handedBack)),
    /** The `error` frame code refused, naming one send. */
    refused: (id: string) => apply([unacked.take(id, handedBack)].flatMap((u) => (u ? [u] : []))),
    /** The connection status changes (it may end before its chat's hello). */
    status: (s: Parameters<typeof waitOnStatus>[1]) => {
      const r = waitOnStatus(w, s, true);
      if (r.handBack !== null) apply(unacked.takeFrom(r.handBack, handedBack));
      w = r.next;
    },
    error: () => {
      const conn = errorHandsBack(w);
      if (conn !== null) apply(unacked.takeFrom(conn, handedBack));
    },
  };
}

test("b1: a card click unacked when 'reloaded' arrives leaves the draft empty and its buttons back", () => {
  const p = pane();
  p.open();
  p.hello();
  p.click("c_9", "a");
  assert.deepEqual(p.state.cardSent, { c_9: "a" }, "control: the card shows Sent: a");
  p.reloaded();
  assert.equal(p.state.draft ?? "", "", "never in the composer");
  assert.equal(p.state.cardSent.c_9, undefined, "cardSent[c_9] cleared: the buttons come back");
  assert.deepEqual(p.state.notes, [CLICK_NOT_DELIVERED]);
  assert.equal(CLICK_NOT_DELIVERED, "Your click didn't reach the Overseer. Click again.");
});

test("b1: a card click on a connection that ends before its chat's hello leaves the draft empty and its buttons back", () => {
  const p = pane();
  p.open();
  p.click("c_9", "a");
  p.status("closed");
  assert.equal(p.state.draft ?? "", "");
  assert.equal(p.state.cardSent.c_9, undefined);
  assert.deepEqual(p.state.notes, [CLICK_NOT_DELIVERED]);
  // The same, through the error frame before the hello.
  const q = pane();
  q.open();
  q.click("c_9", "a");
  q.error();
  assert.equal(q.state.draft ?? "", "");
  assert.equal(q.state.cardSent.c_9, undefined);
});

test("a refusal naming the click (the chat was restarting) brings the card back, never the composer; a typed draft is kept as it was", () => {
  const p = pane("half a thought");
  p.open();
  p.hello();
  const id = p.click("c_9", "a");
  p.refused(id);
  assert.equal(p.state.draft, "half a thought");
  assert.deepEqual(p.state.cardSent, {});
  assert.deepEqual(p.state.notes, [CLICK_NOT_DELIVERED]);
});

test("typed sends still come back to the top of the draft, oldest first; clicks beside them go to their cards", () => {
  const p = pane("draft");
  p.open();
  p.hello();
  p.type("first");
  p.click("c_9", "a");
  p.click("c_3", "b", "c_3 b: Keep it.");
  p.type("second");
  p.reloaded();
  assert.equal(p.state.draft, "first\n\nsecond\n\ndraft");
  assert.deepEqual(p.state.cardSent, {});
  assert.deepEqual(p.state.notes, [CLICK_NOT_DELIVERED], "one note for the batch");
  // Nothing typed: the draft is untouched and no note says a click came back.
  const q = pane("kept");
  q.open();
  q.hello();
  q.type("t");
  q.reloaded();
  assert.equal(q.state.draft, "t\n\nkept");
  assert.deepEqual(q.state.notes, []);
});

test("only the card whose click came back reopens; another card's Sent mark stays", () => {
  assert.deepEqual(reopenCards({ c_9: "a", c_2: "b" }, ["c_9"]), { c_2: "b" });
  const clicks = new CardClicks();
  clicks.note("k1", "c_9", CLICK);
  const r = handBack({ draft: undefined, cardSent: { c_9: "a", c_2: "b" } }, [{ id: "k1", text: CLICK }], clicks);
  assert.deepEqual(r.cardSent, { c_2: "b" });
  assert.equal(r.draft, undefined);
  assert.deepEqual(r.texts, []);
  assert.deepEqual(r.cards, ["c_9"]);
});

test("a row with no id, or an id that was no click, is typed text, even when it reads like a click", () => {
  const clicks = new CardClicks();
  clicks.note("k1", "c_9", CLICK);
  const s = splitHandBack([{ text: CLICK }, { id: "k2", text: CLICK }, { id: "k1", text: CLICK }], clicks);
  assert.deepEqual(s.texts, [{ text: CLICK }, { id: "k2", text: CLICK }]);
  assert.deepEqual(s.cards, ["c_9"]);
  // Handed back once: the click is forgotten (handedBack keeps any second hand-back of its id away).
  assert.equal(clicks.cardOf("k1"), undefined);
});

test("Stop's drained queue names texts: a click's text takes its card, once, oldest first", () => {
  const clicks = new CardClicks();
  clicks.note("k1", "c_9", CLICK);
  clicks.note("k2", "c_9", CLICK);
  assert.equal(clicks.takeByText("typed"), undefined);
  assert.equal(clicks.takeByText(CLICK), "c_9");
  assert.equal(clicks.cardOf("k1"), undefined);
  assert.equal(clicks.cardOf("k2"), "c_9");
});

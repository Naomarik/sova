import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BatonInfo, BatonSummaryField } from "../../shared/baton";
import { batonComposerGate, goalShown, leaseMinutes, linkReplaced, linksStale, liveOffer, namesList, proposedAreasLine, stripActions, whereLine, wrapupLine } from "./baton-strip";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const info = (session: Partial<BatonInfo["session"]>, offer: BatonInfo["offer"] = null): Pick<BatonInfo, "offer" | "session" | "names"> => ({
  session: { state: "open", holder: null, ...session } as BatonInfo["session"],
  offer,
  names: { p_1: "Tony", operator: "Omar" },
});
const offer = (state: "open" | "held" | "withdrawn", extra: Partial<NonNullable<BatonInfo["offer"]>> = {}): NonNullable<BatonInfo["offer"]> => ({
  id: "off_1",
  n: 2,
  to: [
    { id: "p_1", name: "Tony" },
    { id: "p_2", name: "Ana" },
    { id: "p_3", name: "Bob" },
  ],
  state,
  createdAt: "2026-09-26T11:00:00Z",
  ...extra,
});

test("names read as a list with a serial comma", () => {
  assert.equal(namesList(["Ana"]), "Ana");
  assert.equal(namesList(["Ana", "Bob"]), "Ana and Bob");
  assert.equal(namesList(["Ana", "Bob", "Carl"]), "Ana, Bob, and Carl");
});

test("lease minutes round up and stop at 0", () => {
  assert.equal(leaseMinutes("2026-09-26T12:14:01Z", NOW), 15);
  assert.equal(leaseMinutes("2026-09-26T11:00:00Z", NOW), 0);
});

test("an offer is live only while it is the session's current one and not withdrawn", () => {
  assert.equal(liveOffer(info({ offerId: "off_1" }, offer("open")))?.id, "off_1");
  assert.equal(liveOffer(info({ offerId: undefined }, offer("open"))), null, "a past offer");
  assert.equal(liveOffer(info({ offerId: "off_1" }, offer("withdrawn"))), null);
});

test("every place the baton can be has its phrase", () => {
  assert.equal(whereLine(info({ state: "done" }), NOW), "done");
  assert.equal(whereLine(info({ state: "closed" }), NOW), "closed");
  assert.equal(whereLine(info({ offerId: "off_1" }, offer("open")), NOW), "offered to Tony, Ana, and Bob — nobody has answered yet");
  assert.equal(
    whereLine(info({ offerId: "off_1", holder: "p_2" }, offer("held", { holder: { id: "p_2", name: "Ana" }, leaseUntil: "2026-09-26T12:01:00Z" })), NOW),
    "Ana is answering (offered to Tony, Ana, and Bob) — theirs for 1 more minute of quiet",
  );
  // A lapsed lease: someone answered and went quiet, so the offer is open again, not untouched.
  assert.equal(
    whereLine(info({ offerId: "off_1" }, offer("open", { lastActivityAt: "2026-09-26T11:30:00Z" })), NOW),
    "offered to Tony, Ana, and Bob — open again; nobody is answering right now",
  );
  // A lease with seconds left (a short test lease, or the last minute of a real one) is not "1 more minute".
  assert.equal(
    whereLine(info({ offerId: "off_1", holder: "p_2" }, offer("held", { holder: { id: "p_2", name: "Ana" }, leaseUntil: "2026-09-26T12:00:05Z" })), NOW),
    "Ana is answering (offered to Tony, Ana, and Bob) — theirs for less than a minute more of quiet",
  );
  assert.equal(whereLine(info({ holder: "operator", state: "needs-you" }), NOW), "with you — you can write now");
  assert.equal(whereLine(info({ holder: "operator", state: "needs-you", budget: { messagesMax: 5, messagesUsed: 5 } }), NOW), "with you — extend the limit to write");
  assert.equal(whereLine(info({ holder: "p_1" }), NOW), "with Tony — you can write once you take it back");
});

test("links stay through refetches and go only when a later hand-off exists", () => {
  assert.equal(linksStale(3, undefined), false, "info not read yet (the refetch in flight)");
  assert.equal(linksStale(3, 3), false, "same hand-off: New Link, a refetch");
  assert.equal(linksStale(3, 2), false, "a stale read never clears");
  assert.equal(linksStale(3, 4), true, "the baton moved on");
  assert.equal(linksStale(null, 9), false, "nothing on screen");
});

test("a referral's decision areas are said on its approval card, or that there are none", () => {
  assert.equal(proposedAreasLine("Bob", ["invoicing", "payroll export"]), "Decides: invoicing, payroll export — approving Bob approves these areas.");
  assert.equal(proposedAreasLine("Bob", ["bank access"]), "Decides: bank access — approving Bob approves this area.");
  assert.equal(proposedAreasLine("Bob", []), "No decision areas.");
  assert.equal(proposedAreasLine("Bob", undefined), null, "not sent is unknown, never 'none'");
  assert.equal(proposedAreasLine("Bob", [" ", ""]), "No decision areas.");
});

test("the wrap-up line: skipped and running offer no review; done and failed do", () => {
  const w = (state: "running" | "done" | "failed" | "skipped", extra = {}) => ({ state, at: "2026-09-26T12:00:00Z", applied: 0, refused: [], ...extra });
  assert.deepEqual(wrapupLine(w("skipped")), { text: "Wrap-up skipped: nobody but you wrote in this session.", review: false });
  assert.equal(wrapupLine(w("running")).review, false);
  assert.deepEqual(wrapupLine(w("done", { applied: 1 })), { text: "Wrap-up: 1 profile field updated.", review: true });
  assert.equal(wrapupLine(w("done", { applied: 3, refused: [{ personId: "p", field: "role", reason: "x" }] })).text, "Wrap-up: 3 profile fields updated, 1 refused.");
  assert.deepEqual(wrapupLine(w("failed", { error: "Model timed out." })), { text: "Wrap-up stopped: Model timed out. Profiles it didn't reach are unchanged.", review: true });
});

test("the operator's composer is read-only whenever someone else has the baton, whatever the list lags", () => {
  const field = (f: Partial<BatonSummaryField>): BatonSummaryField => ({ holder: "Bob", state: "open", ...f });
  const theirs = { ended: false, text: "Bob holds the baton. Take it back to write." };
  // A Hand On from the strip: the strip already reads Bob, the list still says it's the operator's turn.
  assert.deepEqual(batonComposerGate(field({ state: "needs-you", holder: "Omar" }), false), { ended: false, text: "Omar holds the baton. Take it back to write." });
  assert.deepEqual(batonComposerGate(field({}), false), theirs);
  assert.deepEqual(batonComposerGate(field({}), undefined), theirs, "not read yet: the list's open means a person's");
  assert.equal(batonComposerGate(field({ state: "needs-you", holder: "Omar" }), undefined), null, "not read yet: needs-you is the operator's");
  assert.equal(batonComposerGate(field({ holder: "Omar" }), true), null, "open after Take Back and a reply: the operator's");
  assert.deepEqual(batonComposerGate(field({ holder: null, offer: { state: "open", invited: 3 } }), true)?.text, "Offered to 3 people; nobody is answering right now. Withdraw it to write.");
  assert.deepEqual(batonComposerGate(field({ offer: { state: "held", invited: 3, holder: "Ana" } }), false)?.text, "Ana took the offer and is answering. Withdraw it to write.");
  assert.deepEqual(batonComposerGate(field({ state: "done", holder: null }), true), { ended: true, text: "This hand-off session is done." });
  assert.equal(batonComposerGate(undefined, undefined), null, "not a baton session");
});

test("a shown link reads as replaced only once a newer link of the same person exists", () => {
  const shown = { personId: "p_1", name: "Tony", link: "/h/x", at: "2026-09-27T10:00:00.000Z" };
  assert.equal(linkReplaced(shown, { linkAt: { p_1: "2026-09-27T10:00:00.000Z" } }), false, "itself");
  assert.equal(linkReplaced(shown, { linkAt: { p_1: "2026-09-27T10:00:05.000Z" } }), true, "another tab's Get Link");
  assert.equal(linkReplaced(shown, { linkAt: { p_2: "2026-09-27T10:00:05.000Z" } }), false, "another invitee's new link is not this one's");
  assert.equal(linkReplaced(shown, { linkAt: {} }), false, "turned off, not replaced");
  assert.equal(linkReplaced({ ...shown, at: undefined }, { linkAt: { p_1: "2026-09-27T10:00:05.000Z" } }), false, "no mint time known: never guessed");
  assert.equal(linkReplaced(shown, undefined), false);
});

test("the goal shows trimmed, and not at all when there is none", () => {
  assert.equal(goalShown({ goal: "  Find out who approves invoices.\nAnd by when.  " }), "Find out who approves invoices.\nAnd by when.");
  assert.equal(goalShown({ goal: "" }), null);
  assert.equal(goalShown({ goal: " \n\t " }), null, "whitespace only");
  assert.equal(goalShown({}), null, "an older row with no goal");
  assert.equal(goalShown({ goal: null }), null);
  assert.equal(goalShown(undefined), null);
});

describe("the strip's acts: one primary, the rest in the menu, the destructive ones last", () => {
  const at = (
    session: Partial<BatonInfo["session"]>,
    extra: { offer?: BatonInfo["offer"]; liveLinks?: number; owner?: { name: string } | null } = {},
  ): Pick<BatonInfo, "offer" | "session" | "liveLinks" | "owner"> => ({
    session: { state: "open", holder: null, budget: { messagesUsed: 3, messagesMax: 30 }, ...session } as BatonInfo["session"],
    offer: extra.offer ?? null,
    liveLinks: extra.liveLinks ?? 0,
    owner: extra.owner ?? null,
  });

  test("a person holds it, with a live link: Take Back, Get Link and Hand On in the menu, Delete Link and Close set apart", () => {
    assert.deepEqual(stripActions(at({ holder: "p_1" }, { liveLinks: 1 })), {
      primary: "take-back",
      menu: ["get-link", "hand-on", "told"],
      destructive: ["delete-link", "close"],
    });
  });

  test("a person holds it with no live link: no Delete Link", () => {
    assert.deepEqual(stripActions(at({ holder: "p_1" })), { primary: "take-back", menu: ["get-link", "hand-on", "told"], destructive: ["close"] });
  });

  test("a person holds it at the limit: still Take Back", () => {
    assert.equal(stripActions(at({ holder: "p_1", budget: { messagesUsed: 30, messagesMax: 30 } })).primary, "take-back");
  });

  test("an offer is live (open or held by its taker): Withdraw Offer, no Get Link or Delete Link", () => {
    const open = at({ offerId: "off_1" }, { offer: offer("open"), liveLinks: 3 });
    assert.deepEqual(stripActions(open), { primary: "withdraw", menu: ["hand-on", "told"], destructive: ["close"] });
    const held = at({ offerId: "off_1", holder: "p_2" }, { offer: offer("held", { holder: { id: "p_2", name: "Ana" } }), liveLinks: 3 });
    assert.deepEqual(stripActions(held), { primary: "withdraw", menu: ["hand-on", "told"], destructive: ["close"] });
  });

  test("a withdrawn offer is not live: whoever holds it decides", () => {
    assert.equal(stripActions(at({ offerId: "off_1", holder: "operator" }, { offer: offer("withdrawn") })).primary, "hand-on");
  });

  test("the operator holds it with messages left: Hand On is the primary and not repeated in the menu", () => {
    for (const state of ["open", "needs-you"] as const) {
      assert.deepEqual(stripActions(at({ holder: "operator", state })), { primary: "hand-on", menu: ["told"], destructive: ["close"] });
    }
  });

  test("the operator holds it at the limit: no primary (Extend has its own row), Hand On stays in the menu", () => {
    assert.deepEqual(stripActions(at({ holder: "operator", state: "needs-you", budget: { messagesUsed: 30, messagesMax: 30 } })), {
      primary: null,
      menu: ["hand-on", "told"],
      destructive: ["close"],
    });
  });

  test("done: only What It's Told and Close Session", () => {
    assert.deepEqual(stripActions(at({ holder: "p_1", state: "done" }, { liveLinks: 1 })), { primary: null, menu: ["told"], destructive: ["close"] });
  });

  test("closed: only What It's Told", () => {
    assert.deepEqual(stripActions(at({ holder: "p_1", state: "closed" }, { liveLinks: 1 })), { primary: null, menu: ["told"], destructive: [] });
  });

  test("an org with an owner adds Hide From / Show To, in every state", () => {
    const owner = { name: "Owner Name" };
    assert.deepEqual(stripActions(at({ holder: "p_1" }, { owner })).menu, ["get-link", "hand-on", "told", "owner"]);
    assert.deepEqual(stripActions(at({ holder: "operator" }, { owner })).menu, ["told", "owner"]);
    assert.deepEqual(stripActions(at({ state: "closed" }, { owner })).menu, ["told", "owner"]);
  });
});

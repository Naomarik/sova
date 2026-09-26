import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatonInfo } from "../../shared/baton";
import { leaseMinutes, linksStale, liveOffer, namesList, proposedAreasLine, whereLine, wrapupLine } from "./baton-strip";

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
  assert.equal(whereLine(info({ holder: "operator", state: "needs-you" }), NOW), "with you — you can write now");
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

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WireAreas } from "../../shared/wire-areas";
import { behindName, canSend, displayWarningWords, hostReading, readsWithoutSending, sendingOffWords, stateCost, updateNeededWords } from "./mesh-compat";
import { hostTone } from "./mesh-details";

const own: WireAreas = { sessions: 3, transcript: 3, composer: 3, peer: 3 };
const up = (over: Partial<WireAreas> = {}) => ({ state: "up" as const, areas: { ...own, ...over } });
const names = { self: "Desk", peer: "VPS" };

test("the page's own numbers decide, with the first true line of the states' order", () => {
  assert.equal(hostReading(up(), false, own), "works");
  assert.equal(hostReading(up({ composer: 4 }), false, own), "read-only");
  assert.equal(hostReading(up({ composer: 2 }), false, own), "read-only", "a difference is a difference, whichever side is higher");
  assert.equal(hostReading(up({ transcript: 4 }), false, own), "display");
  assert.equal(hostReading(up({ transcript: 4, composer: 4 }), false, own), "display", "reading before writing");
  assert.equal(hostReading(up({ sessions: 4 }), false, own), "update");
  assert.equal(hostReading(up({ peer: 2 }), false, own), "update");
  assert.equal(hostReading(up({ sessions: 4, transcript: 4, composer: 4 }), false, own), "update", "update first");
});

test("a host that lists no areas: skewed reads Update needed, same fingerprint works", () => {
  assert.equal(hostReading({ state: "skewed" }, false, own), "update");
  assert.equal(hostReading({ state: "up" }, false, own), "works");
});

test("a host that doesn't answer, refuses or hides keeps that state, whatever it lists", () => {
  assert.equal(hostReading({ state: "down" }, false, own), "down");
  assert.equal(hostReading({ state: "refused" }, false, own), "refused");
  assert.equal(hostReading({ state: "hidden" }, false, own), "hidden");
  assert.equal(hostReading(up({ composer: 4 }), true, own), "hidden", "keeps its sessions from this host");
});

test("what each reading allows", () => {
  assert.deepEqual((["works", "read-only", "display", "update", "hidden", "down", "refused"] as const).filter(canSend), ["works"]);
  assert.deepEqual((["works", "read-only", "display", "update", "hidden", "down", "refused"] as const).filter(readsWithoutSending), ["read-only", "display"]);
});

test("amber means something is lost: works is green with no word, the three reduced states amber with theirs", () => {
  assert.deepEqual(hostTone("works"), { tone: "up", word: null });
  assert.deepEqual(hostTone("read-only"), { tone: "skewed", word: "read only" });
  assert.deepEqual(hostTone("display"), { tone: "skewed", word: "display may be wrong" });
  assert.deepEqual(hostTone("update"), { tone: "skewed", word: "update needed" });
});

test("the side named behind is the lower number on the area that was lost, never the other area", () => {
  assert.equal(behindName("read-only", up({ composer: 2 }), names, own), "VPS");
  assert.equal(behindName("read-only", up({ composer: 4 }), names, own), "Desk");
  assert.equal(behindName("display", up({ transcript: 2, composer: 4 }), names, own), "VPS", "reading's number, though writing differs the other way");
  assert.equal(behindName("display", up({ transcript: 4, composer: 2 }), names, own), "Desk");
});

test("the sentences say what the spec has them say, and none leans on a release number or the retired words", () => {
  const notice = sendingOffWords("VPS", "VPS");
  assert.match(notice.title, /^Nothing can be sent to VPS from this page, Stop included\.$/);
  assert.match(notice.body, /You can still read and watch\. VPS is behind\./);
  assert.doesNotMatch(sendingOffWords("VPS", null).body, /behind/);
  assert.match(displayWarningWords("Desk").title, /may not show correctly/);
  assert.match(displayWarningWords("Desk").body, /Desk is behind/);
  const page = updateNeededWords("VPS");
  assert.match(page.title, /runs another version of Sova/);
  assert.match(page.body, /opens once the two match/);
  assert.match(page.body, /Nothing here changed/);
  for (const s of [notice.title, notice.body, page.title, page.body, stateCost("read-only", "VPS"), stateCost("display", "VPS"), stateCost("update", "VPS")]) {
    assert.doesNotMatch(s, /can't be reached|\bother version|\d+\.\d+/, s);
  }
});

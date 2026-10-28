// Run: pnpm test -- src/lib/transcript-kinds.test.ts
// The transcript's kind list (§chat.transcript-cards/toolkit): one list, first match wins in the
// order the old per-kind chain had, each kind's estimate, host and placement.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { followingKinds, followsNow, kindById, kindOf, sameHit, toolkitKinds, TRANSCRIPT_KINDS, type KindContext, type TranscriptKind } from "./transcript-kinds";
import { rowEstimate } from "./tail-render";

const AT = "2026-02-01T00:00:00.000Z";
const row = (over: Partial<TranscriptItem>): TranscriptItem => ({ id: "r1", kind: "info", at: AT, ...over }) as TranscriptItem;
const ctx = (over: Partial<KindContext> = {}): KindContext => ({
  hasUserRow: () => true,
  tourCard: () => undefined,
  showChanges: () => undefined,
  offer: () => undefined,
  settings: () => undefined,
  ...over,
});
const idOf = (item: TranscriptItem, c = ctx()) => kindOf(item, c)?.kind.id;

test("ids are unique, plain names, and each kind is anchored or follows by a named condition", () => {
  const ids = TRANSCRIPT_KINDS.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of TRANSCRIPT_KINDS) {
    assert.match(k.id, /^[a-z][a-z0-9-]*$/, "Sova's own kinds have plain names");
    assert.ok(k.placement === "anchored" || ["until-answered", "until-done"].includes(k.placement.follow), k.id);
    assert.equal(k.host, "page", "Sova's own kinds draw in the page");
  }
  assert.equal(kindById("wake")?.id, "wake");
});

test("first match wins, in the old chain's order", () => {
  assert.equal(idOf(row({ kind: "user", text: "[overseer brief] x" })), "user", "a plain user row");
  assert.equal(idOf(row({ kind: "wake", wake: { id: "n1" } })), "wake");
  assert.equal(idOf(row({ kind: "wake" })), undefined, "a wake row without its parse draws as Unknown, as before");
  assert.equal(idOf(row({ kind: "topic", topic: { topic: "t", batch: "b", notes: [] } })), "topic");
  // Info rows: marks and the specific info kinds come before the plain info row.
  assert.equal(idOf(row({ overseerMark: { kind: "sent", targetId: "x" } } as never)), "overseer-sent");
  assert.equal(idOf(row({ ownerRequest: { id: "x" } } as never)), "owner-request");
  assert.equal(idOf(row({ handoffRun: { status: "running" } } as never)), "handoff-run");
  assert.equal(idOf(row({ facts: { compaction: { summary: "s" } } })), "compaction");
  assert.equal(idOf(row({ handoffRun: { status: "running" }, facts: { compaction: {} } } as never)), "handoff-run", "a handoff run before a compaction");
  assert.equal(idOf(row({ loginNote: true } as never), ctx({ hasUserRow: () => false })), "login-note-waiting");
  assert.equal(idOf(row({ loginNote: true } as never), ctx({ hasUserRow: () => true })), "info", "a login note shows once a message is on the branch");
  assert.equal(idOf(row({ text: "x" })), "info");
  // Tool calls: the cards first, then the generic tool card.
  assert.equal(idOf(row({ kind: "tool-call", text: "offer", toolCallId: "c" }), ctx({ offer: () => ({ id: "o" }) })), "offer");
  assert.equal(idOf(row({ kind: "tool-call", text: "offer", toolCallId: "c" })), "tool", "an offer call that failed is a tool card");
  assert.equal(idOf(row({ kind: "tool-call", text: "offer" }), ctx({ tourCard: () => ({}), offer: () => ({}) })), "tour", "a tour card before an offer");
  assert.equal(idOf(row({ kind: "tool-result" })), "tool-result");
  assert.equal(idOf(row({ kind: "report", report: { source: "x" } } as never)), "report");
  assert.equal(idOf(row({ kind: "report", report: { source: "x", team: {} } } as never)), "team-report");
});

test("a match's value is what the row draws from, and two hits from one value draw the same", () => {
  const wake = { id: "n1" };
  const a = kindOf(row({ kind: "wake", wake }), ctx());
  const b = kindOf(row({ kind: "wake", wake }), ctx());
  assert.equal(a?.value, wake);
  assert.ok(sameHit(a, b));
  assert.ok(!sameHit(a, kindOf(row({ kind: "wake", wake: { id: "n1" } }), ctx())));
});

test("the kinds on the toolkit reserve the height they reserved before", () => {
  const cases: [Partial<TranscriptItem>, string][] = [
    [{ kind: "wake", wake: { id: "n1" } }, "calc(46px)"],
    [{ kind: "topic", topic: { topic: "t", batch: "b", notes: [] } }, "calc(70px)"],
    [{ facts: { compaction: {} } }, "calc(36px)"],
    [{ text: "a line of text" }, rowEstimate({ kind: "info", text: "a line of text" })],
  ];
  for (const [over, before] of cases) {
    const item = row(over);
    const hit = kindOf(item, ctx())!;
    assert.ok(hit.kind.view, hit.kind.id);
    assert.equal(rowEstimate(item, undefined, "user", false, false, false, hit.kind.estimate!(item, hit.value)), before, hit.kind.id);
    assert.equal(rowEstimate(item), before, `${hit.kind.id}: the rule without the kind agrees`);
  }
});

test("only the toolkit's own kinds may follow, and none does yet; the alignment card follows by revision until it moves", () => {
  assert.deepEqual(followingKinds(), []);
  assert.deepEqual(kindById("align")?.placement, { follow: "until-answered" });
  assert.equal(kindById("align")?.view, undefined, "drawn by its own branch, so its rows never move today");
  const item = row({ kind: "align", align: { v: 1, line: "" } } as never);
  assert.equal(followsNow(kindOf(item, ctx()), item), false);
  // A kind on the toolkit that follows does so while its condition holds, and settles after.
  const open = { done: false };
  const card: TranscriptKind = { id: "card", match: () => open, host: "data", placement: { follow: "until-done" }, holds: (_it, v) => !(v as { done: boolean }).done, view: { page: "info" } };
  assert.deepEqual(followingKinds([card]), [card]);
  const hit = kindOf(item, ctx(), [card]);
  assert.equal(followsNow(hit, item), true);
  open.done = true;
  assert.equal(followsNow(hit, item), false);
  assert.equal(followsNow({ kind: { ...card, placement: "anchored" }, value: { done: false } }, item), false, "an anchored kind never moves");
  assert.deepEqual(toolkitKinds([card]), ["card"]);
});

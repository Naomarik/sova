import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "./protocol";
import { briefBody, isBriefText, isOwnInput, messageBody, otherSender, ownInputIds, rowSender, sendersOf } from "./senders";

const sessionMark = (target: string, title = "Planner"): TranscriptItem => ({
  id: `m-${target}`,
  kind: "info",
  sessionMark: { kind: "sent", targetId: target, from: { sessionId: "sid", title }, hop: 2 },
});

test("sendersOf reads all three markers by target id, in either arrival order", () => {
  const items: TranscriptItem[] = [
    sessionMark("s1"),
    { id: "s1", kind: "user", text: "x" },
    { id: "o1", kind: "user", text: "x" },
    { id: "m-o1", kind: "info", overseerMark: { kind: "sent", targetId: "o1" } },
    { id: "m-t1", kind: "info", batonMark: { kind: "sent", targetId: "t1", by: "p_kim" } },
    { id: "m-d", kind: "info", overseerMark: { kind: "dialog-answer", title: "t", answer: "a" } },
  ];
  const s = sendersOf(items);
  assert.deepEqual(s.get("s1"), { kind: "session", sessionId: "sid", title: "Planner", hop: 2 });
  assert.deepEqual(s.get("o1"), { kind: "overseer" });
  assert.deepEqual(s.get("t1"), { kind: "baton", by: "p_kim" });
  assert.equal(s.size, 3, "a dialog answer names no sender");
});

test("two markers on one row: another session wins over the Overseer, the Overseer over a baton participant", () => {
  const s = sendersOf([
    { id: "b", kind: "info", batonMark: { kind: "sent", targetId: "x", by: "p_kim" } },
    { id: "o", kind: "info", overseerMark: { kind: "sent", targetId: "x" } },
  ]);
  assert.equal(s.get("x")!.kind, "overseer");
  assert.equal(sendersOf([sessionMark("x"), { id: "o", kind: "info", overseerMark: { kind: "sent", targetId: "x" } }]).get("x")!.kind, "session");
});

test("the operator's own baton message has no other sender; a block id resolves to its entry", () => {
  const s = sendersOf([{ id: "b", kind: "info", batonMark: { kind: "sent", targetId: "op", by: "operator" } }, sessionMark("e")]);
  assert.equal(otherSender(s, "op"), undefined);
  assert.equal(otherSender(s, "e:1")!.kind, "session");
});

test("isOwnInput: a user row nobody else sent, never a brief, a wake or a link", () => {
  const s = sendersOf([sessionMark("s1")]);
  assert.equal(isOwnInput({ id: "u", kind: "user", text: "hi" }, s), true);
  assert.equal(isOwnInput({ id: "s1", kind: "user", text: "hi" }, s), false);
  assert.equal(isOwnInput({ id: "b", kind: "user", text: "  [overseer-brief] x" }, s), false);
  assert.equal(isOwnInput({ id: "w", kind: "wake", text: "x" }, s), false);
  assert.equal(isOwnInput({ id: "l", kind: "link", text: "x" }, s), false);
  assert.deepEqual(rowSender({ id: "b", kind: "user", text: "[overseer-brief] x" }, s), { kind: "overseer" });
});

test("ownInputIds judges by the markers among the rows themselves", () => {
  const rows: TranscriptItem[] = [{ id: "u", kind: "user" }, { id: "s1", kind: "user" }, sessionMark("s1"), { id: "k", kind: "user" }];
  assert.deepEqual(ownInputIds(rows), ["u", "k"]);
});

test("messageBody strips another session's header only when the marker says so; a brief its tag", () => {
  const text = '[from session "Planner" (sid), hop 2]\nplease run it';
  assert.equal(messageBody(text, { kind: "session", sessionId: "sid", title: "Planner", hop: 2 }), "please run it");
  assert.equal(messageBody(text, undefined), text);
  assert.equal(messageBody(text, { kind: "overseer" }), text);
  assert.equal(isBriefText("[overseer-brief] two"), true);
  assert.equal(briefBody("[overseer-brief] two"), "two");
  assert.equal(messageBody("[overseer-brief] two", { kind: "overseer" }, true), "two");
});


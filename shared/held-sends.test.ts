// Run: pnpm test -- shared/held-sends.test.ts. What became of the sends one chat connection made
// (§chat.transcript/send-while-starting): taken, or refused and handed back once.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANSWER_MAX_CHARS, HeldSends } from "./held-sends";

const prompt = (clientId: string, text = `text of ${clientId}`) => ({ type: "prompt", text, clientId });

describe("HeldSends", () => {
  test("holds prompts and steers with a client id, nothing else", () => {
    const h = new HeldSends();
    h.sent(prompt("a"));
    h.sent({ type: "steer", text: "s", clientId: "b" });
    h.sent({ type: "prompt", text: "no id" });
    h.sent({ type: "set_model", ref: "x/y" });
    h.sent(null);
    assert.equal(h.size, 2);
  });

  test("an ack settles its send; a refusal naming one hands it back once", () => {
    const h = new HeldSends();
    h.sent(prompt("a"));
    h.sent(prompt("b"));
    assert.deepEqual(h.heard({ type: "hello" }), []);
    assert.deepEqual(h.heard({ type: "send_ack", clientId: "a", queued: false }), []);
    assert.deepEqual(h.heard({ type: "error", code: "internal", message: "off", clientId: "b" }), [{ id: "b", text: "text of b" }]);
    assert.deepEqual(h.heard({ type: "error", code: "internal", message: "off", clientId: "b" }), []);
    assert.equal(h.size, 0);
  });

  test("an error naming no send: before the hello the chat never opened, so everything comes back", () => {
    const h = new HeldSends();
    h.sent(prompt("a"));
    h.sent(prompt("b"));
    assert.deepEqual(
      h.heard({ type: "error", code: "config", message: "folder gone" }).map((u) => u.id),
      ["a", "b"],
    );
  });

  test("after the hello an unnamed turn error hands nothing back; reloaded and closed hand back all", () => {
    const h = new HeldSends();
    h.heard({ type: "hello" });
    h.sent(prompt("a"));
    assert.deepEqual(h.heard({ type: "error", code: "internal", message: "turn failed" }), []);
    assert.deepEqual(h.heard({ type: "error", code: "reloaded", message: "reconnect" }).map((u) => u.id), ["a"]);
    h.sent(prompt("b"));
    assert.deepEqual(h.heard({ type: "closed", reason: "idle" }).map((u) => u.id), ["b"]);
  });

  test("heardJson: answers parsed, a hello too big to parse still counts as the hello", () => {
    const h = new HeldSends();
    assert.equal(h.listening, true, "listens for the hello with nothing held");
    h.sent(prompt("a"));
    const big = JSON.stringify({ type: "hello", items: ["x".repeat(ANSWER_MAX_CHARS)] });
    assert.deepEqual(h.heardJson(big), []);
    // After that hello, an unnamed error is a turn's, not a failed open.
    assert.deepEqual(h.heardJson(JSON.stringify({ type: "error", code: "internal", message: "x" })), []);
    assert.equal(h.size, 1);
    assert.deepEqual(h.heardJson(JSON.stringify({ type: "send_ack", clientId: "a", queued: true })), []);
    assert.equal(h.size, 0);
    assert.equal(h.listening, false, "nothing held after the hello: frames go unparsed");
    assert.deepEqual(h.heardJson("not json"), []);
  });

  test("takeAll: every send still held, oldest first, then none", () => {
    const h = new HeldSends();
    h.sent(prompt("a"));
    h.sent(prompt("b"));
    assert.deepEqual(h.takeAll(), [
      { id: "a", text: "text of a" },
      { id: "b", text: "text of b" },
    ]);
    assert.deepEqual(h.takeAll(), []);
  });
});

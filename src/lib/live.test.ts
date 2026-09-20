// Run: npx tsx --test src/lib/live.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "solid-js/store";
import { addPendingPrompt, applyEvent, emptyLive, takeBackQueued, type LiveState } from "./live";

function store(): [LiveState, ReturnType<typeof createStore<LiveState>>[1]] {
  const [s, set] = createStore<LiveState>(emptyLive());
  return [s, set];
}

const messageStart = (provider?: string, model?: string) => ({
  type: "message_start",
  message: { role: "assistant", provider, model, content: [] },
});

test("message_start attributes the streaming message to its model", () => {
  const [s, set] = store();
  applyEvent(set, messageStart("zai", "glm-5.3"));
  assert.equal(s.entries[0]?.kind, "assistant");
  if (s.entries[0]?.kind === "assistant") assert.equal(s.entries[0].model, "zai/glm-5.3");
});

test("message_end is authoritative and can override the model", () => {
  const [s, set] = store();
  applyEvent(set, messageStart("zai", "glm-5.3"));
  applyEvent(set, {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "hi" }],
      stopReason: "stop",
    },
  });
  if (s.entries[0]?.kind === "assistant") {
    assert.equal(s.entries[0].model, "openai/gpt-5.5");
    assert.equal(s.entries[0].done, true);
  }
});

test("events without provider/model leave the entry's model unset", () => {
  const [s, set] = store();
  applyEvent(set, messageStart());
  if (s.entries[0]?.kind === "assistant") assert.equal(s.entries[0].model, undefined);
});

test("a pending prompt carries its uploads as available attachments until confirmed", () => {
  const [s, set] = store();
  const path = "/tmp/pi-web-a58752a9-8229-46d3-a816-07ef24919b10.png";
  addPendingPrompt(set, `look at this\n${path}`, [], [{ path, name: path.slice(5), mimeType: "image/png", size: 1234 }]);
  const entry = s.entries[0];
  assert.equal(entry?.kind, "user");
  if (entry?.kind !== "user") return;
  assert.equal(entry.text, `look at this\n${path}`);
  assert.deepEqual(entry.images, []);
  assert.deepEqual(entry.attachments, [{ path, name: path.slice(5), mimeType: "image/png", size: 1234, available: true }]);
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: entry.text }] } });
  assert.equal(s.entries.length, 1);
  if (s.entries[0]?.kind === "user") {
    assert.equal(s.entries[0].confirmed, true);
    assert.equal(s.entries[0].attachments?.length, 1);
  }
});

test("a pending prompt without uploads has no attachments", () => {
  const [s, set] = store();
  addPendingPrompt(set, "hi");
  if (s.entries[0]?.kind === "user") assert.equal(s.entries[0].attachments, undefined);
});

test("takeBackQueued drops the drained prompts' pending rows and hands their text back", () => {
  const [s, set] = store();
  addPendingPrompt(set, "first prompt");
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "first prompt" }] } });
  applyEvent(set, messageStart("zai", "glm-5.3"));
  addPendingPrompt(set, "so basically");
  addPendingPrompt(set, "and later");
  const text = takeBackQueued(set, ["so basically", "and later"]);
  assert.equal(text, "so basically\n\nand later");
  assert.deepEqual(
    s.entries.map((e) => e.kind),
    ["user", "assistant"],
  );
  if (s.entries[0]?.kind === "user") assert.equal(s.entries[0].confirmed, true); // the delivered prompt stays
});

test("takeBackQueued keeps unrelated and already-delivered rows with the same text", () => {
  const [s, set] = store();
  addPendingPrompt(set, "same");
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "same" }] } });
  addPendingPrompt(set, "other");
  addPendingPrompt(set, "same");
  // An expanded skill/template queues different text: no row matches, the text still comes back.
  assert.equal(takeBackQueued(set, ["same", "<skill>expanded</skill>"]), "same\n\n<skill>expanded</skill>");
  assert.deepEqual(
    s.entries.map((e) => (e.kind === "user" ? [e.text, e.confirmed] : e.kind)),
    [
      ["same", true],
      ["other", false],
    ],
  );
});

test("takeBackQueued with nothing drained changes nothing", () => {
  const [s, set] = store();
  addPendingPrompt(set, "hi");
  assert.equal(takeBackQueued(set, []), "");
  assert.equal(s.entries.length, 1);
});

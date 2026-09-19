// Run: npx tsx --test src/lib/live.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "solid-js/store";
import { applyEvent, emptyLive, type LiveState } from "./live";

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

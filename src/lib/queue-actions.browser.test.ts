// Run: pnpm test -- src/lib/queue-actions.browser.test.ts (Solid's reactive build).
// A pending row's Remove (§chat.transcript/a-queued-message), as ChatView builds it for Thread's queued row
// (`queueActions` → lib/queue-actions.ts): rows come from the live store exactly as the server's queue snapshot
// sets them, and the Remove's `run` sends the frame ChatView's `removeQueued` asks with. No DOM is available to
// these tests (no DOM library in the repo), so this drives the strip's items, not a rendered button.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const { createStore } = await import("solid-js/store");
const { addPendingPrompt, applyQueue, emptyLive, markDelivered } = await import("./live");
const { queueRemoveFrame, queueRowActions } = await import("./queue-actions");
type LiveState = import("./live").LiveState;
type QueuedItem = import("./live").QueuedItem;

const LABEL = "Remove this queued message";

/** A chat's live rows, and the strip ChatView would hand each; `sent` records every frame a Remove sends. */
function chat() {
  const [s, set] = createStore<LiveState>(emptyLive());
  const sent: unknown[] = [];
  const strip = (id: string) => {
    const row = s.entries.find((e) => e.kind === "user" && e.id === id);
    assert.ok(row && row.kind === "user", `a row ${id}`);
    return queueRowActions(row, { removing: [], sharedQueue: [], remove: (itemId) => void sent.push(queueRemoveFrame(itemId)) });
  };
  return { s, set, sent, strip };
}

const snap = (id: string, text: string, kind: QueuedItem["kind"], state: QueuedItem["state"]): QueuedItem => ({ id, kind, text, state, origin: "client" });

describe("a pending row's Remove", () => {
  test("a steer the server has handed to the agent and reports `queued` draws Remove, and a click sends queue_remove for its id", () => {
    const c = chat();
    addPendingPrompt(c.set, "two", [], [], "k2");
    // The server's snapshot for a handed steer with its ticket (server/queue.ts snapshot): "queued".
    applyQueue(c.set, [snap("k2", "two", "steer", "queued")]);
    const items = c.strip("k2");
    assert.deepEqual(items.map((i) => [i.kind, i.label, i.reason]), [["remove", LABEL, null]], "one Remove, enabled");
    items[0]!.run();
    assert.deepEqual(c.sent, [{ type: "queue_remove", itemId: "k2" }], "it names that item to the server");
  });

  test("a `sending` row (a handed follow-up) draws no Remove; nor does a delivered one", () => {
    const c = chat();
    addPendingPrompt(c.set, "later", [], [], "f1");
    applyQueue(c.set, [snap("f1", "later", "followUp", "sending")]);
    assert.deepEqual(c.strip("f1"), [], "Sending…: no Remove at all, not even a disabled one");
    addPendingPrompt(c.set, "one", [], [], "k1");
    applyQueue(c.set, [snap("f1", "later", "followUp", "sending"), snap("k1", "one", "steer", "queued")]);
    assert.equal(c.strip("k1").length, 1);
    markDelivered(c.set, "k1");
    assert.deepEqual(c.strip("k1"), [], "the agent took it: nothing to remove");
    assert.deepEqual(c.sent, []);
  });
});

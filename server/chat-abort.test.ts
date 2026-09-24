// Run: npx tsx --test server/chat-abort.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR; the fake session never touches a session file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-abort-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
after(() => rmSync(agentDir, { recursive: true, force: true }));
const { drainQueueThenAbort } = await import("./chat-manager");

/** The two AgentSession members Stop uses, recording their call order. */
function fakeSession(queue: { steering: string[]; followUp: string[] }) {
  const calls: string[] = [];
  return {
    calls,
    clearQueue() {
      calls.push("clearQueue");
      const drained = { steering: [...queue.steering], followUp: [...queue.followUp] };
      queue.steering = [];
      queue.followUp = [];
      return drained;
    },
    async abort() {
      calls.push("abort");
    },
  };
}

test("Stop drains the queue before aborting and broadcasts what it drained", async () => {
  const session = fakeSession({ steering: ["so basically"], followUp: ["and later"] });
  const sent: ChatServerMessage[] = [];
  await drainQueueThenAbort(session, (m) => {
    session.calls.push("broadcast");
    sent.push(m);
  });
  assert.deepEqual(session.calls, ["clearQueue", "broadcast", "abort"]);
  assert.deepEqual(sent, [{ type: "queue_cleared", steering: ["so basically"], followUp: ["and later"] }]);
});

test("Stop with an empty queue broadcasts nothing and still aborts", async () => {
  const session = fakeSession({ steering: [], followUp: [] });
  const sent: ChatServerMessage[] = [];
  await drainQueueThenAbort(session, (m) => sent.push(m));
  assert.deepEqual(session.calls, ["clearQueue", "abort"]);
  assert.deepEqual(sent, []);
});

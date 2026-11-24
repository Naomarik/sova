// When a Moved row can come back (§app.transport/moved-row): Move Back for 7 days while nothing happened
// on the other device, Copy Back once it had a turn there or after 7 days, and neither while that device
// can't be reached.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { test } from "node:test";
import { markMoved, MOVE_BACK_MS, resetMovedMemo } from "./moved";
import { backState } from "./routes";
import { createTransport, readTransport } from "./store";

const record = (tid: string) =>
  createTransport({ tid, side: "source", mode: "move", chatId: `c-${tid}`, sourceChatId: `c-${tid}`, title: "t", peer: "laptop", peerLabel: "Laptop", path: "/x.jsonl", folder: "~/x", state: "done" });
const answering = (body: object | null, status = 200) => ({
  peerFetch: async () => (body === null ? Promise.reject(new Error("down")) : new Response(JSON.stringify(body), { status })),
});

test("Move Back while nothing happened there; Copy Back after a turn there or 7 days; neither while it is offline", async () => {
  resetMovedMemo();
  const r = record("tr_back001");
  assert.deepEqual((await backState(r, answering({ turned: false }))).can, null, "no mark: it runs here");
  markMoved(r.chatId, { tid: r.tid, peer: "laptop", to: "Laptop", at: new Date().toISOString(), arrivedId: r.chatId, arrivedPath: "/there.jsonl" });
  const fresh = await backState(readTransport(r.tid)!, answering({ turned: false }));
  assert.equal(fresh.can, "move");
  assert.equal(fresh.path, "/there.jsonl");
  assert.equal((await backState(r, answering({ turned: true }))).can, "copy");
  const down = await backState(r, answering(null));
  assert.equal(down.can, null);
  assert.equal(down.reason, "Laptop is offline.");
  assert.equal((await backState(r, answering({}, 403))).reason, "Laptop doesn't let this device start chats there.");
  markMoved(r.chatId, { tid: r.tid, peer: "laptop", to: "Laptop", at: new Date(Date.now() - MOVE_BACK_MS - 1000).toISOString(), arrivedId: r.chatId });
  assert.equal((await backState(r, answering({ turned: false }))).can, "copy", "past 7 days only a Copy comes back");
});

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

test("a helper's turn on the destination makes it Copy Back; the lead alone unchanged doesn't hide it", async () => {
  const { ensureChatHome } = await import("../chat-homes/root");
  const { fingerprint, statusOf } = await import("./destination");
  const { updateTransport } = await import("./store");
  const { appendFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const id = "0199aaaa-0000-7000-8000-00000000000a";
  const home = ensureChatHome(id);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", `t_${id}.jsonl`), '{"type":"session"}\n');
  writeFileSync(join(home, "sessions", "t_W1.jsonl"), '{"type":"session"}\n');
  const r = createTransport({ tid: "tr_turn0001", side: "destination", mode: "move", chatId: id, sourceChatId: id, title: "t", peer: "desk", peerLabel: "Desk", path: join(home, "sessions", `t_${id}.jsonl`), folder: "/x", state: "done", steps: { opened: "now" }, arrivedId: id });
  updateTransport(r.tid, { ext: { openedPrint: await fingerprint(r) } });
  assert.equal((await statusOf({ id: "desk" }, r.tid)).turned, false);
  appendFileSync(join(home, "sessions", "t_W1.jsonl"), '{"type":"message"}\n');
  assert.equal((await statusOf({ id: "desk" }, r.tid)).turned, true);
});

test("a moved home's helpers aren't this server's: the registry leaves its records at start", async () => {
  const { ensureChatHome } = await import("../chat-homes/root");
  const { WorkerRegistry } = await import("../chat-workers");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const rec = (home: string, chatId: string, parent: string) => ({ v: 1, chatId, path: join(home, "sessions", `t_${chatId}.jsonl`), key: `k-${chatId}`, kind: "worker", parent: { sessionId: parent, path: join(home, "sessions", `t_${parent}.jsonl`), workerId: "ag_01" }, spec: {}, state: "idle", startedAt: "now" });
  for (const [lead, worker, moved] of [["0199aaaa-0000-7000-8000-00000000000b", "W-here", false], ["0199aaaa-0000-7000-8000-00000000000c", "W-moved", true]] as const) {
    const home = ensureChatHome(lead);
    mkdirSync(join(home, "workers"), { recursive: true });
    writeFileSync(join(home, "workers", `${worker}.json`), JSON.stringify(rec(home, worker, lead)));
    if (moved) markMoved(lead, { tid: "tr_moved001", peer: "laptop", to: "Laptop", at: new Date().toISOString(), arrivedId: lead });
  }
  const r = new WorkerRegistry({ start: async () => Promise.reject(new Error("no")), stop: async () => {} });
  assert.equal(r.has("W-here"), true);
  assert.equal(r.has("W-moved"), false);
});

test("a chat in a Move's switch, or moved away, starts nowhere here; before the switch, or stopped before the decision, it does", async () => {
  resetMovedMemo();
  const { chatHome } = await import("../chat-homes/root");
  const { startRefusal } = await import("./routes");
  const { stepDone, updateTransport } = await import("./store");
  const id = "0199aaaa-0000-7000-8000-00000000000d";
  const path = `${chatHome(id)}/sessions/2026-01-01T00-00-00-000Z_${id}.jsonl`;
  createTransport({ tid: "tr_start01", side: "source", mode: "move", chatId: id, sourceChatId: id, title: "t", peer: "laptop", peerLabel: "Laptop", path, folder: "~/x", state: "preparing" });
  assert.equal(startRefusal(path), null, "the team keeps working while that device is prepared");
  stepDone("tr_start01", "stopped", { state: "packing" });
  assert.equal(startRefusal(path), "This chat is moving to Laptop. Nothing was sent.");
  updateTransport("tr_start01", { state: "needs-you" });
  assert.equal(startRefusal(path), null, "stopped before the decision: it carries on here");
  updateTransport("tr_start01", { state: "switching", decided: true });
  assert.match(startRefusal(path) ?? "", /opens there once that finishes/);
  updateTransport("tr_start01", { state: "needs-you" });
  assert.match(startRefusal(path) ?? "", /press Retry/, "decided: never here again while it waits");
  updateTransport("tr_start01", { state: "done" });
  markMoved(id, { tid: "tr_start01", peer: "laptop", to: "Laptop", at: new Date().toISOString(), arrivedId: id });
  assert.equal(startRefusal(path), "This chat moved to Laptop; it runs there now.");
  assert.equal(startRefusal("/elsewhere/sessions/x.jsonl"), null, "a chat outside the homes isn't Transport's");
});

test("the start guard is a memory lookup: 200 records on disk are read once, then every write keeps it", async () => {
  const { chatHome } = await import("../chat-homes/root");
  const { startRefusal } = await import("./routes");
  const { resetActiveIndex, stepDone, updateTransport } = await import("./store");
  const { stateRoot } = await import("../state-root");
  const { readdirSync, renameSync } = await import("node:fs");
  const { join } = await import("node:path");
  resetMovedMemo();
  resetActiveIndex();
  const ids = Array.from({ length: 200 }, (_, i) => `0199bbbb-0000-7000-8000-${String(i).padStart(12, "0")}`);
  for (const [i, id] of ids.entries()) {
    createTransport({ tid: `tr_load${String(i).padStart(4, "0")}`, side: "source", mode: "move", chatId: id, sourceChatId: id, title: "t", peer: "laptop", peerLabel: "Laptop", path: "/x.jsonl", folder: "~/x", state: i % 2 ? "done" : "packing" });
    if (!(i % 2)) stepDone(`tr_load${String(i).padStart(4, "0")}`, "stopped");
  }
  resetActiveIndex();
  const path = (id: string) => `${chatHome(id)}/sessions/2026-01-01T00-00-00-000Z_${id}.jsonl`;
  assert.equal(startRefusal(path(ids[0]!)), "This chat is moving to Laptop. Nothing was sent.");
  // Every record file hidden from the disk: the guard still answers, so it reads none of them.
  const dir = join(stateRoot(), "transport");
  const hidden = `${dir}.hidden`;
  renameSync(dir, hidden);
  try {
    const t0 = performance.now();
    for (let n = 0; n < 50; n++) for (const [i, id] of ids.entries()) assert.equal(startRefusal(path(id)) !== null, !(i % 2));
    assert.ok(performance.now() - t0 < 2000, "10,000 lookups take well under the cost of one read each");
  } finally {
    renameSync(hidden, dir);
  }
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("tr_load")).length, 200);
  // A write here updates it at once.
  updateTransport("tr_load0000", { state: "done" });
  assert.equal(startRefusal(path(ids[0]!)), null);
});

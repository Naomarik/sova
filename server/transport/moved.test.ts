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

test("A→B→A by a fresh Move after A's Moved row was deleted: the arrival clears A's old Moved mark and opens, a Retry too", async () => {
  resetMovedMemo();
  const { ensureChatHome } = await import("../chat-homes/root");
  const dest = await import("./destination");
  const { cameBack, startRefusal } = await import("./routes");
  const { movedOf } = await import("./moved");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const id = "0199aaaa-0000-7000-8000-00000000000e";
  // A once moved it to B (the done source record, the mark); its Moved row was deleted since.
  createTransport({ tid: "tr_rtold01", side: "source", mode: "move", chatId: id, sourceChatId: id, title: "t", peer: "b", peerLabel: "lab B", path: "/gone.jsonl", folder: "~/x", state: "done" });
  markMoved(id, { tid: "tr_rtold01", peer: "b", to: "lab B", at: new Date().toISOString(), arrivedId: id });
  // B moves it back to A: published here, about to open.
  const home = ensureChatHome(id);
  mkdirSync(join(home, "sessions"), { recursive: true });
  const file = join(home, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n`);
  createTransport({
    tid: "tr_rtback1", side: "destination", mode: "move", chatId: id, sourceChatId: id, title: "t", peer: "b", peerLabel: "lab B", path: "", folder: "/x", state: "switching", arrivedId: id,
    steps: { offered: "t", prepared: "t", pulled: "t", staged: "t", verified: "t", decided: "t", published: "t" },
    ext: { offer: { trees: [], repoRel: null, project: { remotes: [], roots: [] } } },
  });
  const opened: string[] = [];
  dest.setDestinationDeps({
    peerFetch: async () => new Response("{}"),
    clickProven: async () => true,
    adopt: () => {},
    cameBack,
    openWithNote: async (p) => {
      const why = startRefusal(p);
      if (why) throw new Error(why);
      opened.push(p);
    },
    tellHelper: async () => {},
    helperNote: () => "",
    importUsage: () => ({}),
  });
  assert.equal(startRefusal(file), "This chat moved to lab B; it runs there now.", "the old mark is what stuck it");
  const res = await dest.commit({ id: "b" }, "tr_rtback1", {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(opened, [file]);
  assert.equal(movedOf(id), undefined);
  assert.equal(startRefusal(file), null, "it runs here again");
  assert.equal(readTransport("tr_rtback1")?.state, "done");
});

test("coming home where its old copy was compressed: that copy is moved aside, kept, and the arrived chat opens", async () => {
  resetMovedMemo();
  const { ensureChatHome, homesRoot } = await import("../chat-homes/root");
  const { compressedAt, putCompressed } = await import("../archive-compress/store");
  const dest = await import("./destination");
  const { cameBack, startRefusal } = await import("./routes");
  const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const id = "0199aaaa-0000-7000-8000-00000000000f";
  const tid = "tr_rtcomp1";
  // The arriving home, staged (made as a home, then put where the arrival stages it).
  const made = ensureChatHome(id);
  const file = join(made, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n`);
  // Its old Moved row here was in the Archive, and this server still holds that mark (lab: the first attempt
  // stopped "That session is archived"); the arriving home carries none (the arrival drops it).
  const { isArchived, setArchived } = await import("../archived-sessions");
  setArchived(id, true);
  const staged = join(dest.incomingRoot(), tid, "home");
  mkdirSync(join(dest.incomingRoot(), tid), { recursive: true });
  renameSync(made, staged);
  const meta = join(staged, "chat", "meta.json");
  if (existsSync(meta)) {
    const v = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
    delete v.archived;
    for (const k of Object.keys(v)) if (k.includes("archived")) delete v[k];
    writeFileSync(meta, JSON.stringify(v));
  }
  assert.ok(isArchived(id), "the stale mark that stopped the first attempt");
  // Here: the Moved mark, and its old home compressed whole after 7 days.
  markMoved(id, { tid: "tr_rtold02", peer: "b", to: "lab B", at: new Date().toISOString(), arrivedId: id });
  const archive = join(homesRoot(), `${id}.tar.gz`);
  writeFileSync(archive, "old home");
  putCompressed({ id, kind: "home", at: new Date().toISOString(), by: "auto", row: { id, path: file } as never, archive, home: made });
  assert.ok(compressedAt(file));

  createTransport({
    tid, side: "destination", mode: "move", chatId: id, sourceChatId: id, title: "t", peer: "b", peerLabel: "lab B", path: "", folder: "/x", state: "switching", arrivedId: id,
    steps: { offered: "t", prepared: "t", pulled: "t", staged: "t", verified: "t", decided: "t" },
    ext: { offer: { trees: [], repoRel: null, project: { remotes: [], roots: [] } } },
  });
  const opened: string[] = [];
  dest.setDestinationDeps({
    peerFetch: async () => new Response("{}"),
    clickProven: async () => true,
    adopt: () => {},
    cameBack,
    openWithNote: async (p) => {
      const why = startRefusal(p) ?? (compressedAt(p) ? "compressed" : null) ?? (isArchived(id) ? "archived" : null);
      if (why) throw new Error(why);
      opened.push(p);
    },
    tellHelper: async () => {},
    helperNote: () => "",
    importUsage: () => ({}),
  });
  const res = await dest.commit({ id: "b" }, tid, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(opened, [file]);
  assert.equal(compressedAt(file), undefined);
  const aside = join(`${homesRoot()}.superseded`, `${id}-${tid}`);
  assert.equal(readFileSync(`${aside}.tar.gz`, "utf8"), "old home", "kept, never deleted");
  assert.ok(existsSync(`${aside}.compressed.json`));
  assert.ok(!existsSync(archive));
});

test("a first arrival of a chat archived where it came from keeps its archive mark: only an old Moved row's is cleared", async () => {
  resetMovedMemo();
  const { ensureChatHome } = await import("../chat-homes/root");
  const { isArchived, setArchived } = await import("../archived-sessions");
  const { cameBack } = await import("./routes");
  const id = "0199aaaa-0000-7000-8000-000000000010";
  ensureChatHome(id);
  setArchived(id, true);
  cameBack(id);
  assert.ok(isArchived(id), "never moved away from here: the user's own choice stays");
});

test("a first arrival carrying its archive mark shows archived here at once (the server's set learns it, no restart)", async () => {
  resetMovedMemo();
  const { ensureChatHome } = await import("../chat-homes/root");
  const { isArchived, setArchived } = await import("../archived-sessions");
  const { cameBack } = await import("./routes");
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const id = "0199aaaa-0000-7000-8000-000000000011";
  const home = ensureChatHome(id);
  setArchived(id, false);
  // The home lands with its meta saying archived, written behind the server's back (as an arrival's rename is).
  const meta = join(home, "chat", "meta.json");
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
  } catch {
    // none yet
  }
  mkdirSync(join(home, "chat"), { recursive: true });
  writeFileSync(meta, JSON.stringify({ ...v, "archived-sessions.json": [id] }));
  cameBack(id);
  assert.ok(isArchived(id));
});

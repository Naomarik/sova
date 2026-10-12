// Run: pnpm test -- server/chat-handle.test.ts. Uses a throwaway PI_CODING_AGENT_DIR and cwd in the
// OS temp dir; ~/.pi is never read or written, and with no credentials no model is ever called.
//
// The seam the server talks to a chat through (server/chat-handle.ts): a command's refusal reaches
// the caller as the class the chat threw, an answer is the chat's own, the mirror reads the chat as
// it is, and lifecycle events carry increasing seqs a consumer can ask again for.
import assert from "node:assert/strict";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatLifecycleEvent } from "../shared/chat-runtime";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-handle-test-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chathandle--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChatHandle, BusyError, chatEventsSince, chatHandle, closeChat, ConfigError, disposeAllChats, errorOfRefusal, failureReply, isSessionBusy, ModeRefusedError, onChatEvent, RefusedError, refusalOf } =
  await import("./chat-handle");
const { canonicalPath } = await import("./paths");

after(async () => {
  await disposeAllChats();
});

let n = 0;
/** A one-turn session on disk: u1 → a1. */
function session(): string {
  const path = join(sessionsDir, `2026-10-12T00-00-0${n}-000Z_01a0-ch${n++}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `01a0-ch${n}`, timestamp: "2026-10-12T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-12T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}

test("a refusal crosses as its kind and comes back as the class the chat threw", () => {
  const cases: [Error, (e: Error) => boolean][] = [
    [new BusyError("a TUI has it", "busy"), (e) => e instanceof BusyError && e.code === "busy"],
    [new BusyError("someone wrote", "recent"), (e) => e instanceof BusyError && e.code === "recent"],
    [new ModeRefusedError("no mode here"), (e) => e instanceof ModeRefusedError],
    [new RefusedError("not yours"), (e) => e instanceof RefusedError && !(e instanceof ModeRefusedError)],
    [new ConfigError("gone", "/nowhere"), (e) => e instanceof ConfigError && e.cwd === "/nowhere"],
  ];
  for (const [err, same] of cases) {
    const refusal = refusalOf(err);
    assert.ok(refusal, err.message);
    assert.deepEqual(JSON.parse(JSON.stringify(refusal)), refusal, "a refusal is plain data");
    const back = errorOfRefusal(refusal);
    assert.ok(same(back), `${err.message} came back as ${back.constructor.name}`);
    assert.equal(back.message, err.message);
  }
  assert.equal(refusalOf(new Error("anything else")), null);
  assert.deepEqual(failureReply("c1", new BusyError("a TUI has it", "busy")), { id: "c1", ok: false, refusal: { kind: "busy", code: "busy", message: "a TUI has it" } });
  assert.deepEqual(failureReply("c2", new Error("boom")), { id: "c2", ok: false, error: { message: "boom" } });
});

test("commands answer with the chat's own results, and a failed one throws the chat's own error", async () => {
  const path = session();
  const h = await acquireChatHandle(path, true);
  assert.equal(chatHandle(path), h, "one handle per chat");
  assert.equal(h.mirror.chatId, path);
  assert.equal(h.mirror.sessionId, `01a0-ch${n}`);
  assert.equal(h.mirror.cwd, cwd);
  assert.equal(h.mirror.closed, false);
  assert.equal(h.mirror.running, false);
  assert.equal(h.mirror.pristine, false);
  assert.equal(h.mirror.leafId, "a1");
  assert.deepEqual(h.mirror.queue, { web: 0, agent: false });
  assert.equal(isSessionBusy(path), false);
  assert.deepEqual(
    (await h.branch()).map((e) => e.id),
    ["u1", "a1"],
  );
  assert.equal(await h.checkWrites(), false);
  await assert.rejects(h.setThinking("loudly"), /Unknown thinking level: loudly/);
  await assert.rejects(h.call("appendState", { kind: "no-such-kind", data: {} }), /Unknown state kind: no-such-kind/);
  // A blank message is no message: accepted, nothing queued, its "turn" ended at once; asked once.
  const receipt = await h.send({ text: "   ", track: true });
  assert.equal(receipt.queued, false);
  assert.deepEqual(await h.turnEnd(receipt), { ok: true });
  await assert.rejects(h.turnEnd(receipt), /That turn is not tracked/);
});

test("closing a chat is an event with a higher seq than any before, kept for a late reader", async () => {
  const path = session();
  const h = await acquireChatHandle(path, true);
  const seen: ChatLifecycleEvent[] = [];
  const off = onChatEvent((e) => seen.push(e));
  const before = chatEventsSince(0).at(-1)?.seq ?? 0;
  assert.equal(await closeChat(path, "test close"), true);
  off();
  assert.equal(h.closed, true);
  assert.equal(h.mirror.closed, true);
  assert.equal(chatHandle(path), undefined);
  const closed = seen.filter((e) => e.chatId === path && e.type === "closed");
  assert.equal(closed.length, 1);
  assert.ok(closed[0]!.seq > before);
  assert.deepEqual(
    chatEventsSince(before).filter((e) => e.chatId === path),
    closed,
  );
});

test("server code reaches a chat only through its handle: nothing outside the chat's host imports chat-manager", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // The chat's host: the handle itself and the pi adapter the chat runs on.
  const allowed = new Set(["server/chat-handle.ts"]);
  const importers = globSync("{server,shared,src}/**/*.{ts,tsx}", { cwd: root })
    .map((f) => relative(root, join(root, f)))
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith("server/harness/") && f !== "server/chat-manager.ts")
    .filter((f) => /from "(?:\.\.?\/)+(?:[\w-]+\/)*chat-manager(?:\.ts)?"/.test(readFileSync(join(root, f), "utf8")));
  assert.deepEqual(importers.filter((f) => !allowed.has(f)), []);
  assert.deepEqual([...allowed].filter((f) => !importers.includes(f)), [], "an allowed file that no longer imports it leaves the list");
});

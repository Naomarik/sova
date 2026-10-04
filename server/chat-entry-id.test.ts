// Run: npx tsx --test server/chat-entry-id.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR and cwd in the OS temp dir; ~/.pi is never read or written, and with no
// credentials in that dir no model is ever called.
//
// A forwarded `message_end` names the entry the SDK wrote its message as (`entryId`), so a live row
// knows the transcript row it becomes (§chat.transcript/rendering, "Switching back"). The SDK
// persists the message only after its listeners ran, so the event waits a microtask: these pin
// that the id is the written entry's, and that nothing broadcast meanwhile overtakes the event.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-entry-id-test-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-entryid--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

function session(): string {
  const path = join(sessionsDir, "2026-10-04T00-00-00-000Z_01a0-entryid.jsonl");
  const lines = [
    { type: "session", version: 3, id: "01a0-entryid", timestamp: "2026-10-04T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-04T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-04T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "anthropic", model: "claude-opus-5", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}

test("a forwarded message_end carries the id of the entry it was written as, and keeps its place among broadcasts", async () => {
  const path = session();
  const chat = await acquireChat(path, true);
  const log: ChatServerMessage[] = [];
  chat.attach({ send: (m: ChatServerMessage) => void log.push(m) });
  log.length = 0;
  // pi's own agent event path: listeners, then the write (agent-session.js `_handleAgentEvent`).
  const sdk = (chat as unknown as { session: { _handleAgentEvent(e: unknown): Promise<void>; subscribe(fn: (e: { type: string }) => void): () => void } }).session;
  // A listener after ours broadcasting in the same synchronous stretch, before the write.
  const off = sdk.subscribe((e) => {
    if (e.type === "message_end") chat.broadcast({ type: "queue", items: [] });
  });
  await sdk._handleAgentEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "second ask" }], timestamp: Date.now() } });
  await sdk._handleAgentEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "second ask" }], timestamp: Date.now() } });
  await new Promise((r) => setTimeout(r, 0));
  off();
  const written = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "message").at(-1);
  assert.equal(written.message.content[0].text, "second ask", "the SDK wrote the message");
  const end = log.findIndex((m) => m.type === "event" && (m.event as { type?: string }).type === "message_end");
  assert.ok(end >= 0, "the message_end was forwarded");
  const msg = log[end] as Extract<ChatServerMessage, { type: "event" }>;
  assert.equal(msg.entryId, written.id, "tagged with the written entry's id");
  const queue = log.findIndex((m) => m.type === "queue");
  assert.ok(queue > end, "a broadcast made while the event waited for its id comes after it");
  const start = log.find((m) => m.type === "event" && (m.event as { type?: string }).type === "message_start") as Extract<ChatServerMessage, { type: "event" }>;
  assert.equal(start.entryId, undefined, "no other event is tagged");
});

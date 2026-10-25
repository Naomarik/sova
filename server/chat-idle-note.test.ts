// Run: pnpm test -- server/chat-idle-note.test.ts. A displayable note an extension appends while the
// chat is idle (pi's sendMessage with triggerTurn: false, as /btw saves its answer) reaches every pane
// at once, as its transcript row, not at the next reload (§chat.slash-commands/btw). On a throwaway
// PI_CODING_AGENT_DIR with no credentials: no model is ever called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";
import { until } from "./test-wait";

const agentDir = mkdtempSync(join(tmpdir(), "sova-idle-note-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-idle-note--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");

after(async () => {
  await disposeAllChats();
});

test("a note appended while idle reaches the attached pane at once, as one row", async () => {
  const path = join(sessionsDir, "2026-10-13T00-00-00-000Z_01a0-note.jsonl");
  const lines = [
    { type: "session", version: 3, id: "01a0-note", timestamp: "2026-10-13T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-13T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-13T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, old, old);
  const chat = await acquireChat(canonicalPath(path));
  const sent: ChatServerMessage[] = [];
  chat.attach({ send: (m: ChatServerMessage) => sent.push(m) } as never);
  await piSession(chat).sendCustomMessage({ customType: "btw-note", content: "Q: why?\n\nA: because.", display: true }, { triggerTurn: false });
  await until(() => sent.some((m) => m.type === "append"), "the note's append", 2_000).catch(() => {});
  const appends = sent.filter((m): m is Extract<ChatServerMessage, { type: "append" }> => m.type === "append");
  assert.equal(appends.length, 1, "one append for the note");
  const rows = appends[0]!.items;
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(rows[0]), /because\./);
});

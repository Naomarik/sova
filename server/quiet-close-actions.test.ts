// Run: pnpm test -- server/quiet-close-actions.test.ts. After a chat's process closed for being quiet
// (§app.chat-processes/idle-stop) the server holds no chat for it. A person's own action on that chat
// opens it again, as a send does (§chat.transcript/instant-open), and never answers "open the chat
// first": a mode switch or save, a sandbox switch, a subagent profile pick, a restored worker's
// resume. A read never opens it: the chat's subagent profile and its memory outline come from its
// file. In-process chats on a throwaway PI_CODING_AGENT_DIR with this tree's extensions linked; no
// model is ever called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-quiet-actions-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const cwd = join(dir, "cwd");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(dir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(dir);
process.env.PI_CODING_AGENT_DIR = dir;
await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("./app");
// A chat's pick read from its file goes through this (server/index.ts reads the file's entries); this
// file's chats have none, so the device default comes back.
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { chatHandle, closeChat } = await import("./chat-handle");
const { disposeAllChats } = await import("./chat-manager");

after(async () => {
  await disposeAllChats();
});
afterEach(async () => {
  await disposeAllChats();
});

let n = 0;
/** A chat with one exchange, its file older than the foreign-write window, and no chat held for it:
    the state a quiet close leaves. */
function closedChat(): string {
  const id = `01a0c1a5-0000-7000-8000-0000000000${String(10 + n++)}`;
  const sessions = join(dir, "sessions", "--quiet-actions--");
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, `2026-10-12T00-00-0${n}-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-12T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, old, old);
  assert.equal(chatHandle(path), undefined, "no chat held for it");
  return path;
}

const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const q = (path: string) => encodeURIComponent(path);
const OPEN_FIRST = /open the chat first/i;

/** The action answered as the opened chat answers it, never "open the chat first", and the chat is open now. */
async function opensFor(path: string, res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = (await res.json()) as Record<string, unknown>;
  assert.doesNotMatch(String(body.error ?? ""), OPEN_FIRST);
  assert.notEqual(res.status, 404, JSON.stringify(body));
  assert.ok(chatHandle(path), "the action opened the chat");
  return { status: res.status, body };
}

test("a mode switch opens a chat closed while quiet and switches it", async () => {
  const path = closedChat();
  const r = await opensFor(path, await post(`/api/mode?path=${q(path)}`, { minorModes: ["vis"] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.minorModes, ["vis"]);
});

test("saving a chat's mode as the default opens it", async () => {
  const path = closedChat();
  const r = await opensFor(path, await post(`/api/mode?path=${q(path)}`, { saveDefault: true }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("a sandbox switch opens it and switches it", async () => {
  const path = closedChat();
  const r = await opensFor(path, await post(`/api/sandbox?path=${q(path)}`, { state: "on" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, "command");
});

test("a subagent profile pick opens it and picks", async () => {
  const path = closedChat();
  const r = await opensFor(path, await post(`/api/subagents?path=${q(path)}`, { profile: "off" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("resuming a restored worker opens the chat; its answer is the chat's own (here: no such worker)", async () => {
  const path = closedChat();
  const r = await opensFor(path, await post(`/api/workers/resume?path=${q(path)}&id=ag_01`, {}));
  assert.notEqual(r.status, 200, "no restored worker ag_01 in this chat");
  assert.ok(r.body.error, "refused with the chat's reason");
});

test("reads never open it: its subagent profile and its memory outline come from its file", async () => {
  const path = closedChat();
  const profiles = await app.request(`/api/settings/subagents?path=${q(path)}`);
  assert.equal(profiles.status, 200, await profiles.clone().text());
  assert.ok(((await profiles.json()) as { current?: unknown }).current, "its current profile");
  const outline = await app.request(`/api/memory?path=${q(path)}`);
  assert.equal(outline.status, 200, await outline.clone().text());
  assert.equal(((await outline.json()) as { messages: number }).messages, 2);
  assert.equal(chatHandle(path), undefined, "still closed");
  // Once open, the same reads answer from the chat.
  await post(`/api/mode?path=${q(path)}`, { minorModes: [] });
  assert.ok(chatHandle(path));
  assert.equal((await app.request(`/api/settings/subagents?path=${q(path)}`)).status, 200);
  await closeChat(path, "test");
});

test("a session file that isn't there is still a 404, and nothing opens", async () => {
  const path = join(dir, "sessions", "--quiet-actions--", "2026-10-12T00-00-00-000Z_01a0c1a5-0000-7000-8000-00000000dead.jsonl");
  for (const url of [`/api/mode?path=${q(path)}`, `/api/sandbox?path=${q(path)}`, `/api/subagents?path=${q(path)}`, `/api/workers/resume?path=${q(path)}&id=ag_01`]) {
    const res = await post(url, url.includes("mode") ? { minorModes: [] } : url.includes("sandbox") ? { state: "on" } : { profile: "off" });
    assert.equal(res.status, 404, url);
  }
  assert.equal((await app.request(`/api/settings/subagents?path=${q(path)}`)).status, 404);
});

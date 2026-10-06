// Run: pnpm test -- server/session-summary-chat.test.ts. SessionSummary.chat (§chat.composer/known-on-switch):
// a held chat's model, thinking level and mode ride on its list row and its summary, read from
// memory, and its sandbox and Claude login as its socket messages last said them; a session the
// server doesn't hold has none. A throwaway PI_CODING_AGENT_DIR in the OS
// temp dir; ~/.pi is never read or written. PORT=0 binds an ephemeral port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage, SessionSummary } from "../shared/protocol";
import { ClaudeLogins } from "../pi-config/extensions/claude-code/accounts.ts";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-summary-chat-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
const cwd = join(agentDir, "work");
mkdirSync(cwd, { recursive: true });
const sessionsDir = join(agentDir, "sessions", "--summary-chat--");
mkdirSync(sessionsDir, { recursive: true });

const { app, server } = await import("./index");
const { acquireChat, disposeAllChats, heldChatState } = await import("./chat-manager");
const { setHostLogins } = await import("./claude-login-state");
const { listGeneration } = await import("./list-generation");

after(async () => {
  setHostLogins(null);
  server.close();
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

/** A session with one user message, so the list carries it. */
function session(id: string): string {
  const path = join(sessionsDir, `2026-10-05T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-05T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-05T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `hello ${id}` }], timestamp: 0 } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const list = async (): Promise<SessionSummary[]> => (await (await app.request("/api/sessions")).json()) as SessionSummary[];
const summary = async (id: string): Promise<SessionSummary> => (await (await app.request(`/api/sessions/summary?id=${id}`)).json()) as SessionSummary;

describe("SessionSummary.chat", () => {
  const heldId = "01a0d000-0000-7000-8000-0000000000c1";
  const idleId = "01a0d000-0000-7000-8000-0000000000c2";
  const heldPath = session(heldId);
  session(idleId);

  test("absent for a session the server doesn't hold", async () => {
    const rows = await list();
    const row = rows.find((s) => s.id === idleId);
    assert.ok(row, "the session is listed");
    assert.equal(row.chat, undefined);
    assert.equal((await summary(idleId)).chat, undefined);
    assert.equal(heldChatState(row.path), undefined);
  });

  test("a held chat's row and summary carry what its hello and mode message say", async () => {
    const chat = await acquireChat(heldPath, true); // just written: past the recent-write guard
    const expected = {
      model: chat.harness.model()?.ref ?? null,
      thinking: chat.harness.thinking(),
      mode: chat.modeState.mode,
      minorModes: [...chat.modeState.minorModes],
      strict: chat.modeState.strict,
      applies: chat.modeApplies,
      // Opening the chat sent its commands and sandbox state (none: no extension here); no socket
      // has been told its login yet, so that is absent.
      sandbox: chat.sandboxInfo(),
    };
    const hello = chat.modeMessage();
    assert.equal(hello.type, "mode");
    const row = (await list()).find((s) => s.id === heldId);
    assert.deepEqual(row?.chat, expected);
    assert.deepEqual((await summary(heldId)).chat, expected);
    // The other session is still unheld.
    assert.equal((await list()).find((s) => s.id === idleId)?.chat, undefined);
  });

  test("a mode change the chat broadcasts reaches the next listing (no reused list)", async () => {
    const chat = await acquireChat(heldPath, true); // just written: past the recent-write guard
    // Prime a listing, then change the mode in memory and broadcast it, as applyMode does.
    await list();
    chat.modeState = { ...chat.modeState, mode: "delegate", minorModes: ["align"] };
    chat.broadcast(chat.modeMessage());
    const row = (await list()).find((s) => s.id === heldId);
    assert.equal(row?.chat?.mode, "delegate");
    assert.deepEqual(row?.chat?.minorModes, ["align"]);
  });
});

/** The registry chatClaudeLogin reads, counting every read of it (claude-accounts*.json, a login's
    identity), so a test can tell a list built from memory from one that read the files. */
class CountingLogins extends ClaudeLogins {
  reads = 0;
  override accounts() {
    this.reads++;
    return super.accounts();
  }
  override identityOf(...args: Parameters<ClaudeLogins["identityOf"]>) {
    this.reads++;
    return super.identityOf(...args);
  }
}
const claudeDir = join(agentDir, "claude-own");
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "own@example.com" } }));
const loginsEnv = { PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: claudeDir };
const A = "l-0000000a";
const twoLogins = () =>
  writeFileSync(
    join(agentDir, "claude-accounts.json"),
    JSON.stringify({ version: 1, logins: [{ id: A, addedAt: 1, enabled: true, device: "local", label: "Work", identity: { email: "work@example.com" } }], devices: { local: { order: [A, "default"] } } }),
  );

/** A client that keeps what it was sent. */
const client = () => {
  const got: ChatServerMessage[] = [];
  return { got, send: (m: ChatServerMessage | object) => void got.push(m as ChatServerMessage) };
};

describe("SessionSummary.chat: sandbox and Claude login", () => {
  const singleId = "01a0d000-0000-7000-8000-0000000000d1";
  const doubleId = "01a0d000-0000-7000-8000-0000000000d2";
  const singlePath = session(singleId);
  const doublePath = session(doubleId);
  const row = async (id: string) => (await list()).find((s) => s.id === id)?.chat;

  test("one login on this device: the login is absent until a socket is told, then null; no sandbox extension: null", async () => {
    setHostLogins(new CountingLogins({ agentDir, env: loginsEnv }));
    const chat = await acquireChat(singlePath, true);
    const before = await row(singleId);
    assert.ok(before, "held");
    assert.equal("login" in before, false, "no claude_login message built yet: unknown, not none");
    // The runtime has no sandbox extension (a throwaway agent dir): opening it already built its
    // sandbox state (bind sends the commands and the sandbox), as none.
    assert.equal(before.sandbox, null);
    const c = client();
    chat.attach(c);
    const sent = c.got.find((m) => m.type === "claude_login");
    assert.deepEqual(sent, { type: "claude_login", login: null }, "sent after the hello even with nothing to choose between");
    assert.equal(c.got.some((m) => m.type === "sandbox"), false, "no extension: no sandbox message");
    const after = await row(singleId);
    assert.equal(after?.login, null);
    assert.equal(after?.sandbox, null);
    assert.deepEqual((await summary(singleId)).chat?.login, null);
  });

  test("two logins: the first attach bumps the list once, an unchanged re-send not at all, and the list reads no registry", async () => {
    twoLogins();
    const logins = new CountingLogins({ agentDir, env: loginsEnv });
    setHostLogins(logins);
    const chat = await acquireChat(doublePath, true);
    await list(); // settle any open-time bump into a built listing
    const gen = listGeneration();
    const c = client();
    chat.attach(c);
    assert.equal(listGeneration() - gen, 1, "the login became known: one bump");
    const sent = c.got.find((m) => m.type === "claude_login") as Extract<ChatServerMessage, { type: "claude_login" }>;
    assert.equal(sent.login?.id, A);
    assert.ok(logins.reads > 0, "the message was built from the swapped-in registry, so the counter sees reads");
    // The same login again (a second tab, a broadcast): no bump.
    chat.attach(client());
    chat.broadcast(chat.loginMessage());
    assert.equal(listGeneration() - gen, 1, "an unchanged login bumps nothing");
    // Building the list and the summary reads the memo, never the files.
    logins.reads = 0;
    const r = await row(doubleId);
    assert.deepEqual(r?.login, sent.login);
    assert.equal(r?.sandbox, null);
    assert.deepEqual((await summary(doubleId)).chat?.login, sent.login);
    assert.equal(logins.reads, 0, "the list read no claude-accounts*.json and no login identity");
  });
});

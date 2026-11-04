// Run: pnpm test -- server/your-click-sandbox.test.ts
// §app.access/your-click, the sandbox: lowering it, by POST /api/sandbox and by a `/sandbox` sent as a message, against
// a REAL hosted runtime with this repo's sandbox extension. No model request is made.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-your-click-sb-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sova-your-click-sb-cwd-")));
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
mkdirSync(join(dir, "extensions"), { recursive: true });
symlinkSync(resolve(here, "../pi-config/extensions/sandbox"), join(dir, "extensions", "sandbox"));
process.env.PI_CODING_AGENT_DIR = dir;
await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { sandboxCommand, sandboxLowers } = await import("./sandbox-state");
const { pageHeaders } = await import("./testing/page");
after(() => disposeAllChats());

const json = { "content-type": "application/json" };
const script = () => ({ "x-sova-token": pageHeaders().cookie!.split("=")[1]! });
const set = (path: string, state: string, headers: Record<string, string>, env?: Record<string, unknown>) =>
  app.request(`/api/sandbox?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ state }) }, env);
const send = (path: string, text: string, headers: Record<string, string>) =>
  app.request("/api/sessions/prompt", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ path, text }) });

async function openChat() {
  const res = await app.request("/api/sessions", { method: "POST", headers: json, body: JSON.stringify({ cwd }) });
  assert.equal(res.status, 201);
  const { path } = (await res.json()) as { path: string };
  const chat = await acquireChat(path);
  return { path, state: () => chat.sandboxInfo()?.state };
}

test("the words: what counts as the command, and what lowers", () => {
  assert.equal(sandboxCommand("/sandbox off"), "off");
  assert.equal(sandboxCommand("  /sandbox   OFF \n"), "off");
  assert.equal(sandboxCommand("/sandbox subagents"), "subagents");
  assert.equal(sandboxCommand("/sandbox"), null);
  assert.equal(sandboxCommand("/sandbox status"), null);
  assert.equal(sandboxCommand("/sandboxes off"), null);
  assert.equal(sandboxCommand("please run /sandbox off"), null);
  assert.equal(sandboxLowers("on", "subagents"), true);
  assert.equal(sandboxLowers("on", "off"), true);
  assert.equal(sandboxLowers("subagents", "off"), true);
  assert.equal(sandboxLowers("off", "subagents"), false);
  assert.equal(sandboxLowers("subagents", "on"), false);
  assert.equal(sandboxLowers("on", "on"), false);
});

test("POST /api/sandbox: lowering is refused but for the page and the Overseer, raising stays open", async () => {
  const { path, state } = await openChat();
  assert.equal(state(), "subagents");
  for (const [who, headers, env] of [
    ["script", script(), undefined],
    ["a chat", { "x-sova-caller": "k" }, undefined],
    ["a card's button", {}, undefined],
    ["a peer", {}, { meshPeer: { id: "x" } }],
  ] as const) {
    const r = await set(path, "off", headers as Record<string, string>, env as never);
    assert.equal(r.status, 403, who);
    const b = (await r.json()) as { error: string; yourClick: boolean; peer?: boolean };
    assert.equal(b.yourClick, true);
    assert.match(b.error, who === "a peer" ? /on the page of the computer it belongs to/ : /Sandbox rows in that chat's composer/);
    assert.equal(state(), "subagents", `${who}: nothing changed`);
  }
  // Raising stays open to a script.
  assert.equal((await set(path, "on", script())).status, 200);
  assert.equal(state(), "on");
  assert.equal((await set(path, "subagents", script())).status, 403);
  assert.equal(state(), "on");
  assert.equal((await set(path, "subagents", { [OVERSEER_SENDER_HEADER]: senderSecret() })).status, 200, "the Overseer's own");
  assert.equal(state(), "subagents");
  assert.equal((await set(path, "off", pageHeaders())).status, 200, "your click");
  assert.equal(state(), "off");
});

test("a /sandbox that lowers, sent as a message, is refused whoever sends it; the chat itself refuses every other send", async () => {
  const { path, state } = await openChat();
  for (const [who, headers] of [["script", script()], ["the Overseer", { [OVERSEER_SENDER_HEADER]: senderSecret() }], ["a page-shaped call", pageHeaders()]] as const) {
    const r = await send(path, "/sandbox off", headers);
    assert.equal(r.status, 403, who);
    assert.match(((await r.json()) as { error: string }).error, /Sandbox rows in that chat's composer/);
    assert.equal(state(), "subagents", `${who}: nothing changed`);
  }
  const chat = await acquireChat(path);
  const { METHODS } = await import("./chat-runtime/methods");
  await assert.rejects(async () => METHODS.send(chat, { text: "/sandbox off", origin: "server" }, { turns: new Map() } as never), /Only the user lowers a chat's sandbox/);
  assert.equal(state(), "subagents");
});

test("frames from anything but the page: a /sandbox that lowers never runs, raising does; the page's own runs", async () => {
  const { path, state } = await openChat();
  const heard: { type: string; state?: string }[] = [];
  (await acquireChat(path)).attach({ send: (m: { type: string; state?: string }) => heard.push(m) } as never);
  const reaches = async (want: string) => {
    for (let i = 0; i < 400 && state() !== want; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(state(), want);
  };
  const post = (headers: Record<string, string>, text: string, clientId: string) =>
    app.request(`/api/chat/frames?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ frames: [{ type: "prompt", text, clientId }] }) });
  assert.equal((await post(script(), "/sandbox off", "s1")).status, 202);
  assert.equal((await post(script(), "/sandbox on", "s2")).status, 202);
  await reaches("on");
  assert.deepEqual(heard.filter((m) => m.type === "sandbox" && m.state === "off"), [], "the lowering never ran, even for a moment");
  assert.equal((await post(pageHeaders(), "/sandbox off", "p1")).status, 202);
  await reaches("off");
});

test("a card's click from anything but the page never reaches the chat; the page's does", async () => {
  const { path, state } = await openChat();
  const frames = (headers: Record<string, string>, list: unknown[]) =>
    app.request(`/api/chat/frames?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ frames: list }) });
  const leaves = async (from: string) => {
    for (let i = 0; i < 400 && state() === from; i++) await new Promise((r) => setTimeout(r, 10));
  };
  // Raising runs for anyone, so a click that got through would show: on, then the plain raise below can't lower it.
  const click = (id: string, text = "/sandbox on") => ({ type: "prompt", text, clientId: id, confirm: "c_1" });
  assert.equal((await frames(pageHeaders(), [{ type: "prompt", text: "/sandbox off", clientId: "p0" }])).status, 202);
  await leaves("subagents");
  assert.equal(state(), "off");
  assert.equal((await frames(script(), [click("s1"), { type: "prompt", text: "/sandbox subagents", clientId: "s2" }])).status, 202);
  await leaves("off");
  assert.equal(state(), "subagents", "the plain frame ran and the click didn't");
  assert.equal((await frames(pageHeaders(), [click("p1")])).status, 202);
  await leaves("subagents");
  assert.equal(state(), "on", "the page's click reaches the chat");
});

test("only a socket that isn't the page or a peer is marked as not the user", async () => {
  const { path } = await openChat();
  const chat = await acquireChat(path);
  const real = chat.handle.bind(chat);
  const seen: Record<string, boolean | undefined> = {};
  chat.handle = ((client: { notUser?: true }, msg: { clientId?: string }) => {
    seen[msg.clientId ?? ""] = client.notUser;
    return real(client as never, msg as never);
  }) as never;
  const frame = (clientId: string, headers: Record<string, string>, env?: Record<string, unknown>) =>
    app.request(`/api/chat/frames?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ frames: [{ type: "prompt", text: "/sandbox on", clientId }] }) }, env);
  const sent: [string, Record<string, string>, Record<string, unknown>?][] = [
    ["script", script()],
    ["chat", { "x-sova-caller": "a-chat-key" }],
    ["page", pageHeaders()],
    ["peer", {}, { meshPeer: { id: "other", nodeId: "n" } }],
  ];
  for (const [id, headers, env] of sent) assert.equal((await frame(id, headers, env)).status, 202, id);
  for (let i = 0; i < 400 && Object.keys(seen).length < sent.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, { script: true, chat: true, page: undefined, peer: undefined });
});

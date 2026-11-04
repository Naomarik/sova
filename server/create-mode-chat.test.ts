// Run: bun test server/create-mode-chat.test.ts (or pnpm test)
// A switch to Create through the mode route (§chat.create-mode/per-chat-only, /minor-modes, /where-offered), against a
// REAL hosted runtime whose only extension is this repo's mode extension. No model request is made: every switch runs
// the extension's own /mode handler, so what reads back was taken by the extension, past its Sova-only check.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { CREATE_NO_DEFAULT, CREATE_NOT_SENT, createNotNamed } from "../shared/profiles";
import type { ChatModeResult } from "../shared/protocol";
import { MODE } from "./harness/state-kinds";

const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-create-chat-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
writeFileSync(join(dir, "mode.json"), JSON.stringify({ version: 1, mode: "delegate", strict: false, minorModes: ["vis"] }));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.SOVA_CHAT_STATE_ROOT;
await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { ensureOverseer } = await import("./overseer");
const { pageHeaders } = await import("./testing/page");
const { promptSession } = await import("./session-prompt");
const { CREATE_NOT_TAKEN } = await import("./mode-state");
after(async () => {
  await disposeAllChats();
});

const json = { "content-type": "application/json" };
const post = (path: string | null, body: unknown, headers: Record<string, string> = pageHeaders()) =>
  app.request(path === null ? "/api/mode" : `/api/mode?path=${encodeURIComponent(path)}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });
const get = async (path: string) => (await (await app.request(`/api/mode?path=${encodeURIComponent(path)}`)).json()) as ChatModeResult;
const file = () => JSON.parse(readFileSync(join(dir, "mode.json"), "utf8")) as { mode: string; minorModes: string[] };

async function newChat(): Promise<string> {
  const res = await app.request("/api/sessions", { method: "POST", headers: json, body: JSON.stringify({ cwd: dir }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { path } = (await res.json()) as { path: string };
  await acquireChat(path);
  return path;
}

test("a chat offers Create, takes it through the extension, and align comes on with it", async () => {
  const path = await newChat();
  assert.ok((await get(path)).modes.some((m) => m.id === "create"));
  const res = await post(path, { mode: "create" });
  assert.equal(res.status, 200, await res.clone().text());
  const got = (await res.json()) as ChatModeResult;
  assert.equal(got.mode, "create");
  assert.deepEqual(got.minorModes, ["align", "vis"], "align on, the default's others as they were");
  assert.equal(got.saveMode, "delegate");
  const chat = await acquireChat(path);
  // The extension's own entry, so it passed the permit: the server didn't merely note the wish.
  const active = chat.harness.state.branch().latest(MODE)?.data.active;
  assert.equal(active?.mode, "create");
  assert.equal(active?.lastMode, "delegate");
});

/** A client on a chat's socket, as far as a typed send uses it: what it was sent. */
async function typed(chat: Awaited<ReturnType<typeof acquireChat>>, text: string, id: string, type: "steer" | "prompt" = "steer"): Promise<{ type: string; message?: string }[]> {
  const sent: { type: string; message?: string }[] = [];
  const client = { send: (m: { type: string; message?: string }) => void sent.push(m) };
  chat.attach(client as never);
  sent.length = 0;
  chat.handle(client as never, { type, text, clientId: id } as never);
  const end = Date.now() + 10_000;
  while (!sent.some((m) => m.type === "error" || m.type === "send_ack" || m.type === "ack")) {
    if (Date.now() > end) throw new Error(`no answer to ${text}: ${JSON.stringify(sent)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return sent;
}

test("`/mode create` typed in a Sova chat is the menu's switch: align on, the lookup, and the server knows", async () => {
  const path = await newChat();
  const chat = await acquireChat(path);
  const sent = await typed(chat, "/mode create", "c1");
  assert.ok(!sent.some((m) => m.type === "error"), JSON.stringify(sent));
  const got = await get(path);
  assert.equal(got.mode, "create", "the menu reads it");
  assert.equal(got.saveMode, "delegate");
  assert.deepEqual(got.minorModes, ["align", "vis"]);
  assert.ok(chat.harness.activeTools().includes("create_guide"));
  assert.ok(!readFileSync(path, "utf8").includes('"type":"message"'), "nothing reached the model or the transcript");
});

test("typed /mode delegate and /mode normal reach the server too: the menu never reads a stale mode", async () => {
  const path = await newChat();
  const chat = await acquireChat(path);
  await typed(chat, "/mode normal", "n1");
  assert.equal((await get(path)).mode, "normal");
  await typed(chat, "/mode create", "n2");
  await typed(chat, "/mode delegate", "n3");
  assert.equal((await get(path)).mode, "delegate");
  assert.ok(!chat.harness.activeTools().includes("create_guide"));
});

test("other typed /mode arguments are the extension's, and the server reads them back: strict and a minor mode", async () => {
  const path = await newChat();
  const chat = await acquireChat(path);
  await post(path, { mode: "create" });
  await typed(chat, "/mode strict on", "s1");
  const until = async (ok: (m: ChatModeResult) => boolean) => {
    const end = Date.now() + 5_000;
    while (!ok(await get(path))) {
      if (Date.now() > end) throw new Error(`stale: ${JSON.stringify(await get(path))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until((m) => m.strict === true);
  assert.ok(!chat.harness.activeTools().includes("edit"));
  assert.equal((await get(path)).mode, "create", "the read keeps the mode");
  assert.equal((await get(path)).saveMode, "delegate", "and the last choice");
  await typed(chat, "/mode align off", "s2");
  await until((m) => !m.minorModes.includes("align"));
  await typed(chat, "/mode strict off", "s3", "prompt"); // a script's frame takes the same road
  await until((m) => m.strict === false);
  assert.ok(chat.harness.activeTools().includes("edit"));
});

test("a chat that doesn't take the typed switch says why, as the route does", async () => {
  const chat = await acquireChat(await newChat());
  const real = chat.switchMode.bind(chat);
  // What a chat open elsewhere answers: its mode, unchanged. (A chat on older code has no typed road: its extension refuses.)
  chat.switchMode = (async () => ({ ...(await real({ mode: "normal" })) })) as never;
  try {
    const sent = await typed(chat, "/mode create", "o1");
    assert.equal(sent.find((m) => m.type === "error")?.message, CREATE_NOT_TAKEN);
  } finally {
    chat.switchMode = real;
  }
});

test("sent by anything but a composer the text names nothing: an Overseer's sova_send or session.send takes the extension's road and is refused", async () => {
  const path = await newChat();
  const chat = await acquireChat(path);
  // chat.prompt is what those sends call; only a client's composer send reaches the typed switch.
  await chat.prompt("/mode create", undefined, "server");
  assert.notEqual((await get(path)).mode, "create");
  assert.notEqual(chat.harness.state.branch().latest(MODE)?.data.active.mode, "create", "the extension took nothing either");
  assert.ok(!chat.harness.activeTools().includes("create_guide"));
});

test("/mode create sent by a script or the Overseer is refused to the sender, and nothing goes", async () => {
  await ensureOverseer();
  const path = await newChat();
  const size = readFileSync(path, "utf8").length;
  const send = (headers: Record<string, string>) => app.request("/api/sessions/prompt", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ path, text: "/mode create" }) });
  let res = await send({});
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, CREATE_NOT_SENT);
  res = await send({ [OVERSEER_SENDER_HEADER]: senderSecret() });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, createNotNamed("the Overseer"));
  assert.equal(((await promptSession(path, "/mode create", undefined, "followUp", { projectOverseer: "po" })) as { error: string }).error, createNotNamed("a project overseer"));
  assert.notEqual((await get(path)).mode, "create");
  assert.equal(readFileSync(path, "utf8").length, size, "no row");
});

test("a strict chat in Create, in a real runtime, has lost edit and write, and they come back in normal", async () => {
  const before = readFileSync(join(dir, "mode.json"), "utf8");
  writeFileSync(join(dir, "mode.json"), JSON.stringify({ ...JSON.parse(before), strict: true }));
  const path = await newChat();
  writeFileSync(join(dir, "mode.json"), before);
  const chat = await acquireChat(path);
  assert.equal((await post(path, { mode: "create" })).status, 200);
  let tools = chat.harness.activeTools();
  assert.ok(!tools.includes("edit") && !tools.includes("write"), `${tools}`);
  assert.ok(tools.includes("create_guide"), `${tools}`);
  assert.equal((await post(path, { mode: "normal" })).status, 200);
  tools = chat.harness.activeTools();
  assert.ok(tools.includes("edit") && tools.includes("write"), `${tools}`);
  assert.ok(!tools.includes("create_guide"), `${tools}`);
});

test("Save as Default in Create saves the last choice, and the file never holds Create", async () => {
  const path = await newChat();
  assert.equal((await post(path, { mode: "normal" })).status, 200);
  assert.equal((await post(path, { mode: "create" })).status, 200);
  const res = await post(path, { saveDefault: true });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(file().mode, "normal");
  assert.ok(file().minorModes.includes("align"), "its minor modes are saved with it");
  // Back to what the other tests start from.
  writeFileSync(join(dir, "mode.json"), JSON.stringify({ version: 1, mode: "delegate", strict: false, minorModes: ["vis"] }));
});

test("no path: the default refuses Create, and lists it nowhere", async () => {
  const before = readFileSync(join(dir, "mode.json"), "utf8");
  const res = await post(null, { mode: "create" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, CREATE_NO_DEFAULT);
  assert.equal(readFileSync(join(dir, "mode.json"), "utf8"), before);
  const info = (await (await app.request("/api/mode")).json()) as ChatModeResult;
  assert.ok(!info.modes.some((m) => m.id === "create"));
  assert.deepEqual(info.chatModes?.map((m) => m.id), ["create"], "a peer's chat reads this list, so its menu still has the row");
});

test("the Overseer can't switch a chat to Create", async () => {
  await ensureOverseer();
  const path = await newChat();
  const sender = { [OVERSEER_SENDER_HEADER]: senderSecret() };
  const res = await post(path, { mode: "create" }, sender);
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal(((await res.json()) as { error: string }).error, createNotNamed("the Overseer"));
  assert.notEqual((await get(path)).mode, "create");
});

test("an Overseer's own chat has no Create to offer, and refuses it", async () => {
  const { path } = await ensureOverseer();
  await acquireChat(path);
  assert.ok(!(await get(path)).modes.some((m) => m.id === "create"));
  assert.equal((await post(path, { mode: "create" })).status, 409);
});

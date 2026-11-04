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
import { CREATE_NO_DEFAULT, createNotNamed } from "../shared/profiles";
import type { ChatModeResult } from "../shared/protocol";

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
  const entry = chat.extensionBranch().filter((e) => e.type === "custom" && e.customType === "mode").at(-1) as { data?: { active?: { mode?: string; lastMode?: string } } } | undefined;
  assert.equal(entry?.data?.active?.mode, "create");
  assert.equal(entry?.data?.active?.lastMode, "delegate");
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

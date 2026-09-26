// Run: npx tsx --test server/overseer-mode.test.ts (or npm test)
// The Overseer is always in the normal mode with no minor modes, against a REAL hosted runtime in a
// throwaway PI_CODING_AGENT_DIR whose only extension is this repo's mode extension (named in
// settings.json by its real path, so its imports of sibling extensions resolve), and
// whose default (mode.json) is Delegate with both minor modes on. No model request is made: every
// switch runs the extension's own /mode handler, never a prompt. An ordinary session in the same
// dir is the control: its switches must take, or a refusal here would prove nothing.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-mode-")));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-mode-cwd-")));
writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
const DEFAULT = { version: 1, mode: "delegate", strict: false, minorModes: ["align", "spec"] };
writeFileSync(join(dir, "mode.json"), JSON.stringify(DEFAULT));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PORT = "0";
const { app, server } = await import("./index");
const { acquireChat, disposeAllChats, disposeHeldChat, ModeRefusedError } = await import("./chat-manager");
const { ensureOverseer } = await import("./overseer");
const { resolveChatMode } = await import("./mode-state");
after(async () => {
  await disposeAllChats();
  await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const NORMAL = { mode: "normal", minorModes: [] as string[] };
/** The mode as this chat holds it, and as its own branch would restore it on the next open. */
const held = (chat: Chat) => ({ mode: chat.modeState.mode, minorModes: [...chat.modeState.minorModes] });
const onBranch = (chat: Chat) => {
  const s = resolveChatMode(chat.session.sessionManager.getBranch());
  return { mode: s.mode, minorModes: [...s.minorModes] };
};
const postMode = (path: string, body: unknown) =>
  app.request(`/api/mode?path=${encodeURIComponent(path)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function overseerChat(): Promise<Chat> {
  return acquireChat((await ensureOverseer()).path);
}

test("control: an ordinary chat in this dir takes a switch through the mode extension", async () => {
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { path } = (await res.json()) as { path: string };
  const chat = await acquireChat(path);
  assert.deepEqual(held(chat), { mode: "delegate", minorModes: ["align", "spec"] }, "it opens on the default");
  const r = await postMode(path, { mode: "normal", minorModes: ["align"] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(held(chat), { mode: "normal", minorModes: ["align"] });
  assert.deepEqual(onBranch(chat), { mode: "normal", minorModes: ["align"] }, "the extension wrote its marker");
});

test("a new Overseer starts normal with no minor modes, whatever the default says", async () => {
  const chat = await overseerChat();
  assert.equal(chat.overseer, true);
  assert.deepEqual(held(chat), NORMAL);
  assert.deepEqual(onBranch(chat), NORMAL);
});

test("a stale mode entry on the Overseer's branch is undone at its next open", async () => {
  const { path } = await ensureOverseer();
  const chat = await acquireChat(path);
  // What a switch made before the guard existed left behind: delegate and spec, pinned on the branch.
  await chat.applyMode({ ...chat.modeState, mode: "delegate", minorModes: ["spec"] });
  assert.deepEqual(onBranch(chat), { mode: "delegate", minorModes: ["spec"] }, "the stale entry is really there");
  await disposeHeldChat(path, "test: reopen");
  const reopened = await acquireChat(path);
  assert.notEqual(reopened, chat, "a new runtime, restored from the file");
  assert.deepEqual(held(reopened), NORMAL);
  assert.deepEqual(onBranch(reopened), NORMAL, "and the file says so for the open after this one");
});

test("an Overseer already normal opens without a write", async () => {
  const { path } = await ensureOverseer();
  await disposeHeldChat(path, "test: reopen");
  const before = readFileSync(path, "utf8");
  const chat = await acquireChat(path);
  assert.deepEqual(held(chat), NORMAL);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("switchMode and saveModeDefault refuse the Overseer; the route answers 409 and nothing moves", async () => {
  const chat = await overseerChat();
  const before = readFileSync(chat.path, "utf8");
  await assert.rejects(chat.switchMode({ mode: "delegate" }), ModeRefusedError);
  await assert.rejects(chat.saveModeDefault(), ModeRefusedError);
  const r = await postMode(chat.path, { minorModes: ["spec"] });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, "The Overseer is always in normal mode.");
  const saved = await postMode(chat.path, { saveDefault: true });
  assert.equal(saved.status, 409);
  assert.deepEqual(held(chat), NORMAL);
  assert.equal(readFileSync(chat.path, "utf8"), before, "no marker written");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "mode.json"), "utf8")), DEFAULT, "the default is untouched");
});

test("a typed /mode reaching the Overseer's runtime is refused and never runs", async () => {
  const chat = await overseerChat();
  const before = readFileSync(chat.path, "utf8");
  for (const type of ["prompt", "steer"] as const) {
    const sent: ChatServerMessage[] = [];
    chat.handle({ send: (m) => sent.push(m) }, { type, text: "/mode delegate", clientId: `c-${type}` });
    assert.deepEqual(sent, [{ type: "error", code: "internal", message: "The Overseer is always in normal mode.", clientId: `c-${type}` }]);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(held(chat), NORMAL);
  assert.equal(readFileSync(chat.path, "utf8"), before);
});

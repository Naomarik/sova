// Run: pnpm test server/merge-queue/thread-modes.test.ts
// The merge queue's own chats start in the modes Sova names for them, whatever this computer's default
// is: the merge thread in mode normal with memory on (UniiChat) and nothing else, the reviewer in mode
// normal with no minor modes at all. Both are pinned, so a later change of mode.json never reaches
// them, and neither takes a switch from the mode menu or the configure route. REAL hosted runtimes in a
// throwaway PI_CODING_AGENT_DIR whose default is delegate + align, spec and vis; no model request is made.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-mq-modes-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sova-mq-modes-cwd-")));
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../../pi-config/extensions/mode")] }));
const DEFAULT = { version: 1, mode: "delegate", strict: false, minorModes: ["align", "spec", "vis"] };
writeFileSync(join(dir, "mode.json"), JSON.stringify(DEFAULT));
process.env.PI_CODING_AGENT_DIR = dir;
await import("../testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("../app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("../chat-manager");
const { closeChat } = await import("../chat-handle");
const { createChat, threadMemoryOn, THREAD_PROFILE } = await import("./thread");
after(async () => {
  await disposeAllChats();
});

const request = (p: string, init?: RequestInit) => app.request(p, init);
const post = (p: string, body: unknown) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The newest `mode` entry's active state in the file (what a reopen restores). */
function pinned(path: string): { mode: string; minorModes: string[] } | undefined {
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === "mode");
  return entries.at(-1)?.data?.active;
}

async function modesOf(path: string) {
  const chat = await acquireChat(path);
  const r = chat.modeResult();
  return { mode: r.mode, minorModes: [...r.minorModes].sort(), memory: r.memory?.type };
}

test("the merge thread: mode normal, memory on as UniiChat and nothing else, pinned against mode.json", async () => {
  const made = await createChat(request, cwd, THREAD_PROFILE, "", "Merge thread · t · 2026-11-03");
  assert.ok(made.ok, JSON.stringify(made));
  if (!made.ok) return;
  const memory = await threadMemoryOn(made.path);
  assert.deepEqual(memory, { type: "uniichat" });
  assert.deepEqual(await modesOf(made.path), { mode: "normal", minorModes: ["memory"], memory: "uniichat" });
  assert.deepEqual(pinned(made.path)?.minorModes, ["memory"], "pinned in the file");
  assert.equal(pinned(made.path)?.mode, "normal");

  // A later default reaches new chats, never this one.
  writeFileSync(join(dir, "mode.json"), JSON.stringify({ ...DEFAULT, minorModes: ["align", "vis"] }));
  await closeChat(made.path, "test reopen");
  assert.deepEqual(await modesOf(made.path), { mode: "normal", minorModes: ["memory"], memory: "uniichat" });
  writeFileSync(join(dir, "mode.json"), JSON.stringify(DEFAULT));

  // The mode menu's route and the configure route refuse it; nothing changed.
  const menu = await post(`/api/mode?path=${encodeURIComponent(made.path)}`, { minorModes: ["memory", "spec"] });
  assert.equal(menu.status, 409);
  assert.match(((await menu.json()) as { error: string }).error, /merge queue's own chats/);
  const configure = await post("/api/sessions/configure", { path: made.path, mode: "delegate" });
  assert.equal(configure.status, 409);
  assert.deepEqual(await modesOf(made.path), { mode: "normal", minorModes: ["memory"], memory: "uniichat" });
});

test("the reviewer: mode normal with no minor modes and no memory, whatever the default", async () => {
  const made = await createChat(request, cwd, "merge-reviewer", "", "Review · feat/x · abc1234");
  assert.ok(made.ok, JSON.stringify(made));
  if (!made.ok) return;
  const m = await modesOf(made.path);
  assert.equal(m.mode, "normal");
  assert.deepEqual(m.minorModes, []);
  assert.deepEqual(pinned(made.path), { ...pinned(made.path), mode: "normal", minorModes: [] });
  const menu = await post(`/api/mode?path=${encodeURIComponent(made.path)}`, { minorModes: ["memory"] });
  assert.equal(menu.status, 409);
  assert.deepEqual((await modesOf(made.path)).minorModes, []);
});

test("an ordinary chat in the same folder still starts on the default (the control)", async () => {
  const res = await post("/api/sessions", { cwd });
  assert.equal(res.status, 201);
  const { path } = (await res.json()) as { path: string };
  const m = await modesOf(path);
  assert.equal(m.mode, "delegate");
  assert.deepEqual(m.minorModes, ["align", "spec", "vis"]);
});

// Run: pnpm test server/merge-queue/thread-modes.test.ts
// The merge queue's own chats start in the modes Sova names for them, whatever this computer's default
// is: the merge thread in mode normal with memory on (UniiChat) and nothing else, the reviewer in mode
// normal with no minor modes at all. Both are pinned, so a later change of mode.json never reaches
// them, and neither takes a switch from the mode menu or the configure route. REAL hosted runtimes in a
// throwaway PI_CODING_AGENT_DIR whose default is delegate + align, spec and vis; no model request is made.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-mq-modes-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sova-mq-modes-cwd-")));
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
writeFileSync(join(dir, "settings.json"), JSON.stringify({}));
const DEFAULT = { version: 1, mode: "delegate", strict: false, minorModes: ["align", "spec", "vis"] };
writeFileSync(join(dir, "mode.json"), JSON.stringify(DEFAULT));
process.env.PI_CODING_AGENT_DIR = dir;
await import("../testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("../app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("../chat-manager");
const { closeChat } = await import("../chat-handle");
const { createChat, threadMemoryOn, THREAD_PROFILE } = await import("./thread");
const { piSession } = await import("../harness/pi/testing/handle");
const { REPLY_SHAPE_INSTRUCTIONS } = await import("../../pi-config/extensions/mode/prompt.ts");
const { RELEASE_THREAD_PROFILE } = await import("../../shared/fixed-names");
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

test("a queue chat never takes another profile: applyProfile is refused (409) and its mark stays", async () => {
  const { applyProfile } = await import("../session-profile-routes");
  const { getSessionSummary } = await import("../sessions-index");
  for (const [profile, role] of [[THREAD_PROFILE, "thread"], ["merge-reviewer", "reviewer"]] as const) {
    // A session file on Sova's own profile ({id, source: 'sova'}), no message yet: the one state a profile could change.
    const made = await createChat(request, cwd, profile, "", `queue chat · ${role}`);
    assert.ok(made.ok, JSON.stringify(made));
    if (!made.ok) return;
    await closeChat(made.path, "test");
    assert.deepEqual((await getSessionSummary(made.path))?.queueChat, { role });
    for (const choice of [{ remove: [] as string[], grant: [] as string[] }, null]) {
      const r = await applyProfile(made.path, choice);
      assert.equal(r.ok, false, `${role}: ${JSON.stringify(choice)} refused`);
      assert.equal(!r.ok && r.status, 409);
      assert.match(!r.ok ? r.error : "", /merge queue's own chats/);
      assert.deepEqual((await getSessionSummary(made.path))?.queueChat, { role }, `${role}: still the queue's`);
    }
    assert.deepEqual((await modesOf(made.path)).mode, "normal", "its modes unchanged");
  }
});

// The reply shape (§chat.mode-menu/reply-shape) is for the chats the user reads and talks to. The merge queue's own
// chats and the release thread are machine-facing (the thread's questions reach the user on the merge card), so Sova
// launches them without it; a playbook run's chat (an ordinary chat, or one on the run's own profile) has it.
const shapes = async (path: string) => piSession(await acquireChat(path)).systemPrompt.split(REPLY_SHAPE_INSTRUCTIONS).length - 1;

test("reply shape: the merge thread's, the reviewer's and the release thread's prompts never carry it; a playbook run's chat carries it once", async () => {
  for (const profile of [THREAD_PROFILE, "merge-reviewer", RELEASE_THREAD_PROFILE]) {
    const made = await createChat(request, cwd, profile, "", `queue chat · ${profile}`);
    assert.ok(made.ok, JSON.stringify(made));
    if (!made.ok) return;
    assert.equal(await shapes(made.path), 0, `${profile}: no reply shape`);
  }
  // A playbook's run in a new chat: made as playbook-runs/start.ts newChat makes it, then on the run's own profile.
  const res = await post("/api/sessions", { cwd });
  const { path } = (await res.json()) as { path: string };
  assert.equal(await shapes(path), 1, "a run's new chat, before its profile");
  const { applyProfile } = await import("../session-profile-routes");
  const applied = await applyProfile(path, { remove: [], grant: [] }, "start");
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(await shapes(path), 1, "on the run's own profile");
});

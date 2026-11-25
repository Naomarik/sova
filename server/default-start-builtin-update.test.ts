// Run: pnpm test -- server/default-start-builtin-update.test.ts. A throwaway agent dir holding this tree's claude-code
// extension and a throwaway Claude Code directory signed in; ~/.pi and ~/.claude are never read or written.
//
// A fresh computer, Claude connected, no default chosen and no modes saved anywhere (§chat.profiles/default,
// §chat.subagent-profiles/menu): a chat on the built-in Claude profile picks delegate · align · spec, the menu offers
// Update Claude, its press makes the built-in yours (frozen, in its place) with those modes, the foot's confirmation
// says so, and the next new chat starts in them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const REPO = resolve(import.meta.dirname, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-default-builtin-update-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
const claudeDir = join(root, "claude");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(claudeDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
symlinkSync(join(REPO, "pi-config", "extensions", "claude-code"), join(agentDir, "extensions", "claude-code"));
writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
const sessionsDir = join(agentDir, "sessions", "--tmp-builtin-update--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });

await import("./testing/in-process-chats");
const { acquireChat, disposeAllChats, getModelRuntime, warmClaudeCodeProvider } = await import("./chat-manager");
const { acquireChatHandle } = await import("./chat-handle");
const { canonicalPath } = await import("./paths");
const { startOnDefault } = await import("./default-start");
const { addWebSession } = await import("./web-sessions");
const { markOwned } = await import("./write-guard");
const { registerProfileRoutes } = await import("./session-profile-routes");
const { registerProfileEditorRoutes } = await import("./profile-editor-routes");
const { startsOfRow, updateOffered } = await import("../src/lib/profile-switch");
const { footNote } = await import("../src/lib/mode-menu");
type ProfilesListing = import("../shared/profiles").ProfilesListing;
await warmClaudeCodeProvider(await getModelRuntime(), agentDir);

const sources = {
  piModels: async () => { throw new Error("offline"); },
  policy: () => ({ version: 1 as const, disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }),
};
const app = new Hono();
registerProfileRoutes(app);
registerProfileEditorRoutes(app, sources);
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as ProfilesListing & { error?: string } };
};

let n = 0;
async function newChat(): Promise<string> {
  const id = `0199eeee-0000-7000-8000-00000000000${++n}`;
  const path = canonicalPath(join(sessionsDir, `2026-11-25T00-00-0${n}-000Z_${id}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: `2026-11-25T00:00:0${n}.000Z`, cwd })}\n`);
  markOwned(path);
  addWebSession(id);
  assert.deepEqual(await startOnDefault(path, cwd, false), { ok: true, applied: "whole" });
  return path;
}

after(async () => {
  await disposeAllChats();
});

test("Update Claude from a chat on the built-in: offered, the built-in becomes yours with the chat's modes, and the next new chat starts in them", async () => {
  const first = await newChat();
  const handle = await acquireChatHandle(first);
  await handle.switchMode({ mode: "delegate", minorModes: ["align", "spec"] });
  const chat = await acquireChat(first, true);
  const before = await call("GET", `/api/profiles?cwd=${encodeURIComponent(cwd)}`);
  const row = before.body.joined!.find((r) => r.key === "sova:claude")!;
  assert.equal(row.group, "builtin");
  assert.deepEqual([before.body.newChats?.mode, before.body.newChats?.minorModes], ["normal", []], "nothing saved: new chats start in normal");
  // The menu's offer, from the listing as the menu reads it.
  const chatNow = { model: chat.harness.model()?.ref ?? null, thinking: chat.harness.thinking() ?? null, mode: "delegate", minorModes: ["align", "spec"] };
  assert.equal(updateOffered(row, { starts: startsOfRow(row, before.body.startsBase), chat: chatNow }), true, "Update Claude is offered");

  const saved = await call("POST", "/api/profiles/update-from-chat", { path: first, cwd });
  assert.equal(saved.status, 200, saved.body.error);
  // Frozen as yours: a profile of yours in the built-in's place, under its name and id, its helpers copied.
  const yours = saved.body.joined!.find((r) => r.replaces === "sova:claude")!;
  assert.deepEqual([yours.key, yours.group, yours.name, yours.libraryId], ["user:claude", "yours", "Claude", "claude"]);
  assert.equal(saved.body.joined!.some((r) => r.key === "sova:claude"), false, "the built-in one is no longer listed beside it");
  const file = JSON.parse(readFileSync(join(agentDir, "sova", "session-profiles.json"), "utf8")) as { profiles: Record<string, unknown>[] };
  assert.deepEqual([file.profiles[0]!.id, file.profiles[0]!.mode, file.profiles[0]!.minorModes, file.profiles[0]!.model], ["claude", "delegate", ["align", "spec"], "claude-code-cli/claude-opus-5-5"]);
  assert.ok(JSON.parse(readFileSync(join(agentDir, "subagent-profiles.json"), "utf8")).profiles.some((p: { id: string }) => p.id === "claude"));
  // The menu after the press: no offer, and the foot's confirmation from the answer.
  assert.equal(updateOffered(yours, { starts: startsOfRow(yours, saved.body.startsBase), chat: chatNow }), false);
  const nc = saved.body.newChats!;
  assert.equal(footNote({ mode: "delegate", minorModes: ["align", "spec"], strict: false }, null, { newChats: nc, onDefault: nc.key === yours.key, differs: false, saved: "Claude" }), "Saved. New chats start in delegate · align · spec.");

  // The next new chat starts in the saved modes, on the copy.
  const next = await acquireChatHandle(await newChat());
  assert.deepEqual([next.mirror.mode.mode, [...next.mirror.mode.minorModes].sort()], ["delegate", ["align", "spec"]]);
  assert.equal((await next.chatProfileState()).current.key, "user:claude");
});

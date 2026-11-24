// Run: pnpm test -- server/default-start-builtin.test.ts. A throwaway agent dir holding this tree's claude-code
// extension (its provider registered by the warm-up, as a chat process's start does) and a throwaway Claude Code
// directory signed in; ~/.pi and ~/.claude are never read or written.
//
// A fresh computer with only Claude connected and no default chosen (§chat.profiles/default): a new chat starts on the
// built-in Claude profile whole, its own model included: Claude Code's Opus 5.5 at medium, from its first message.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-default-builtin-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
const claudeDir = join(root, "claude");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(claudeDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
symlinkSync(join(REPO, "pi-config", "extensions", "claude-code"), join(agentDir, "extensions", "claude-code"));
writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
const sessionsDir = join(agentDir, "sessions", "--tmp-builtin--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });

await import("./testing/in-process-chats");
const { acquireChat, disposeAllChats, getModelRuntime, warmClaudeCodeProvider } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { startOnDefault } = await import("./default-start");
const { addWebSession } = await import("./web-sessions");
const { markOwned } = await import("./write-guard");
await warmClaudeCodeProvider(await getModelRuntime(), agentDir);

after(async () => {
  await disposeAllChats();
});

test("a new chat on the default the accounts give (Claude only, none chosen): the whole built-in Claude profile, Opus 5.5 at medium", async () => {
  const id = "0199dddd-0000-7000-8000-000000000001";
  const path = canonicalPath(join(sessionsDir, `2026-11-24T00-00-00-000Z_${id}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-24T00:00:00.000Z", cwd })}\n`);
  markOwned(path);
  addWebSession(id);
  const r = await startOnDefault(path, cwd, false);
  assert.deepEqual(r, { ok: true, applied: "whole" });
  const chat = await acquireChat(path, true);
  assert.deepEqual([chat.harness.model()?.ref, chat.harness.thinking()], ["claude-code-cli/claude-opus-5-5", "medium"]);
  const state = await chat.chatProfileState();
  assert.deepEqual([state.current.key, state.current.name, state.current.edited], ["sova:claude", "Claude", false]);
  assert.equal(chat.subagentProfileInfo().current.id, "claude", "its helpers are the built-in Claude profile's");
  assert.equal(existsSync(join(agentDir, "subagent-profiles.json")), false, "no library written");
  assert.equal(existsSync(join(agentDir, "subagent-profiles-default.json")), false, "no default written");
  assert.equal(existsSync(join(agentDir, "sova", "default-profile.json")), false);
  assert.match(readFileSync(path, "utf8"), /"customType":"sova-profile"/, "the chat's own record names it");
});

test("a new chat with no account connected and none chosen: no profile, the model new chats open on, no helpers, nothing written", async () => {
  rmSync(join(claudeDir, ".credentials.json"));
  const id = "0199dddd-0000-7000-8000-000000000002";
  const path = canonicalPath(join(sessionsDir, `2026-11-24T00-00-01-000Z_${id}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-24T00:00:01.000Z", cwd })}\n`);
  markOwned(path);
  addWebSession(id);
  const before = readFileSync(path, "utf8");
  assert.deepEqual(await startOnDefault(path, cwd, false), { ok: true, applied: "none" });
  assert.equal(readFileSync(path, "utf8"), before, "nothing written to the chat: no model, effort or helpers set, so it keeps the model new chats open on");
  const chat = await acquireChat(path, true);
  const state = await chat.chatProfileState();
  assert.deepEqual([state.current.id, state.current.key, state.current.name], ["off", "sova:default", ""], "no profile, and no word for it (never Off)");
  const info = chat.subagentProfileInfo();
  assert.deepEqual([info.current.id, info.default, info.profiles], ["off", "off", []], "no helper profile, none listed");
  for (const f of ["subagent-profiles.json", "subagent-profiles-default.json", join("sova", "default-profile.json")]) assert.equal(existsSync(join(agentDir, f)), false, `${f} not written`);
});

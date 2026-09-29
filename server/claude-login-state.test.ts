// Run: npx tsx --test server/claude-login-state.test.ts
// A chat's Claude login (§app.claude-logins/active-login), against a throwaway agent dir and
// Claude directory with synthetic logins.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ClaudeLogins } from "../pi-config/extensions/claude-code/accounts.ts";
import { chatClaudeLogin, claudeLoginAfterHello, claudeLoginMessage, isClaudeLoginEntry } from "./claude-login-state";

const root = mkdtempSync(join(tmpdir(), "sova-chat-login-"));
after(() => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
const claudeDir = join(root, "claude");
mkdirSync(agentDir, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "own@example.com", organizationType: "claude_pro" } }));
const A = "l-0000000a";
const logins = new ClaudeLogins({ agentDir, env: { PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: claudeDir } });
const entry = (login: string, label?: string) => ({ type: "custom", customType: "claude-login", data: { v: 1, login, ...(label ? { label } : {}) } });

test("with only Claude Code's own login: default, named by its email, and nothing to choose between", () => {
  assert.deepEqual(chatClaudeLogin([], logins), { id: "default", name: "own@example.com", email: "own@example.com", planLabel: "Pro", recorded: false, several: false });
  assert.equal(claudeLoginAfterHello([], logins), null, "after a hello nothing is sent: a single-login host keeps its message sequence");
});

test("the newest claude-login entry wins; before one, the login this host would start on", () => {
  writeFileSync(
    join(agentDir, "claude-accounts.json"),
    JSON.stringify({ version: 1, logins: [{ id: A, addedAt: 1, enabled: true, device: "local", label: "Work", identity: { email: "work@example.com", rateLimitTier: "default_claude_max_5x" } }], devices: { local: { order: [A, "default"] } } }),
  );
  assert.deepEqual(chatClaudeLogin([], logins), { id: A, name: "Work", email: "work@example.com", planLabel: "Max 5x", recorded: false, several: true });
  assert.equal((claudeLoginAfterHello([], logins) as { login: { id: string } }).login.id, A, "several logins: sent after a hello");
  const branch = [entry(A), { type: "message" }, entry("default")];
  assert.equal(chatClaudeLogin(branch, logins)?.id, "default");
  assert.equal(chatClaudeLogin(branch, logins)?.recorded, true);
  // A recorded login this host no longer has keeps the name the entry gave it.
  assert.equal(chatClaudeLogin([entry("l-0000dead", "gone@example.com")], logins)?.name, "gone@example.com");
});

test("the message and the entry test", () => {
  assert.equal((claudeLoginMessage([entry(A)], logins) as { type: string }).type, "claude_login");
  assert.equal(isClaudeLoginEntry(entry(A)), true);
  assert.equal(isClaudeLoginEntry({ type: "custom", customType: "sandbox" }), false);
  assert.equal(isClaudeLoginEntry(null), false);
});

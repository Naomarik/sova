// Run: npx tsx --test server/claude-login-state.test.ts
// A chat's Claude login (§app.claude-logins/active-login), against a throwaway agent dir and
// Claude directory with synthetic logins.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ClaudeLogins } from "../pi-config/extensions/claude-code/accounts.ts";
import { chatClaudeLogin, claudeLoginAfterHello, claudeLoginMessage, isClaudeLoginEntry, LoginPick } from "./claude-login-state";

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

test("the wire: a waiting pick rides along, and a pool with other logins makes a one-login device worth a menu", () => {
  const pending = { id: "l-0000000b", name: "b@example.com" };
  assert.deepEqual(chatClaudeLogin([entry(A)], logins, { pending })?.pending, pending);
  assert.equal(chatClaudeLogin([entry(A)], logins, { pending: null })?.pending, undefined, "no pick, no field");
  const bare = mkdtempSync(join(tmpdir(), "sova-chat-login-bare-"));
  after(() => rmSync(bare, { recursive: true, force: true }));
  const own = new ClaudeLogins({ agentDir: bare, env: { PI_CODING_AGENT_DIR: bare, CLAUDE_CONFIG_DIR: claudeDir } });
  assert.equal(chatClaudeLogin([], own, { poolOthers: () => 0 })?.several, false, "only its own login, no pool");
  assert.equal(chatClaudeLogin([], own, { poolOthers: () => 2 })?.several, true, "the pool has logins to borrow");
});

test("a pick while a reply runs waits; a later one replaces it; the chat's own login or a cancel drops it; it goes at the reply's end", () => {
  const b = { id: "l-0000000b", name: "b@example.com" };
  const c = { id: "l-0000000c", name: "c@example.com" };
  const pick = new LoginPick();
  assert.equal(pick.choose(b, A, true), "queued");
  assert.equal(pick.choose(c, A, true), "queued");
  assert.deepEqual(pick.pending, c, "picking again replaces the waiting pick");
  assert.equal(pick.choose({ id: A, name: "a" }, A, true), "cancelled", "the chat's own login cancels it");
  assert.equal(pick.pending, null);
  assert.equal(pick.choose(null, A, true), "unchanged", "nothing to cancel");
  assert.equal(pick.choose(b, A, true), "queued");
  assert.equal(pick.choose(null, A, true), "cancelled", "Cancel switch");
  // Queued, then the reply ends: the pick lands, and nothing else can be picked or cancelled meanwhile.
  assert.equal(pick.choose(c, A, true), "queued");
  const landing = pick.start();
  assert.deepEqual(landing, c, "applied at the reply's end");
  assert.equal(pick.start(), null, "once");
  assert.equal(pick.choose(b, A, false), "landing");
  assert.equal(pick.choose(null, A, false), "unchanged");
  pick.done(landing!);
  assert.deepEqual([pick.pending, pick.applying], [null, false]);
  // Idle: a pick goes now.
  assert.equal(pick.choose(b, A, false), "apply");
  assert.deepEqual(pick.start(), b);
});

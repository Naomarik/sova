import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatClaudeLogin } from "../../shared/protocol";
import { composerLogin } from "./claude-login";

const login = (over: Partial<ChatClaudeLogin> = {}): ChatClaudeLogin => ({ id: "l-0000000a", name: "a@example.com", email: "a@example.com", planLabel: "Max 20x", recorded: true, several: true, ...over });

test("the indicator shows the chat's login on a Claude Code model when the host has several", () => {
  const shown = composerLogin(login(), "claude-code-cli/opus");
  assert.equal(shown?.text, "a@example.com");
  assert.equal(shown?.short, "a");
  assert.match(shown!.title, /^This chat runs on this Claude login: a@example.com · Max 20x\./);
  assert.equal(shown?.label, "Claude login: a@example.com");
  assert.match(composerLogin(login({ recorded: false }), "claude-code-cli/opus")!.title, /^This chat starts on this Claude login/);
  assert.match(composerLogin(login({ name: "Work" }), "claude-code-cli/opus")!.title, /: Work · a@example.com · Max 20x\./, "a label names it besides the email");
  assert.equal(composerLogin(login({ email: undefined, name: "default" }), "claude-code-cli/opus")?.text, "default");
});

test("no indicator off Claude Code, with a single login, or without a login", () => {
  assert.equal(composerLogin(login(), "zai/glm-5.3"), null);
  assert.equal(composerLogin(login(), null), null);
  assert.equal(composerLogin(login({ several: false }), "claude-code-cli/opus"), null);
  assert.equal(composerLogin(null, "claude-code-cli/opus"), null);
});

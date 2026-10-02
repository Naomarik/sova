import assert from "node:assert/strict";
import { test } from "node:test";
import { exhaustedProvider, failureHasRow, limitAlternative, providerLabel, rowProvider } from "./subagent-limit";
import type { SubagentProfilesInfo } from "../../shared/subagent-profiles";

test("no limit wording, no provider — whatever else the error says", () => {
  for (const text of ["401 auth required by OpenAI", "policy denied by z.ai", "Network connection failed", "429", "HTTP 429 from Upstream", "Usage 90%"])
    assert.equal(exhaustedProvider(text, "claude"), null, `never a row for: ${text}`);
  assert.equal(exhaustedProvider("Claude stopped: auth refresh failed", "claude"), null, "an auth error naming a provider is still not a limit");
});

test("an explicit provider name in the text wins, as its canonical id", () => {
  assert.equal(exhaustedProvider("Claude usage limit reached"), "claude");
  assert.equal(exhaustedProvider("Anthropic rate limit reached, try again later"), "claude");
  assert.equal(exhaustedProvider("OpenAI usage limit reached for this account"), "openai-codex");
  assert.equal(exhaustedProvider("ChatGPT rate limit exceeded"), "openai-codex");
  assert.equal(exhaustedProvider("z.ai rate limit exceeded"), "zai", "the alias is the same provider as zai");
  assert.equal(exhaustedProvider("Ollama Cloud: too many requests"), "ollama-cloud");
  assert.equal(exhaustedProvider("DeepSeek quota exhausted"), "deepseek");
  // Unknown provider names are never guessed at.
  assert.equal(exhaustedProvider("Mistral rate limit exceeded"), null);
});

test("unnamed text falls to the failed turn's own provider, or no row at all", () => {
  assert.equal(exhaustedProvider("Rate limit exceeded", "zai"), "zai");
  assert.equal(exhaustedProvider("too many requests", "openai-codex"), "openai-codex");
  // The pi chat provider for Claude Code logins is the same Claude pool the profiles call "claude".
  assert.equal(exhaustedProvider("You've hit your limit · resets 3pm", "claude-code-cli"), "claude");
  // Neither source: hidden — this is the worker failure case, whose model is none of this chat's.
  assert.equal(exhaustedProvider("Rate limit exceeded"), null);
  assert.equal(exhaustedProvider("Rate limit exceeded", undefined), null);
  // Text wins over the turn's provider when both exist: it is about the specific provider it names.
  assert.equal(exhaustedProvider("Claude usage limit reached", "zai"), "claude");
});

test("the transport's own limit phrasings reach the row", () => {
  // The claude-code transport's LIMIT_TEXT classifies these as the login out of quota; the row's
  // gate must not be narrower than the failover's, or a real limit shows nothing.
  assert.equal(exhaustedProvider("You've hit your limit (fake)", "claude-code-cli"), "claude");
  // (b) The alias stands on its own: no Claude word in the text, the turn's provider supplies it.
  assert.equal(exhaustedProvider("usage limit reached", "claude-code-cli"), "claude");
  // (c) The same message with no provider stays hidden — an unknown provider is never invented.
  assert.equal(exhaustedProvider("usage limit reached"), null);
  assert.equal(exhaustedProvider("usage limit reached, resets soon", "claude-code-cli"), "claude");
  assert.equal(exhaustedProvider("You're out of extra usage", "claude-code-cli"), "claude");
  assert.equal(exhaustedProvider("Your limit will reset at 3 pm", "claude-code-cli"), "claude");
  // And never a limit for a sign-in, which the same transport separates.
  assert.equal(exhaustedProvider("not logged in, please run /login", "claude-code-cli"), null);
});

test("usage limits offer configured alternatives, never Off or the current profile", () => {
  const info = {
    current: { id: "current" },
    profiles: [
      { id: "off", name: "Off", providers: [] },
      { id: "current", name: "Current", providers: ["zai"] },
      { id: "mixed", name: "Mixed", providers: ["zai", "claude"] },
      { id: "escape", name: "Escape", providers: ["zai"] },
    ],
  } as SubagentProfilesInfo;
  // `providers` counts fallbacks, so an exhausted provider hiding in a fallback disqualifies too.
  assert.equal(limitAlternative(info, "claude")?.id, "escape");
  assert.equal(limitAlternative(info, "zai"), undefined, "no profile is zai-free: no offer");
});

test("a provider id the way the row says it", () => {
  assert.equal(providerLabel("claude"), "Claude");
  assert.equal(providerLabel("openai-codex"), "OpenAI");
  assert.equal(providerLabel("zai"), "z.ai");
  assert.equal(providerLabel("ollama-cloud"), "Ollama");
  assert.equal(providerLabel("deepseek"), "DeepSeek");
  assert.equal(providerLabel("openrouter"), "openrouter", "an unmapped id reads as itself");
});

test("a thread row's provider is its own model's first segment, canonicalized", () => {
  assert.equal(rowProvider("zai/glm-5.3"), "zai");
  assert.equal(rowProvider("claude-code-cli/opus[1m]"), "claude", "the cli chat provider is the Claude pool");
  assert.equal(rowProvider("Opus"), "Opus", "a bare alias has no provider here");
  assert.equal(rowProvider(undefined), undefined, "a row that doesn't know says nothing");
  assert.equal(rowProvider(null), undefined);
});

test("one failure, one row: the feed entry yields to the failure's own thread row", () => {
  const entries = [
    { kind: "user" },
    { kind: "assistant", error: "You've hit your limit (fake)." },
    { kind: "assistant" },
  ];
  assert.equal(failureHasRow(entries, "You've hit your limit (fake)"), true, "a trailing period is presentation, not identity");
  assert.equal(failureHasRow(entries, "Some other failure"), false);
  assert.equal(failureHasRow([], "You've hit your limit (fake)"), false, "no thread row: the feed's entry keeps its row");
});

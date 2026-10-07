import assert from "node:assert/strict";
import { test } from "node:test";
import { compactModel, modelLabel, modelMismatch, relativeIn, shortModel, usageModelNote } from "./format";

test("shortModel drops the provider only", () => {
  assert.equal(shortModel("anthropic/claude-opus-5"), "claude-opus-5");
  assert.equal(shortModel("claude-opus-5"), "claude-opus-5");
  assert.equal(shortModel(null), null);
  assert.equal(shortModel(""), null);
});

test("compactModel names a Claude model by its catalog name, under any provider and id", () => {
  assert.equal(compactModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(compactModel("anthropic/claude-sonnet-5"), "Sonnet 5");
  assert.equal(compactModel("claude-opus-5"), "Opus 5");
  assert.equal(compactModel("claude-code-cli/opus[1m]"), "Opus 5.5", "an old alias reads as the model it meant");
  assert.equal(compactModel("claude-opus-5-5[1m]"), "Opus 5.5", "no 1M: the window is the model's own");
  assert.equal(compactModel("claude-fable-5-1[1m]"), "Fable 5.1");
});

test("compactModel shortens other ids: no provider, no dated build, a dotted version", () => {
  assert.equal(compactModel("anthropic/claude-sonnet-4-5-20250929"), "sonnet-4.5", "a Claude id the catalog doesn't list keeps the short form");
  assert.equal(compactModel("claude-opus-6[1m]"), "opus-6 1M");
});

test("modelLabel: the catalog name, of the model that answered when known; else the short id", () => {
  assert.equal(modelLabel("claude-code-cli/opus[1m]"), "Opus 5.5");
  assert.equal(modelLabel("claude-code-cli/opus[1m]", "claude-opus-4-8"), "Opus 4.8", "the answer wins");
  assert.equal(modelLabel("claude-code-cli/claude-haiku-4-5", "claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("zai/glm-5.3"), "glm-5.3");
  assert.equal(modelLabel("claude-code-cli/claude-opus-6"), "claude-opus-6", "an id the catalog doesn't know");
  assert.equal(modelLabel(null), null);
});

test("modelMismatch only when another catalog model answered; usageModelNote says it and the ids asked for", () => {
  assert.equal(modelMismatch("claude-code-cli/opus[1m]", "claude-opus-4-8"), "Asked for Opus 5.5; Opus 4.8 answered.");
  assert.equal(modelMismatch("claude-code-cli/opus[1m]", "claude-opus-5-5"), null);
  assert.equal(modelMismatch("claude-code-cli/claude-haiku-4-5", "claude-haiku-4-5-20251001"), null);
  assert.equal(modelMismatch("zai/glm-5.3", "glm-5.3"), null);
  assert.equal(usageModelNote({ model: "claude-opus-5-5" }), "");
  assert.equal(usageModelNote({ model: "claude-opus-5-5", requested: ["claude-opus-5-5[1m]", "opus", "opus[1m]"] }), "Asked as claude-opus-5-5[1m], opus, opus[1m].");
  assert.equal(usageModelNote({ model: "claude-opus-4-8", asked: "claude-opus-5-5", requested: ["opus[1m]"] }), "Asked for Opus 5.5; Opus 4.8 answered. Asked as opus[1m].");
});

test("compactModel leaves ids it doesn't recognize alone", () => {
  assert.equal(compactModel("gpt-5-mini"), "gpt-5-mini");
  assert.equal(compactModel("deepseek/deepseek-chat"), "deepseek-chat");
  assert.equal(compactModel("openai/gpt-4-1"), "gpt-4.1");
  assert.equal(compactModel(null), null);
  assert.equal(compactModel(undefined), null);
});

test("relativeIn: a future time as 'in {rel}'; passed or unreadable is null", () => {
  const now = Date.parse("2026-09-19T05:33:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(relativeIn(at(20_000), now), "in under a minute");
  assert.equal(relativeIn(at(3 * 60_000), now), "in 3m");
  assert.equal(relativeIn(at(2 * 3_600_000), now), "in 2h");
  assert.equal(relativeIn(at(30 * 3_600_000), now), "in 1d");
  assert.equal(relativeIn(at(0), now), null);
  assert.equal(relativeIn(at(-5000), now), null);
  assert.equal(relativeIn("nope", now), null);
});

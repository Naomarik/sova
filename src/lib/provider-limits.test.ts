import assert from "node:assert/strict";
import test from "node:test";
import { limitsDraftOf, limitsOfDraft, limitsProblem, parseLimitField, rebaseLimits, sameLimits } from "./provider-limits";

test("a field is a whole number 1..999, or empty for no limit", () => {
  assert.equal(parseLimitField(""), null);
  assert.equal(parseLimitField("  "), null);
  assert.equal(parseLimitField("5"), 5);
  assert.equal(parseLimitField(" 12 "), 12);
  for (const bad of ["0", "1000", "2.5", "-1", "five", "1e2"]) assert.equal(parseLimitField(bad), "invalid", bad);
});

test("draft ↔ limits: empty fields drop out, an invalid one names its provider", () => {
  assert.deepEqual(limitsDraftOf({ zai: 5 }), { zai: "5" });
  assert.deepEqual(limitsOfDraft({ zai: "4", "ollama-cloud": "", "claude-code": "2" }), { limits: { zai: 4, "claude-code": 2 } });
  assert.deepEqual(limitsOfDraft({ zai: "x" }), { invalid: "zai" });
  assert.match(limitsProblem({ zai: "0" }) ?? "", /zai's At once must be a whole number from 1 to 999/);
  assert.equal(limitsProblem({ zai: "" }), null);
  assert.equal(sameLimits({ zai: "5", "ollama-cloud": "" }, { zai: 5 }), true);
  assert.equal(sameLimits({ zai: "" }, { zai: 5 }), false, "clearing a field removes the limit");
  assert.equal(sameLimits({ zai: "5x" }, { zai: 5 }), false);
});

test("rebase keeps the fields the user changed and follows the file everywhere else", () => {
  const base = { zai: 5, "ollama-cloud": 10 };
  const draft = { zai: "3", "ollama-cloud": "10" }; // the user changed zai only
  const fresh = { zai: 5, "ollama-cloud": 8, "openai-codex": 2 }; // a peer changed ollama-cloud and added codex
  assert.deepEqual(rebaseLimits(draft, base, fresh), { zai: "3", "ollama-cloud": "8", "openai-codex": "2" });
  assert.deepEqual(rebaseLimits({ zai: "", "ollama-cloud": "10" }, base, fresh), { zai: "", "ollama-cloud": "8", "openai-codex": "2" }, "a cleared field stays cleared");
  assert.deepEqual(rebaseLimits({ zai: "abc", "ollama-cloud": "10" }, base, fresh).zai, "abc", "an invalid edit is kept for the user to fix");
});

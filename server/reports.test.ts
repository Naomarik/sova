// Run: npx tsx --test server/reports.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReport } from "./reports";

const report = (...lines: string[]) => parseReport("subagent-complete", lines.join("\n"));
const HEAD = "### ag_01 (ui-review) — done · task success";
const SESSION = "Session: ~/.pi/agent/sessions/abc.jsonl";

test("model line: model, thinking and backend, kept out of body and preview", () => {
  const r = report(HEAD, SESSION, "Model: claude-sonnet-4-6 · thinking: high · backend: claude-code",
    "", "Reviewed the composer.", "Second line.");
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.effort, "high");
  assert.equal(r.backend, "claude-code");
  assert.equal(r.body, "Reviewed the composer.\nSecond line.");
  assert.equal(r.preview, "Reviewed the composer.");
});

test("model line without a backend; a provider/model id keeps its slash", () => {
  const r = report(HEAD, SESSION, "Model: ollama-cloud/kimi-k3 · thinking: medium", "", "Done.");
  assert.equal(r.model, "ollama-cloud/kimi-k3");
  assert.equal(r.effort, "medium");
  assert.equal(r.backend, undefined);
  assert.equal(r.body, "Done.");
});

test("no session line: the model line is still peeled", () => {
  const r = report(HEAD, "Model: claude-sonnet-4-6 · thinking: low", "", "Done.");
  assert.equal(r.session, undefined);
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.effort, "low");
  assert.equal(r.body, "Done.");
});

test("old format without a model line is unchanged; preview is the first body line", () => {
  const r = report(HEAD, SESSION, "", "", "# Findings", "One issue.");
  assert.equal(r.model, undefined);
  assert.equal(r.effort, undefined);
  assert.equal(r.backend, undefined);
  assert.equal(r.body, "# Findings\nOne issue.");
  assert.equal(r.preview, "Findings");
});

test("sentinel values pass through verbatim", () => {
  const r = report(HEAD, SESSION, "Model: child default · thinking: default", "", "Done.");
  assert.equal(r.model, "child default");
  assert.equal(r.effort, "default");
});

test("model line present, body empty", () => {
  const r = report(HEAD, SESSION, "Model: claude-sonnet-4-6 · thinking: high · backend: claude-code");
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.effort, "high");
  assert.equal(r.body, "");
  assert.equal(r.preview, "");
});

test("malformed line: no model leaves every field unset, and unknown keys are ignored", () => {
  const empty = report(HEAD, SESSION, "Model: ", "", "Done.");
  assert.equal(empty.model, undefined);
  assert.equal(empty.body, "Done.");

  const bare = report(HEAD, SESSION, "Model: claude-sonnet-4-6", "", "Done.");
  assert.deepEqual([bare.model, bare.effort, bare.backend], ["claude-sonnet-4-6", undefined, undefined]);

  const odd = report(HEAD, SESSION, "Model: kimi · thinking: · nonsense · temperature: 0.7 · backend: claude-code",
    "", "Done.");
  assert.deepEqual([odd.model, odd.effort, odd.backend], ["kimi", undefined, "claude-code"]);
  assert.equal(odd.body, "Done.");
});

test("a body line that looks like the model line is left alone", () => {
  const r = report(HEAD, SESSION, "", "Model: gpt-5 · thinking: high");
  assert.equal(r.model, undefined);
  assert.equal(r.body, "Model: gpt-5 · thinking: high");
});

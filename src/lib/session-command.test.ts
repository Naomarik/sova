// Run: npx tsx --test src/lib/session-command.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeCommand, shellQuote } from "./session-command";

test("resumeCommand quotes the full session path", () => {
  assert.equal(
    resumeCommand("/home/u/.pi/agent/sessions/--home-u-app--/2026-09-20T23-02-00-286Z_01a0c10e.jsonl"),
    "pi --session '/home/u/.pi/agent/sessions/--home-u-app--/2026-09-20T23-02-00-286Z_01a0c10e.jsonl'",
  );
});

test("a path with spaces stays one word", () => {
  assert.equal(resumeCommand("/home/u/My Projects/s.jsonl"), "pi --session '/home/u/My Projects/s.jsonl'");
});

test("shellQuote leaves !, $, backticks and backslashes literal", () => {
  assert.equal(shellQuote("/tmp/wow!/s.jsonl"), "'/tmp/wow!/s.jsonl'");
  assert.equal(shellQuote("/tmp/a$HOME/s.jsonl"), "'/tmp/a$HOME/s.jsonl'");
  assert.equal(shellQuote("/tmp/back`tick`/s.jsonl"), "'/tmp/back`tick`/s.jsonl'");
  assert.equal(shellQuote("/tmp/back\\slash/s.jsonl"), "'/tmp/back\\slash/s.jsonl'");
});

test("shellQuote closes, escapes and reopens around a single quote", () => {
  assert.equal(shellQuote("/tmp/it's/s.jsonl"), "'/tmp/it'\\''s/s.jsonl'");
  assert.equal(shellQuote("''"), "''\\'''\\'''");
});

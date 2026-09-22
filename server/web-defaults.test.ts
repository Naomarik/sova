// Run: npx tsx --test server/web-defaults.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-defaults-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its path
const { loadDefaults, saveDefaults } = await import("./web-defaults");
const file = join(agentDir, "sova", "defaults.json");

after(() => rmSync(agentDir, { recursive: true, force: true }));

test("a missing file loads empty", () => {
  assert.deepEqual(loadDefaults(file), {});
});

test("saveDefaults writes both fields and round-trips", () => {
  const saved = saveDefaults({ model: "anthropic/claude-opus-4-6", thinking: "medium" }, file);
  assert.deepEqual(saved, { model: "anthropic/claude-opus-4-6", thinking: "medium" });
  assert.deepEqual(loadDefaults(file), { model: "anthropic/claude-opus-4-6", thinking: "medium" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("saveDefaults merges per field instead of clobbering", () => {
  saveDefaults({ thinking: "high" }, file);
  assert.deepEqual(loadDefaults(file), { model: "anthropic/claude-opus-4-6", thinking: "high" });
  saveDefaults({ model: "openai/gpt-6" }, file);
  assert.deepEqual(loadDefaults(file), { model: "openai/gpt-6", thinking: "high" });
});

test("empty or non-string patch fields are dropped, keeping the stored default", () => {
  saveDefaults({ model: "", thinking: undefined }, file);
  assert.deepEqual(loadDefaults(file), { model: "openai/gpt-6", thinking: "high" });
});

test("a corrupt or wrong-shaped file loads empty, and a save over it repairs the file", () => {
  for (const body of ["not json{", "[]", "42"]) {
    mkdirSync(join(agentDir, "sova"), { recursive: true });
    writeFileSync(file, body);
    assert.deepEqual(loadDefaults(file), {});
  }
  const saved = saveDefaults({ model: "x/y" }, file);
  assert.deepEqual(saved, { model: "x/y" });
  assert.deepEqual(loadDefaults(file), { model: "x/y" });
});

test("unknown fields in the file are dropped on load", () => {
  writeFileSync(file, JSON.stringify({ version: 1, model: "a/b", thinking: "low", bogus: true, other: "c/d" }));
  assert.deepEqual(loadDefaults(file), { model: "a/b", thinking: "low" });
});

// Run: npx tsx --test server/settings.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point BOTH the server module and (would it be loaded) the extension's policy.ts at a scratch
// agent dir: getAgentDir() reads PI_CODING_AGENT_DIR per call, so no real file is touched.
const dir = mkdtempSync(join(tmpdir(), "pi-web-settings-"));
mkdirSync(join(dir, "subagents"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = dir;
const { readSubagentPolicy, writeSubagentPolicy } = await import("./settings");
const file = () => join(dir, "subagents", "settings.json");

test.after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("read: missing, corrupt and foreign files disable nothing", () => {
  assert.deepEqual(readSubagentPolicy(), { disabledProviders: [], disabledModels: [] });
  writeFileSync(file(), "{corrupt");
  assert.deepEqual(readSubagentPolicy(), { disabledProviders: [], disabledModels: [] });
  writeFileSync(file(), JSON.stringify({ version: 2, disabledProviders: ["x"] }));
  assert.deepEqual(readSubagentPolicy(), { disabledProviders: [], disabledModels: [] });
  writeFileSync(file(), JSON.stringify({ version: 1, disabledProviders: "nope", disabledModels: [] }));
  assert.deepEqual(readSubagentPolicy(), { disabledProviders: [], disabledModels: [] });
});

test("write: canonicalizes (lowercase, dedupe, sort), rejects bad shapes, reads back", () => {
  const wrote = writeSubagentPolicy({
    disabledProviders: ["ZAI", "zai", " anthropic "],
    disabledModels: ["OpenAI/GPT-5.2", "claude-code/opus"],
  });
  assert.ok(!("error" in wrote), "valid policy writes");
  assert.deepEqual(wrote, { disabledProviders: ["anthropic", "zai"], disabledModels: ["claude-code/opus", "openai/gpt-5.2"] });
  assert.deepEqual(readSubagentPolicy(), wrote);
  // The file on disk is the extension's contract shape (pi-config policy.ts).
  assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")), { version: 1, ...wrote });
  // Bad shapes are rejected whole, and the last good write survives.
  for (const bad of [
    { disabledProviders: "nope" },
    { disabledProviders: ["ok"], disabledModels: ["no-slash"] },
    { disabledProviders: ["has/slash"], disabledModels: [] },
    null,
    { disabledProviders: Array.from({ length: 201 }, (_, i) => `p${i}`), disabledModels: [] },
  ]) {
    assert.equal("error" in writeSubagentPolicy(bad), true, JSON.stringify(bad));
  }
  assert.deepEqual(readSubagentPolicy(), wrote);
});

test("empty arrays write the nothing-disabled file the extension treats as absent", () => {
  const wrote = writeSubagentPolicy({ disabledProviders: [], disabledModels: [] });
  assert.ok(!("error" in wrote));
  assert.deepEqual(readSubagentPolicy(), { disabledProviders: [], disabledModels: [] });
});

// What the store tells its readers: the status Settings' line follows, and the watch every process polls.
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CLAUDE_MODELS_FILE, claudeStateRoot, claudeTableStatus, loadClaudeModels, readClaudeModelsFile, watchClaudeModelsFile, type ClaudeModelsFile } from "../pi-config/extensions/claude-code/catalog-store.ts";
import { claudeModel, mergeClaudeCatalog } from "../pi-config/extensions/claude-code/catalog.ts";

const dirs: string[] = [];
afterEach(() => {
  mergeClaudeCatalog({ models: [] });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function root() {
  const d = mkdtempSync(join(tmpdir(), "claude-store-"));
  dirs.push(d);
  return d;
}
const put = (dir: string, file: ClaudeModelsFile) => {
  writeFileSync(join(dir, `${CLAUDE_MODELS_FILE}.tmp`), JSON.stringify(file));
  renameSync(join(dir, `${CLAUDE_MODELS_FILE}.tmp`), join(dir, CLAUDE_MODELS_FILE));
};
const unreadable = { reason: "no model rows found", at: 5 };

test("the status tells an unreadable table from no program, and says nothing with reading off", () => {
  const d = root();
  assert.deepEqual(claudeTableStatus(d, {}), { readable: true });
  put(d, { v: 1, models: [], noProgram: true });
  assert.deepEqual(claudeTableStatus(d, {}), { readable: true, noProgram: true });
  put(d, { v: 1, models: [], unreadable });
  assert.deepEqual(claudeTableStatus(d, {}), { readable: false, reason: unreadable.reason, at: 5 });
  for (const env of [{ SOVA_MODELS_FETCH: "off" }, { PI_OFFLINE: "1" }, { SOVA_CLAUDE_TABLE: "off" }]) assert.deepEqual(claudeTableStatus(d, env), { readable: true });
});

test("a load is a change when the list or the status moved, and only then", () => {
  const d = root();
  put(d, { v: 1, models: [{ id: "claude-opus-9", window: 1000 }] });
  assert.equal(loadClaudeModels(d), true);
  assert.equal(claudeModel("claude-opus-9")?.window, 1000);
  assert.equal(loadClaudeModels(d), false);
  put(d, { v: 1, models: [{ id: "claude-opus-9", window: 1000 }], unreadable });
  assert.equal(loadClaudeModels(d), true);
  assert.equal(loadClaudeModels(d), false);
});

test("a missing or damaged file is the built-in list", () => {
  const d = root();
  assert.equal(readClaudeModelsFile(d), null);
  writeFileSync(join(d, CLAUDE_MODELS_FILE), "{ not json");
  assert.equal(readClaudeModelsFile(d), null);
  writeFileSync(join(d, CLAUDE_MODELS_FILE), JSON.stringify({ v: 2, models: [] }));
  assert.equal(readClaudeModelsFile(d), null);
});

test("a worker reads its server's state root", () => {
  assert.equal(claudeStateRoot({ SOVA_CHAT_STATE_ROOT: "/server/state", PI_CODING_AGENT_DIR: "/worktree/.agent" }), "/server/state");
  assert.equal(claudeStateRoot({ PI_CODING_AGENT_DIR: "/a" }), join("/a", "sova"));
});

test("the watch fires on a replaced file and stops when asked", async () => {
  const d = root();
  put(d, { v: 1, models: [] });
  let resolve!: () => void;
  const fired = new Promise<void>((r) => (resolve = r));
  const stop = watchClaudeModelsFile(d, resolve, 20);
  await new Promise((r) => setTimeout(r, 60));
  put(d, { v: 1, models: [{ id: "claude-opus-9" }] });
  await fired;
  stop();
});

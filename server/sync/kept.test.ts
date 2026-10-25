// Kept copies of replaced settings documents (§mesh.sync/kept-copies).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEPT_DIR, keepCopy, keptDir, listKept, markRestored } from "./kept";

const root = mkdtempSync(join(tmpdir(), "sova-kept-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("each document keeps its newest 10, newest first; another document's copies are its own", () => {
  const dir = join(root, "cap");
  for (let i = 0; i < 13; i++) keepCopy(dir, { key: "settings:mode.json", at: 1000 + i, by: "b", content: `v${i}` });
  keepCopy(dir, { key: "settings:sova/settings.json", at: 5, by: "c", content: "other" });
  const kept = listKept(dir, "settings:mode.json");
  assert.deepEqual(kept.map((k) => k.content), ["v12", "v11", "v10", "v9", "v8", "v7", "v6", "v5", "v4", "v3"]);
  assert.equal(readdirSync(keptDir(dir, "settings:mode.json")).length, 10);
  assert.deepEqual(listKept(dir, "settings:sova/settings.json").map((k) => k.content), ["other"]);
  assert.deepEqual(readdirSync(join(dir, KEPT_DIR)).sort(), ["settings_mode.json", "settings_sova_settings.json"], "one plain folder per document");
});

test("marking one restored keeps it, says when; an unknown name or an unreadable file is skipped", () => {
  const dir = join(root, "restore");
  const file = keepCopy(dir, { key: "settings:subagent-profiles.json", at: 7, by: "zen", byName: "Zen", content: "{}", changes: { added: ["Fast"], changed: [], removed: [] } });
  writeFileSync(join(keptDir(dir, "settings:subagent-profiles.json"), "000000000000099-bad.json"), "{ nope");
  assert.equal(markRestored(dir, "settings:subagent-profiles.json", "../../elsewhere.json", 9), false);
  assert.equal(markRestored(dir, "settings:subagent-profiles.json", file, 9), true);
  const [k] = listKept(dir, "settings:subagent-profiles.json");
  assert.equal(listKept(dir, "settings:subagent-profiles.json").length, 1);
  assert.equal(k!.restoredAt, 9);
  assert.equal(k!.byName, "Zen");
  assert.deepEqual(k!.changes, { added: ["Fast"], changed: [], removed: [] });
  assert.deepEqual(listKept(join(root, "nothing"), "settings:mode.json"), []);
});

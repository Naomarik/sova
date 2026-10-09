// Run: pnpm exec tsx --test server/adversarial-review-flag.test.ts
// Settings → Alignment's Adversarial review reaches a hosted session only as the mode extension's
// `adversarial-review` flag (§chat.alignment-review/flag): from the chat's launch record when it has one,
// else as saved now; absent when off, never handed to a loadout without extensions. A file that stores
// only `alignment.review: true` (no Experimental key at all) turns it on and seeds the reviewer.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-review-flag-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

const { writeWebSettings } = await import("./web-settings");
const { extensionFlagsFor } = await import("./chat-manager");
const { DEFAULT_REVIEWER, readSubagentProfiles, writeSubagentProfiles } = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
const { delegateDefaults } = await import("../pi-config/extensions/mode/delegate.ts");

test("only alignment.review: true stored: the session flag is on and the reviewer is seeded", () => {
  assert.equal(extensionFlagsFor(agentDir, false, false).has("adversarial-review"), false, "no settings file: off");
  writeSubagentProfiles(agentDir, { version: 1, profiles: [{ id: "a", name: "a", delegate: delegateDefaults().profiles, teams: null, members: null, specWriter: null }] });
  writeWebSettings({ alignment: { review: true } });
  const stored = JSON.parse(readFileSync(join(agentDir, "sova", "settings.json"), "utf8"));
  assert.equal(stored.experimental.adversarialReview, undefined, "nothing under Experimental");
  assert.deepEqual(stored.alignment, { review: true });
  assert.equal(extensionFlagsFor(agentDir, false, false).get("adversarial-review"), true);
  const library = readSubagentProfiles(agentDir);
  assert.ok(library.state === "ok" && library.value.profiles[0]!.reviewer !== undefined);
  assert.deepEqual(library.state === "ok" ? library.value.profiles[0]!.reviewer : null, DEFAULT_REVIEWER, "the first save that turns it on seeds the default reviewer");
  assert.deepEqual([...extensionFlagsFor(agentDir, false, true)], [], "a loadout with no extension gets no flag at all");
  writeWebSettings({ alignment: { review: false } });
  assert.equal(extensionFlagsFor(agentDir, false, false).has("adversarial-review"), false);
});

test("a hand-written file holding only alignment.review: true reads on", () => {
  writeFileSync(join(agentDir, "sova", "settings.json"), JSON.stringify({ version: 1, alignment: { review: true } }));
  assert.equal(extensionFlagsFor(agentDir, false, false).get("adversarial-review"), true);
});

test("a chat's launch record wins over the setting, both ways, and hands the extension its Visuals", () => {
  writeWebSettings({ alignment: { review: true } });
  const off = extensionFlagsFor(agentDir, false, false, "legacy", { v: 1, review: false, visuals: false });
  assert.equal(off.has("adversarial-review"), false, "recorded off: off, whatever is saved now");
  assert.equal(off.get("align-visuals"), "off", "Visuals off is said, so the extension never reads the file instead");
  writeWebSettings({ alignment: { review: false } });
  const on = extensionFlagsFor(agentDir, false, false, "legacy", { v: 1, review: true, visuals: true });
  assert.equal(on.get("adversarial-review"), true, "recorded on: on");
  assert.equal(on.get("align-visuals"), "on");
  assert.equal(extensionFlagsFor(agentDir, false, false).has("align-visuals"), false, "no record (no chat): no Visuals flag");
});

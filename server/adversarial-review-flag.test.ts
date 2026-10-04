// Run: pnpm exec tsx --test server/adversarial-review-flag.test.ts
// Settings → Experimental's Adversarial review reaches a hosted session only as the mode
// extension's `adversarial-review` flag (§chat.alignment-review/flag): set while the switch is
// saved on, absent otherwise, never handed to a loadout without extensions.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-review-flag-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

const { writeWebSettings } = await import("./web-settings");
const { extensionFlagsFor } = await import("./chat-manager");

test("the flag follows the saved switch, read at each runtime start", () => {
  assert.equal(extensionFlagsFor(agentDir, false, false).has("adversarial-review"), false, "no settings file: off");
  writeWebSettings({ experimental: { adversarialReview: true } });
  assert.equal(extensionFlagsFor(agentDir, false, false).get("adversarial-review"), true);
  assert.deepEqual([...extensionFlagsFor(agentDir, false, true)], [], "a loadout with no extension gets no flag at all");
  writeWebSettings({ experimental: { adversarialReview: false } });
  assert.equal(extensionFlagsFor(agentDir, false, false).has("adversarial-review"), false);
});

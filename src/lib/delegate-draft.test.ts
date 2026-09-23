import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegateSettings } from "../../shared/protocol";
import { delegateDirty, delegateDraft, resetDelegateDraft, setDelegateDraft, setDelegateSaved } from "./delegate-draft";
import { cloneSettings } from "./delegate-form";

const claude = (model: string, effort: string) => ({ backend: "claude-code" as const, model, effort });
const saved: DelegateSettings = {
  version: 1,
  profiles: {
    planning: { primary: claude("claude-fable-5-1[1m]", "medium"), fallback: claude("opus[1m]", "high") },
    investigation: { primary: claude("opus[1m]", "low"), fallback: null },
    routine: { primary: claude("opus[1m]", "low"), fallback: null },
    complex: { primary: claude("opus[1m]", "medium"), fallback: null },
  },
};

test("a draft outlives the section (tab switches) until the dialog resets it", () => {
  resetDelegateDraft();
  assert.equal(delegateDirty(), false, "nothing loaded: nothing to lose");
  setDelegateSaved(saved);
  assert.deepEqual(delegateDraft(), saved, "the first load seeds the draft");
  const edited = cloneSettings(saved);
  edited.profiles.routine.primary = { backend: "pi", model: "zai/glm-5.3", effort: "low" };
  setDelegateDraft(edited);
  assert.equal(delegateDirty(), true);
  // The section remounts (back to Modes) and the saved routing loads again: the edit stays.
  setDelegateSaved(saved);
  assert.equal(delegateDraft()!.profiles.routine.primary.backend, "pi", "a reload of the saved routing never overwrites a kept draft");
  assert.equal(delegateDirty(), true);
  // A save replaces the draft with what the server now holds.
  setDelegateSaved(edited as DelegateSettings, { replaceDraft: true });
  assert.equal(delegateDirty(), false);
  // Closing the dialog forgets everything.
  setDelegateDraft(cloneSettings(saved));
  assert.equal(delegateDirty(), true);
  resetDelegateDraft();
  assert.equal(delegateDraft(), null);
  assert.equal(delegateDirty(), false);
});

test("every way out of the dialog goes through the close guard", async () => {
  const { readFileSync } = await import("node:fs");
  const dialog = readFileSync(new URL("../components/SettingsDialog.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(dialog, /onClick=\{props\.onClose\}|=== "Escape"\) props\.onClose\(\)/, "no exit bypasses requestClose");
  assert.equal(dialog.match(/requestClose\b/g)?.length, 4, "defined once, used by the scrim, Esc and Close");
});

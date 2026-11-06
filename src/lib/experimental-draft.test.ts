// Run: bun test src/lib/experimental-draft.test.ts (or pnpm test)
// Settings → Experimental's draft (experimental-draft.ts): its one switch, Sova runs chat modes
// (§chat.mode-menu/sova-runs-modes), starts from what the server saved and is dirty only when flipped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { experimentalDraft, experimentalSaved, resetExperimentalDraft, setExperimentalDraft, setExperimentalSaved } from "./experimental-draft";
import { dirtyForms } from "./settings-draft";

test("the switch starts from the saved value, on or off, and only a flip makes the tab dirty", () => {
  for (const saved of [true, false]) {
    resetExperimentalDraft();
    setExperimentalSaved({ sovaModes: saved });
    assert.deepEqual(experimentalDraft(), { sovaModes: saved }, "the draft is what the server saved, never a guessed default");
    assert.equal(dirtyForms().some((f) => f.tab === "experimental"), false);
    setExperimentalDraft({ sovaModes: !saved });
    assert.equal(dirtyForms().some((f) => f.tab === "experimental"), true, "a flip waits for Save Changes");
    setExperimentalDraft({ sovaModes: saved });
    assert.equal(dirtyForms().some((f) => f.tab === "experimental"), false, "flipped back: nothing to save");
    assert.deepEqual(experimentalSaved(), { sovaModes: saved });
  }
  resetExperimentalDraft();
  assert.equal(experimentalDraft(), null, "before the tab reads the server the switch has no value (it waits disabled)");
});

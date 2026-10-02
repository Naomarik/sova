import assert from "node:assert/strict";
import { test } from "node:test";
import { filterProfiles, FOOT_NOTE, isDefaultAll, isDefaultMode, modeSummary, nextSetup, noProfileMatch, SAVE_LABEL, SAVED_LABEL, saveLabel, saveTitle, savedAnnounce, SAVING_LABEL } from "./mode-menu";

const def = (mode: string, minorModes: string[], strict = false) => ({ mode, minorModes, strict });

test("already the default: the same mode AND the same minors in the same order", () => {
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("delegate", ["align"])), true);
  assert.equal(isDefaultMode(def("normal", []), def("normal", [])), true);
  // A different major, a different minor, one extra, one missing, or a different order: all moves.
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("normal", ["align"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("delegate", ["spec"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align", "spec"]), def("delegate", ["align"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("delegate", ["align", "spec"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align", "spec"]), def("delegate", ["spec", "align"])), false);
  // strict is one of the three fields a save writes (as `/mode default` does), so it counts too.
  assert.equal(isDefaultMode(def("delegate", ["align"], false), def("delegate", ["align"], true)), false);
  assert.equal(isDefaultMode(def("delegate", ["align"], true), def("delegate", ["align"], false)), false);
  assert.equal(isDefaultMode(def("delegate", ["align"], true), def("delegate", ["align"], true)), true);
});

test("unknown is never 'already the default': the button stays pressable", () => {
  // Nothing read yet, or this chat's mode hasn't arrived: a disabled button would claim knowledge.
  assert.equal(isDefaultMode(null, def("delegate", ["align"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align"]), null), false);
  assert.equal(isDefaultMode(null, null), false);
});

test("the label is the state, and no two states share one", () => {
  assert.equal(saveLabel("idle"), SAVE_LABEL);
  assert.equal(saveLabel("saving"), SAVING_LABEL);
  assert.equal(saveLabel("done"), SAVED_LABEL);
  assert.equal(new Set([SAVE_LABEL, SAVING_LABEL, SAVED_LABEL]).size, 3);
  assert.equal(FOOT_NOTE, "A switch here is this chat's own. New sessions start from the default.");
});

test("the title says what the press makes true, with the mode it names", () => {
  assert.equal(saveTitle(def("delegate", ["align"]), false), "New sessions will start from delegate · align.");
  assert.equal(saveTitle(def("delegate", ["align"]), true), "New sessions already start from delegate · align.");
  assert.equal(saveTitle(def("normal", []), false), "New sessions will start from normal.");
  assert.equal(saveTitle(def("delegate", ["align"], true), false), "New sessions will start from delegate · strict · align.");
  // No mode to name (nothing arrived yet): the sentence drops the name rather than saying "undefined".
  assert.equal(saveTitle(null, false), "Make this chat's mode the default for new sessions.");
  assert.equal(saveTitle(null, true), "New sessions already start from the default mode.");
});

test("modeSummary is the extension's own form: major, strict only when on, then the minors in order", () => {
  assert.equal(modeSummary(def("delegate", [])), "delegate");
  assert.equal(modeSummary(def("delegate", ["align", "spec"])), "delegate · align · spec");
  assert.equal(modeSummary(def("delegate", ["align"], true)), "delegate · strict · align");
});

// The footer's save-as-default covers this chat's subagent profile too.
const profiles = (currentId: string | null, defaultId: string) => ({
  current: { id: currentId, name: currentId ?? "Legacy settings", source: "pick" as const },
  default: defaultId,
});

test("'already the default' asks the profile too, and never says yes to an unknown", () => {
  const atDefault = profiles("my-setup", "my-setup");
  assert.equal(isDefaultAll(def("delegate", ["align"]), def("delegate", ["align"]), atDefault), true);
  // The mode matches but the profile doesn't: there is still something for the press to save.
  assert.equal(isDefaultAll(def("delegate", ["align"]), def("delegate", ["align"]), profiles("my-setup", "off")), false);
  // The profile matches but the mode doesn't: same.
  assert.equal(isDefaultAll(def("normal", []), def("delegate", ["align"]), atDefault), false);
  // The profiles read failed, or the chat resolves to the legacy files (no id): unknown is a button, not a done.
  assert.equal(isDefaultAll(def("delegate", ["align"]), def("delegate", ["align"]), null), false);
  assert.equal(isDefaultAll(def("delegate", ["align"]), def("delegate", ["align"]), profiles(null, "my-setup")), false);
});

test("the saved announcement names both halves of what was written", () => {
  assert.equal(savedAnnounce(def("normal", []), "My setup"), "Default saved: normal · Subagents: My setup. New sessions start here.");
  assert.equal(savedAnnounce(def("delegate", ["align"], true), null), "Default saved: delegate · strict · align. New sessions start here.");
  assert.equal(savedAnnounce(null, "My setup"), "Default saved: Subagents: My setup. New sessions start here.");
  assert.equal(savedAnnounce(null, null), "Default saved. New sessions start here.");
});

test("the picker search is a case-insensitive name match that keeps list order", () => {
  const list = [{ name: "Off" }, { name: "My setup" }, { name: "Opus everywhere" }, { name: "opus fallback" }];
  assert.deepEqual(filterProfiles(list, "").map((p) => p.name), ["Off", "My setup", "Opus everywhere", "opus fallback"]);
  assert.deepEqual(filterProfiles(list, "OPUS").map((p) => p.name), ["Opus everywhere", "opus fallback"]);
  assert.deepEqual(filterProfiles(list, "off").map((p) => p.name), ["Off"], "Off answers a search like any other row");
  assert.deepEqual(filterProfiles(list, "nothing matches this"), []);
});

test("an empty search says so and no two setup suggestions collide", () => {
  assert.equal(noProfileMatch("xyz"), "No subagent profile matches \u201cxyz\u201d.");
  assert.equal(noProfileMatch("  xyz  "), "No subagent profile matches \u201cxyz\u201d.");
  assert.deepEqual(nextSetup([]), { id: "setup-1", name: "Setup 1" });
  assert.deepEqual(nextSetup([{ id: "setup-1", name: "Setup 1" }]), { id: "setup-2", name: "Setup 2" });
  // Both checks block: a taken id and a taken name each move the suggestion on.
  assert.deepEqual(nextSetup([{ id: "setup-1", name: "Mine" }, { id: "other", name: "Setup 2" }]), { id: "setup-3", name: "Setup 3" });
  assert.deepEqual(nextSetup([{ id: "mine", name: "Setup 2" }]), { id: "setup-1", name: "Setup 1" }, "a taken name blocks only that name");
});

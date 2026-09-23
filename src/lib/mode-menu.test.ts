import assert from "node:assert/strict";
import { test } from "node:test";
import { FOOT_NOTE, isDefaultMode, modeSummary, SAVE_LABEL, SAVED_LABEL, saveLabel, saveTitle, SAVING_LABEL } from "./mode-menu";

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

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReleaseView } from "../../shared/release";
import { autoHint, countOff, groupSummary, kindLine, minutesWord, NONE_OFF, preset, presetOf, startBody, startLabel, startPanel, totalMinutes, turnedOffLine } from "./release-options";

const VIEW = {
  settings: { checks: [{ id: "release-integration", label: "Every integration group" }, { id: "release-leaks", label: "Leak scan" }] } as unknown as ReleaseView["settings"],
  manifest: {
    v: 1 as const,
    steps: [
      { id: "version", label: "Pick the version", phase: "prepare" as const },
      { id: "notes", label: "Write the notes", phase: "prepare" as const, skippable: true as const, about: "Off: one short line.", minutes: 2 },
      { id: "docs", label: "Docs pages", phase: "prepare" as const, skippable: true as const },
      { id: "commit", label: "Make the release commit", phase: "prepare" as const },
      { id: "try-live", label: "Try it on the live server", phase: "check" as const, held: true as const, skippable: true as const, minutes: 3 },
      { id: "release-page", label: "Release page", phase: "after" as const },
      { id: "unlist", label: "Mark it withdrawn", phase: "withdraw" as const },
    ],
    checks: { "release-integration": { minutes: 8.5, about: "Every group, slow ones too." }, unit: { minutes: 1.4 }, typecheck: { minutes: 0.6 } },
  },
  landingChecks: [{ id: "typecheck", label: "Typecheck" }, { id: "unit", label: "Unit tests" }],
  next: { patch: "0.17.1", minor: "0.18.0", major: "1.0.0" },
};
const P = startPanel(VIEW)!;

test("the panel lists what always runs, the steps marked skippable, the release checks and the landing checks, with their hints", () => {
  assert.deepEqual(P.always, ["Landings wait until it's published or cancelled", "Pick the version", "Make the release commit", "Publish, after your confirm", "Release page"], "withdraw steps never appear");
  assert.deepEqual(P.steps.map((s) => s.id), ["notes", "docs", "try-live"]);
  assert.deepEqual(P.steps[0], { id: "notes", label: "Write the notes", about: "Off: one short line.", minutes: 2 });
  assert.deepEqual(P.checks, [{ id: "release-integration", label: "Every integration group", about: "Every group, slow ones too.", minutes: 8.5 }, { id: "release-leaks", label: "Leak scan" }]);
  assert.deepEqual(P.landing.map((c) => c.minutes), [0.6, 1.4]);
  assert.equal(startPanel({ ...VIEW, manifest: null }), null, "no manifest: no panel");
});

test("presets: Full is nothing off, Quick is every step and release check off, anything else is custom", () => {
  assert.equal(presetOf(P, NONE_OFF), "full");
  assert.equal(presetOf(P, preset(P, "quick")), "quick");
  assert.equal(countOff(P, preset(P, "quick")), 5);
  assert.equal(presetOf(P, { steps: new Set(["docs"]), checks: new Set() }), null);
  assert.equal(presetOf(P, { steps: new Set(["not-listed"]), checks: new Set() }), "full", "an id the panel doesn't list counts for nothing");
});

test("Start's label names the kind and says Custom exactly when something is off", () => {
  assert.equal(startLabel("minor", false), "Start Minor Release");
  assert.equal(startLabel("patch", true), "Start Patch Release (Custom)");
  assert.equal(startLabel(null, false), "Start Release", "Auto names no kind");
  assert.equal(startLabel(null, true), "Start Release (Custom)");
  assert.equal(autoHint(VIEW.next), "0.17.1 or 0.18.0", "Auto: the patch or the minor the chat's rule may pick");
});

test("the total adds the landing checks and what's left on, from the figures there are", () => {
  assert.equal(totalMinutes(P, NONE_OFF), 0.6 + 1.4 + 2 + 3 + 8.5);
  assert.equal(totalMinutes(P, preset(P, "quick")), 0.6 + 1.4, "Quick: the landing checks only");
  assert.equal(totalMinutes({ ...P, landing: [], steps: [], checks: [{ id: "x", label: "x" }] }, NONE_OFF), null, "no figure at all: no total");
  assert.equal(minutesWord(0.05), "under 1 min");
  assert.equal(minutesWord(15.5), "about 16 min");
});

test("Start sends the kind and only the lists with something off, in the panel's order", () => {
  assert.deepEqual(startBody(P, "patch", NONE_OFF), { kind: "patch" });
  assert.deepEqual(startBody(P, "major", { steps: new Set(["try-live", "notes"]), checks: new Set(["release-leaks", "nope"]) }), { kind: "major", skipSteps: ["notes", "try-live"], skipChecks: ["release-leaks"] });
  assert.deepEqual(startBody(P, null, NONE_OFF), {}, "Auto (or a non-semver project) with nothing off: the empty body of a plain Start Release");
  assert.deepEqual(startBody(P, null, { steps: new Set(["docs"]), checks: new Set() }), { skipSteps: ["docs"] }, "Auto sends no kind, only what's off");
});

test("the card's lines: what its start turned off, and the kind it picked", () => {
  assert.equal(turnedOffLine({}), null);
  assert.equal(turnedOffLine({ options: { kind: "patch", skipSteps: [], skipChecks: [], off: [] } }), null);
  const off = (labels: string[]) => ({ options: { kind: null, skipSteps: [], skipChecks: [], off: labels.map((label, i) => ({ what: "step" as const, id: `s${i}`, label })) } });
  assert.equal(turnedOffLine(off(["Docs pages"])), "Turned off: Docs pages.");
  assert.equal(turnedOffLine(off(["Docs pages", "Spec replay", "Leak scan"])), "Turned off: Docs pages, Spec replay and Leak scan.");
  assert.equal(kindLine({ options: { kind: "minor", skipSteps: [], skipChecks: [], off: [] } }), "Minor release, picked at Start.");
  assert.equal(kindLine(off(["x"])), null);
});

test("a folded group's header: how many are on and their minutes, or the words of a group nothing turns off", () => {
  assert.equal(groupSummary(P.steps, NONE_OFF.steps), "3 of 3 on · about 5 min");
  assert.equal(groupSummary(P.steps, new Set(["try-live"])), "2 of 3 on · about 2 min", "minutes of what's on only");
  assert.equal(groupSummary(P.steps, preset(P, "quick").steps), "0 of 3 on", "nothing on: no figure");
  assert.equal(groupSummary(P.landing, null), "all run · about 2 min");
  assert.equal(groupSummary([{ id: "a", label: "a" }], null, "never turned off"), "never turned off", "no figure at all: the words alone");
});

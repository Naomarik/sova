import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpecSettings } from "../../shared/protocol";
import { resetSpecDraft, setSpecDraft, setSpecSaved, specDirty, specDraft } from "./spec-draft";
import { cloneSpec, sameSpec, specDraftComplete, specDraftConflict, writerFor, type SpecDraft } from "./spec-form";

const opus = { backend: "claude-code" as const, model: "opus[1m]", effort: "medium" };
const glm = { backend: "pi" as const, model: "zai/glm-5.3", effort: "high" };
const none: SpecSettings = { version: 1, writer: null };
const set: SpecSettings = { version: 1, writer: { primary: opus, fallback: glm } };

test("sameSpec: none equals none; a writer compares both slots", () => {
  assert.ok(sameSpec(none, { version: 1, writer: null }));
  assert.ok(!sameSpec(none, set));
  assert.ok(!sameSpec(set, none));
  assert.ok(sameSpec(set, cloneSpec(set)));
  assert.ok(!sameSpec(set, { version: 1, writer: { primary: opus, fallback: null } }));
  assert.ok(!sameSpec(set, { version: 1, writer: { primary: { ...opus, effort: "high" }, fallback: glm } }));
});

test("writerFor: choosing a worker picks no model; choosing none clears it", () => {
  assert.deepEqual(writerFor(true), { primary: { backend: "claude-code", model: "", effort: "" }, fallback: null });
  assert.equal(writerFor(false), null);
});

test("complete and conflict: what Save waits for", () => {
  assert.ok(specDraftComplete(none as SpecDraft), "none is complete");
  assert.ok(specDraftComplete(set as SpecDraft));
  assert.ok(!specDraftComplete({ version: 1, writer: writerFor(true) }), "a fresh worker row needs a model");
  assert.ok(!specDraftComplete({ version: 1, writer: { primary: opus, fallback: { ...glm, effort: "" } } }));
  assert.ok(!specDraftConflict(set as SpecDraft));
  assert.ok(!specDraftConflict(none as SpecDraft));
  assert.ok(specDraftConflict({ version: 1, writer: { primary: opus, fallback: { ...opus } } }));
  assert.ok(!specDraftConflict({ version: 1, writer: { primary: opus, fallback: { ...opus, model: "" } } }), "a half-chosen fallback is not a conflict yet");
});

test("the draft outlives a tab switch until the dialog resets it", () => {
  resetSpecDraft();
  assert.equal(specDirty(), false);
  setSpecSaved(none);
  assert.deepEqual(specDraft(), none, "the first load seeds the draft");
  setSpecDraft({ version: 1, writer: writerFor(true) });
  assert.equal(specDirty(), true);
  setSpecSaved(none);
  assert.notEqual(specDraft()!.writer, null, "a reload of the saved writer never overwrites a kept draft");
  setSpecSaved(set, { replaceDraft: true });
  assert.equal(specDirty(), false);
  assert.deepEqual(specDraft(), set);
  resetSpecDraft();
  assert.equal(specDraft(), null);
  assert.equal(specDirty(), false);
});

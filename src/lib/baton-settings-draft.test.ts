import assert from "node:assert/strict";
import { test } from "node:test";
import { MB, MESSAGES_CAP, PHOTO_DEFAULTS } from "../../shared/baton";
import { parseLimit, setBatonDraft, setBatonSaved } from "./baton-settings-draft";
import { dirtyForms, invalidForms, resetAllDrafts, saveAllDrafts } from "./settings-draft";

test("a typed message limit: whole numbers within the shared bounds only", () => {
  assert.equal(parseLimit("60"), 60);
  assert.equal(parseLimit(" 1 "), 1);
  assert.equal(parseLimit(String(MESSAGES_CAP)), MESSAGES_CAP);
  for (const bad of ["", "0", "-5", "2.5", "1e2", "abc", String(MESSAGES_CAP + 1)]) assert.equal(parseLimit(bad), null, bad);
});

const form = (patch: Partial<{ messagesMax: string; photosOn: boolean; perMessage: string; mb: string; perConversation: string; fileMb: string }> = {}) => ({
  messagesMax: "60",
  photosOn: true,
  perMessage: "4",
  mb: "5",
  perConversation: "40",
  fileMb: "25",
  ...patch,
});

test("the limit saves from the dialog's footer: a dirty edit is listed, an invalid one holds Save and is named", async () => {
  setBatonSaved({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS }, files: { maxBytes: 25 * MB } });
  setBatonDraft(form({ messagesMax: "45" }));
  assert.deepEqual(dirtyForms().map((f) => f.label), ["Organizations"]);
  assert.deepEqual(invalidForms(), []);
  setBatonDraft(form({ messagesMax: "0" }));
  assert.equal(invalidForms()[0]?.problem(), "Organizations needs a message limit from 1 to 1,000.");
  assert.deepEqual(await saveAllDrafts(), { saved: [], failed: [] }, "nothing is written while a dirty form is invalid");
  resetAllDrafts();
  assert.deepEqual(dirtyForms(), []);
});

test("photo limits: the saved settings read back as the form, and a number outside its range holds Save", async () => {
  setBatonSaved({ messagesMax: 60, photos: { enabled: true, perMessage: 4, maxBytes: 5 * MB, perConversation: 40 }, files: { maxBytes: 25 * MB } });
  setBatonDraft(form());
  assert.deepEqual(dirtyForms(), [], "the defaults read back unchanged");
  setBatonDraft(form({ photosOn: false }));
  assert.deepEqual(dirtyForms().map((f) => f.label), ["Organizations"]);
  for (const bad of [{ perMessage: "9" }, { mb: "0" }, { mb: "11" }, { perConversation: "201" }, { perMessage: "2.5" }]) {
    setBatonDraft(form(bad));
    assert.equal(invalidForms()[0]?.problem(), "Organizations needs photo limits within their ranges.", JSON.stringify(bad));
  }
  resetAllDrafts();
});

test("the largest file (§app.baton/files): reads back as the form, and outside 1–25 MB holds Save", () => {
  setBatonSaved({ messagesMax: 60, photos: { ...PHOTO_DEFAULTS }, files: { maxBytes: 25 * MB } });
  setBatonDraft(form());
  assert.deepEqual(dirtyForms(), [], "25 MB reads back unchanged");
  setBatonDraft(form({ fileMb: "10" }));
  assert.deepEqual(dirtyForms().map((f) => f.label), ["Organizations"]);
  for (const bad of ["0", "26", "2.5", ""]) {
    setBatonDraft(form({ fileMb: bad }));
    assert.equal(invalidForms()[0]?.problem(), "Organizations needs a largest file from 1 to 25 MB.", bad);
  }
  resetAllDrafts();
});

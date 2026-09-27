import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGES_CAP } from "../../shared/baton";
import { parseLimit, setBatonDraft, setBatonSaved } from "./baton-settings-draft";
import { dirtyForms, invalidForms, resetAllDrafts, saveAllDrafts } from "./settings-draft";

test("a typed message limit: whole numbers within the shared bounds only", () => {
  assert.equal(parseLimit("60"), 60);
  assert.equal(parseLimit(" 1 "), 1);
  assert.equal(parseLimit(String(MESSAGES_CAP)), MESSAGES_CAP);
  for (const bad of ["", "0", "-5", "2.5", "1e2", "abc", String(MESSAGES_CAP + 1)]) assert.equal(parseLimit(bad), null, bad);
});

test("the limit saves from the dialog's footer: a dirty edit is listed, an invalid one holds Save and is named", async () => {
  setBatonSaved({ messagesMax: 60 });
  setBatonDraft("45");
  assert.deepEqual(dirtyForms().map((f) => f.label), ["Organizations"]);
  assert.deepEqual(invalidForms(), []);
  setBatonDraft("0");
  assert.equal(invalidForms()[0]?.problem(), "Organizations needs a message limit from 1 to 1,000.");
  assert.deepEqual(await saveAllDrafts(), { saved: [], failed: [] }, "nothing is written while a dirty form is invalid");
  resetAllDrafts();
  assert.deepEqual(dirtyForms(), []);
});

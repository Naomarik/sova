import { test } from "node:test";
import assert from "node:assert/strict";
import { replacedNotice } from "./subagent-replaced";

// Local wall times, so the 12-hour stamp reads the same in every time zone.
const at = new Date(2026, 9, 11, 14, 1).getTime();
const now = new Date(2026, 9, 11, 16, 0).getTime();

test("a copy that changed or removed a profile reads as a replacement, naming the device, the time and what changed", () => {
  const n = replacedNotice({ file: "f", at, by: "Zen", changes: { added: ["Fast"], changed: ["Deep"], removed: ["Old"] } }, now);
  assert.equal(n.title, "Replaced by Zen's copy at 2:01 PM.");
  assert.equal(n.body, "Added Fast; changed Deep; removed Old. Your previous library is kept on this device.");
});

test("a copy that only added profiles says what it added, in the title alone", () => {
  const n = replacedNotice({ file: "f", at, by: "Zen", changes: { added: ["Fast", "Cheap"], changed: [], removed: [] } }, now);
  assert.equal(n.title, "Zen's copy added Fast, Cheap at 2:01 PM.");
  assert.equal(n.body, "Your previous library is kept on this device.");
});

test("a kept copy with no change list still names the device; a stamp from another day carries its date", () => {
  const n = replacedNotice({ file: "f", at, by: "A Person" }, now + 24 * 3600_000);
  assert.equal(n.title, "Replaced by A Person's copy at Oct 11 2:01 PM.");
  assert.equal(n.body, "Your previous library is kept on this device.");
});

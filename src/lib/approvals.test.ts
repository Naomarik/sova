import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideAll,
  flipTo,
  groupDoneLine,
  groupFlip,
  groupState,
  isOn,
  itemsPhrase,
  markOf,
  newOffPhrase,
  offInChatLine,
  onPhrase,
  overseerButtonWords,
  PARTIAL_FINGERPRINT_LINE,
  seenNewToSettle,
  SETTING_LABEL,
  type Approval,
} from "./approvals";

const ALL: Approval[] = ["approved", "disallowed", "waiting", "changed"];
const items = (approvals: Approval[]) => approvals.map((a, i) => ({ kind: "skill" as const, key: `k${i}`, approval: a }));

test("on and off per mode: new items start on (no record is on) or off (only what was turned on is on)", () => {
  assert.deepEqual(ALL.map((a) => isOn(a, false)), [true, false, true, true], "start on: everything but a turned-off item");
  assert.deepEqual(ALL.map((a) => isOn(a, true)), [true, false, false, true], "start off: an item nobody set is off; a changed one stays on");
});

test("marks: New and Changed only while new items start off; never while they start on", () => {
  assert.deepEqual(ALL.map((a) => markOf(a, true)), [null, null, "new", "changed"]);
  assert.deepEqual(ALL.map((a) => markOf(a, false)), [null, null, null, null]);
});

test("one flip: turning on approves while new items start off, and only lifts the Disallow while they start on", () => {
  assert.equal(flipTo(true, true), "approved");
  assert.equal(flipTo(true, false), "waiting");
  assert.equal(flipTo(false, true), "disallowed");
  assert.equal(flipTo(false, false), "disallowed");
});

test("a group switch reads on, off, or mixed from its rows", () => {
  assert.equal(groupState(items(["approved", "changed"]), true), "on");
  assert.equal(groupState(items(["disallowed", "waiting"]), true), "off");
  assert.equal(groupState(items(["approved", "waiting"]), true), "mixed");
  assert.equal(groupState(items(["waiting", "approved"]), false), "on", "start on: an unset item is on");
  assert.equal(groupState([], true), "off");
});

test("a group press: from off or mixed every row on, from on every row off; the save names only rows that change", () => {
  const mixed = items(["approved", "changed", "waiting", "disallowed"]);
  const up = groupFlip(mixed, true);
  assert.equal(up.on, true);
  assert.equal(up.to, "approved");
  // An approved row, and a changed one, are left out: a group press never accepts a change.
  assert.deepEqual(up.rows.map((r) => r.approval), ["waiting", "disallowed"]);
  const upLoose = groupFlip(mixed, false);
  assert.equal(upLoose.to, "waiting", "start on: turning on only lifts the Disallow");
  assert.deepEqual(upLoose.rows.map((r) => r.approval), ["disallowed"]);
  const down = groupFlip(items(["approved", "changed"]), true);
  assert.equal(down.on, false);
  assert.equal(down.to, "disallowed");
  assert.deepEqual(down.rows.map((r) => r.approval), ["approved", "changed"]);
  assert.deepEqual(decideAll(down.rows, down.to), { k0: "disallowed", k1: "disallowed" });
});

test("the words: a group press's line, the folded count, the setting, the Overseer's button, a running chat's line", () => {
  assert.equal(groupDoneLine(6, "skill", false), "Turned 6 skills off.");
  assert.equal(groupDoneLine(1, "context", true), "Turned 1 context file on.");
  assert.equal(newOffPhrase(2), "2 new, off");
  assert.equal(onPhrase(3, 1), "3 files, 1 skill on");
  assert.equal(SETTING_LABEL, "New context files and skills start on");
  assert.equal(overseerButtonWords(2), "2 new, off");
  assert.equal(overseerButtonWords(0), "Context Files and Skills");
  assert.equal(offInChatLine("AGENTS.md", "project"), "AGENTS.md wasn't loaded: it is off for this project.");
  assert.equal(itemsPhrase(2, 1), "2 context files and 1 skill");
});

test("a first message settles only the New rows the open list showed, and only while new items start off", () => {
  const rows = items(["waiting", "waiting", "approved", "disallowed"]);
  assert.deepEqual(seenNewToSettle(new Set(["k0", "k2", "k3"]), rows, true).map((r) => r.key), ["k0"], "shown and still New");
  assert.deepEqual(seenNewToSettle(new Set(["k0"]), rows, false), [], "start on: nothing is New");
});

test("a skill folder that can't be fully fingerprinted says so and why, never that a change goes unnoticed", () => {
  assert.equal(PARTIAL_FINGERPRINT_LINE, "Not fully checked for changes: the folder is very large, or holds links or files Sova can't read.");
  assert.ok(!/unnoticed|aren't noticed|missed/.test(PARTIAL_FINGERPRINT_LINE));
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { CHECK_EVERY_MS, checksOffIn, DEFAULT_SETTINGS, nextCheckDue, parseSource, readUpdatesFile, RETRY_AFTER_MS, validBranchName, writeUpdatesFile } from "./state";

/** updates.json and the daily cadence. */

const T0 = Date.parse("2026-10-14T12:00:00Z");

test("a missing or unreadable updates.json is the defaults: Stable, checks on, upgrades off", () => {
  const dir = scratchRoot("updates-state-");
  const file = join(dir, "updates.json");
  assert.deepEqual(readUpdatesFile(file), { ...DEFAULT_SETTINGS, lastCheck: null, lastUpgrade: null });
  writeFileSync(file, "{not json");
  assert.deepEqual(readUpdatesFile(file), { ...DEFAULT_SETTINGS, lastCheck: null, lastUpgrade: null });
  writeFileSync(file, JSON.stringify({ source: { kind: "branch", branch: "a..b" }, autoCheck: "yes", autoUpgrade: 1 }));
  const f = readUpdatesFile(file);
  assert.deepEqual([f.source, f.autoCheck, f.autoUpgrade], [{ kind: "stable" }, true, false], "an unreadable field is that field's default");
});

test("the last check's time survives a restart: a server started within the day waits for the rest of it", () => {
  const dir = scratchRoot("updates-state-");
  const file = join(dir, "updates.json");
  const checkedAt = T0 - 3 * 60 * 60 * 1000; // 3 hours before this "boot"
  writeUpdatesFile(file, { ...DEFAULT_SETTINGS, lastCheck: { at: new Date(checkedAt).toISOString(), ok: true, source: { kind: "stable" }, head: "a".repeat(40), result: { state: "up-to-date" } }, lastUpgrade: null });
  // A new process reads the file afresh: due a day after the last check, not now.
  const reread = readUpdatesFile(file);
  assert.equal(nextCheckDue(reread, false, T0), checkedAt + CHECK_EVERY_MS);
  assert.ok(nextCheckDue(reread, false, T0)! > T0, "not due at boot");
  // Past the day it is due at once.
  assert.equal(nextCheckDue(reread, false, checkedAt + CHECK_EVERY_MS + 1), checkedAt + CHECK_EVERY_MS);
});

test("no check yet: due now; a failed check: an hour later; the checkbox off or checks off: never", () => {
  assert.equal(nextCheckDue({ autoCheck: true, lastCheck: null }, false, T0), T0);
  const failed = { at: new Date(T0).toISOString(), ok: false, source: { kind: "stable" as const }, head: null, error: "Couldn't reach" };
  assert.equal(nextCheckDue({ autoCheck: true, lastCheck: failed }, false, T0), T0 + RETRY_AFTER_MS);
  assert.equal(nextCheckDue({ autoCheck: false, lastCheck: null }, false, T0), null);
  assert.equal(nextCheckDue({ autoCheck: true, lastCheck: null }, true, T0), null);
  // A last check in the future (a clock set back) counts from now.
  const future = { ...failed, ok: true, at: new Date(T0 + 5 * CHECK_EVERY_MS).toISOString() };
  assert.equal(nextCheckDue({ autoCheck: true, lastCheck: future }, false, T0), T0 + CHECK_EVERY_MS);
});

test("SOVA_UPDATES_CHECK=off stops checks; a test process never checks unless it says on", () => {
  assert.equal(checksOffIn({ SOVA_UPDATES_CHECK: "off" }), true);
  assert.equal(checksOffIn({ SOVA_UPDATES_CHECK: "0" }), true);
  assert.equal(checksOffIn({}), false);
  assert.equal(checksOffIn({ NODE_ENV: "test" }), true);
  assert.equal(checksOffIn({ NODE_TEST_CONTEXT: "child" }), true);
  assert.equal(checksOffIn({ NODE_ENV: "test", SOVA_UPDATES_CHECK: "on" }), false);
});

test("a source is Stable, master or a branch name git takes", () => {
  assert.deepEqual(parseSource({ kind: "stable" }), { kind: "stable" });
  assert.deepEqual(parseSource({ kind: "master" }), { kind: "master" });
  assert.deepEqual(parseSource({ kind: "branch", branch: " feat/updates " }), { kind: "branch", branch: "feat/updates" });
  assert.equal(parseSource({ kind: "fork", url: "https://github.com/someone/sova" }), null, "no other repository, ever");
  for (const bad of ["", "-x", "a..b", "a b", "a~1", "x.lock", "/x", "x/", "a//b", ".hidden", "a/.b", "@", "a@{1}", "a:b"]) assert.equal(validBranchName(bad), false, bad);
  for (const good of ["master", "feat/updates", "release-1.2", "a_b/c-d"]) assert.equal(validBranchName(good), true, good);
});

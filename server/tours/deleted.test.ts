import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "./assets";
import { isTourSessionDeleted, markTourSessionDeleted, tourSessionDeletionStatus } from "./deleted";

test("a durable deletion barrier is synchronous, scoped and idempotent without retaining raw identity", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-deleted-"));
  try {
    const session = "deleted-chat-fixture";
    assert.equal(tourSessionDeletionStatus(root, session), "not-deleted");
    assert.equal(isTourSessionDeleted(root, session), false);
    markTourSessionDeleted(root, session);
    assert.equal(tourSessionDeletionStatus(root, session), "deleted");
    assert.equal(isTourSessionDeleted(root, session), true);
    assert.equal(isTourSessionDeleted(root, "retained-chat-fixture"), false);
    markTourSessionDeleted(root, session);
    const dir = join(root, "tour-deleted"), files = readdirSync(dir);
    assert.deepEqual(files, [`${digest(session)}.json`]);
    const path = join(dir, files[0]!);
    assert.equal(readFileSync(path, "utf8"), "{\"v\":1}\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    // A newly opened module/process needs only the persisted marker, not a runtime's in-memory set.
    assert.equal(isTourSessionDeleted(root, session), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed or symlinked deletion markers fail closed and are never repaired or followed", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-deleted-corrupt-"));
  try {
    const session = "deleted-chat-fixture", dir = join(root, "tour-deleted"), path = join(dir, `${digest(session)}.json`);
    mkdirSync(dir);
    writeFileSync(path, "corrupt marker");
    assert.equal(tourSessionDeletionStatus(root, session), "deleted", "regular marker presence, not its parse result, is authority");
    assert.equal(isTourSessionDeleted(root, session), true);
    markTourSessionDeleted(root, session);
    assert.equal(readFileSync(path, "utf8"), "corrupt marker", "no force repair");
    rmSync(path);
    const outside = join(root, "unrelated.txt");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, path);
    assert.equal(tourSessionDeletionStatus(root, session), "unknown", "unsafe marker denial cannot authorize destructive cleanup");
    assert.equal(isTourSessionDeleted(root, session), true);
    assert.throws(() => markTourSessionDeleted(root, session), /symlink/);
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    assert.equal(tourSessionDeletionStatus(root, "../invalid"), "unknown");
    assert.equal(isTourSessionDeleted(root, "../invalid"), true);
    assert.throws(() => markTourSessionDeleted(root, "../invalid"), /Invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symlinked deletion directory never grants permission or writes through the link", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-deleted-directory-"));
  try {
    const outside = join(root, "unrelated"); mkdirSync(outside);
    symlinkSync(outside, join(root, "tour-deleted"));
    assert.equal(tourSessionDeletionStatus(root, "deleted-chat-fixture"), "unknown");
    assert.equal(isTourSessionDeleted(root, "deleted-chat-fixture"), true);
    assert.throws(() => markTourSessionDeleted(root, "deleted-chat-fixture"), /symlink/);
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nonregular markers and failed marker-path traversal deny access without authorizing deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-deleted-unknown-"));
  try {
    const id = "retained-chat-fixture", dir = join(root, "tour-deleted"), path = join(dir, `${digest(id)}.json`);
    mkdirSync(path, { recursive: true });
    assert.equal(tourSessionDeletionStatus(root, id), "unknown", "a marker directory is not a deletion receipt");
    assert.equal(isTourSessionDeleted(root, id), true);
    rmSync(dir, { recursive: true }); writeFileSync(dir, "not a directory");
    assert.equal(tourSessionDeletionStatus(root, id), "unknown", "ENOTDIR differs from an absent marker, independent of uid privileges");
    assert.equal(isTourSessionDeleted(root, id), true);
    assert.equal(readFileSync(dir, "utf8"), "not a directory", "status never repairs private state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

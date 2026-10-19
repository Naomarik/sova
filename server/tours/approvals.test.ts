import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TourApprovalStore } from "./approvals";

test("site approval is exact scheme, host and effective port, includes loopback, persists and revokes", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-approval-"));
  try {
    const store = new TourApprovalStore(root);
    const approved = "http://localhost:9000";
    assert.equal(store.isApproved(approved), false, "loopback never auto-approved");
    store.approve(approved); store.approve(approved);
    assert.deepEqual(new TourApprovalStore(root).list(), [approved]);
    for (const different of ["http://localhost:9001", "https://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000"]) assert.equal(store.isApproved(different), false, different);
    store.revoke(approved); assert.equal(new TourApprovalStore(root).isApproved(approved), false);
    store.approve("https://example.test"); assert.equal(store.isApproved("https://example.test"), true);
    for (const bad of ["https://example.test/", "https://example.test:443", "https://user:secret@example.test", "file:///page", "http://localhost:9000/private"]) assert.throws(() => store.approve(bad), /exact HTTP/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only a verified project's exact current origin is exempt, not other loopback or declared sites", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-approval-"));
  try {
    const store = new TourApprovalStore(root);
    assert.deepEqual(store.missing(["http://localhost:9000", "http://localhost:9001", "https://example.test"], "http://localhost:9000"), ["http://localhost:9001", "https://example.test"]);
    assert.deepEqual(store.missing(["http://localhost:9000"]), ["http://localhost:9000"]);
    store.approve("https://example.test"); assert.deepEqual(store.missing(["https://example.test"]), []);
    // A second store sees revocation; no per-job/store cached approval can outlive it.
    new TourApprovalStore(root).revoke("https://example.test"); assert.deepEqual(store.missing(["https://example.test"]), ["https://example.test"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("damaged approval state fails closed instead of silently remembering or replacing consent", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-approval-"));
  try {
    writeFileSync(join(root, "origins.json"), JSON.stringify({ v: 1, origins: ["https://example.test/"] }));
    const store = new TourApprovalStore(root);
    assert.throws(() => store.isApproved("https://example.test"), /could not be read/);
    assert.throws(() => store.approve("https://different.test"), /could not be read/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

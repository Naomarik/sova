import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tourEditionAssetsFixture, tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { projectTourPublic, TOUR_LIMITS } from "../../shared/tour";
import { scratchRoot } from "../test-scratch";
import { TourPrivateStore, type TourPrivateAttempt } from "./private";

test("submitted script, report, receipts and contact sheets survive private store reopen but never project publicly", () => {
  const root = scratchRoot("tour-private-");
  try {
    const store = new TourPrivateStore(join(root, "private"));
    const script = tourScriptFixture(); script.audience = "PRIVATE_AUTHORING_AUDIENCE";
    const manifest = tourManifestFixture(); manifest.check.notes = "PRIVATE_CHECK_RECEIPT";
    const attempt: TourPrivateAttempt = { v: 1, sessionId: "chat-a", jobId: "job-a", tourId: manifest.id, script, mode: "record", dryRunPassed: true, manifest, suspicious: ["phone.png"], receipts: ["contact-sheet.png"], publicOrigins: ["https://attested.example.test"] };
    store.save(attempt);
    for (const [file, bytes] of tourEditionAssetsFixture()) store.writeImage("chat-a", "job-a", file, bytes);
    const reopened = new TourPrivateStore(store.root);
    assert.deepEqual(reopened.read("chat-a", "job-a"), attempt);
    assert.ok(reopened.readImage("chat-a", "job-a", "contact-sheet.png"));
    assert.equal(reopened.read("chat-b", "job-a"), null);
    assert.equal(reopened.readImage("chat-b", "job-a", "contact-sheet.png"), null);
    const projection = projectTourPublic(reopened.read("chat-a", "job-a")!.manifest!, { id: "public-tour", editionId: "public-edition" });
    const json = JSON.stringify(projection);
    for (const secret of ["PRIVATE_AUTHORING_AUDIENCE", "PRIVATE_CHECK_RECEIPT", "contact-sheet.png", "receipts", "suspicious", "scriptDigest", "check", "publicOrigins", "https://attested.example.test"]) assert.ok(!json.includes(secret), secret);
    assert.deepEqual(projection.assets.map(a => a.file), ["desktop.png", "phone.png"]);
    assert.equal(lstatSync(join(root, "private", "chat-a", "job-a", "attempt.json")).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(root, "private", "chat-a", "job-a")).mode & 0o777, 0o700);
    // Completion does not delete anything; only explicit chat deletion releases it.
    reopened.removeSession("chat-a"); assert.equal(reopened.read("chat-a", "job-a"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("private record-time attestations reject malformed, duplicate and oversized origins", () => {
  const root = scratchRoot("tour-private-attestation-");
  try {
    const store = new TourPrivateStore(join(root, "private"));
    const attempt: TourPrivateAttempt = { v: 1, sessionId: "chat-a", jobId: "job-a", tourId: "tour-a", script: tourScriptFixture(), mode: "record", suspicious: [], receipts: [] };
    for (const publicOrigins of [["https://attested.example.test/path"], ["https://attested.example.test", "https://attested.example.test"], Array.from({ length: 65 }, (_, i) => `https://host${i}.example.test`)]) {
      assert.throws(() => store.save({ ...attempt, publicOrigins }), /Invalid private recording artifact/);
    }
    store.save({ ...attempt, publicOrigins: ["https://attested.example.test"] });
    assert.deepEqual(store.read("chat-a", "job-a")?.publicOrigins, ["https://attested.example.test"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Change 1440 to 1439 pixels: the 1-bit raster still uses the same row byte count.
// Recompute IHDR's CRC so this is a different valid PNG, not a malformed-header rejection.
function alternatePng(bytes: Uint8Array): Buffer {
  const altered = Buffer.from(bytes); altered.writeUInt32BE(1439, 16);
  let crc = 0xffffffff;
  for (const byte of altered.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  altered.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return altered;
}
for (const corruption of ["same-sized-valid-png-hash", "truncated", "oversize", "symlink"] as const) {
  test(`private picture inventory rejects ${corruption} independently`, () => {
    const root = scratchRoot("tour-private-corruption-");
    try {
      const store = new TourPrivateStore(join(root, "private")), manifest = tourManifestFixture();
      const attempt: TourPrivateAttempt = { v: 1, sessionId: "chat-a", jobId: "job-a", tourId: manifest.id, script: tourScriptFixture(), mode: "record", manifest, suspicious: [], receipts: [] };
      store.save(attempt);
      const bytes = tourEditionAssetsFixture().get("desktop.png")!;
      store.writeImage("chat-a", "job-a", "desktop.png", bytes);
      assert.ok(store.readImage("chat-a", "job-a", "desktop.png"), "positive control before isolated corruption");
      const path = join(store.root, "chat-a", "job-a", "pictures", "desktop.png");
      if (corruption === "same-sized-valid-png-hash") {
        const replacement = alternatePng(bytes);
        assert.equal(replacement.length, bytes.length);
        assert.deepEqual(replacement.subarray(0, 8), Buffer.from(bytes).subarray(0, 8));
        assert.notDeepEqual(replacement, Buffer.from(bytes));
        writeFileSync(path, replacement);
      } else if (corruption === "truncated") truncateSync(path, bytes.length - 1);
      else if (corruption === "oversize") truncateSync(path, TOUR_LIMITS.assetBytes + 1);
      else {
        // The target is the exact valid, hash-matching PNG: only no-follow containment rejects it.
        const outside = join(root, "outside-picture.png"); writeFileSync(outside, bytes);
        rmSync(path); symlinkSync(outside, path);
      }
      assert.equal(new TourPrivateStore(store.root).readImage("chat-a", "job-a", "desktop.png"), null);
      assert.throws(() => store.images(attempt), /inventory is incomplete/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("private artifact readers reject traversal and symlinked pictures", () => {
  const root = scratchRoot("tour-private-paths-");
  try {
    const store = new TourPrivateStore(join(root, "private"));
    const manifest = tourManifestFixture();
    store.save({ v: 1, sessionId: "chat-a", jobId: "job-a", tourId: manifest.id, script: tourScriptFixture(), mode: "record", manifest, suspicious: [], receipts: [] });
    const [file, bytes] = [...tourEditionAssetsFixture()][0]!;
    store.writeImage("chat-a", "job-a", file, bytes);
    const path = join(root, "private", "chat-a", "job-a", "pictures", file);
    writeFileSync(path, Buffer.from("private-file-substitution"));
    assert.equal(store.readImage("chat-a", "job-a", file), null);
    rmSync(path); symlinkSync(join(root, "private", "chat-a", "job-a", "attempt.json"), path);
    assert.equal(store.readImage("chat-a", "job-a", file), null);
    assert.equal(store.readImage("chat-a", "job-a", "../attempt.json"), null);
    assert.equal(store.read("../chat-a", "job-a"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

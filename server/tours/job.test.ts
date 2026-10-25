import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TourJobStore, readPrivateTourJson, writePrivateTourJson } from "./job";
import type { TourJob } from "../../shared/tour";
const job = (id: string, phase: TourJob["phase"]): TourJob => ({ v: 1, id, tourId: "tour", sessionId: "session", title: "Example", phase, completed: 0, total: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

test("job persistence is private, validated, session-neutral storage and recovery keeps completed editions", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-job-"));
  try {
    const store = new TourJobStore(root);
    const ready = store.save({ ...job("ready", "ready"), editionId: "edition" });
    store.save({ ...job("waiting", "queued"), queuePosition: 1 }); store.save(job("working", "recording")); store.save(job("cancelled", "cancelled"));
    const checking = store.save(job("checking", "checking"));
    store.save({ ...job("consent", "needs-site-approval"), requirements: { origins: ["https://example.test"] } });
    const recovered = new TourJobStore(root).recover();
    assert.deepEqual(recovered.find(j => j.id === "checking"), checking, "a finished capture awaiting its check is kept as it was");
    assert.equal(recovered.find(j => j.id === "consent")!.phase, "interrupted", "a blocked request lost its task: interrupted, never replayed");
    assert.deepEqual(recovered.find(j => j.id === "ready"), ready);
    assert.equal(recovered.find(j => j.id === "cancelled")!.phase, "cancelled");
    for (const id of ["waiting", "working"]) { const j = recovered.find(j => j.id === id)!; assert.equal(j.phase, "interrupted"); assert.equal(j.queuePosition, undefined); }
    assert.equal(store.get("../ready"), null);
    if (process.platform !== "win32") {
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(join(root, "ready.json")).mode & 0o777, 0o600);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deleting a session removes only its own persisted jobs, including completed references", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-job-"));
  try {
    const store = new TourJobStore(root);
    store.save({ ...job("source-ready", "ready"), editionId: "source-edition" });
    store.save(job("source-waiting", "queued"));
    const destination = store.save({ ...job("destination-ready", "ready"), sessionId: "destination-session", editionId: "destination-owned-edition" });
    writeFileSync(join(root, "origins.json"), JSON.stringify({ v: 1, origins: ["https://example.test"] }));
    store.removeSession("session");
    assert.equal(store.get("source-ready"), null); assert.equal(store.get("source-waiting"), null);
    assert.deepEqual(new TourJobStore(root).get(destination.id), destination);
    assert.deepEqual(store.list(), [destination]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "origins.json"), "utf8")), { v: 1, origins: ["https://example.test"] }, "shared state is not removed by a directory-wide delete");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one failed job-file removal does not skip the other matching files or touch another session", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-job-"));
  try {
    const store = new TourJobStore(root);
    store.save(job("a-blocked", "cancelled")); store.save(job("b-removable", "cancelled"));
    const other = store.save({ ...job("other", "ready"), sessionId: "other-session", editionId: "other-edition" });
    const listed = store.list();
    // Deterministic concurrent-filesystem failure after listing, with no permissions/root assumptions.
    rmSync(join(root, "a-blocked.json")); mkdirSync(join(root, "a-blocked.json"));
    store.list = () => listed;
    assert.throws(() => store.removeSession("session"), AggregateError);
    assert.equal(store.get("b-removable"), null, "first failure cannot strand remaining deleted-chat jobs");
    assert.deepEqual(store.get(other.id), other);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("jobs reject credentials, source payloads and unknown fields rather than serializing them", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-job-"));
  try {
    const store = new TourJobStore(root);
    assert.throws(() => store.save({ ...job("secret", "queued"), password: "test-secret" } as TourJob), /Invalid tour job/);
    assert.throws(() => store.save({ ...job("secret", "queued"), context: { cookies: "test-secret" } } as TourJob), /Invalid tour job/);
    assert.equal(store.get("secret"), null);
    store.save(job("good", "failed"));
    assert.ok(!readFileSync(join(root, "good.json"), "utf8").includes("test-secret"));
    writeFileSync(join(root, "broken.json"), "bad json"); assert.equal(store.get("broken"), null);
    writeFileSync(join(root, "mismatch.json"), JSON.stringify(job("different", "failed"))); assert.equal(store.get("mismatch"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private state refuses symlink reads and atomic replacements never write through symlinks", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tour-job-"));
  try {
    const target = join(root, "target"); writeFileSync(target, "untouched"); symlinkSync(target, join(root, "link.json"));
    assert.throws(() => readPrivateTourJson(root, "link.json"));
    writePrivateTourJson(root, "link.json", { safe: true });
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.deepEqual(readPrivateTourJson(root, "link.json"), { safe: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tourEditionAssetsFixture, tourEditionFixture } from "../../shared/tour-fixtures";
import { TourStore } from "./store";
import { TourShares } from "./shares";
import { TourJobStore } from "./job";
import { TourPrivateStore } from "./private";
import { markTourSessionDeleted } from "./deleted";
import { startTourSweep, sweepMissingTourOwners, tourOwnerStates } from "./sweep";
import { forgetTourOwner, readKnownTourOwner, rememberTourOwner, scanTourOwnerFiles, tourOwnerPath } from "./ownership";
import { extraSessionRoots, setExtraSessionRoots, SESSIONS_DIR } from "../paths";
import { digest } from "./assets";
import { randomUUID } from "node:crypto";
import { stateRoot } from "../state-root";

const at = "2026-01-02T03:04:05.000Z";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "tour-sweep-")), state = join(root, "state"), sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const store = new TourStore(join(state, "tours")), shares = new TourShares(state, store), jobs = new TourJobStore(join(state, "tour-jobs"));
  const publish = (id: string) => { const e = tourEditionFixture(); e.sessionId = id; store.publishEdition(e, tourEditionAssetsFixture()); return e; };
  const header = (id: string, headerId = id) => writeFileSync(join(sessions, `fixture_${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id: headerId, timestamp: at, cwd: root }) + "\n");
  const knownAbsent = async (id: string) => { header(id); assert.equal(await rememberTourOwner(id, join(sessions, `fixture_${id}.jsonl`), { root: state, sessionRoots: [{ path: sessions, flat: true }] }), true); unlinkSync(join(sessions, `fixture_${id}.jsonl`)); };
  const cleanup = async (id: string) => { markTourSessionDeleted(state, id); shares.deleteSession(id); jobs.removeSession(id); new TourPrivateStore(join(state, "tour-private")).removeSession(id); store.deleteSession(id); forgetTourOwner(id, state); };
  return { root, state, sessions, store, shares, jobs, publish, header, knownAbsent, cleanup, options: { root: state, sessionRoots: [{ path: sessions, flat: true }], cleanup, warning: () => {} }, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("sweep unions source/share/private/job candidates, preserves zero-input owners and reusable shared state", async () => {
  const f = setup(); try {
    f.publish("retained-husk"); f.header("retained-husk");
    f.publish("source-only"); await f.knownAbsent("source-only");
    const e = f.publish("share-only"), preview = f.shares.previewFor(e), made = f.shares.create(e.sessionId, e.manifest.id, e.manifest.editionId, preview.previewId, new Date(Date.now() + 60_000).toISOString());
    f.store.deleteSession("share-only"); await f.knownAbsent("share-only");
    mkdirSync(join(f.state, "tour-private", "private-only", "attempt"), { recursive: true }); await f.knownAbsent("private-only");
    f.jobs.save({ v: 1, id: "orphan-job", tourId: "tour-orphan", sessionId: "job-only", title: "Queued recording", phase: "queued", completed: 0, total: 2, createdAt: at, updatedAt: at });
    await f.knownAbsent("job-only");
    mkdirSync(join(f.state, "tour-accounts"), { recursive: true }); writeFileSync(join(f.state, "tour-accounts", "keep.json"), "shared test-account state");
    mkdirSync(join(f.state, "tour-approvals"), { recursive: true }); writeFileSync(join(f.state, "tour-approvals", "origins.json"), "shared origin approvals");
    const removed: string[] = [];
    const result = await sweepMissingTourOwners({ ...f.options, cleanup: async id => { removed.push(id); await f.cleanup(id); } });
    assert.deepEqual(new Set(removed), new Set(["source-only", "share-only", "private-only", "job-only"]));
    assert.equal(result.removed, 4); assert.equal(result.failed, 0); assert.equal(result.unknown, 0);
    assert.ok(f.store.latestEdition("retained-husk", "tour-demo"), "a header-only retained chat is not a sidebar-filtered orphan");
    assert.equal(f.shares.access(made.token), null); assert.equal(existsSync(join(f.state, "tour-share-snapshots", `${made.link.id}.json`)), false);
    assert.equal(f.jobs.list().length, 0); assert.equal(existsSync(join(f.state, "tour-private", "private-only")), false);
    assert.ok(existsSync(join(f.state, "tour-accounts", "keep.json"))); assert.ok(existsSync(join(f.state, "tour-approvals", "origins.json")));
  } finally { f.close(); }
});
test("incomplete listings and corrupt or identity-reused headers are UNKNOWN, never destructive absence", async () => {
  const f = setup(); try {
    f.publish("ambiguous"); f.publish("corrupt"); f.publish("reused");
    writeFileSync(join(f.sessions, "fixture_corrupt.jsonl"), "not JSON\n"); f.header("reused", "another-chat");
    const notDirectory = join(f.root, "unreadable-root"); writeFileSync(notDirectory, "not a directory");
    const roots = [{ path: f.sessions, flat: true }, { path: notDirectory, flat: true }];
    const states = await tourOwnerStates(["ambiguous", "corrupt", "reused"], roots);
    assert.deepEqual([...states.values()], ["unknown", "unknown", "unknown"]);
    let removals = 0;
    const result = await sweepMissingTourOwners({ ...f.options, sessionRoots: roots, cleanup: async () => { removals++; } });
    assert.equal(removals, 0); assert.equal(result.unknown, 3); assert.ok(f.store.latestEdition("ambiguous", "tour-demo"));
  } finally { f.close(); }
});
test("retained editions survive live and broken owner JSONL symlinks instead of becoming confirmed orphans", async () => {
  for (const broken of [false, true]) {
    const f = setup(); try {
      const id = "linked-owner", edition = f.publish(id), target = join(f.root, "owner-target.jsonl");
      if (!broken) writeFileSync(target, JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: f.root }) + "\n");
      symlinkSync(target, join(f.sessions, `fixture_${id}.jsonl`));
      const picture = join(f.store.root, id, edition.manifest.id, "editions", edition.manifest.editionId, "desktop.png"), before = readFileSync(picture);
      let removals = 0;
      const result = await sweepMissingTourOwners({ ...f.options, cleanup: async sid => { removals++; await f.cleanup(sid); } });
      assert.equal(result.unknown, 1, broken ? "broken link is uncertainty, not absent owner" : "a skipped linked transcript is not absent owner");
      assert.equal(result.removed, 0); assert.equal(removals, 0);
      assert.deepEqual(readFileSync(picture), before, "actual retained picture bytes are untouched");
      assert.ok(f.store.readEdition(id, edition.manifest.id, edition.manifest.editionId));
    } finally { f.close(); }
  }
});

test("linked project directories and live or broken scan roots never authorize retained-edition cleanup", async () => {
  for (const rootLink of [false, true]) for (const broken of [false, true]) {
    const f = setup(); try {
      const id = "directory-linked-owner", edition = f.publish(id), target = join(f.root, "owner-target");
      if (!broken) {
        mkdirSync(target);
        writeFileSync(join(target, `fixture_${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: f.root }) + "\n");
      }
      const link = rootLink ? join(f.root, "linked-root") : join(f.sessions, "linked-project");
      symlinkSync(target, link);
      const picture = join(f.store.root, id, edition.manifest.id, "editions", edition.manifest.editionId, "desktop.png"), before = readFileSync(picture);
      const roots = [{ path: rootLink ? link : f.sessions, flat: rootLink }];
      assert.equal((await tourOwnerStates([id], roots)).get(id), "unknown", "neither following nor skipping a link proves owner absence");
      let removals = 0;
      const result = await sweepMissingTourOwners({ ...f.options, sessionRoots: roots, cleanup: async sid => { removals++; await f.cleanup(sid); } });
      assert.equal(result.unknown, 1); assert.equal(result.removed, 0); assert.equal(removals, 0);
      assert.deepEqual(readFileSync(picture), before, "linked directory cannot remove or change retained picture bytes");
      assert.ok(f.store.readEdition(id, edition.manifest.id, edition.manifest.editionId));
    } finally { f.close(); }
  }
});

test("regular project directories still establish retained owners and confirmed missing neighbours", async () => {
  const f = setup(); try {
    const id = "regular-owner"; f.publish(id); f.publish("really-missing"); await f.knownAbsent("really-missing");
    const project = join(f.sessions, "regular-project"); mkdirSync(project);
    writeFileSync(join(project, `fixture_${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: f.root }) + "\n");
    const removed: string[] = [];
    const result = await sweepMissingTourOwners({ ...f.options, sessionRoots: [{ path: f.sessions, flat: false }], cleanup: async sid => { removed.push(sid); await f.cleanup(sid); } });
    assert.deepEqual(removed, ["really-missing"]); assert.equal(result.removed, 1); assert.equal(result.unknown, 0);
    assert.ok(f.store.latestEdition(id, "tour-demo"));
  } finally { f.close(); }
});

test("missing roots and non-transcript links remain UNKNOWN without touching retained pictures", async () => {
  for (const kind of ["missing-root", "flat-non-transcript-link"] as const) {
    const f = setup(); try {
      const e = f.publish("uncertain-owner"), picture = join(f.store.root, e.sessionId, e.manifest.id, "editions", e.manifest.editionId, "desktop.png"), before = readFileSync(picture);
      if (kind === "missing-root") rmSync(f.sessions, { recursive: true });
      else symlinkSync(join(f.root, "missing-target"), join(f.sessions, "unrelated-entry"));
      let removals = 0;
      const result = await sweepMissingTourOwners({ ...f.options, cleanup: async id => { removals++; await f.cleanup(id); } });
      assert.equal(result.unknown, 1, kind); assert.equal(removals, 0, kind); assert.deepEqual(readFileSync(picture), before);
    } finally { f.close(); }
  }
});
test("both missing-owner confirmations receive the same immutable root snapshot", async () => {
  const f = setup(); try {
    f.publish("really-missing"); await f.knownAbsent("really-missing");
    const roots = [{ path: f.sessions, flat: true }], snapshots: (readonly { path: string; flat: boolean }[])[] = [];
    let checks = 0, removals = 0;
    const result = await sweepMissingTourOwners({ ...f.options, sessionRoots: roots, owners: async (ids, snapshot) => {
      snapshots.push(snapshot); const states = await tourOwnerStates(ids, snapshot, f.state);
      if (++checks === 1) { roots[0]!.path = join(f.root, "now-missing-root"); roots.push({ path: join(f.root, "another-root"), flat: false }); }
      return states;
    }, cleanup: async id => { removals++; await f.cleanup(id); } });
    assert.equal(checks, 2); assert.equal(snapshots[0], snapshots[1]); assert.deepEqual(snapshots[1], [{ path: f.sessions, flat: true }]);
    assert.equal(Object.isFrozen(snapshots[0]), true); assert.equal(Object.isFrozen(snapshots[0]![0]), true);
    assert.equal(result.removed, 0); assert.equal(result.unknown, 1); assert.equal(removals, 0, "a changed visibility index is uncertainty even though both scans use the original snapshot");
  } finally { f.close(); }
});
test("default root visibility disappearing never erases a tour, even when the remembered file is gone", async () => {
  const f = setup(), original = extraSessionRoots();
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    f.publish("visibility-hidden"); await f.knownAbsent("visibility-hidden");
    setExtraSessionRoots(() => [f.sessions]);
    assert.equal((await tourOwnerStates(["visibility-hidden"], undefined, f.state)).get("visibility-hidden"), "missing", "positive control: trusted plain parent and exact known-file absence can establish cleanup");
    setExtraSessionRoots(() => []);
    let removed = 0;
    const result = await sweepMissingTourOwners({ root: f.state, cleanup: async () => { removed++; }, warning: () => {} });
    assert.equal(result.unknown, 1); assert.equal(removed, 0); assert.ok(f.store.latestEdition("visibility-hidden", "tour-demo"));
  } finally { setExtraSessionRoots(() => original); f.close(); }
});
test("an unreadable retained-owner directory and an uncertain registry never authorize cleanup", async () => {
  const f = setup(); try {
    const e = f.publish("unreadable-owner"); f.header(e.sessionId);
    assert.equal(await rememberTourOwner(e.sessionId, join(f.sessions, `fixture_${e.sessionId}.jsonl`), { root: f.state, sessionRoots: f.options.sessionRoots }), true);
    const picture = join(f.store.root, e.sessionId, e.manifest.id, "editions", e.manifest.editionId, "desktop.png"), before = readFileSync(picture);
    chmodSync(f.sessions, 0);
    let removed = 0;
    const denied = await sweepMissingTourOwners({ ...f.options, cleanup: async () => { removed++; } });
    assert.equal(denied.removed, 0); assert.equal(denied.unknown, 1); assert.equal(removed, 0); assert.deepEqual(readFileSync(picture), before);
    chmodSync(f.sessions, 0o700);
    await f.knownAbsent(e.sessionId); writeFileSync(join(f.state, "orgs.json"), "{unreadable-registry");
    const unknown = await sweepMissingTourOwners({ ...f.options, cleanup: async () => { removed++; } }); assert.equal(unknown.unknown, 1); assert.equal(removed, 0);
  } finally { if (existsSync(f.sessions)) chmodSync(f.sessions, 0o700); f.close(); }
});
test("missing or corrupt birth records stay UNKNOWN; a validated moved owner updates the private record", async () => {
  const f = setup(); try {
    f.publish("no-provenance"); f.publish("corrupt-provenance"); await f.knownAbsent("corrupt-provenance");
    const bad = join(f.state, "tour-owners", `${digest("corrupt-provenance")}.json`); writeFileSync(bad, "{corrupt");
    let removed = 0;
    const denied = await sweepMissingTourOwners({ ...f.options, cleanup: async () => { removed++; } });
    assert.equal(denied.unknown, 2); assert.equal(removed, 0); assert.equal(readFileSync(bad, "utf8"), "{corrupt");
    f.publish("moved-owner"); await f.knownAbsent("moved-owner");
    const moved = join(f.root, "moved-root"); mkdirSync(moved);
    const path = join(moved, "moved_moved-owner.jsonl"); writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "moved-owner", timestamp: at, cwd: f.root }) + "\n");
    const roots = [{ path: f.sessions, flat: true }, { path: moved, flat: true }];
    assert.equal((await tourOwnerStates(["moved-owner"], roots, f.state)).get("moved-owner"), "present");
    const recorded = readKnownTourOwner("moved-owner", f.state); assert.equal(recorded.status, "known"); if (recorded.status === "known") assert.equal(recorded.owner.file, path);
    const retained = await sweepMissingTourOwners({ ...f.options, sessionRoots: roots, cleanup: async () => { removed++; } });
    assert.equal(retained.removed, 0); assert.equal(removed, 0); assert.ok(f.store.latestEdition("moved-owner", "tour-demo"));
  } finally { f.close(); }
});
test("admission revalidates deletion and unsafe file replacement after private persistence awaits", async () => {
  for (const change of ["deleted", "symlink"] as const) {
    const f = setup(), id = randomUUID(), file = join(SESSIONS_DIR, `admission_${id}.jsonl`), root = stateRoot();
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      const text = JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: f.root }) + "\n"; writeFileSync(file, text);
      const admission = tourOwnerPath(id, async (sid, path) => { const saved = await rememberTourOwner(sid, path); assert.equal(saved, true); reached(); await gate; return saved; });
      await Promise.race([entered, admission.then(() => { throw new Error("Admission skipped its deferred persistence boundary."); })]);
      assert.equal(readKnownTourOwner(id).status, "known", "real private persistence completed before the deferred boundary");
      if (change === "deleted") { markTourSessionDeleted(root, id); forgetTourOwner(id); }
      else { const outside = join(f.root, "outside.jsonl"); writeFileSync(outside, text); unlinkSync(file); symlinkSync(outside, file); }
      release(); assert.equal(await admission, null, change);
      if (change === "deleted") assert.equal(readKnownTourOwner(id).status, "absent", "completed cleanup is not recreated by the pending admission");
      else assert.equal(readKnownTourOwner(id).status, "known", "old birth metadata is never current read permission");
    } finally {
      release?.(); rmSync(file, { force: true }); forgetTourOwner(id); rmSync(join(root, "tour-deleted", `${digest(id)}.json`), { force: true }); f.close();
    }
  }
});
test("a periodic pass lists no root while every candidate's remembered transcript is still in place", async () => {
  const f = setup(); try {
    const remember = async (id: string) => { f.header(id); assert.equal(await rememberTourOwner(id, join(f.sessions, `fixture_${id}.jsonl`), { root: f.state, sessionRoots: f.options.sessionRoots }), true); };
    f.publish("kept-a"); f.publish("kept-b"); await remember("kept-a"); await remember("kept-b");
    let scans = 0, removed = 0;
    const pass = () => sweepMissingTourOwners({ ...f.options, owners: (ids, roots) => tourOwnerStates(ids, roots, f.state, r => { scans++; return scanTourOwnerFiles(r); }), cleanup: async () => { removed++; } });
    const quiet = await pass();
    assert.equal(scans, 0, "no full listing or header sweep for owners proven in place"); assert.equal(quiet.unknown, 0); assert.equal(removed, 0);
    f.publish("not-remembered"); f.header("not-remembered");
    const control = await pass();
    assert.equal(scans, 1, "positive control: an owner with no remembered file still gets the full scan"); assert.equal(control.unknown, 0); assert.equal(removed, 0);
    assert.equal(readKnownTourOwner("not-remembered", f.state).status, "known", "the full scan remembers it");
    await pass(); assert.equal(scans, 1, "and later passes are cheap again");
    unlinkSync(join(f.sessions, "fixture_kept-a.jsonl")); symlinkSync(join(f.root, "elsewhere.jsonl"), join(f.sessions, "fixture_kept-a.jsonl"));
    const linked = await pass(); assert.equal(scans, 2, "a remembered file that became a link is not taken as present"); assert.equal(linked.unknown, 1); assert.equal(removed, 0);
  } finally { f.close(); }
});
test("stop waits for the pass in flight and starts no other; the pending warning is said once until a clean pass", async () => {
  const f = setup(); try {
    f.publish("slow-owner"); markTourSessionDeleted(f.state, "slow-owner"); // Sova's own deletion: cleaned on the first pass.
    let release!: () => void, entered!: () => void, cleaned = 0, warnings = 0;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    const control = startTourSweep({ ...f.options, schedule: () => () => {}, warning: () => { warnings++; }, cleanup: async id => { entered(); await gate; await f.cleanup(id); cleaned++; } });
    await started;
    let stopped = false; const stopping = control.stop().then(() => { stopped = true; });
    await new Promise(r => setTimeout(r, 10)); assert.equal(stopped, false, "stop does not return while the pass is still cleaning");
    release(); await stopping; assert.equal(cleaned, 1); assert.equal((await control.first).removed, 1);
    assert.deepEqual(await control.run(), { checked: 0, removed: 0, unknown: 0, failed: 0 }, "no pass after stop");
    const g = setup(); try {
      g.publish("unknown-owner");
      let tick = () => {}; const noisy = startTourSweep({ ...g.options, schedule: fn => { tick = fn; return () => {}; }, warning: () => { warnings++; } });
      await noisy.first; tick(); await noisy.run(); tick(); await noisy.run();
      assert.equal(warnings, 1, "a lasting UNKNOWN warns once, not every minute"); await noisy.stop();
    } finally { g.close(); }
  } finally { f.close(); }
});
test("absence alone cleans only on a second sighting a minute later over the same folders; Sova's own deletion marker cleans at once", async () => {
  const f = setup(); try {
    f.publish("marked-leftover"); markTourSessionDeleted(f.state, "marked-leftover");
    f.publish("absent-owner"); await f.knownAbsent("absent-owner");
    let clock = Date.parse(at), notes = 0; const removed: string[] = [];
    const sweep = (extra = {}) => startTourSweep({ ...f.options, now: () => clock, schedule: () => () => {}, removedAbsent: (...args: unknown[]) => { assert.deepEqual(args, []); notes++; }, cleanup: async id => { removed.push(id); await f.cleanup(id); }, ...extra });
    const control = sweep();
    assert.equal((await control.first).removed, 1); assert.deepEqual(removed, ["marked-leftover"], "a concrete deletion marker is finished on the first pass after a start");
    clock += 30_000; await control.run(); assert.deepEqual(removed, ["marked-leftover"], "a second sighting under a minute later is not enough");
    clock += 30_000; await control.run(); assert.deepEqual(removed, ["marked-leftover", "absent-owner"], "still missing a minute after the first sighting: cleaned");
    assert.equal(notes, 1, "the absence-only cleanup is told once, with nothing in it"); await control.stop();

    f.publish("returns"); await f.knownAbsent("returns");
    const again = sweep(); await again.first;
    f.header("returns"); clock += 60_000; await again.run();
    unlinkSync(join(f.sessions, "fixture_returns.jsonl")); clock += 60_000; await again.run();
    assert.equal(removed.includes("returns"), false, "a chat that reappeared between sightings starts over");
    clock += 60_000; await again.run(); assert.equal(removed.includes("returns"), true); await again.stop();

    f.publish("restart"); await f.knownAbsent("restart");
    const before = sweep(); await before.first; await before.stop();
    clock += 120_000; const after = sweep(); await after.first;
    assert.equal(removed.includes("restart"), false, "a restart forgets the earlier sighting"); await after.stop();
  } finally { f.close(); }
});
test("a confirmation that throws forgets the earlier sighting: absence must be seen twice again", async () => {
  const f = setup(); try {
    f.publish("flaky-confirm"); await f.knownAbsent("flaky-confirm");
    let clock = Date.parse(at), pass = 0, calls = 0, removed = 0;
    const control = startTourSweep({ ...f.options, now: () => clock, schedule: () => () => {}, removedAbsent: () => {}, cleanup: async () => { removed++; },
      owners: async (ids, roots) => { if (pass === 2 && ++calls === 2) throw new Error("confirmation failed"); return tourOwnerStates(ids, roots, f.state); } });
    pass = 1; const first = await control.first; assert.equal(first.unknown, 1, "pass 1: first sighting");
    pass = 2; clock += 60_000; const failed = await control.run();
    assert.equal(calls, 2, "the second confirmation really threw"); assert.equal(failed.failed, 1); assert.equal(removed, 0);
    pass = 3; clock += 60_000; await control.run();
    assert.equal(removed, 0, "a throw is uncertainty: pass 3 is a new first sighting, not the confirming second");
    pass = 4; clock += 60_000; await control.run(); assert.equal(removed, 1, "two clean sightings a minute apart again");
    await control.stop();
  } finally { f.close(); }
});
test("a change in the visible session folders between sightings starts the count over", async () => {
  const f = setup(), original = extraSessionRoots();
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const other = join(f.root, "other-root"); mkdirSync(other);
    f.publish("folder-change"); await f.knownAbsent("folder-change");
    let clock = Date.parse(at), removed = 0;
    setExtraSessionRoots(() => [f.sessions]);
    assert.equal((await tourOwnerStates(["folder-change"], undefined, f.state)).get("folder-change"), "missing", "positive control: absence is provable over these folders");
    const control = startTourSweep({ root: f.state, now: () => clock, schedule: () => () => {}, warning: () => {}, removedAbsent: () => {}, cleanup: async () => { removed++; } });
    await control.first;
    setExtraSessionRoots(() => [f.sessions, other]); clock += 60_000; await control.run();
    assert.equal(removed, 0, "the second sighting saw other folders: it is a first sighting again");
    clock += 60_000; await control.run(); assert.equal(removed, 1, "two sightings over the same folders a minute apart"); await control.stop();
  } finally { setExtraSessionRoots(() => original); f.close(); }
});
test("startup failure leaves durable route-denial authority; periodic retry removes leftovers without secret logs or resurrection", async () => {
  const f = setup(); let stop = () => {}; try {
    const e = f.publish("deleted-chat"); await f.knownAbsent(e.sessionId);
    const p = f.shares.previewFor(e), made = f.shares.create(e.sessionId, e.manifest.id, e.manifest.editionId, p.previewId, new Date(Date.now() + 60_000).toISOString());
    const unused = f.shares.previewFor(e, "baton:destination");
    const secret = "fake-sec-21";
    let attempts = 0, tick = () => {}, canceled = false, clock = Date.parse(at); const warnings: unknown[][] = [];
    const control = startTourSweep({ ...f.options, now: () => clock, warning: (...args: unknown[]) => { warnings.push(args); }, schedule: (fn, ms) => { assert.equal(ms, 60_000); tick = fn; return () => { canceled = true; }; }, cleanup: async id => { attempts++; markTourSessionDeleted(f.state, id); if (attempts === 1) throw new Error(secret); await f.cleanup(id); } });
    stop = () => { void control.stop(); };
    const sighted = await control.first;
    assert.equal(sighted.removed, 0); assert.equal(attempts, 0, "absence alone never cleans on the first pass after a start");
    clock += 60_000;
    const first = await control.run();
    assert.equal(first.failed, 1); assert.equal(attempts, 1);
    assert.ok(existsSync(join(f.store.root, e.sessionId)), "simulated cleanup failure really left physical source files");
    assert.equal(f.store.readEdition(e.sessionId, e.manifest.id, e.manifest.editionId), null); assert.equal(f.shares.access(made.token), null);
    assert.equal(f.shares.consumePreview(unused.previewId, e.sessionId, e.manifest.id, e.manifest.editionId, "baton:destination"), null);
    assert.throws(() => f.store.publishEdition({ ...e, manifest: { ...e.manifest, editionId: "late-edition" } }, tourEditionAssetsFixture()), /deleted/);
    f.header(e.sessionId); // A late file with the old id cannot resurrect a deliberately deleted chat.
    tick(); const retried = await control.run(); assert.equal(retried.removed, 1); assert.equal(attempts, 2);
    assert.equal(existsSync(join(f.store.root, e.sessionId)), false); assert.equal(f.shares.sessions().includes(e.sessionId), false);
    assert.equal(existsSync(join(f.state, "tour-share-snapshots", `${made.link.id}.json`)), false);
    assert.equal(JSON.stringify(warnings).includes(secret), false); assert.equal(warnings.length, 1); assert.deepEqual(warnings[0], [], "warning callback receives no exception, path, token or id");
    await control.stop(); assert.equal(canceled, true); tick(); await control.run(); assert.equal(attempts, 2);
  } finally { stop(); f.close(); }
});

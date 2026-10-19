// Run: npx tsx --test server/sessions-index.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// The paths mode of Archive cleanup: one
// archived session deleted for good, and everything that must be refused instead. The bulk modes'
// own rules are covered elsewhere — group pruning in session-groups-index.test.ts, husk detection
// in cleanup.test.ts. The route's input validation is covered by the pieces it calls
// (resolveSessionPath); these tests call cleanupSessions directly, which re-validates the same way.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-sessions-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-sessions-index--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { archiveSession, cleanupSessions, getSessionSummary, idOf, LIST_REUSE_MS, listSessions } = await import("./sessions-index");
const { sessionsChanged } = await import("./list-generation");
const { isArchived, setArchived } = await import("./archived-sessions");
const { addWebSession, isWebSession } = await import("./web-sessions");
const { setDraft } = await import("./drafts");
const { canonicalPath } = await import("./paths");
const { stateRoot } = await import("./state-root");
const { ensureTourToolRuntime } = await import("./tours/runtime");
const { tourShares } = await import("./tours/shares");
const { removeSessionTours } = await import("./tours/lifecycle");
const { isTourSessionDeleted } = await import("./tours/deleted");
const { tourEditionFixture, tourEditionAssetsFixture, tourScriptFixture } = await import("../shared/tour-fixtures");

// A live record's pid must be alive for readLive to see it, like archived-sessions.test.ts fakes it.
// The runner that started this file, alive for all of it, stands in for another live process.
const otherPid = process.ppid;
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

const ID_A = "01234567-89ab-7cde-8f01-234567890abc";
const ID_B = "01234567-89ab-7cde-8f01-234567890abd";
const ID_C = "01234567-89ab-7cde-8f01-234567890abe";

const header = (id: string) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" });
const userMessage = (text: string) =>
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: text } });

/** A session file with a user message, aged past the just-written window so the bulk rules let it go. */
function session(id: string, title: string): string {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[header(id), userMessage(title)].join("\n")}\n`);
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, old, old);
  return canonicalPath(path);
}

test("paths: deleting an archived session removes exactly that file, clears the mark, leaves neighbours", async () => {
  const a = session(ID_A, "delete me");
  const b = session(ID_B, "keep me");
  const c = session(ID_C, "never archived");
  setArchived(ID_A, true);
  setArchived(ID_B, true);

  const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });

  assert.deepEqual(r, {
    deletedCount: 1,
    deletedIds: [ID_A],
    skipped: { live: 0, busy: 0, recent: 0, failed: 0 },
    refused: [],
  });
  assert.ok(!existsSync(a), "the named file is gone");
  assert.ok(existsSync(b), "an archived neighbour stays");
  assert.ok(existsSync(c), "an unarchived neighbour stays");
  assert.equal(isArchived(ID_A), false, "the deleted session's archive mark is cleared");
  assert.equal(isArchived(ID_B), true, "the neighbour's mark stays");
});

test("paths: an unarchived session is refused with the archive-first reason, not deleted", async () => {
  const c = session(ID_C, "never archived");

  const r = await cleanupSessions({ mode: "paths", paths: [c], dryRun: false });

  assert.deepEqual(r, {
    deletedCount: 0,
    deletedIds: [],
    skipped: { live: 0, busy: 0, recent: 0, failed: 0 },
    refused: [{ path: c, reason: "Not archived — archive it first, then delete it." }],
  });
  assert.ok(existsSync(c));
});

test("paths: a live session is skipped as live, not deleted (archived before a TUI opened it)", async () => {
  const a = session(ID_A, "live in a TUI");
  setArchived(ID_A, true);
  const rec = join(liveDir, "p-test.json");
  writeFileSync(rec, JSON.stringify({ session: { pid: otherPid, sessionFile: a, mode: "tui" }, presence: { status: "idle" } }));
  try {
    const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });
    assert.equal(r.deletedCount, 0);
    assert.deepEqual(r.deletedIds, []);
    assert.deepEqual(r.skipped, { live: 1, busy: 0, recent: 0, failed: 0 });
    assert.deepEqual(r.refused, []);
    assert.ok(existsSync(a));
  } finally {
    rmSync(rec);
  }
});

test("paths: a path outside the sessions dir is refused, not deleted", async () => {
  const outside = join(tmpdir(), `sova-sessions-index-outside-${process.pid}.jsonl`);
  writeFileSync(outside, `${header(ID_A)}\n`);
  try {
    const r = await cleanupSessions({ mode: "paths", paths: [outside], dryRun: false });
    assert.equal(r.deletedCount, 0);
    assert.deepEqual(r.deletedIds, []);
    const [refusal] = r.refused ?? [];
    assert.ok(refusal, "one refusal, saying the rule");
    assert.equal(refusal.path, outside);
    assert.match(refusal.reason, /not a session file/i);
    assert.ok(existsSync(outside));
  } finally {
    rmSync(outside, { force: true });
  }
});

test("paths: dryRun reports the candidate without deleting anything", async () => {
  const b = session(ID_B, "dry run me");
  setArchived(ID_B, true);

  const r = await cleanupSessions({ mode: "paths", paths: [b], dryRun: true });

  assert.deepEqual(r, {
    deletedCount: 0,
    deletedIds: [ID_B],
    skipped: { live: 0, busy: 0, recent: 0, failed: 0 },
    refused: [],
  });
  assert.ok(existsSync(b), "a dry run deletes nothing");
  assert.equal(isArchived(ID_B), true, "and clears no mark either");
});

test("paths: a just-written session is skipped as recent, not deleted", async () => {
  const a = session(ID_A, "just written");
  setArchived(ID_A, true);
  utimesSync(a, new Date(), new Date());

  const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });

  assert.equal(r.deletedCount, 0);
  assert.deepEqual(r.skipped, { live: 0, busy: 0, recent: 1, failed: 0 });
  assert.ok(existsSync(a));
});

test("paths: a file whose header doesn't parse is refused, not deleted — even archived", async () => {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${ID_A}.jsonl`);
  writeFileSync(path, '{"type":"sessi'); // truncated: no complete line anywhere
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, old, old);
  const a = canonicalPath(path);
  setArchived(ID_A, true);

  const r = await cleanupSessions({ mode: "paths", paths: [a], dryRun: false });

  assert.equal(r.deletedCount, 0);
  assert.deepEqual(r.deletedIds, []);
  const [refusal] = r.refused ?? [];
  assert.ok(refusal, "one refusal, saying why");
  assert.equal(refusal.path, a);
  assert.match(refusal.reason, /couldn't read/i);
  assert.ok(existsSync(a), "never delete what can't be read as a session");
});

test("paths: a session file that is already gone is refused, not failed", async () => {
  const gone = join(sessionsDir, "2026-09-21T00-00-00-000Z_01234567-89ab-7cde-8f01-234567890abf.jsonl");

  const r = await cleanupSessions({ mode: "paths", paths: [gone], dryRun: false });

  assert.equal(r.deletedCount, 0);
  assert.deepEqual(r.skipped, { live: 0, busy: 0, recent: 0, failed: 0 });
  const [refusal] = r.refused ?? [];
  assert.ok(refusal, "one refusal, saying why");
  assert.match(refusal.reason, /not found/i);
});

// A header-only husk: no user message anywhere in the file (the "Untitled" row of a new session
// that was never sent anything).
function husk(id: string): string {
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${header(id)}\n`);
  return canonicalPath(path);
}

test("archive: an empty husk is deleted outright, with every id list it was on", async () => {
  const id = "01234567-89ab-7cde-8f01-234567890ac0";
  const path = husk(id);
  addWebSession(id);

  const r = await archiveSession(path, true);

  assert.ok(r.ok, "archiving a husk succeeds");
  assert.ok(!existsSync(path), "the husk file is gone for good");
  assert.equal(isArchived(id), false, "no archive mark for a file that no longer exists");
  assert.equal(isWebSession(id), false, "the web-session id went with it");
});

test("archive: a husk with a stored draft is kept and marked, not deleted", async () => {
  const id = "01234567-89ab-7cde-8f01-234567890ac1";
  const path = husk(id);
  addWebSession(id);
  setDraft(id, "still writing this");

  const r = await archiveSession(path, true);

  assert.ok(r.ok);
  assert.ok(existsSync(path), "a draft the user is writing is a session, not an abandoned stub");
  assert.equal(isArchived(id), true, "it archives like any other session");
});

test("archive: a web session with messages is kept and marked, as before", async () => {
  const id = "01234567-89ab-7cde-8f01-234567890ac3";
  const path = session(id, "i exist");
  addWebSession(id);

  const r = await archiveSession(path, true);

  assert.ok(r.ok);
  assert.ok(existsSync(path));
  assert.equal(isArchived(id), true);
});

test("archive: a husk this server didn't spawn is still refused, never deleted", async () => {
  const id = "01234567-89ab-7cde-8f01-234567890ac2";
  const path = husk(id); // never added to web-sessions

  const r = await archiveSession(path, true);

  assert.equal(r.ok, false);
  assert.ok(existsSync(path), "an external session file is never touched");
});
function seedTours(id: string) {
  const runtime = ensureTourToolRuntime(), shares = tourShares(), edition = tourEditionFixture();
  edition.sessionId = id;
  runtime.store.publishEdition(edition, tourEditionAssetsFixture());
  const job = runtime.queue.enqueue({ sessionId: id, tourId: edition.manifest.id, title: "A saved draft", total: 2, requirements: { origins: ["https://example.test"] } }, async () => { throw new Error("A blocked fixture job must never run."); });
  runtime.artifacts.save({ v: 1, sessionId: id, jobId: job.id, tourId: job.tourId, script: tourScriptFixture(), mode: "dry-run", suspicious: [], receipts: [], report: job });
  const reviewed = shares.previewFor(edition);
  const link = shares.create(id, edition.manifest.id, edition.manifest.editionId, reviewed.previewId, new Date(Date.now() + 60_000).toISOString());
  const pending = shares.previewFor(edition, "baton:reviewer");
  return { runtime, shares, edition, job, link, pending };
}

function assertToursRemoved(id: string, fixture: ReturnType<typeof seedTours>) {
  const root = stateRoot(), { runtime, shares, edition, job, link, pending } = fixture;
  assert.equal(isTourSessionDeleted(root, id), true, "deletion remains durable after request completion");
  assert.equal(existsSync(join(root, "tours", id)), false, "source editions are removed");
  assert.equal(existsSync(join(root, "tour-private", id)), false, "private scripts and receipts are removed");
  assert.equal(existsSync(join(root, "tour-jobs", `${job.id}.json`)), false, "durable jobs are removed");
  assert.deepEqual(runtime.queue.list(id), []);
  assert.equal(shares.access(link.token), null, "standalone authority is revoked");
  assert.equal(existsSync(join(root, "tour-share-snapshots", `${link.link.id}.json`)), false);
  assert.equal(shares.consumePreview(pending.previewId, id, edition.manifest.id, edition.manifest.editionId, "baton:reviewer"), null, "unused review cannot attach after deletion");
}

test("actual transcript cleanup removes default tour stores and authority but preserves reusable operator state", async () => {
  const id = "01234567-89ab-7cde-8f01-234567890d01", path = session(id, "remove my tours");
  setArchived(id, true);
  const fixture = seedTours(id), { runtime } = fixture;
  runtime.approvals.approve("https://example.test");
  const account = runtime.accounts.save({ origin: "https://example.test", username: "made-up-reviewer", password: "fake-pw-01", testAccount: true });
  const result = await cleanupSessions({ mode: "paths", paths: [path], dryRun: false });
  assert.equal(result.deletedCount, 1); assert.deepEqual(result.deletedIds, [id]); assert.equal(result.skipped.failed, 0);
  assert.equal(existsSync(path), false);
  assertToursRemoved(id, fixture);
  assert.equal(runtime.approvals.isApproved("https://example.test"), true);
  assert.ok(runtime.accounts.resolve(account.id, account.origin), "another chat may reuse the approved test account");
});

test("archive, dry-run, refused and recent deletions retain real tour pictures, jobs and reviewed snapshots", async () => {
  for (const [n, mode] of ["archive", "dry-run", "refused", "recent"] .entries()) {
    const id = `01234567-89ab-7cde-8f01-234567890d1${n}`, path = session(id, mode), fixture = seedTours(id);
    addWebSession(id);
    if (mode === "archive") assert.ok((await archiveSession(path, true)).ok);
    else {
      if (mode !== "refused") setArchived(id, true);
      if (mode === "recent") utimesSync(path, new Date(), new Date());
      const result = await cleanupSessions({ mode: "paths", paths: [path], dryRun: mode === "dry-run" });
      assert.equal(result.deletedCount, 0);
    }
    assert.ok(existsSync(path));
    assert.equal(isTourSessionDeleted(stateRoot(), id), false);
    assert.ok(fixture.runtime.store.readEdition(id, fixture.edition.manifest.id, fixture.edition.manifest.editionId));
    assert.ok(fixture.runtime.artifacts.read(id, fixture.job.id));
    assert.ok(fixture.runtime.queue.get(id, fixture.job.id));
    assert.ok(existsSync(join(stateRoot(), "tour-share-snapshots", `${fixture.link.link.id}.json`)), "archive may revoke access, but must not delete retained pictures");
    if (mode !== "archive") {
      assert.ok(fixture.shares.access(fixture.link.token));
      assert.ok(fixture.shares.consumePreview(fixture.pending.previewId, id, fixture.edition.manifest.id, fixture.edition.manifest.editionId, "baton:reviewer"));
    }
  }
});

test("archive's actual empty-husk unlink also removes its real tour stores", async () => {
  const id = "01234567-89ab-7cde-8f01-234567890d20", path = husk(id), fixture = seedTours(id);
  addWebSession(id);
  const result = await archiveSession(path, true);
  assert.ok(result.ok); assert.equal(result.summary.deleted, true); assert.equal(existsSync(path), false);
  assertToursRemoved(id, fixture);
});

test("post-unlink tour failures preserve truthful delete results and log no nested private errors; retry removes leftovers", async () => {
  const runtime = ensureTourToolRuntime(), original = runtime.artifacts.removeSession, originalLog = console.error;
  const logs: unknown[][] = [], secretPath = "/private/made-up-account/profile", token = "fake-tok-02";
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    for (const [n, mode] of ["cleanup", "husk"].entries()) {
      const id = `01234567-89ab-7cde-8f01-234567890d3${n}`, path = mode === "husk" ? husk(id) : session(id, "cleanup failure"), fixture = seedTours(id);
      addWebSession(id); setArchived(id, true);
      runtime.artifacts.removeSession = current => {
        if (current === id) throw new AggregateError([new Error(secretPath, { cause: new Error(token) })], `Private cleanup ${secretPath}`);
        original.call(runtime.artifacts, current);
      };
      if (mode === "husk") {
        const result = await archiveSession(path, true);
        assert.ok(result.ok); assert.equal(result.summary.deleted, true);
      } else {
        const result = await cleanupSessions({ mode: "paths", paths: [path], dryRun: false });
        assert.equal(result.deletedCount, 1); assert.deepEqual(result.deletedIds, [id]); assert.equal(result.skipped.failed, 0);
      }
      assert.equal(existsSync(path), false);
      assert.equal(isTourSessionDeleted(stateRoot(), id), true);
      assert.ok(existsSync(join(stateRoot(), "tour-private", id)), "failed artifact removal really leaves retryable files");
      assert.equal(fixture.shares.access(fixture.link.token), null);
      assert.equal(fixture.runtime.store.latestEdition(id, fixture.edition.manifest.id), null);
      runtime.artifacts.removeSession = original;
      await removeSessionTours(id);
      assertToursRemoved(id, fixture);
    }
    assert.deepEqual(logs, Array.from({ length: 2 }, () => ["[sessions] Deleted chat tour cleanup is pending; a later sweep will retry."]), "constant-only logging cannot expose Error, stack, cause or AggregateError.errors");
    assert.equal(JSON.stringify(logs).includes(secretPath), false); assert.equal(JSON.stringify(logs).includes(token), false);
  } finally { runtime.artifacts.removeSession = original; console.error = originalLog; }
});

test("workerSession: a file its owner names as a worker is flagged in the list and the single summary; the owner is not", async () => {
  const ID_W = "01234567-89ab-7cde-8f01-2345678900a1";
  const ID_O = "01234567-89ab-7cde-8f01-2345678900a2";
  const worker = session(ID_W, "worker task");
  const owner = session(ID_O, "owner thread");
  const completion = JSON.stringify({ type: "custom_message", customType: "subagent-complete", display: true, content: `### ag_01 (worker) — done\nSession: ${ID_W}\nModel: m\nthe answer` });
  appendFileSync(owner, `${completion}\n`);

  const byId = new Map((await listSessions()).map((s) => [s.id, s]));
  assert.equal(byId.get(ID_W)?.workerSession, true);
  assert.equal(byId.get(ID_O)?.workerSession, undefined);
  assert.equal((await getSessionSummary(worker))?.workerSession, true);
  assert.equal((await getSessionSummary(owner))?.workerSession, undefined);

  // The flag is recomputed per listing: once the owner is gone, nothing names the worker. The
  // file goes from outside this server, so a listing reused for LIST_REUSE_MS may not see it yet.
  rmSync(owner);
  await new Promise((r) => setTimeout(r, LIST_REUSE_MS));
  assert.equal((await listSessions()).find((s) => s.id === ID_W)?.workerSession, undefined);
});

test("listing reuse (§app.session-list/listing-reuse): callers share a build for a second; this server's own writes are never missed", async () => {
  const ID_R = "01234567-89ab-7cde-8f01-2345678900b1";
  const ID_S = "01234567-89ab-7cde-8f01-2345678900b2";
  const ID_T = "01234567-89ab-7cde-8f01-2345678900b3";
  session(ID_R, "reuse one");
  sessionsChanged();
  const [first, second] = await Promise.all([listSessions(), listSessions()]);
  assert.notEqual(first, second, "each caller gets its own array");
  assert.deepEqual(first, second, "built once, the same rows");
  assert.ok(first.some((s) => s.id === ID_R));

  // A file written from outside this server: within the window, the shared list stands.
  session(ID_S, "outside write");
  assert.equal((await listSessions()).some((s) => s.id === ID_S), false, "an outside change can wait out the window");
  // A write through this server's stores starts the next listing afresh, at once.
  setArchived(ID_R, true);
  const after = await listSessions();
  assert.equal(after.find((s) => s.id === ID_R)?.archived, true, "its own archive is in the very next listing");
  assert.ok(after.some((s) => s.id === ID_S), "and so is everything else that changed meanwhile");

  session(ID_T, "seen after the window");
  await new Promise((r) => setTimeout(r, LIST_REUSE_MS));
  assert.ok((await listSessions()).some((s) => s.id === ID_T), "past the window, a fresh build");
});

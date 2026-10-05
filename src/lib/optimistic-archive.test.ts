import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { OptimisticArchive } from "./optimistic-archive";
import { isTopSession } from "./regions";
import { archivedDropToast } from "./drag-archive";

const row = (path: string, archived = false): SessionSummary => ({
  id: path, path, cwd: "/project", title: path, createdAt: "2026-01-01",
  lastActiveAt: "2026-01-01", live: null, origin: "web", archived,
} as SessionSummary);
const owns = () => true;

test("archive moves before response, preserves other rows, and no-op pending polls reuse the array", () => {
  const a = row("a"), b = row("b");
  const changes = new OptimisticArchive(() => {});
  changes.begin(a, true);
  const moved = changes.apply([a, b])!;
  assert.equal(isTopSession(moved[0]!), false);
  assert.equal(moved[1], b);
  changes.observe([a, b], owns);
  assert.equal(changes.apply([{ ...a }, { ...b }], moved), moved);
});

test("failure restores archive state, not stale metadata; stale pending poll cannot undo rollback", () => {
  const a = row("a");
  const changes = new OptimisticArchive(() => {});
  const mutation = changes.begin(a, true);
  const pendingRevision = changes.revision;
  mutation.rollback();
  assert.notEqual(pendingRevision, changes.revision);
  const updated: SessionSummary = { ...a, title: "Fresh title", unread: true };
  const restored = changes.apply([updated])![0]!;
  assert.equal(restored.archived, false);
  assert.equal(restored.title, "Fresh title");
  assert.equal(restored.unread, true);
});

test("settlement invalidates old polls even after a fresh poll acknowledges archive", () => {
  const a = row("a");
  const changes = new OptimisticArchive(() => {});
  const beforeRevision = changes.revision;
  const mutation = changes.begin(a, true);
  const pendingRevision = changes.revision;
  mutation.commit();
  const committedRevision = changes.revision;
  assert.notEqual(beforeRevision, committedRevision);
  assert.notEqual(pendingRevision, committedRevision);
  assert.equal(changes.apply([a])![0]!.archived, true);
  changes.observe([row("a", true)], owns);
  assert.notEqual(changes.revision, committedRevision, "ack invalidates another post-commit poll carrying a stale answer");
  assert.equal(changes.apply([row("a", true)])![0]!.archived, true);
});

test("old answer after confirmation is rejected even when both requests started after commit", async () => {
  const a = row("a");
  const changes = new OptimisticArchive(() => {});
  changes.begin(a, true).commit();
  let displayed = changes.apply([a])!;
  let resolveOld!: (rows: SessionSummary[]) => void;
  const oldAnswer = new Promise<SessionSummary[]>((resolve) => { resolveOld = resolve; });
  const fetch = async (answer: Promise<SessionSummary[]>) => {
    const revision = changes.revision;
    const rows = await answer;
    if (revision !== changes.revision) return;
    changes.observe(rows, owns);
    displayed = changes.apply(rows, displayed)!;
  };
  const old = fetch(oldAnswer);
  await fetch(Promise.resolve([row("a", true)]));
  resolveOld([a]);
  await old;
  assert.equal(displayed[0]!.archived, true, "older false answer cannot resurrect top row after acknowledgment");
});

test("confirmed empty deletion removes row and stale lists cannot resurrect it; no Undo", () => {
  const a = row("a"), b = row("b");
  const changes = new OptimisticArchive(() => {});
  const mutation = changes.begin(a, true);
  assert.equal(changes.apply([a, b])!.length, 2);
  mutation.commit(true);
  assert.deepEqual(changes.apply([a, b]), [b]);
  changes.observe([a, b], owns);
  assert.deepEqual(changes.apply([a, b]), [b]);
  assert.equal(archivedDropToast(true).undo, false);
  changes.observe([b], owns);
  assert.deepEqual(changes.apply([b]), [b]);
});

test("Undo moves before response, failed Undo restores Archive, successful Undo stays top", () => {
  const a = row("a", true);
  const changes = new OptimisticArchive(() => {});
  const undo = changes.begin(a, false);
  assert.equal(isTopSession(changes.apply([a])![0]!), true);
  undo.rollback();
  assert.equal(isTopSession(changes.apply([a])![0]!), false);
  const retry = changes.begin(a, false);
  retry.commit();
  assert.equal(isTopSession(changes.apply([a])![0]!), true);
  changes.observe([row("a")], owns);
  assert.equal(isTopSession(changes.apply([row("a")])![0]!), true);
});

test("local poll never acknowledges a peer deletion; path isolates same-id rows", () => {
  const a = row("local"), remote = { ...row("peer"), id: a.id };
  const changes = new OptimisticArchive(() => {});
  changes.begin(remote, true).commit(true);
  changes.observe([a], (path) => path === "local");
  assert.deepEqual(changes.apply([a, remote]), [a]);
});

test("superseded settlements cannot undo newer intent; live rule remains authoritative", () => {
  const a = row("a");
  const changes = new OptimisticArchive(() => {});
  const archive = changes.begin(a, true);
  const undo = changes.begin(changes.apply([a])![0]!, false);
  archive.rollback();
  assert.equal(changes.apply([a])![0]!.archived, false);
  undo.commit();
  assert.equal(isTopSession(changes.apply([{ ...a, live: { pid: 1, status: "idle" } }])![0]!), true);
});

test("unchanged unmodified lists preserve array identity", () => {
  const a = row("a"), b = row("b"), previous = [a, b];
  const changes = new OptimisticArchive(() => {});
  assert.equal(changes.apply([{ ...a }, { ...b }], previous), previous);
});

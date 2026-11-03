// Run: pnpm test src/lib/queue-chats.test.ts
// The merge queue's own chats (`SessionSummary.queueChat`: its thread, each reviewer) are in no list of the
// session pane: Recent, Folders, the project and folder blocks, groups, the Archive and its Clean Up counts,
// Needs you, search (the Sidebar's rows all pass isMainThread), the Agents board, the overview counts, what
// is working now, and the Name sessions button. Each surface is asked about the same chat with and without
// the mark, so a rule that left everything out (or nothing) can't pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentsInsight, SessionSummary } from "../../shared/protocol";
import { boardRows } from "./agents-board";
import { isNameable } from "./auto-title";
import { sessionsGlance } from "./home-sessions";
import { inLocalProjectsRegion, projectBlocks } from "./project-region";
import { recentEligible } from "./recent";
import { canJoinGroup, groupMembersOf, inFolders, isMainThread, isOrdinarySession, listedWithLocalProject } from "./regions";
import { workNow } from "./work-now";

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/w/proj",
    title: id,
    createdAt: "2026-11-01T00:00:00Z",
    lastActiveAt: "2026-11-03T00:00:00Z",
    model: null,
    live: null,
    busy: false,
    origin: "web",
    archived: false,
    ...extra,
  }) as SessionSummary;

const folder = { kind: "folder", projectId: "p1", projectName: "proj" } as SessionSummary["project"];
const thread = { role: "thread" } as const;
const reviewer = { role: "reviewer" } as const;

/** The same chat twice: the control and the marked one. */
const pair = (extra: Partial<SessionSummary> = {}) => [session("plain", extra), session("queue", { ...extra, queueChat: reviewer })] as const;

test("the region rules: a marked chat is no main thread, so in no ordinary surface, group, Folders or Recent", () => {
  const [plain, queue] = pair();
  assert.equal(isMainThread(plain), true);
  assert.equal(isMainThread(queue), false);
  assert.equal(isMainThread(session("t", { queueChat: thread })), false);
  assert.deepEqual([isOrdinarySession(plain), isOrdinarySession(queue)], [true, false]);
  assert.deepEqual([canJoinGroup(plain), canJoinGroup(queue)], [true, false]);
  assert.deepEqual([inFolders(plain, true), inFolders(queue, true)], [true, false]);
  assert.deepEqual([recentEligible(plain), recentEligible(queue)], [true, false]);
  assert.deepEqual(groupMembersOf([{ ...plain, groupId: "g" }, { ...queue, groupId: "g" }], "g").map((s) => s.id), ["plain"]);
  // The Archive (isOrdinarySession on archived rows) and its Clean Up counts read the same rule.
  const [ap, aq] = pair({ archived: true });
  assert.deepEqual([isOrdinarySession(ap), isOrdinarySession(aq)], [true, false]);
});

test("the project's folder block: the thread and reviewers run in its folder but are never its rows", () => {
  const [plain, queue] = pair({ project: folder });
  assert.deepEqual([listedWithLocalProject(plain, true), listedWithLocalProject(queue, true)], [true, false]);
  assert.deepEqual([inLocalProjectsRegion(plain, true), inLocalProjectsRegion(queue, true)], [true, false]);
  const blocks = projectBlocks([plain, queue, session("t", { project: folder, queueChat: thread })]);
  assert.deepEqual(blocks.flatMap((b) => [...b.builds.active, ...b.builds.done].map((s) => s.id)), ["plain"]);
});

test("the overview counts, the Agents board, working now and Name sessions leave it out", () => {
  const working = { activity: { state: "working" as const } };
  const [plain, queue] = pair(working);
  const g = sessionsGlance([plain, queue], undefined, undefined);
  assert.equal(g.total, 1);
  assert.equal(g.working, 1);
  assert.equal(g.last?.id, "plain");
  assert.deepEqual(boardRows([plain, queue], undefined, () => true).map((r) => r.session.id), ["plain"]);
  const agents = { at: 0, totals: {}, sessions: [] } as unknown as AgentsInsight;
  const peers = [{ label: "peer", rows: [{ ...plain, path: "/peer/a.jsonl", busy: true }, { ...queue, path: "/peer/b.jsonl", busy: true }] }];
  assert.equal(workNow(agents, peers).sessions, 1, "a peer's working queue chat is not counted");
  assert.deepEqual([isNameable(plain), isNameable(queue)], [true, false]);
});

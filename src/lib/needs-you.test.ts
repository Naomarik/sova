// Run: npx tsx --test src/lib/needs-you.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem, SessionSummary } from "../../shared/protocol";
import { needsYouCut, needsYouOpen, needsYouRows, needsYouShown, storedNeedsYouOpen } from "./needs-you";

const session = (id: string): SessionSummary =>
  ({
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/w/a",
    title: id,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    model: null,
    live: null,
    busy: false,
    origin: "external",
    archived: false,
  }) as SessionSummary;

const item = (id: string, tier: AttentionItem["tier"], kind: AttentionItem["kind"], since: number, detail?: string): AttentionItem => ({
  id,
  path: `/s/${id}.jsonl`,
  title: id,
  where: "~/w",
  tier,
  kind,
  since,
  href: `#/s/${id}`,
  ...(detail ? { detail } : {}),
});

const digest = (items: AttentionItem[], act = items.filter((i) => i.tier === "act").length) => ({
  generatedAt: 0,
  counts: { act, decide: items.filter((i) => i.tier === "decide").length, fyi: 0 },
  items,
});

test("one row per session with an act item, newest first; decide and fyi items never list", () => {
  const d = digest([
    item("a", "act", "error", 100, "The last turn stopped with an error."),
    item("b", "act", "open-questions", 300, "2 open questions in al_1 Ship it"),
    item("a", "act", "worker-error", 200, "1 subagent ended in an error."),
    item("c", "decide", "finished", 900, "done"),
    item("d", "fyi", "working", 999),
  ]);
  const rows = needsYouRows(d, ["a", "b", "c", "d"].map(session));
  assert.deepEqual(
    rows.map((r) => r.session.id),
    ["b", "a"],
    "b's newest act item (300) beats a's (200); c and d have no act item",
  );
  const a = rows.find((r) => r.session.id === "a")!;
  assert.equal(a.since, 200, "a session's time is its NEWEST act item, not its first");
  assert.equal(a.detail, "1 subagent ended in an error.", "line 2 is the newest act item's sentence");
  assert.deepEqual(a.details, ["1 subagent ended in an error.", "The last turn stopped with an error."], "the tooltip has every sentence, newest first");
});

test("a session the hit list doesn't carry is dropped, so the count is the rows on screen", () => {
  const d = digest([item("a", "act", "error", 1), item("b", "act", "needs-input", 2)]);
  assert.deepEqual(
    needsYouRows(d, [session("a")]).map((r) => r.session.id),
    ["a"],
    "b is filtered out by the search (or the host filter), so it neither lists nor counts",
  );
  assert.deepEqual(needsYouRows(undefined, [session("a")]), [], "no digest yet: no rows");
});

test("an act item without a detail leaves the row's line 2 to its own gist", () => {
  const rows = needsYouRows(digest([item("a", "act", "needs-input", 5)]), [session("a")]);
  assert.equal(rows[0]!.detail, null);
  assert.deepEqual(rows[0]!.details, []);
});

test("the cut note: only when the digest's cap dropped act items", () => {
  assert.equal(needsYouCut(digest([item("a", "act", "error", 1)])), false);
  assert.equal(needsYouCut(digest([item("a", "act", "error", 1)], 31)), true);
  assert.equal(needsYouCut(undefined), false);
});

test("shown: at least one row, and proactivity known and not Off", () => {
  const cases: [Parameters<typeof needsYouShown>[0], number, boolean][] = [
    ["badge", 1, true],
    ["brief", 3, true],
    ["badge", 0, false],
    ["off", 2, false],
    [undefined, 2, false],
  ];
  for (const [p, n, want] of cases) assert.equal(needsYouShown(p, n), want, `${p} with ${n} rows`);
});

test("open by default; only a stored collapse closes it, and a search forces it open", () => {
  assert.equal(storedNeedsYouOpen(null), true, "never touched: open");
  assert.equal(storedNeedsYouOpen("1"), true);
  assert.equal(storedNeedsYouOpen("0"), false, "the user collapsed it in this tab");
  assert.equal(storedNeedsYouOpen("garbage"), true, "anything else reads as open");
  assert.equal(needsYouOpen({ stored: false, searching: true }), true);
  assert.equal(needsYouOpen({ stored: false, searching: false }), false);
  assert.equal(needsYouOpen({ stored: true, searching: false }), true);
});

test("a roster proposal lists although its tier is decide; other decide kinds still don't", () => {
  const d = digest([item("a", "decide", "roster-proposal", 500, "Approve Bob (IT) proposed by Tony?"), item("b", "decide", "finished", 900, "done")]);
  const rows = needsYouRows(d, ["a", "b"].map(session));
  assert.deepEqual(rows.map((r) => r.session.id), ["a"]);
  assert.equal(rows[0]!.detail, "Approve Bob (IT) proposed by Tony?");
});

test("a worktree waiting for your OK and a stalled team list in Needs you; merge follow-ups and the restart item don't", () => {
  // The shapes server/merge-readiness.ts readinessItems and server/attention.ts sessionItems emit
  // (their own tests pin the tiers): both blockers are act tier.
  const rows = needsYouRows(
    digest([
      item("merge", "act", "ready-to-merge", 30, "Ready to merge: feat/agents-row-dropdown"),
      item("team", "act", "team-stalled", 20, "Waiting on frontend, reviewer, quiet for 16 min."),
      item("merged", "decide", "merged-open-work", 40, "Merged with open work: not a clean pass"),
      { ...item("server", "decide", "restart-pending", 50, "Restart pending: 1 merge changed the server since it started (feat/x)."), path: "" },
    ]),
    ["merge", "team", "merged", "server"].map(session),
  );
  assert.deepEqual(
    rows.map((r) => [r.session.id, r.detail]),
    [
      ["merge", "Ready to merge: feat/agents-row-dropdown"],
      ["team", "Waiting on frontend, reviewer, quiet for 16 min."],
    ],
  );
});

test("asks you, team stalled and ready to merge are decide items: never a Needs you row", () => {
  const d = digest([item("a", "decide", "asks-you", 100), item("b", "decide", "team-stalled", 100), item("c", "decide", "ready-to-merge", 100)]);
  assert.deepEqual(needsYouRows(d, ["a", "b", "c"].map(session)), []);
});

test("a proposed playbook run's row carries what its Approve & Merge needs; no other row does (§app.project-runtime/review)", () => {
  const playbook = { projectId: "p1", label: "Project verbs", hash: "sha256:abc", approved: false, branch: "sova/v", target: "main" };
  const rows = needsYouRows(digest([{ ...item("a", "act", "playbook-review", 20, "Project verbs: approve abc and merge into main"), playbook }, item("b", "act", "error", 10, "boom")]), [session("a"), session("b")]);
  assert.deepEqual(rows.map((r) => [r.session.id, r.playbook?.hash ?? null]), [["a", "sha256:abc"], ["b", null]]);
});

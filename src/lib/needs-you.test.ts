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
    item("b", "act", "asks-you", 300, "Asks you: ship it?"),
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

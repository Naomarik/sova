// Run: npx tsx --test src/lib/archive.test.ts
// Dates are built with the local-time constructor so the cases hold in any TZ.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveGroupOf,
  cleanupCandidates,
  groupByArchiveDate,
  parseCleanupResult,
  skippedText,
} from "./archive";

const at = (y: number, m: number, d: number, h = 12, min = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, min, s, ms);
const iso = (d: Date) => d.toISOString();

const NOW = at(2026, 9, 20, 15, 30);

test("today: from local midnight up to now", () => {
  assert.equal(archiveGroupOf(iso(at(2026, 9, 20, 0, 0)), NOW), "today");
  assert.equal(archiveGroupOf(iso(NOW), NOW), "today");
});

test("just before midnight is yesterday; just after is today", () => {
  assert.equal(archiveGroupOf(iso(at(2026, 9, 19, 23, 59, 59, 999)), NOW), "yesterday");
  assert.equal(archiveGroupOf(iso(at(2026, 9, 19, 0, 0)), NOW), "yesterday");
  const justAfterMidnight = at(2026, 9, 20, 0, 0, 1);
  assert.equal(archiveGroupOf(iso(at(2026, 9, 19, 23, 59)), justAfterMidnight), "yesterday");
  assert.equal(archiveGroupOf(iso(at(2026, 9, 20, 0, 0)), justAfterMidnight), "today");
});

test("calendar days, not 24h spans", () => {
  // 1 minute ago but across midnight: yesterday.
  assert.equal(archiveGroupOf(iso(at(2026, 9, 19, 23, 59)), at(2026, 9, 20, 0, 0)), "yesterday");
  // 40 hours ago, 2 calendar days: last 7 days.
  assert.equal(archiveGroupOf(iso(at(2026, 9, 18, 23, 30)), at(2026, 9, 20, 15, 30)), "week");
});

test("exactly 2 and 7 days ago are Last 7 days; 8 is Last 30 days", () => {
  assert.equal(archiveGroupOf(iso(at(2026, 9, 18)), NOW), "week");
  assert.equal(archiveGroupOf(iso(at(2026, 9, 13, 0, 0)), NOW), "week");
  assert.equal(archiveGroupOf(iso(at(2026, 9, 13, 23, 59)), NOW), "week");
  assert.equal(archiveGroupOf(iso(at(2026, 9, 12, 23, 59)), NOW), "month");
  assert.equal(archiveGroupOf(iso(at(2026, 9, 12)), NOW), "month");
});

test("exactly 30 days ago is Last 30 days; 31 is Older", () => {
  assert.equal(archiveGroupOf(iso(at(2026, 8, 21, 0, 0)), NOW), "month");
  assert.equal(archiveGroupOf(iso(at(2026, 8, 20, 23, 59)), NOW), "older");
  assert.equal(archiveGroupOf(iso(at(2025, 1, 1)), NOW), "older");
});

test("month rollover", () => {
  const march1 = at(2026, 3, 1, 9);
  assert.equal(archiveGroupOf(iso(at(2026, 2, 28, 22)), march1), "yesterday"); // 2026 isn't a leap year
  assert.equal(archiveGroupOf(iso(at(2026, 2, 22)), march1), "week"); // 7 days
  assert.equal(archiveGroupOf(iso(at(2026, 2, 21)), march1), "month"); // 8 days
  const leapMarch1 = at(2028, 3, 1, 9);
  assert.equal(archiveGroupOf(iso(at(2028, 2, 29, 23)), leapMarch1), "yesterday");
  assert.equal(archiveGroupOf(iso(at(2028, 2, 28, 23)), leapMarch1), "week");
});

test("year rollover", () => {
  const jan1 = at(2027, 1, 1, 0, 5);
  assert.equal(archiveGroupOf(iso(at(2026, 12, 31, 23, 55)), jan1), "yesterday");
  assert.equal(archiveGroupOf(iso(at(2026, 12, 25)), jan1), "week"); // 7 days
  assert.equal(archiveGroupOf(iso(at(2026, 12, 24)), jan1), "month"); // 8 days
  assert.equal(archiveGroupOf(iso(at(2026, 12, 2)), jan1), "month"); // 30 days
  assert.equal(archiveGroupOf(iso(at(2026, 12, 1)), jan1), "older"); // 31 days
});

test("DST-length days still count as one calendar day", () => {
  // Spans the US and EU spring-forward and fall-back dates; exact in any TZ.
  assert.equal(archiveGroupOf(iso(at(2026, 3, 7, 12)), at(2026, 3, 9, 12)), "week");
  assert.equal(archiveGroupOf(iso(at(2026, 3, 28, 12)), at(2026, 3, 29, 12)), "yesterday");
  assert.equal(archiveGroupOf(iso(at(2026, 10, 25, 0, 30)), at(2026, 10, 25, 23, 30)), "today");
  assert.equal(archiveGroupOf(iso(at(2026, 10, 3)), at(2026, 11, 2)), "month"); // 30 days
});

test("future times count as today; unparseable ones as Older", () => {
  assert.equal(archiveGroupOf(iso(at(2026, 9, 21, 9)), NOW), "today");
  assert.equal(archiveGroupOf("not a date", NOW), "older");
  assert.equal(archiveGroupOf("", NOW), "older");
});

test("groupByArchiveDate keeps input order, display order, and drops empty groups", () => {
  const rows = [
    { id: "a", lastActiveAt: iso(at(2026, 9, 20, 10)) },
    { id: "b", lastActiveAt: iso(at(2026, 9, 1)) },
    { id: "c", lastActiveAt: iso(at(2026, 9, 20, 9)) },
    { id: "d", lastActiveAt: iso(at(2025, 1, 1)) },
  ];
  const groups = groupByArchiveDate(rows, NOW);
  assert.deepEqual(
    groups.map((g) => [g.id, g.label, g.items.map((r) => r.id)]),
    [
      ["today", "Today", ["a", "c"]],
      ["month", "Last 30 days", ["b"]],
      ["older", "Older", ["d"]],
    ],
  );
  assert.deepEqual(groupByArchiveDate([], NOW), []);
});

test("parseCleanupResult is lenient", () => {
  const empty = { deletedCount: 0, deletedIds: null, skipped: { live: 0, busy: 0, recent: 0 } };
  assert.deepEqual(parseCleanupResult(null), empty);
  assert.deepEqual(parseCleanupResult("nope"), empty);
  assert.deepEqual(parseCleanupResult({ deletedCount: "3", skipped: [1] }), empty);
  assert.deepEqual(parseCleanupResult({ deletedCount: -1, skipped: { live: NaN, busy: 2.7 } }), {
    ...empty,
    skipped: { live: 0, busy: 2, recent: 0 },
  });
  assert.deepEqual(parseCleanupResult({ deletedCount: 4, deletedIds: ["a", 1, "b"], extra: true }), {
    ...empty,
    deletedCount: 4,
    deletedIds: ["a", "b"],
  });
});

test("cleanupCandidates prefers the id list (deletedCount is 0 on a dry run)", () => {
  assert.equal(cleanupCandidates(parseCleanupResult({ deletedCount: 0, deletedIds: ["a", "b"] })), 2);
  assert.equal(cleanupCandidates(parseCleanupResult({ deletedCount: 5 })), 5);
  assert.equal(cleanupCandidates(parseCleanupResult({})), 0);
});

test("skippedText lists only the nonzero reasons", () => {
  assert.equal(skippedText(parseCleanupResult({})), null);
  assert.equal(
    skippedText(parseCleanupResult({ skipped: { live: 1, busy: 1, recent: 1 } })),
    "3 skipped: 1 open in a TUI, 1 mid-turn, 1 just written",
  );
  assert.equal(skippedText(parseCleanupResult({ skipped: { recent: 2 } })), "2 skipped: 2 just written");
});

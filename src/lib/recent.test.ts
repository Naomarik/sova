// Run: npx tsx --test src/lib/recent.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import {
  DEFAULT_RECENT_COUNT,
  MAX_RECENT_COUNT,
  MIN_RECENT_COUNT,
  normalizeRecentCount,
  recentCountValid,
  parseRecentCount,
  recentEligible,
  recentSessions,
} from "./recent";

const session = (o: { id: string; lastActiveAt: string; createdAt?: string; archived?: boolean }): SessionSummary =>
  ({
    id: o.id,
    path: `/s/${o.id}.jsonl`,
    cwd: "/w/a",
    title: o.id,
    createdAt: o.createdAt ?? "2026-01-01T00:00:00Z",
    lastActiveAt: o.lastActiveAt,
    model: null,
    live: null,
    busy: false,
    origin: "external",
    archived: o.archived ?? false,
  }) as SessionSummary;

const ids = (list: readonly SessionSummary[]) => list.map((s) => s.id);

test("a bad count is the default; a number out of range is clamped to the nearest end", () => {
  // Not a number the field could have meant: no usable choice at all.
  for (const raw of [null, undefined, "", "   ", "abc", "4.7", 4.7, NaN, Infinity, {}, [], true, "5px"]) {
    assert.equal(normalizeRecentCount(raw), DEFAULT_RECENT_COUNT, `${JSON.stringify(raw)}`);
  }
  // A number, said badly: the user meant fewer or more, so the nearest legal count stands.
  assert.equal(normalizeRecentCount(0), MIN_RECENT_COUNT);
  assert.equal(normalizeRecentCount(2), MIN_RECENT_COUNT);
  assert.equal(normalizeRecentCount(-11), MIN_RECENT_COUNT);
  assert.equal(normalizeRecentCount(999), MAX_RECENT_COUNT);
  assert.equal(normalizeRecentCount("999"), MAX_RECENT_COUNT);
  // In range, as a number or as the string an <input> hands over.
  assert.equal(normalizeRecentCount(3), 3);
  assert.equal(normalizeRecentCount("7"), 7);
  assert.equal(normalizeRecentCount(MAX_RECENT_COUNT), MAX_RECENT_COUNT);
});

test("an empty field says no number at all, which is not the same as saying too few", () => {
  // `Number("") === 0`, so a parse that skips this guard calls a cleared box "fewer than 3" and
  // offers the floor as the fix. The field's error copy branches on exactly this null.
  assert.equal(parseRecentCount(""), null);
  assert.equal(parseRecentCount("   "), null);
  assert.equal(parseRecentCount(null), null);
  assert.equal(parseRecentCount("abc"), null);
  assert.equal(parseRecentCount("4.5"), null);
  // A number the user did type, however unusable, comes back as itself — that is what lets the
  // copy say WHICH way it is wrong.
  assert.equal(parseRecentCount("0"), 0);
  assert.equal(parseRecentCount(2), 2);
  assert.equal(parseRecentCount("99"), 99);
});

test("3 is the floor, and it is the floor in the validator too", () => {
  assert.equal(MIN_RECENT_COUNT, 3);
  assert.equal(recentCountValid(2), false); // the one the field has to talk about
  assert.equal(recentCountValid(3), true);
  assert.equal(recentCountValid(MAX_RECENT_COUNT), true);
  assert.equal(recentCountValid(MAX_RECENT_COUNT + 1), false);
  assert.equal(recentCountValid("4"), true);
  assert.equal(recentCountValid("4.5"), false);
  assert.equal(recentCountValid(""), false);
  // The two agree about what they disagree on: anything the validator rejects, normalize repairs.
  for (const raw of [2, 0, 99, "", "x", 4.5]) {
    assert.equal(recentCountValid(raw), false);
    assert.equal(recentCountValid(normalizeRecentCount(raw)), true);
  }
});

test("Recent lists the most recently active sessions, archived ones left out", () => {
  const list = [
    session({ id: "old", lastActiveAt: "2026-09-01T00:00:00Z" }),
    session({ id: "newest", lastActiveAt: "2026-09-22T09:00:00Z" }),
    session({ id: "archived", lastActiveAt: "2026-09-22T10:00:00Z", archived: true }),
    session({ id: "mid", lastActiveAt: "2026-09-10T00:00:00Z" }),
  ];
  // `archived` is the most recently active thing in the list and it is still not here: archiving
  // is the user saying "done", and a row that keeps coming back is that gesture not working.
  assert.deepEqual(ids(recentSessions(list, 5)), ["newest", "mid", "old"]);
  assert.equal(recentEligible({ archived: true }), false);
  assert.equal(recentEligible({ archived: false }), true);
  assert.equal(recentEligible({} as Pick<SessionSummary, "archived">), true); // older server
});

test("the count caps the list, and a bad count can't produce an empty or unbounded one", () => {
  const list = Array.from({ length: 30 }, (_, i) =>
    session({ id: `s${String(i).padStart(2, "0")}`, lastActiveAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
  );
  assert.equal(recentSessions(list, 3).length, 3);
  assert.equal(recentSessions(list, 5).length, 5);
  assert.equal(recentSessions(list, 0).length, MIN_RECENT_COUNT);
  assert.equal(recentSessions(list, "nonsense").length, DEFAULT_RECENT_COUNT);
  assert.equal(recentSessions(list, 10_000).length, MAX_RECENT_COUNT);
  // Newest first, whatever the cap.
  assert.deepEqual(ids(recentSessions(list, 3)), ["s29", "s28", "s27"]);
});

test("ties are settled, so the top of the sidebar doesn't shuffle between polls", () => {
  const t = "2026-09-22T08:00:00Z";
  const list = [
    session({ id: "b", lastActiveAt: t, createdAt: "2026-09-01T00:00:00Z" }),
    session({ id: "a", lastActiveAt: t, createdAt: "2026-09-05T00:00:00Z" }),
    session({ id: "c", lastActiveAt: t, createdAt: "2026-09-05T00:00:00Z" }),
  ];
  // Same mtime: the newer session wins; same createdAt too: the id decides.
  const expected = ["a", "c", "b"];
  assert.deepEqual(ids(recentSessions(list, 5)), expected);
  assert.deepEqual(ids(recentSessions([...list].reverse(), 5)), expected);
  assert.deepEqual(ids(recentSessions([list[1]!, list[2]!, list[0]!], 5)), expected);
});

test("Recent narrows with whatever the caller already filtered", () => {
  // The sidebar hands over its search hits, so a row the search ruled out cannot be here. Passing
  // the hit list IS the rule — this pins that the function adds no list of its own.
  const all = [
    session({ id: "keep", lastActiveAt: "2026-09-22T00:00:00Z" }),
    session({ id: "drop", lastActiveAt: "2026-09-21T00:00:00Z" }),
  ];
  const hits = all.filter((s) => s.id === "drop");
  assert.deepEqual(ids(recentSessions(hits, 5)), ["drop"]);
  assert.deepEqual(ids(recentSessions([], 5)), []);
  // And the caller's array is not the one that got sorted.
  assert.deepEqual(ids(all), ["keep", "drop"]);
});

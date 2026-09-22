// Run: npx tsx --test src/lib/session-order.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { byCreationDesc, groupByActivity, groupByCreation } from "./session-order";

const session = (o: { id: string; cwd?: string; createdAt: string; lastActiveAt?: string }): SessionSummary =>
  ({
    id: o.id,
    path: `/s/${o.id}.jsonl`,
    cwd: o.cwd ?? "/w/a",
    title: o.id,
    createdAt: o.createdAt,
    lastActiveAt: o.lastActiveAt ?? o.createdAt,
    model: null,
    live: null,
    busy: false,
    origin: "web",
    archived: false,
  }) as SessionSummary;

const ids = (list: readonly SessionSummary[]) => list.map((s) => s.id);
const shape = (groups: { cwd: string; sessions: SessionSummary[] }[]) => groups.map((g) => [g.cwd, ids(g.sessions)] as const);

test("Live & web orders by creation, and an activity burst doesn't move anything", () => {
  // `old` was created first and has been hammered since; `new` was created last and is quiet.
  const older = session({ id: "a", createdAt: "2026-09-01T00:00:00Z", lastActiveAt: "2026-09-22T12:00:00Z" });
  const newer = session({ id: "b", createdAt: "2026-09-20T00:00:00Z", lastActiveAt: "2026-09-20T00:00:01Z" });

  assert.deepEqual(ids(groupByCreation([older, newer])[0]!.sessions), ["b", "a"]);
  // The activity order is the OTHER one — which is what makes the assertion above mean something.
  assert.deepEqual(ids(groupByActivity([older, newer])[0]!.sessions), ["a", "b"]);

  // The whole point, stated as a change rather than a snapshot: move lastActiveAt anywhere at all
  // and the creation order is the same list. A rule that read mtime could not pass this.
  const bumped = [
    { ...newer, lastActiveAt: "2020-01-01T00:00:00Z" },
    { ...older, lastActiveAt: "2030-01-01T00:00:00Z" },
  ];
  assert.deepEqual(ids(groupByCreation(bumped)[0]!.sessions), ["b", "a"]);
});

test("folders sit where their newest session puts them, by creation", () => {
  const list = [
    session({ id: "a1", cwd: "/w/a", createdAt: "2026-09-01T00:00:00Z" }),
    session({ id: "b1", cwd: "/w/b", createdAt: "2026-09-05T00:00:00Z" }),
    session({ id: "a2", cwd: "/w/a", createdAt: "2026-09-09T00:00:00Z" }),
  ];
  // /w/a leads because a2 is the newest session anywhere, even though /w/b's only session is
  // newer than /w/a's oldest.
  assert.deepEqual(shape(groupByCreation(list)), [
    ["/w/a", ["a2", "a1"]],
    ["/w/b", ["b1"]],
  ]);
});

test("exact ties are settled, so two polls in a row agree", () => {
  const stamp = "2026-09-09T00:00:00Z";
  const list = [
    session({ id: "y", cwd: "/w/b", createdAt: stamp }),
    session({ id: "x", cwd: "/w/a", createdAt: stamp }),
    session({ id: "z", cwd: "/w/a", createdAt: stamp }),
  ];
  const expected = [
    ["/w/a", ["x", "z"]],
    ["/w/b", ["y"]],
  ];
  assert.deepEqual(shape(groupByCreation(list)), expected);
  // Same sessions, any arrival order the server likes: one answer. Reversed and rotated, because
  // a stable sort over one input order proves nothing about a different one.
  assert.deepEqual(shape(groupByCreation([...list].reverse())), expected);
  assert.deepEqual(shape(groupByCreation([list[2]!, list[0]!, list[1]!])), expected);

  // And the tie-break is id-then-cwd, not the reverse: `z` in /w/a beats `y` in /w/b on the row
  // key, yet /w/a still leads on the section key.
  assert.equal(byCreationDesc(list[1]!, list[2]!) < 0, true);
});

test("the Archive's order is the one it had: activity, ties left alone", () => {
  const list = [
    session({ id: "a", cwd: "/w/a", createdAt: "2026-01-01T00:00:00Z", lastActiveAt: "2026-09-01T00:00:00Z" }),
    session({ id: "b", cwd: "/w/b", createdAt: "2026-08-01T00:00:00Z", lastActiveAt: "2026-09-02T00:00:00Z" }),
  ];
  assert.deepEqual(shape(groupByActivity(list)), [
    ["/w/b", ["b"]],
    ["/w/a", ["a"]],
  ]);
  // Two folders tied on mtime keep the order the caller passed — no cwd tie-break here. This is
  // the assertion that turns red if the creation rule's tie-breaks are ever "tidied" into it.
  const tied = [
    session({ id: "p", cwd: "/w/z", createdAt: "2026-01-01T00:00:00Z", lastActiveAt: "2026-09-01T00:00:00Z" }),
    session({ id: "q", cwd: "/w/a", createdAt: "2026-01-01T00:00:00Z", lastActiveAt: "2026-09-01T00:00:00Z" }),
  ];
  assert.deepEqual(shape(groupByActivity(tied))[0]![0], "/w/z");
});

test("nothing is lost or duplicated by either order", () => {
  const list = [
    session({ id: "a", cwd: "/w/a", createdAt: "2026-09-01T00:00:00Z" }),
    session({ id: "b", cwd: "/w/b", createdAt: "2026-09-02T00:00:00Z" }),
    session({ id: "c", cwd: "/w/a", createdAt: "2026-09-03T00:00:00Z" }),
  ];
  for (const groups of [groupByCreation(list), groupByActivity(list)]) {
    assert.deepEqual(groups.flatMap((g) => ids(g.sessions)).sort(), ["a", "b", "c"]);
  }
  // And the caller's array is not the one that got sorted.
  assert.deepEqual(ids(list), ["a", "b", "c"]);
});

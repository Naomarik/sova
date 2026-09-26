import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrgSummary } from "../../shared/orgs";
import { OVERVIEW_ORG_ROWS, orgsGlance } from "./overview-orgs";

const org = (id: string, over: Partial<OrgSummary> = {}): OrgSummary => ({
  id,
  name: id,
  slug: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  dir: `/w/${id}`,
  people: 0,
  projects: 0,
  openBatons: 0,
  ...over,
});

test("no orgs: zero totals, no rows", () => {
  assert.deepEqual(orgsGlance([]), { totals: { orgs: 0, people: 0, projects: 0, openBatons: 0, needsYou: 0 }, rows: [], more: 0 });
});

test("totals sum every org, capped rows included, and absent needsYou counts 0", () => {
  const orgs = Array.from({ length: 7 }, (_, i) =>
    org(`o${i}`, { people: i + 1, projects: i, openBatons: i % 2, needsYou: i === 6 ? { replies: 1, links: 2, proposals: 0, conflicts: 1 } : undefined }),
  );
  const g = orgsGlance(orgs, 2);
  assert.deepEqual(g.totals, { orgs: 7, people: 28, projects: 21, openBatons: 3, needsYou: 4 });
  assert.equal(g.rows.length, 2);
  assert.equal(g.more, 5);
});

test("rows are newest activity first; unknown or unparsable activity last; ties keep the server's order", () => {
  const orgs = [
    org("none"),
    org("old", { lastActivityAt: "2026-03-01T00:00:00.000Z" }),
    org("bad", { lastActivityAt: "not a date" }),
    org("new", { lastActivityAt: "2026-09-01T00:00:00.000Z" }),
    org("tieA", { lastActivityAt: "2026-05-01T00:00:00.000Z" }),
    org("tieB", { lastActivityAt: "2026-05-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    orgsGlance(orgs, 10).rows.map((o) => o.id),
    ["new", "tieA", "tieB", "old", "none", "bad"],
  );
});

test("the default cap is 5, and the cap takes the most recent", () => {
  const orgs = Array.from({ length: 6 }, (_, i) => org(`o${i}`, { lastActivityAt: `2026-0${i + 1}-01T00:00:00.000Z` }));
  const g = orgsGlance(orgs);
  assert.equal(OVERVIEW_ORG_ROWS, 5);
  assert.deepEqual(g.rows.map((o) => o.id), ["o5", "o4", "o3", "o2", "o1"]);
  assert.equal(g.more, 1);
});

test("the input is not reordered", () => {
  const orgs = [org("a"), org("b", { lastActivityAt: "2026-02-01T00:00:00.000Z" })];
  orgsGlance(orgs);
  assert.deepEqual(orgs.map((o) => o.id), ["a", "b"]);
});

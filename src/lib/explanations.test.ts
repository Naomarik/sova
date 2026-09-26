import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExplanationInfo, SessionSummary } from "../../shared/protocol";
import {
  explanationSessionOptions,
  explanationsGlance,
  explanationsMeta,
  filterExplanations,
  rangeStart,
  resolveExplainSession,
  sessionsToLookUp,
} from "./explanations";

const ex = (id: string, createdAt: string, parentSessionId = "s1"): ExplanationInfo => ({ id, topic: id, summary: "", createdAt, parentSessionId });
const session = (id: string, extra: Partial<SessionSummary> = {}) => ({ id, path: `/p/${id}.jsonl`, title: `Title ${id}`, ...extra }) as SessionSummary;

// Noon, local time, so "today" and "7 days" have room on both sides.
const now = new Date(2026, 8, 27, 12, 0, 0).getTime();
const iso = (daysAgo: number, hour = 12) => new Date(2026, 8, 27 - daysAgo, hour, 0, 0).toISOString();

test("Today starts at local midnight; 7 and 30 days count back from now; All has no start", () => {
  assert.equal(rangeStart("today", now), new Date(2026, 8, 27, 0, 0, 0).getTime());
  assert.equal(rangeStart("7d", now), now - 7 * 86_400_000);
  assert.equal(rangeStart("30d", now), now - 30 * 86_400_000);
  assert.equal(rangeStart("all", now), null);
});

test("the date filter keeps each range's own rows, and only those", () => {
  const list = [ex("early-today", iso(0, 1)), ex("yesterday-late", iso(1, 23)), ex("six-days", iso(6)), ex("twenty-days", iso(20)), ex("forty-days", iso(40))];
  const ids = (range: "today" | "7d" | "30d" | "all") => filterExplanations(list, { session: null, range, order: "newest" }, now).map((e) => e.id);
  assert.deepEqual(ids("today"), ["early-today"], "yesterday 23:00 is not today, however close");
  assert.deepEqual(ids("7d"), ["early-today", "yesterday-late", "six-days"]);
  assert.deepEqual(ids("30d"), ["early-today", "yesterday-late", "six-days", "twenty-days"]);
  assert.deepEqual(ids("all"), ["early-today", "yesterday-late", "six-days", "twenty-days", "forty-days"]);
});

test("the session filter keeps one parent's rows; the sort flips the order; nothing is mutated", () => {
  const list = [ex("a", iso(3), "s1"), ex("b", iso(1), "s2"), ex("c", iso(2), "s1")];
  assert.deepEqual(filterExplanations(list, { session: "s1", range: "all", order: "newest" }, now).map((e) => e.id), ["c", "a"]);
  assert.deepEqual(filterExplanations(list, { session: "s1", range: "all", order: "oldest" }, now).map((e) => e.id), ["a", "c"]);
  assert.deepEqual(filterExplanations(list, { session: null, range: "all", order: "oldest" }, now).map((e) => e.id), ["a", "c", "b"]);
  assert.deepEqual(filterExplanations(list, { session: "nobody", range: "all", order: "newest" }, now), []);
  assert.deepEqual(list.map((e) => e.id), ["a", "b", "c"]);
});

test("an unreadable date sorts oldest and only survives All", () => {
  const list = [ex("bad", "not a date"), ex("ok", iso(1))];
  assert.deepEqual(filterExplanations(list, { session: null, range: "all", order: "newest" }, now).map((e) => e.id), ["ok", "bad"]);
  assert.deepEqual(filterExplanations(list, { session: null, range: "30d", order: "newest" }, now).map((e) => e.id), ["ok"]);
});

test("the head meta counts, singular at 1, and follows the sort", () => {
  assert.equal(explanationsMeta(1, "newest"), "1 explanation · newest first");
  assert.equal(explanationsMeta(0, "newest"), "0 explanations · newest first");
  assert.equal(explanationsMeta(12, "oldest"), "12 explanations · oldest first");
});

test("a listed session resolves to its title, archive mark and #/s/ route", () => {
  const ref = resolveExplainSession("s1", [session("s1", { archived: true })], {});
  assert.deepEqual(ref, { kind: "known", id: "s1", title: "Title s1", archived: true, path: "/p/s1.jsonl", href: `#/s/${encodeURIComponent("/p/s1.jsonl")}` });
});

test("an unlisted session links by id until its lookup says found or gone", () => {
  const byId = resolveExplainSession("01a0d030-aaaa", [session("s1")], {});
  assert.equal(byId.kind, "by-id");
  assert.equal(byId.kind === "by-id" && byId.href, "#/sid/01a0d030-aaaa");
  assert.equal(byId.kind === "by-id" && byId.title, "session 01a0d030");
  assert.equal(resolveExplainSession("x", [], { x: "pending" }).kind, "by-id");
  assert.equal(resolveExplainSession("x", [], { x: "failed" }).kind, "by-id", "a failed ask is not proof it's gone");
  assert.deepEqual(resolveExplainSession("x", [], { x: "gone" }), { kind: "gone", id: "x" });
  const found = resolveExplainSession("x", [], { x: session("x", { archived: true }) });
  assert.equal(found.kind, "known");
  assert.equal(found.kind === "known" && found.archived, true);
  // Found only by the lookup: #/s/<path> would say "Couldn't find", since the list lacks it.
  assert.equal(found.kind === "known" && found.href, "#/sid/x");
  // The list wins over a stale lookup: a session that came back is linked.
  assert.equal(resolveExplainSession("x", [session("x")], { x: "gone" }).kind, "known");
});

test("lookups: only unlisted parents, once each, and none before the list loads", () => {
  const list = [ex("a", iso(1), "s1"), ex("b", iso(1), "s2"), ex("c", iso(2), "s2"), ex("d", iso(2), "s3")];
  assert.deepEqual(sessionsToLookUp(list, undefined, {}), []);
  assert.deepEqual(sessionsToLookUp(list, [session("s1")], {}), ["s2", "s3"]);
  assert.deepEqual(sessionsToLookUp(list, [session("s1")], { s2: "pending" }), ["s3"]);
});

test("session options: newest session first, with counts; a selected session without explanations is kept", () => {
  const list = [ex("a", iso(5), "old"), ex("b", iso(1), "new"), ex("c", iso(9), "old")];
  const name = (id: string) => `N:${id}`;
  assert.deepEqual(explanationSessionOptions(list, name), [
    { id: "new", label: "N:new", count: 1 },
    { id: "old", label: "N:old", count: 2 },
  ]);
  assert.deepEqual(explanationSessionOptions(list, name, "other").at(-1), { id: "other", label: "N:other", count: 0 });
  assert.equal(explanationSessionOptions(list, name, "old").length, 2, "a selected session that has rows isn't listed twice");
});

test("the overview glance: count and the newest, whatever the input order", () => {
  assert.deepEqual(explanationsGlance([]), { count: 0, latest: null });
  const list = [ex("a", iso(5)), ex("b", iso(1)), ex("c", iso(3))];
  assert.equal(explanationsGlance(list).latest?.id, "b");
  assert.equal(explanationsGlance(list).count, 3);
});

test("#/explanations routes: the page, one session's filter, round-tripped through the href", async () => {
  const { explanationsHref, insightsRouteFromHash } = await import("./insights");
  assert.deepEqual(insightsRouteFromHash("#/explanations"), { page: "explanations", session: null });
  assert.deepEqual(insightsRouteFromHash("#/explanations/"), { page: "explanations", session: null });
  assert.equal(explanationsHref(), "#/explanations");
  assert.equal(explanationsHref(null), "#/explanations");
  for (const id of ["01a0d030-7b2c-7000-8000-000000000000", "odd id/with?chars"]) {
    assert.deepEqual(insightsRouteFromHash(explanationsHref(id)), { page: "explanations", session: id });
  }
  assert.deepEqual(insightsRouteFromHash("#/explanations/%E0%A4%A"), { page: "explanations", session: null }, "a bad escape is the unfiltered page");
  assert.equal(insightsRouteFromHash("#/explanationsx"), null);
  assert.equal(insightsRouteFromHash("#/explain/abc"), null);
});

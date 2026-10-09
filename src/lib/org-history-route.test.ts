import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_KINDS } from "../../shared/org-history";
import { dayMs, filtersKey, filtersSet, historyKey, KIND_GROUPS, queryOf, type HistoryView } from "./org-history-route";
import { orgHistoryHref, orgsRouteFromHash, orgTabHref } from "./orgs-route";

const view = (over: Partial<HistoryView> = {}): HistoryView => ({ filters: { projects: [] }, ...over });

test("the History tab, an event on it, and its filters round-trip through the address", () => {
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_1/history"), { kind: "org", id: "org_1", tab: "history", history: view() });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_1/history/"), { kind: "org", id: "org_1", tab: "history", history: view() });
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_1/history/events/he_ab12"), { kind: "org", id: "org_1", tab: "history", history: view({ event: "he_ab12" }) });
  const full: HistoryView = {
    filters: { projects: ["p_a", "p_b"], kind: "decisions", initiation: "operator", actor: "person:p_9", from: "2026-04-01", to: "2026-04-30", q: "bank sync & CSV" },
    event: "he_e6",
    chain: true,
  };
  const href = orgHistoryHref("org_1", full);
  assert.equal(href, "#/orgs/org_1/history/events/he_e6?project=p_a,p_b&kind=decisions&initiation=operator&actor=person%3Ap_9&from=2026-04-01&to=2026-04-30&q=bank%20sync%20%26%20CSV&view=chain");
  assert.deepEqual(orgsRouteFromHash(href), { kind: "org", id: "org_1", tab: "history", history: full });
  assert.equal(orgHistoryHref("org_1", view()), "#/orgs/org_1/history");
  assert.equal(orgHistoryHref("org_1", view()), orgTabHref("org_1", "history"));
});

test("the Causal View's expansion rides the address beside view=chain, so Back and a link open it as far", () => {
  const v = view({ event: "he_g", chain: true, more: 2 });
  const href = orgHistoryHref("org_1", v);
  assert.equal(href, "#/orgs/org_1/history/events/he_g?view=chain&more=2");
  assert.deepEqual(orgsRouteFromHash(href), { kind: "org", id: "org_1", tab: "history", history: v });
  // only with the Causal View, and only a count it can read
  assert.equal(orgHistoryHref("org_1", view({ event: "he_g", more: 2 })), "#/orgs/org_1/history/events/he_g");
  for (const bad of ["0", "-1", "1.5", "x", "51"]) assert.deepEqual(orgsRouteFromHash(`#/orgs/org_1/history/events/he_g?view=chain&more=${bad}`), { kind: "org", id: "org_1", tab: "history", history: view({ event: "he_g", chain: true }) }, bad);
  assert.deepEqual(orgsRouteFromHash("#/orgs/org_1/history/events/he_g?more=2"), { kind: "org", id: "org_1", tab: "history", history: view({ event: "he_g" }) });
});

test("a value this version can't read is dropped, never guessed; a bad path is no route", () => {
  const r = orgsRouteFromHash("#/orgs/org_1/history?project=p_a,a b,p_a&kind=everything&initiation=boss&actor=person:&from=2026-13-40&to=yesterday&q=%20%20&view=graph&zzz=1");
  assert.deepEqual(r, { kind: "org", id: "org_1", tab: "history", history: { filters: { projects: ["p_a"] } } });
  for (const h of ["#/orgs/org_1/history/events", "#/orgs/org_1/history/events/a b", "#/orgs/org_1/history/x", "#/orgs/a b/history", "#/orgs/org_1/history/events/e/x"])
    assert.equal(orgsRouteFromHash(h), null, h);
  // Elsewhere a query other than host= is still no route.
  assert.equal(orgsRouteFromHash("#/orgs/org_1/people?project=p_a"), null);
});

test("an org on a peer keeps its host beside the filters", async () => {
  const { notePeerOrgs, resetHosts } = await import("./mesh");
  resetHosts();
  notePeerOrgs("vps", ["org_far"]);
  try {
    const v = view({ filters: { projects: ["p_a"] }, event: "he_1" });
    const href = orgHistoryHref("org_far", v);
    assert.equal(href, "#/orgs/org_far/history/events/he_1?project=p_a&host=vps");
    assert.deepEqual(orgsRouteFromHash(href), { kind: "org", id: "org_far", tab: "history", history: v, host: "vps" });
    assert.equal(orgsRouteFromHash("#/orgs/org_far/history?host="), null);
  } finally {
    resetHosts();
  }
});

test("a peer's org: the page's host= stays in the hash; its reads go to the peer by path, carrying only the route's own params", async () => {
  const { notePeerOrgs, resetHosts, routeUrl } = await import("./mesh");
  const { historyParams } = await import("./api");
  // server/org-history-routes.ts LIST_PARAMS: an unknown param is a 400 there, so none may ride along.
  const LIST_PARAMS = ["project", "kind", "outcome", "actor", "initiation", "from", "to", "q", "asOf", "groupOf", "cursor", "limit"];
  resetHosts();
  notePeerOrgs("vps", ["org_far"]);
  try {
    const route = orgsRouteFromHash("#/orgs/org_far/history/events/he_1?project=p_a&kind=decisions&initiation=person&actor=operator&from=2026-04-01&to=2026-04-30&q=csv&host=vps");
    assert.ok(route && route.kind === "org" && route.history);
    const url = routeUrl(`/api/orgs/org_far/history${historyParams({ ...queryOf(route.history.filters), cursor: "c1", groupOf: "he_1" })}`);
    assert.match(url, /^\/peer\/vps\/api\/orgs\/org_far\/history\?/);
    const sent = [...new URLSearchParams(url.split("?")[1]).keys()];
    assert.deepEqual(sent.filter((k) => !LIST_PARAMS.includes(k)), [], "no host= or other stray param");
    assert.ok(!sent.includes("host"));
  } finally {
    resetHosts();
  }
});

test("keys: one string per view; the filter key ignores the selection and the view switch", () => {
  const a = view({ filters: { projects: ["p_a"], kind: "gaps" } });
  assert.equal(historyKey(a), historyKey({ filters: { kind: "gaps", projects: ["p_a"] } }));
  assert.notEqual(historyKey(a), historyKey({ ...a, event: "he_1" }));
  assert.equal(filtersKey(a.filters), filtersKey({ ...a, event: "he_1", chain: true }.filters));
  assert.equal(filtersSet(a.filters), 2);
  assert.equal(filtersSet({ projects: [], from: "2026-04-01", to: "2026-04-02" }), 1, "a date range is one filter");
});

test("the server query: kinds from the group, inclusive local days, literal text", () => {
  const q = queryOf({ projects: ["p_a"], kind: "holds", from: "2026-04-08", to: "2026-04-08", q: "csv", initiation: "unknown", actor: "operator" });
  assert.deepEqual(q.kinds, [...KIND_GROUPS.holds]);
  assert.equal(q.from, new Date(2026, 3, 8).getTime());
  assert.equal(q.to, new Date(2026, 3, 9).getTime() - 1);
  assert.equal(dayMs("2026-04-08", true) - dayMs("2026-04-08"), q.to! - q.from!);
  assert.deepEqual([q.projects, q.text, q.initiation, q.actors], [["p_a"], "csv", ["unknown"], ["operator"]]);
  assert.deepEqual(queryOf({ projects: [] }), {}, "no filter: the whole org");
});

test("every kind this version knows is in exactly one Kind group", () => {
  const seen = Object.values(KIND_GROUPS).flat();
  assert.deepEqual([...seen].sort(), [...HISTORY_KINDS].sort());
});

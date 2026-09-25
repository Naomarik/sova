import assert from "node:assert/strict";
import { test } from "node:test";
import { groupLinkIds, isAppRoute, resolveAppLink, sessionIdFromHash, sessionIndex, sessionIndexVersion, sessionLinkId, setSessionIndex } from "./session-links";

test("sova://s/<id> names a session; nothing else does", () => {
  assert.equal(sessionLinkId("sova://s/019a2b-cd"), "019a2b-cd");
  assert.equal(sessionLinkId("sova://s/019a2b-cd/"), "019a2b-cd");
  assert.equal(sessionLinkId("sova://g/abc"), null);
  assert.equal(sessionLinkId("https://example.com"), null);
  assert.equal(sessionLinkId('sova://s/a"onclick=x'), null, "no quote can ride along into an attribute");
});

test("a known id opens its session in this tab; an unlisted one still links, by id", () => {
  const index = new Map([["id1", { path: "/s/a b.jsonl", title: "fix auth" }]]);
  assert.deepEqual(resolveAppLink("sova://s/id1", index), { kind: "route", href: "#/s/%2Fs%2Fa%20b.jsonl", title: "fix auth" });
  // The list omits sessions with no user message (an empty one waiting on a dialog): missing from
  // it is not gone. Only the server's answer to #/sid/ may say that.
  assert.deepEqual(resolveAppLink("sova://s/nope", index), { kind: "route", href: "#/sid/nope" });
  assert.deepEqual(resolveAppLink("sova://s/id1", null), { kind: "route", href: "#/sid/id1" }, "before the list loads, link by id");
  assert.equal(sessionIdFromHash("#/sid/id1"), "id1");
});

test("same-origin routes are in-app; external links are not this module's", () => {
  assert.deepEqual(resolveAppLink("#/usage", null), { kind: "route", href: "#/usage" });
  assert.equal(isAppRoute('#/s/x"><script>'), false);
  assert.equal(resolveAppLink("https://example.com", null), null);
  assert.equal(resolveAppLink("mailto:a@b.c", null), null);
});

test("the index only bumps its version when ids, paths or titles change", () => {
  setSessionIndex([{ id: "a", path: "/a", title: "A" }]);
  const v = sessionIndexVersion();
  setSessionIndex([{ id: "a", path: "/a", title: "A" }]);
  assert.equal(sessionIndexVersion(), v, "a poll with the same rows re-renders nothing");
  setSessionIndex([{ id: "a", path: "/a", title: "A renamed" }]);
  assert.equal(sessionIndexVersion(), v + 1);
  assert.equal(sessionIndex()?.get("a")?.title, "A renamed");
});

test("sova://g/<id>[/s/<sid>] names a workspace, and optionally a pane in it", () => {
  assert.deepEqual(groupLinkIds("sova://g/grp1"), { group: "grp1", session: null });
  assert.deepEqual(groupLinkIds("sova://g/grp1/s/id1"), { group: "grp1", session: "id1" });
  assert.equal(groupLinkIds("sova://g/"), null);
  assert.equal(groupLinkIds("sova://g/grp1/x/id1"), null);
});

test("a known group opens its workspace; with a resolvable session, that pane focused", () => {
  const sessions = new Map([["id1", { path: "/s/a.jsonl", title: "fix auth" }]]);
  const groups = new Map([["grp1", "Auth work"]]);
  assert.deepEqual(resolveAppLink("sova://g/grp1", sessions, groups), { kind: "route", href: "#/g/grp1", title: "Auth work" });
  assert.deepEqual(resolveAppLink("sova://g/grp1/s/id1", sessions, groups), { kind: "route", href: "#/g/grp1/%2Fs%2Fa.jsonl", title: "Auth work" });
  assert.deepEqual(
    resolveAppLink("sova://g/grp1/s/nope", sessions, groups),
    { kind: "route", href: "#/g/grp1", title: "Auth work" },
    "a pane that can't be resolved falls back to the group alone",
  );
});

test("an unknown group is its link text only; before the groups load, it still links", () => {
  const groups = new Map([["grp1", "Auth work"]]);
  assert.deepEqual(resolveAppLink("sova://g/gone", null, groups), { kind: "text" });
  assert.deepEqual(resolveAppLink("sova://g/gone/s/id1", null, groups), { kind: "text" });
  assert.deepEqual(resolveAppLink("sova://g/grp9", null, null), { kind: "route", href: "#/g/grp9" }, "the workspace route's own recheck decides");
});

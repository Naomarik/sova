// Run: pnpm test -- src/lib/section-reveal.test.ts
// A sidebar section holding the open session opens when you move to that session, once; a collapse on that visit
// sticks (§app.session-list/regions-top-and-archive, §app.projects/list, §app.session-list/organizations).
import assert from "node:assert/strict";
import { test } from "node:test";
import { dismissalAfterToggle, nextVisit, revealsSelected, type Visit } from "./section-reveal";

const counter = () => {
  let n = 0;
  return () => ++n;
};

test("a visit changes only when the open session does: a refresh hands back the same visit", () => {
  const mint = counter();
  const first = nextVisit({ path: null, n: 0 }, "/a.jsonl", mint);
  assert.deepEqual(first, { path: "/a.jsonl", n: 1 });
  assert.equal(nextVisit(first, "/a.jsonl", mint), first, "the same object, so a memo stays quiet");
  const b = nextVisit(first, "/b.jsonl", mint);
  assert.equal(b.n, 2);
  const backToA = nextVisit(b, "/a.jsonl", mint);
  assert.notEqual(backToA.n, first.n, "moving back to a session is a new visit");
});

test("the page loading with no session open still mints a first visit", () => {
  const v = nextVisit({ path: null, n: 0 }, null, counter());
  assert.equal(v.n, 1);
});

test("a collapse while the section holds the open session is remembered for that visit only", () => {
  assert.equal(dismissalAfterToggle(false, true, 7), 7);
  assert.equal(dismissalAfterToggle(false, false, 7), undefined, "a collapse elsewhere: the choice alone answers");
  assert.equal(dismissalAfterToggle(true, true, 7), undefined, "an open clears it");
});

test("reveal: held and not dismissed on this visit", () => {
  assert.equal(revealsSelected(true, undefined, 3), true, "moved to a session inside");
  assert.equal(revealsSelected(true, 3, 3), false, "collapsed on this visit");
  assert.equal(revealsSelected(true, 2, 3), true, "collapsed on an earlier visit: moving again reveals");
  assert.equal(revealsSelected(false, undefined, 3), false);
});

test("the whole sequence: reveal, collapse sticks, expand, collapse sticks again, a new visit reveals", () => {
  const mint = counter();
  let visit: Visit = nextVisit({ path: null, n: 0 }, "/a.jsonl", mint);
  let dismissed: number | undefined;
  const open = (chosen: boolean) => revealsSelected(true, dismissed, visit.n) || chosen;
  let chosen = false;
  assert.equal(open(chosen), true, "revealed on arrival");
  chosen = false;
  dismissed = dismissalAfterToggle(false, true, visit.n);
  for (let i = 0; i < 5; i++) {
    visit = nextVisit(visit, "/a.jsonl", mint); // refreshes
    assert.equal(open(chosen), false, "stays shut through refreshes");
  }
  chosen = true;
  dismissed = dismissalAfterToggle(true, true, visit.n);
  assert.equal(open(chosen), true, "expanded by hand");
  chosen = false;
  dismissed = dismissalAfterToggle(false, true, visit.n);
  assert.equal(open(chosen), false, "collapsed again on the same session: it sticks");
  visit = nextVisit(visit, "/b.jsonl", mint);
  assert.equal(open(chosen), true, "moving to another session inside reveals it again");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantProblemText, isDeadLink, OwnerLoadError, ownerProblemOf } from "./owner-problem";

const kind = (status: number, body: unknown, read: "home" | "sub" | "assistant") => ownerProblemOf(status, body, read)?.kind ?? null;

test("a success is no problem, on every read", () => {
  for (const read of ["home", "sub", "assistant"] as const) for (const s of [200, 202, 204]) assert.equal(ownerProblemOf(s, {}, read), null);
});

test("the Project Assistant reads statuses as the page's own reads do, except a 404 with no code", () => {
  const cases: [number, unknown][] = [
    [410, { why: "expired" }],
    [410, { why: "revoked" }],
    [410, {}],
    [404, { code: "not-found" }],
    [429, {}],
    [503, { error: "offline" }],
    [500, {}],
    [502, null],
    [400, "not json"],
  ];
  for (const [status, body] of cases) assert.equal(kind(status, body, "assistant"), kind(status, body, "home"), `${status} ${JSON.stringify(body)}`);
  // The one difference: an older gateway's edge refusal says nothing but "Not found".
  assert.equal(kind(404, { error: "Not found" }, "assistant"), "unavailable");
  assert.equal(kind(404, {}, "assistant"), "unavailable");
  assert.equal(kind(404, { error: "Not found" }, "home"), "unknown");
});

test("410: turned off unused is expired (and carries asked), anything else gone", () => {
  const e = ownerProblemOf(410, { why: "expired", asked: true }, "assistant")!;
  assert.equal(e.kind, "expired");
  assert.equal(e.asked, true);
  assert.equal(ownerProblemOf(410, { why: "expired" }, "assistant")!.asked, false);
  assert.equal(kind(410, { why: "replaced" }, "assistant"), "gone");
});

test("404: missing only on a project or conversation read; any other code is the link", () => {
  assert.equal(kind(404, { code: "missing" }, "sub"), "missing");
  assert.equal(kind(404, { code: "missing" }, "home"), "unknown");
  assert.equal(kind(404, { code: "missing" }, "assistant"), "unknown");
  assert.equal(kind(404, { code: "not-found" }, "sub"), "unknown");
  assert.equal(kind(404, {}, "sub"), "unknown");
});

test("429, 503 and the rest", () => {
  assert.equal(kind(429, {}, "assistant"), "busy");
  assert.equal(kind(503, {}, "assistant"), "offline");
  assert.equal(kind(500, {}, "assistant"), "failed");
  assert.equal(kind(413, {}, "sub"), "failed");
});

test("dead-link kinds are the link itself; the rest leave the page", () => {
  for (const k of ["unknown", "gone", "expired", "busy"] as const) assert.equal(isDeadLink(k), true, k);
  for (const k of ["missing", "offline", "unavailable", "failed", null, undefined] as const) assert.equal(isDeadLink(k), false, String(k));
  assert.ok(ownerProblemOf(500, {}, "home") instanceof OwnerLoadError);
});

test("the Project Assistant's own problem words: never that the link still works", () => {
  const u = assistantProblemText("unavailable", "Sam");
  assert.deepEqual(u, { title: "The Project Assistant can't open on this link yet.", body: "Sam has to update the server your link goes through. Your projects still open.", tryAgain: false });
  const f = assistantProblemText("failed", "Sam");
  assert.deepEqual(f, { title: "We couldn't load the Project Assistant.", body: "Try again in a minute.", tryAgain: true });
  for (const t of [u, f]) assert.doesNotMatch(`${t.title} ${t.body}`, /still works/);
});

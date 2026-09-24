import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { extFrameSrc, extHref, extRouteFromHash, OPEN_SESSION, parseOpenSession } from "./ext-route";

test("extRouteFromHash reads #/ext/<id>, with or without a trailing slash", () => {
  assert.equal(extRouteFromHash("#/ext/dataico"), "dataico");
  assert.equal(extRouteFromHash("#/ext/my.ext_2-b/"), "my.ext_2-b");
});

test("extRouteFromHash refuses other routes, deeper paths and ids the manifest can't hold", () => {
  for (const hash of ["", "#/", "#/ext", "#/ext/", "#/ext/a/b", "#/s/%2Ftmp%2Fx.jsonl", "#/g/ext", "#/extra/a",
    "#/ext/..", "#/ext/.", "#/ext/a%2Fb", "#/ext/a b", "#ext/a"]) {
    assert.equal(extRouteFromHash(hash), null, hash);
  }
});

test("extHref and extFrameSrc round-trip through the route", () => {
  for (const id of ["dataico", "a.b", "x_y-z"]) {
    assert.equal(extRouteFromHash(extHref(id)), id);
    assert.equal(extFrameSrc(id), `/ext/${id}/`);
  }
});

// A summary exactly as POST /api/sessions returned it (captured from the test server, 201), so
// the real thing must pass; typed as SessionSummary, so it can't drift from the interface either.
const real: SessionSummary = {
  id: "01a0d51c-4ad0-73b7-a178-b77e63be81aa",
  path: "/home/u/.pi/agent/sessions/--tmp--/2026-09-24T20-29-56-304Z_01a0d51c-4ad0-73b7-a178-b77e63be81aa.jsonl",
  cwd: "/tmp",
  title: "Untitled",
  createdAt: "2026-09-24T20:29:56.304Z",
  lastActiveAt: "2026-09-24T20:29:56.303Z",
  model: null,
  live: null,
  origin: "web",
  archived: false,
  busy: false,
};

describe("parseOpenSession", () => {
  const frame = { name: "the extension's window" };
  const other = { name: "some other window" };
  const origin = "http://127.0.0.1:4830";
  const ok: { origin: string; source: unknown; data: unknown } = { origin, source: frame, data: { type: OPEN_SESSION, session: real } };
  const parse = (patch: Partial<typeof ok>, expected: { origin: string; frame: unknown } = { origin, frame }) =>
    parseOpenSession({ ...ok, ...patch }, expected);
  const withSession = (session: unknown) => parse({ data: { type: OPEN_SESSION, session } });

  test("a real POST /api/sessions summary from the extension's own frame and this origin opens", () => {
    assert.deepEqual(parse({}), { session: real });
    const remote = { ...real, target: "box-1", remoteCwd: "/srv/app", live: { pid: 7, status: "idle" }, model: "zai/glm-5.3" };
    assert.deepEqual(withSession(remote), { session: remote });
  });

  test("another origin or another window is ignored silently", () => {
    assert.equal(parse({ origin: "http://evil.test" }), null);
    assert.equal(parse({ source: other }), null);
    assert.equal(parse({ source: null }), null);
    assert.equal(parse({}, { origin, frame: null }), null, "no iframe yet: nothing is its message");
  });

  test("another message type, or no data, is ignored silently", () => {
    for (const data of [null, "sova:open-session", { type: "sova:open", session: real }, { session: real }, [OPEN_SESSION]]) {
      assert.equal(parse({ data }), null, JSON.stringify(data));
    }
  });

  test("an incomplete session is refused with the reason, never opened", () => {
    // The shape that threw in the parent (localeCompare of undefined): path, cwd and id only.
    const stub = { path: real.path, cwd: real.cwd, id: real.id };
    const bad: unknown[] = [
      undefined,
      null,
      [real],
      stub,
      { ...real, path: undefined },
      { ...real, path: 42 },
      { ...real, path: "relative/a.jsonl" },
      { ...real, path: "/home/u/notes.txt" },
      { ...real, cwd: "" },
    ];
    for (const key of ["id", "title", "createdAt", "lastActiveAt", "model", "live", "busy", "archived", "origin"]) {
      const s: Record<string, unknown> = { ...real };
      delete s[key];
      bad.push(s);
    }
    bad.push({ ...real, lastActiveAt: 5 }, { ...real, live: { pid: "7" } }, { ...real, origin: "tui" }, { ...real, target: 3 });
    for (const s of bad) {
      const r = withSession(s);
      assert.ok(r && "error" in r, JSON.stringify(s));
    }
    assert.deepEqual(withSession(stub), { error: "title must be a string" });
  });
});

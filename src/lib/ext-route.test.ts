import assert from "node:assert/strict";
import { describe, test } from "node:test";
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

describe("parseOpenSession", () => {
  const frame = { name: "the extension's window" };
  const other = { name: "some other window" };
  const origin = "http://127.0.0.1:4830";
  const session = { id: "s1", path: "/home/u/.pi/agent/sessions/--x--/a.jsonl", cwd: "/home/u/x", title: "Untitled" };
  const ok: { origin: string; source: unknown; data: unknown } = { origin, source: frame, data: { type: OPEN_SESSION, session } };
  const parse = (patch: Partial<typeof ok>, expected: { origin: string; frame: unknown } = { origin, frame }) =>
    parseOpenSession({ ...ok, ...patch }, expected);

  test("the extension's own frame, this origin, the right type and a session: the session", () => {
    assert.equal(parse({}), session);
  });

  test("another origin or another window is ignored", () => {
    assert.equal(parse({ origin: "http://evil.test" }), null);
    assert.equal(parse({ source: other }), null);
    assert.equal(parse({ source: null }), null);
    assert.equal(parse({}, { origin, frame: null }), null, "no iframe yet: nothing is its message");
  });

  test("another message type, or no data, is ignored", () => {
    for (const data of [null, "sova:open-session", { type: "sova:open" , session }, { session }, [OPEN_SESSION]]) {
      assert.equal(parse({ data }), null, JSON.stringify(data));
    }
  });

  test("a session without a usable path or cwd is ignored", () => {
    const bad: unknown[] = [
      undefined,
      null,
      [session],
      { ...session, path: undefined },
      { ...session, path: 42 },
      { ...session, path: "relative/a.jsonl" },
      { ...session, path: "/home/u/notes.txt" },
      { ...session, cwd: undefined },
      { ...session, cwd: "" },
    ];
    for (const s of bad) assert.equal(parse({ data: { type: OPEN_SESSION, session: s } }), null, JSON.stringify(s));
  });
});

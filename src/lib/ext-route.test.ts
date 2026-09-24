import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { extFrameSrc, extHref, extRouteFromHash, MAXIMIZE, OPEN_SESSION, parseExtMessage, RESTORE, ROUTE, subFromExtHash } from "./ext-route";

test("extRouteFromHash reads #/ext/<id>, with or without a trailing slash, as the extension's home", () => {
  assert.deepEqual(extRouteFromHash("#/ext/dataico"), { id: "dataico", sub: null });
  assert.deepEqual(extRouteFromHash("#/ext/my.ext_2-b/"), { id: "my.ext_2-b", sub: null });
});

test("extRouteFromHash reads a sub-route after the id", () => {
  assert.deepEqual(extRouteFromHash("#/ext/dataico/row/dataico:dataico-wt1"), { id: "dataico", sub: "row/dataico:dataico-wt1" });
  assert.deepEqual(extRouteFromHash("#/ext/a/row/dataico%3Awt1/"), { id: "a", sub: "row/dataico%3Awt1/" });
});

test("a sub-route an extension hash can't carry is dropped, and the extension opens at home", () => {
  for (const hash of ["#/ext/a/b c", "#/ext/a/x?y=1", "#/ext/a/x#y", "#/ext/a/<script>"]) {
    assert.deepEqual(extRouteFromHash(hash), { id: "a", sub: null }, hash);
  }
});

test("extRouteFromHash refuses other routes and ids the manifest can't hold", () => {
  for (const hash of ["", "#/", "#/ext", "#/ext/", "#/s/%2Ftmp%2Fx.jsonl", "#/g/ext", "#/extra/a",
    "#/ext/..", "#/ext/.", "#/ext/../x", "#/ext/a%2Fb", "#/ext/a b", "#ext/a"]) {
    assert.equal(extRouteFromHash(hash), null, hash);
  }
});

test("extHref and extFrameSrc carry the sub-route, and round-trip through the route", () => {
  for (const id of ["dataico", "a.b", "x_y-z"]) {
    assert.deepEqual(extRouteFromHash(extHref(id)), { id, sub: null });
    assert.equal(extFrameSrc(id), `/ext/${id}/`);
    assert.equal(extFrameSrc(id, null), `/ext/${id}/`);
  }
  assert.equal(extHref("dataico", "row/dataico:wt1"), "#/ext/dataico/row/dataico:wt1");
  assert.deepEqual(extRouteFromHash(extHref("dataico", "row/dataico:wt1")), { id: "dataico", sub: "row/dataico:wt1" });
  assert.equal(extFrameSrc("dataico", "row/dataico:wt1"), "/ext/dataico/#/row/dataico:wt1");
});

test("subFromExtHash: an extension hash to its sub-route, #/ to the home", () => {
  assert.equal(subFromExtHash("#/row/dataico:wt1"), "row/dataico:wt1");
  assert.equal(subFromExtHash("#/"), null);
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

describe("parseExtMessage", () => {
  const frame = { name: "the extension's window" };
  const other = { name: "some other window" };
  const origin = "http://127.0.0.1:4830";
  const ok: { origin: string; source: unknown; data: unknown } = { origin, source: frame, data: { type: OPEN_SESSION, session: real } };
  const parse = (patch: Partial<typeof ok>, expected: { origin: string; frame: unknown } = { origin, frame }) =>
    parseExtMessage({ ...ok, ...patch }, expected);
  const withSession = (session: unknown) => parse({ data: { type: OPEN_SESSION, session } });

  test("a real POST /api/sessions summary from the extension's own frame and this origin opens", () => {
    assert.deepEqual(parse({}), { kind: "open-session", session: real });
    const remote = { ...real, target: "box-1", remoteCwd: "/srv/app", live: { pid: 7, status: "idle" }, model: "zai/glm-5.3" };
    assert.deepEqual(withSession(remote), { kind: "open-session", session: remote });
  });

  test("another origin or another window is ignored silently", () => {
    assert.equal(parse({ origin: "http://evil.test" }), null);
    assert.equal(parse({ source: other }), null);
    assert.equal(parse({ source: null }), null);
    assert.equal(parse({}, { origin, frame: null }), null, "no iframe yet: nothing is its message");
  });

  test("another message type, or no data, is ignored silently", () => {
    for (const data of [null, "sova:open-session", { type: "sova:open", session: real }, { session: real }, [OPEN_SESSION], { type: "sova:maximized", on: true }]) {
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
    assert.deepEqual(withSession(stub), { error: "sova:open-session: title must be a string" });
  });

  test("maximize, restore and route are accepted from the extension's own frame and this origin", () => {
    assert.deepEqual(parse({ data: { type: MAXIMIZE } }), { kind: "maximize" });
    assert.deepEqual(parse({ data: { type: RESTORE } }), { kind: "restore" });
    assert.deepEqual(parse({ data: { type: ROUTE, hash: "#/row/dataico:dataico-wt1" } }), { kind: "route", hash: "#/row/dataico:dataico-wt1" });
    assert.deepEqual(parse({ data: { type: ROUTE, hash: "#/" } }), { kind: "route", hash: "#/" });
  });

  test("maximize, restore and route from another origin or window are ignored", () => {
    for (const data of [{ type: MAXIMIZE }, { type: RESTORE }, { type: ROUTE, hash: "#/row/x" }]) {
      assert.equal(parse({ data, origin: "http://evil.test" }), null, JSON.stringify(data));
      assert.equal(parse({ data, source: other }), null, JSON.stringify(data));
      assert.equal(parse({ data }, { origin, frame: null }), null, JSON.stringify(data));
    }
  });

  test("a route with a hash outside #/[A-Za-z0-9._~:%/-]* is refused with the reason", () => {
    for (const hash of [undefined, 3, "", "#", "row/x", "/row/x", "#row", "#/a b", "#/x?y", "#/x#y", "#/<b>", "javascript:alert(1)"]) {
      const r = parse({ data: { type: ROUTE, hash } });
      assert.ok(r && "error" in r, JSON.stringify(hash));
    }
  });
});

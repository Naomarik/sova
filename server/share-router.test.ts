// Run: node scripts/run-tests.mjs server/share-router.test.ts. The gateway router's path parsing
// (§mesh.public/routing), in process; the router behind the real share edge, with fake routed hosts
// on loopback ports, is share-router.integration.test.ts. A throwaway PI_CODING_AGENT_DIR; ~/.pi
// untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-router-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { routeOf } = await import("./share/router");
const { forwardShape, shareMayReach, STRICT_ROUTES } = await import("./share/edge");

const T = (c: string) => c.repeat(43);

test("routeOf: every share path's kind", () => {
  assert.deepEqual(routeOf(`/h/${T("a")}`), { kind: "h", token: T("a") });
  assert.deepEqual(routeOf(`/api/h/${T("a")}/message`), { kind: "h", token: T("a") });
  assert.deepEqual(routeOf(`/api/i/${T("a")}/p/q_abcdefgh`), { kind: "i", token: T("a") });
  assert.deepEqual(routeOf("/h/assets/index-x.js"), { kind: "asset", name: "index-x.js" });
});

test("routeOf: the session share paths are kind s", () => {
  assert.deepEqual(routeOf(`/s/${T("a")}`), { kind: "s", token: T("a") });
  assert.deepEqual(routeOf(`/api/s/${T("a")}`), { kind: "s", token: T("a") });
  assert.deepEqual(routeOf(`/api/s/${T("a")}/img/12`), { kind: "s", token: T("a") });
  // The kind is the prefix's, whatever follows: the edge judged the whole path already.
  assert.deepEqual(routeOf(`/api/s/${T("a")}/message`), { kind: "s", token: T("a") });
  assert.equal(routeOf(`/api/x/${T("a")}`), null);
  assert.equal(routeOf(`/api/i/${T("a").slice(1)}`), null);
});

test("every address the edge's strict routes admit for a kind routes to that kind, and the forward-only tier admits it too", () => {
  const t = T("a");
  // One sample per strict route; a route with no sample fails below, so a new route needs one.
  const samples: [string, string, "h" | "i" | "s" | "t" | "asset"][] = [
    ["GET", `/h/${t}`, "h"],
    ["GET", "/h/assets/index-abc.js", "asset"],
    ["GET", `/api/h/${t}`, "h"],
    ["POST", `/api/h/${t}/message`, "h"],
    ["POST", `/api/h/${t}/image`, "h"],
    ["GET", `/api/h/${t}/img/3`, "h"],
    ["POST", `/api/h/${t}/file`, "h"],
    ["GET", `/i/${t}`, "i"],
    ["GET", `/api/i/${t}`, "i"],
    ["GET", `/api/i/${t}/p/q_abcdefgh`, "i"],
    ["GET", `/api/i/${t}/c/k_abcdefgh`, "i"],
    ["POST", `/i/${t}/ask-link`, "i"],
    ["GET", `/api/i/${t}/assistant`, "i"],
    ["POST", `/api/i/${t}/assistant`, "i"],
    ["GET", `/i/${t}/v/v_abcdefgh`, "i"],
    ["GET", `/api/h/${t}/tours/tr_${"b".repeat(16)}/assets/one-1.png`, "h"],
    ["PUT", `/api/h/${t}/tours/tr_${"b".repeat(16)}/progress`, "h"],
    ["GET", `/api/i/${t}/c/k_abcdefgh/tours/tr_${"b".repeat(16)}`, "i"],
    ["GET", `/t/${t}`, "t"],
    ["GET", `/api/t/${t}/progress`, "t"],
    ["POST", `/api/t/${t}/readers`, "t"],
    ["PUT", `/api/t/${t}/progress`, "t"],
    ["GET", `/s/${t}`, "s"],
    ["GET", `/api/s/${t}`, "s"],
    ["GET", `/api/s/${t}/img/12`, "s"],
  ];
  const covered = new Set<number>();
  for (const [method, path, kind] of samples) {
    assert.ok(shareMayReach(method, path), `${method} ${path} is a strict route`);
    STRICT_ROUTES.forEach((r, i) => r.method === method && r.re.test(path) && covered.add(i));
    const route = routeOf(path);
    assert.equal(route?.kind, kind, `${method} ${path}`);
    if (route && route.kind !== "asset") {
      assert.equal(route.token, t);
      // A tokened address with more after it passes the forward-only shape as well.
      if (path.split("/").length > (path.startsWith("/api/") ? 4 : 3)) assert.ok(forwardShape(method, path), `${method} ${path} is forward-only well formed`);
    }
  }
  const missing = STRICT_ROUTES.map((r, i) => (covered.has(i) ? null : `${r.method} ${r.re.source}`)).filter(Boolean);
  assert.deepEqual(missing, [], "every strict route has a sample here");
});

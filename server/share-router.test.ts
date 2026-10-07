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
  assert.equal(routeOf(`/api/s/${T("a")}/message`), null);
});

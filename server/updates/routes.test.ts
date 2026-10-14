import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { OVERSEER_SENDER_HEADER, senderSecret } from "../overseer-sender";
import { scratchRoot } from "../test-scratch";
import { gitIn } from "./git";
import { UpdatesManager } from "./manager";
import { OPERATOR_ONLY, registerUpdatesRoutes, setUpdatesForTest } from "./routes";

/**
 * Only the operator acts on updates: a same-origin browser request on the
 * main listener. An in-process call (no socket), the peer listener and the Overseer's mark are
 * refused; reading is open to any gated caller.
 */

const root = scratchRoot("updates-routes-");
const calls: string[] = [];
const m = new UpdatesManager({
  file: join(root, "updates.json"),
  jobsDir: join(root, "jobs"),
  repo: "file:///nowhere",
  checksOff: true,
  startedHead: null,
  install: async () => ({ kind: "check-only", whyNot: "This server doesn't run from a git checkout, so it can't check or upgrade.", checkout: null, unit: null, launcher: null, installPort: null, noExtensions: false, noAppEntry: false }),
  git: (d) => gitIn(d),
  now: () => Date.parse("2026-10-14T12:00:00Z"),
  timers: { set: () => 0, clear: () => {} },
  startDelayMs: 0,
  launch: async () => {
    calls.push("launch");
    return null;
  },
  port: () => 4800,
  healthUrl: () => "http://127.0.0.1:4800/api/health",
  pid: 1,
  uid: 1000,
  jobEnv: () => ({}),
  serverLog: join(root, "app-server.log"),
  log: () => {},
});
setUpdatesForTest(m);
after(() => setUpdatesForTest(null));

const app = new Hono();
registerUpdatesRoutes(app);

const BROWSER = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const socket = { incoming: {} };
const call = (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; env?: unknown } = {}) =>
  app.request(path, { method, headers: opts.headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, opts.env as never);

test("reading is any gated caller's, in-process included", async () => {
  const r = await call("GET", "/api/updates");
  assert.equal(r.status, 200);
  const s = (await r.json()) as { settings: { source: { kind: string }; autoCheck: boolean; autoUpgrade: boolean }; checksOff: boolean; running: { kind: string } };
  assert.deepEqual(s.settings, { source: { kind: "stable" }, autoCheck: true, autoUpgrade: false });
  assert.equal(s.running.kind, "check-only");
});

for (const [route, method, body] of [
  ["/api/updates/check", "POST", undefined],
  ["/api/updates/settings", "PUT", { autoUpgrade: true }],
  ["/api/updates/apply", "POST", { target: "a".repeat(40), confirm: true }],
] as const) {
  test(`${method} ${route}: refused with no socket, from the peer listener, with the Overseer's mark, or without a browser's same-origin mark`, async () => {
    for (const [why, env, headers] of [
      ["in-process", undefined, BROWSER],
      ["peer listener", { incoming: {}, meshPeer: { name: "peer" } }, BROWSER],
      ["the Overseer", socket, { ...BROWSER, [OVERSEER_SENDER_HEADER]: senderSecret() }],
      ["not a browser", socket, { "content-type": "application/json" }],
      ["a cross-site page", socket, { "sec-fetch-site": "cross-site", "content-type": "application/json" }],
    ] as const) {
      const r = await call(method, route, { env, headers, body });
      assert.equal(r.status, 403, why);
      assert.deepEqual(await r.json(), { error: OPERATOR_ONLY }, why);
    }
    assert.equal(calls.length, 0, "nothing ran");
  });
}

test("the operator's browser: settings save; a check with checks off says so; an upgrade needs its confirm", async () => {
  const saved = await call("PUT", "/api/updates/settings", { env: socket, headers: BROWSER, body: { autoUpgrade: true, autoCheck: false } });
  assert.equal(saved.status, 200);
  assert.deepEqual(((await saved.json()) as { settings: unknown }).settings, { source: { kind: "stable" }, autoCheck: false, autoUpgrade: true });
  const check = await call("POST", "/api/updates/check", { env: socket, headers: BROWSER });
  assert.equal(check.status, 409);
  assert.match(((await check.json()) as { error: string }).error, /Checks are off on this server/);
  const unconfirmed = await call("POST", "/api/updates/apply", { env: socket, headers: BROWSER, body: { target: "a".repeat(40) } });
  assert.equal(unconfirmed.status, 400);
  const apply = await call("POST", "/api/updates/apply", { env: socket, headers: BROWSER, body: { target: "a".repeat(40), confirm: true } });
  assert.equal(apply.status, 409, "a check-only copy can't upgrade");
  assert.match(((await apply.json()) as { error: string }).error, /doesn't run from a git checkout/);
  assert.equal(calls.length, 0);
});

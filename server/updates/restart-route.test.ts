// Run: pnpm test -- server/updates/restart-route.test.ts
// POST /api/updates/restart (Restart Sova), through the app as the listener hands requests to it
// (app.fetch with env.incoming, as server/caller-auth.test.ts does), with a stand-in manager whose
// scheduler only records: only the operator's same-origin browser and a caller showing the install
// token (the command line, a script) may restart; the peer listener, the Overseer's mark, an
// in-process call and a cross-site page are refused and schedule nothing; a running upgrade refuses
// it; a `sova run server.restart` call leaves its command row in the audit.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const tmp = mkdtempSync(join(tmpdir(), "sova-restart-route-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
for (const name of ["SOVA_TOKEN", "SOVA_AUTH", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_CALLER_KEY"]) delete process.env[name];
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { buildApp } = await import("../app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { AUTH_COOKIE, initAuthToken, setAuthPort, sovaToken } = await import("../auth");
const { commandAudit } = await import("../command-audit");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("../overseer-sender");
const { gitIn } = await import("./git");
const { RESTART_DURING_UPGRADE, RESTART_NO_SERVICE, UpdatesManager } = await import("./manager");
const { registerUpdatesRoutes, RESTART_REFUSED, setUpdatesForTest } = await import("./routes");
type ServiceUnit = import("./install-kind").ServiceUnit;

const port = 47_919;
initAuthToken();
setAuthPort(port);
const token = sovaToken();
const self = `127.0.0.1:${port}`;

const scheduled: ServiceUnit[] = [];
let unit: ServiceUnit | null = { manager: "systemd", name: "sova-runtime.service" };
const jobsDir = join(tmp, "jobs");
let m: InstanceType<typeof UpdatesManager>;
function fresh() {
  m = new UpdatesManager({
    file: join(tmp, "updates.json"),
    jobsDir,
    repo: "file:///nowhere",
    checksOff: true,
    startedHead: null,
    install: async () => ({ kind: unit ? "developer" : "check-only", whyNot: null, checkout: null, unit, launcher: null, installPort: null, noExtensions: false, noAppEntry: false }),
    git: (d) => gitIn(d),
    now: () => Date.now(),
    timers: { set: () => 0, clear: () => {} },
    startDelayMs: 0,
    launch: async () => null,
    port: () => port,
    healthUrl: () => `http://${self}/api/health`,
    pid: 1,
    uid: 1000,
    jobEnv: () => ({}),
    serverLog: join(tmp, "app-server.log"),
    log: () => {},
    startedAt: "2026-10-29T11:00:00.000Z",
    restart: async (u) => (scheduled.push(u), null),
    restartDelaySec: 3,
  });
  setUpdatesForTest(m);
}
beforeEach(() => {
  scheduled.length = 0;
  unit = { manager: "systemd", name: "sova-runtime.service" };
  rmSync(jobsDir, { recursive: true, force: true });
  fresh();
});
after(() => {
  setUpdatesForTest(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function send(headers: Record<string, string>, env: Record<string, unknown> = {}) {
  const sent: Record<string, string> = { Host: self, ...headers };
  const lower = Object.fromEntries(Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]));
  const incoming = { headers: lower, socket: { remoteAddress: "127.0.0.1" }, url: "/api/updates/restart", method: "POST" };
  const res = await app.fetch(new Request(`http://${self}/api/updates/restart`, { method: "POST", headers: sent }), { incoming, ...env });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const BROWSER = { Cookie: `${AUTH_COOKIE}=${token}`, Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin" };
const CLI = { "x-sova-token": token, "x-sova-command": "server.restart" };

async function health(): Promise<{ startedAt: string }> {
  const incoming = { headers: { host: self, cookie: `${AUTH_COOKIE}=${token}` }, socket: { remoteAddress: "127.0.0.1" }, url: "/api/health", method: "GET" };
  const res = await app.fetch(new Request(`http://${self}/api/health`, { headers: { Host: self, Cookie: `${AUTH_COOKIE}=${token}` } }), { incoming });
  assert.equal(res.status, 200);
  return (await res.json()) as { startedAt: string };
}

test("the operator's browser: 202 with exactly the startedAt GET /api/health answers, and the service is scheduled once", async () => {
  const r = await send(BROWSER);
  assert.equal(r.status, 202);
  const h = await health();
  // The Settings block waits for health to answer another start: the reply and health must be one value,
  // or the old process's first answer reads as a new start.
  assert.equal(r.body.startedAt, h.startedAt);
  assert.deepEqual(r.body, { scheduled: true, startedAt: h.startedAt, inSeconds: 3 });
  assert.deepEqual(scheduled, [{ manager: "systemd", name: "sova-runtime.service" }]);
});

test("the command line (the token, sova run's command header): 202, and its row in the audit names the command", async () => {
  await commandAudit.flush();
  const r = await send(CLI);
  assert.equal(r.status, 202);
  assert.equal(scheduled.length, 1);
  await commandAudit.flush();
  const row = (await commandAudit.list({ command: "server.restart" })).rows[0];
  assert.deepEqual(row && { caller: row.caller, method: row.method, route: row.route, status: row.status }, { caller: "no-key", method: "POST", route: "/api/updates/restart", status: 202 });
  // A script with the token and no command name: let in too.
  fresh();
  assert.equal((await send({ "x-sova-token": token })).status, 202);
});

test("refused, scheduling nothing: the Overseer's mark, a cross-site page, a page with no site mark, a wrong token", async () => {
  for (const [why, headers, status] of [
    ["the Overseer, with the token", { ...CLI, [OVERSEER_SENDER_HEADER]: senderSecret() }, 403],
    ["the Overseer, in a browser", { ...BROWSER, [OVERSEER_SENDER_HEADER]: senderSecret() }, 403],
    ["a cross-site page with the cookie", { Cookie: `${AUTH_COOKIE}=${token}`, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, 403],
    ["the cookie with no site mark", { Cookie: `${AUTH_COOKIE}=${token}` }, 403],
    ["a wrong token", { "x-sova-token": "not-the-token-not-the-token-xx" }, 401],
  ] as const) {
    const r = await send(headers);
    assert.equal(r.status, status, why);
  }
  assert.equal(scheduled.length, 0, "nothing scheduled");
});

test("the route itself: refused for the peer listener and an in-process call, with the token or a browser's mark", async () => {
  // The peer listener hands its requests in with meshPeer (no gate here: the route's own check).
  const bare = new Hono();
  registerUpdatesRoutes(bare);
  const call = (headers: Record<string, string>, env: unknown) => bare.request("/api/updates/restart", { method: "POST", headers }, env as never);
  for (const [why, headers, env] of [
    ["peer listener, browser", { "sec-fetch-site": "same-origin" }, { incoming: {}, meshPeer: { name: "peer" } }],
    ["peer listener, token", { "x-sova-token": token }, { incoming: {}, meshPeer: { name: "peer" } }],
    ["in-process, browser mark", { "sec-fetch-site": "same-origin" }, undefined],
    ["in-process, token", { "x-sova-token": token }, undefined],
  ] as const) {
    const r = await call(headers, env);
    assert.equal(r.status, 403, why);
    assert.deepEqual(await r.json(), { error: RESTART_REFUSED }, why);
  }
  assert.equal(scheduled.length, 0);
});

test("refused by the manager: a running upgrade (409), no service (409), each with its own sentence", async () => {
  const dir = join(jobsDir, "0000000aa-abcdef");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ id: "0000000aa-abcdef", kind: "developer", from: { sha: "a", label: "a" }, to: { sha: "b", label: "b" }, auto: false, startedAt: new Date().toISOString(), step: "building", state: "running", detail: null, logPath: "", endedAt: null }));
  assert.deepEqual(await send(BROWSER), { status: 409, body: { error: RESTART_DURING_UPGRADE } });
  rmSync(jobsDir, { recursive: true, force: true });
  unit = null;
  fresh();
  assert.deepEqual(await send(CLI), { status: 409, body: { error: RESTART_NO_SERVICE } });
  assert.equal(scheduled.length, 0);
});

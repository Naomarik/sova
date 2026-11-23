import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { OVERSEER_SENDER_HEADER, senderSecret } from "../overseer-sender";
import { scratchRoot } from "../test-scratch";
import { gitIn } from "./git";
import { UpdatesManager, type UpdatesDeps } from "./manager";
import { pageHeaders } from "../testing/page";
import { jobEnvOf, registerUpdatesRoutes, setUpdatesForTest } from "./routes";
import { makeRepos } from "./testing";

/**
 * Only the operator acts on updates: a same-origin browser request on the
 * main listener. An in-process call (no socket), the peer listener and the Overseer's mark are
 * refused; reading is open to any gated caller.
 */

const root = scratchRoot("updates-routes-");
const calls: string[] = [];
const deps: UpdatesDeps = {
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
};
const m = new UpdatesManager(deps);
setUpdatesForTest(m);
after(() => setUpdatesForTest(null));

const app = new Hono();
registerUpdatesRoutes(app);

const BROWSER = { "sec-fetch-site": "same-origin", "content-type": "application/json", ...pageHeaders() };
const UPDATE_REFUSAL = "Only the user updates Sova. Ask them to do it in Settings → General. Nothing was changed.";
const PEER_REFUSAL = "Only the user approves this, on the page of the computer it belongs to. Open Sova on that computer. Nothing changed.";
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
  test(`${method} ${route}: refused with no socket, from the peer listener, with the Overseer's mark, to a script or a chat, or without a browser's same-origin mark`, async () => {
    for (const [why, env, headers] of [
      ["in-process", undefined, BROWSER],
      ["peer listener", { incoming: {}, meshPeer: { name: "peer" } }, BROWSER],
      ["the Overseer", socket, { ...BROWSER, [OVERSEER_SENDER_HEADER]: senderSecret() }],
      ["not a browser", socket, { "content-type": "application/json" }],
      ["a cross-site page", socket, { ...BROWSER, "sec-fetch-site": "cross-site" }],
      ["the token in a header, claiming same-origin", socket, { "sec-fetch-site": "same-origin", "x-sova-token": "t" }],
      ["the token beside the cookie", socket, { ...BROWSER, "x-sova-token": "t" }],
      ["a chat's key", socket, { ...BROWSER, "x-sova-caller": "k" }],
    ] as const) {
      const r = await call(method, route, { env, headers, body });
      assert.equal(r.status, 403, why);
      const peer = why === "peer listener";
      assert.deepEqual(await r.json(), { error: peer ? PEER_REFUSAL : UPDATE_REFUSAL, yourClick: true, ...(peer ? { peer: true } : {}) }, why);
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

test("the job keeps the server's HOST and the tools' environment, and nothing else", () => {
  // A copy with no service is started again by the job: it must listen where it did (HOST), not on the default.
  const env = jobEnvOf({ HOST: "0.0.0.0", PATH: "/usr/bin", HOME: "/home/u", SOVA_UPDATES_REPO_URL: "file:///standin", ANTHROPIC_API_KEY: "secret", SOVA_CHAT_UNIT: "x" });
  assert.deepEqual(env, { HOST: "0.0.0.0", PATH: "/usr/bin", HOME: "/home/u", SOVA_UPDATES_REPO_URL: "file:///standin" });
});

test("GET /api/updates/notes: 404 with no changelog to show, so the button hides", async () => {
  const r = await call("GET", "/api/updates/notes");
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "This copy has no release notes to show." });
  const s = (await (await call("GET", "/api/updates")).json()) as { notesAvailable: boolean };
  assert.equal(s.notesAvailable, false);
});

test("GET /api/updates/notes: the running copy's releases, and a newer one a check found first, read like GET /api/updates", async () => {
  const r = makeRepos();
  const log = (...sections: string[]) => {
    writeFileSync(join(r.origin, "CHANGELOG.md"), `# Changelog\n\nSee [CONTRIBUTING.md](CONTRIBUTING.md).\n\n${sections.join("\n\n")}\n`);
    r.git(r.origin, "add", "CHANGELOG.md");
  };
  log("## v0.1.0 — 2026-10-01\n\nThe first.");
  r.commit(r.origin, "release v0.1.0");
  r.tag(r.origin, "v0.1.0");
  log("## v0.3.0 — 2026-10-20\n\nThe third.", "## v0.2.0 — 2026-10-10\n\nThe second.", "## v0.1.0 — 2026-10-01\n\nThe first.");
  r.commit(r.origin, "release v0.3.0");
  r.tag(r.origin, "v0.3.0");
  r.tag(r.origin, "stable");
  const copy = r.clone("at-v010", { ref: "v0.1.0" });
  const dir = scratchRoot("updates-notes-");
  const dev = new UpdatesManager({
    ...deps,
    file: join(dir, "updates.json"),
    jobsDir: join(dir, "jobs"),
    repo: r.url,
    checksOff: false,
    install: async () => ({ kind: "developer", whyNot: null, checkout: copy, unit: null, launcher: null, installPort: null, noExtensions: false, noAppEntry: false }),
  });
  setUpdatesForTest(dev);
  try {
    const before = (await (await call("GET", "/api/updates/notes")).json()) as { title: string; markdown: string };
    assert.equal(before.title, "Release Notes");
    assert.match(before.markdown, /^## v0\.1\.0 — 2026-10-01\n\nThe first\.\n$/, "no check yet: what runs, without the preamble");
    await dev.check();
    const res = await call("GET", "/api/updates/notes", { env: { incoming: {}, meshPeer: { name: "peer" } } });
    assert.equal(res.status, 200, "a read: the mesh gate (not this route) decides a peer's need");
    const after = (await res.json()) as { markdown: string; url: string | null };
    assert.match(after.markdown, /^# New in v0\.3\.0, not installed yet\n\n---\n\n## v0\.3\.0[^\n]*\n\nThe third\.\n\n## v0\.2\.0[^\n]*\n\nThe second\.\n\n# You're on v0\.1\.0\n\n---\n\n## v0\.1\.0/);
    assert.equal(after.url, null, "a stand-in repository has no GitHub page");
    assert.equal(((await (await call("GET", "/api/updates")).json()) as { notesAvailable: boolean }).notesAvailable, true);
  } finally {
    setUpdatesForTest(m);
  }
});

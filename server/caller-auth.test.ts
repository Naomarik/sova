// Run: pnpm test -- server/caller-auth.test.ts
// A chat's key beside the token, never instead of it (§app.command-audit/attribution), and the record
// it feeds (§app.command-audit/record), through the app as the listener hands requests to it
// (app.fetch with env.incoming, as server/auth-gate.test.ts does):
//   - can't elevate: every request in a matrix of paths, credentials and sites gets the same status
//     and body with no x-sova-caller, a live key, a dead key, a 10 KB value or the token itself in it;
//   - only a call that shows the token in x-sova-token leaves a row, and its caller is the key's chat;
//   - neither step of the record can change an answer.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, beforeEach, describe, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-caller-auth-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
for (const name of ["SOVA_TOKEN", "SOVA_AUTH", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_CALLER_KEY"]) delete process.env[name];
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { AUTH_COOKIE, initAuthToken, refuseUpgrade, setAuthPort, sovaToken, upgradeAllowed } = await import("./auth");
const { callerKeys } = await import("./caller-keys");
const { commandAudit } = await import("./command-audit");
const port = 47_917;
initAuthToken();
setAuthPort(port);
after(() => rmSync(tmp, { recursive: true, force: true }));

const token = sovaToken();
const self = `127.0.0.1:${port}`;
const live = new Set<string>();
callerKeys.setLiveness((chatId, unit) => live.has(`${chatId} ${unit}`));
const liveKey = callerKeys.issue("chat-live", "unit-live");
live.add("chat-live unit-live");
const deadKey = callerKeys.issue("chat-dead", "unit-dead");

async function send(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  const sent: Record<string, string> = { Host: self, ...headers };
  const lower = Object.fromEntries(Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]));
  const incoming = { headers: lower, socket: { remoteAddress: "127.0.0.1" }, url: path, method };
  const res = await app.fetch(new Request(`http://${self}${path}`, { method, headers: sent, body }), { incoming });
  return { status: res.status, body: await res.text() };
}
const rows = async () => (await commandAudit.list({ limit: 1000 })).rows;
const upgradeReq = (headers: Record<string, string>, url = "/ws/events") => ({ url, headers: { host: self, ...headers } }) as unknown as IncomingMessage;
const socket = () => ({ destroyed: false, end() {} }) as unknown as Duplex;

describe("can't elevate", () => {
  const PATHS: Array<[string, string, string?]> = [
    ["GET", "/api/settings/align"],
    ["GET", "/api/commands"],
    ["POST", "/api/sessions/title", JSON.stringify({ path: "/nowhere.jsonl", title: "x" })],
    ["GET", "/api/health"],
    ["POST", "/api/auth/unlock", JSON.stringify({ token: "nope" })],
    ["GET", "/"],
    ["GET", "/ext/none/api/x"],
    ["GET", "/api/no-such-route"],
  ];
  const CREDS: Record<string, Record<string, string>> = {
    none: {},
    cookie: { Cookie: `${AUTH_COOKIE}=${token}` },
    header: { "x-sova-token": token },
    wrong: { "x-sova-token": "not-the-token-not-the-token-xx" },
  };
  const SITES: Record<string, Record<string, string>> = {
    plain: {},
    same: { Origin: `http://${self}`, "Sec-Fetch-Site": "same-origin" },
    cross: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    foreignHost: { Host: "evil.example" },
  };
  const KEYS: Record<string, string | undefined> = { absent: undefined, live: liveKey, dead: deadKey, huge: "k".repeat(10_000), token };

  test("the same answer with any x-sova-caller, or none, whatever else the request carries", async () => {
    let compared = 0;
    for (const [method, path, body] of PATHS)
      for (const [cn, cred] of Object.entries(CREDS))
        for (const [sn, site] of Object.entries(SITES)) {
          const base = { ...cred, ...site, ...(body ? { "Content-Type": "application/json" } : {}) };
          const want = await send(method, path, base, body);
          for (const [kn, key] of Object.entries(KEYS)) {
            if (key === undefined) continue;
            const got = await send(method, path, { ...base, "x-sova-caller": key }, body);
            assert.deepEqual(got, want, `${method} ${path} ${cn} ${sn} with ${kn} key`);
            compared++;
          }
        }
    assert.equal(compared, PATHS.length * 4 * 4 * 4);
  });

  test("a key with no token is 401 with exactly the answer no credential gets; the token's value in x-sova-caller too", async () => {
    const none = await send("GET", "/api/settings/align");
    assert.equal(none.status, 401);
    for (const key of [liveKey, token]) assert.deepEqual(await send("GET", "/api/settings/align", { "x-sova-caller": key }), none);
  });

  test("sockets: the same verdict with any x-sova-caller", () => {
    const creds: Record<string, string>[] = [{}, { cookie: `${AUTH_COOKIE}=${token}` }, { "x-sova-token": token }, { origin: "https://evil.example", cookie: `${AUTH_COOKIE}=${token}` }];
    for (const cred of creds)
      for (const key of [liveKey, deadKey, token, "k".repeat(10_000)])
        assert.equal(upgradeAllowed(upgradeReq({ ...cred, "x-sova-caller": key })), upgradeAllowed(upgradeReq(cred)), JSON.stringify(Object.keys(cred)));
    assert.equal(upgradeAllowed(upgradeReq({ "x-sova-caller": liveKey })), false);
  });
});

describe("the record", () => {
  beforeEach(async () => {
    await commandAudit.flush();
  });

  test("a call that shows the token: a row naming the key's chat, or no-key, or unattributed", async () => {
    const before = (await rows()).length;
    assert.equal((await send("GET", "/api/settings/align", { "x-sova-token": token, "x-sova-caller": liveKey })).status, 200);
    assert.equal((await send("GET", "/api/settings/align", { "x-sova-token": token })).status, 200);
    assert.equal((await send("GET", "/api/settings/align", { "x-sova-token": token, "x-sova-caller": deadKey })).status, 200);
    const got = (await rows()).slice(0, (await rows()).length - before);
    assert.deepEqual(got.map((r) => r.caller), ["unattributed", "no-key", "chat:chat-live"]);
    for (const r of got) assert.deepEqual({ method: r.method, route: r.route, status: r.status }, { method: "GET", route: "/api/settings/align", status: 200 });
  });

  test("the row names the route as registered and the command only when it is a catalogue id; never a path, query or body", async () => {
    await send("GET", "/api/sessions/draft?path=/secret/wobblefish.jsonl", { "x-sova-token": token, "x-sova-command": "session.draft.get" });
    await send("POST", "/api/sessions/title", { "x-sova-token": token, "x-sova-command": "made.up forged", "Content-Type": "application/json" }, JSON.stringify({ path: "/secret/wobblefish.jsonl", title: "Wobblefish title" }));
    const [title, draft] = await rows();
    assert.equal(draft!.route, "/api/sessions/draft");
    assert.equal(draft!.command, "session.draft.get");
    assert.equal(title!.route, "/api/sessions/title");
    assert.equal(title!.command, undefined, "a name that is no catalogue id is left out");
    await commandAudit.flush();
    const text = readFileSync(commandAudit.file(), "utf8");
    for (const leak of ["wobblefish", "Wobblefish", "secret", "forged", token, liveKey]) assert.ok(!text.includes(leak), `${leak} is in the record`);
  });

  test("only the token's holder adds a row, and never for the page: no row for a cookie, a key alone, an exempt path with a junk token, auth off, or the page", async () => {
    const before = JSON.stringify(await rows());
    await send("GET", "/api/settings/align", { Cookie: `${AUTH_COOKIE}=${token}`, "x-sova-caller": liveKey });
    assert.equal((await send("GET", "/api/settings/align", { "x-sova-caller": liveKey, "x-sova-command": "settings.align.get" })).status, 401);
    assert.equal((await send("GET", "/api/health", { "x-sova-token": "junk-junk-junk-junk-junk-junk-junk", "x-sova-caller": liveKey })).status, 200);
    assert.equal((await send("POST", "/api/auth/unlock", { "x-sova-token": "junk", "Content-Type": "application/json" }, "{}")).status, 401);
    // The page and its files are never recorded, even fetched with the token.
    await send("GET", "/", { "x-sova-token": token });
    await send("GET", "/icons/sova-mark.svg", { "x-sova-token": token });
    process.env.SOVA_AUTH = "off";
    try {
      assert.equal((await send("GET", "/api/settings/align", { "x-sova-caller": liveKey })).status, 200);
      assert.equal((await send("GET", "/api/settings/align", { "x-sova-token": "junk" })).status, 200);
    } finally {
      delete process.env.SOVA_AUTH;
    }
    // Sockets: a cookie-only upgrade and a key with no token leave no row either.
    assert.equal(refuseUpgrade(upgradeReq({ cookie: `${AUTH_COOKIE}=${token}`, "x-sova-caller": liveKey }), socket()), false);
    assert.equal(refuseUpgrade(upgradeReq({ "x-sova-caller": liveKey }), socket()), true);
    assert.equal(JSON.stringify(await rows()), before);
    // A socket that shows the token: one row, its fixed path, 101.
    assert.equal(refuseUpgrade(upgradeReq({ "x-sova-token": token, "x-sova-caller": liveKey }, "/ws/events?stream=abc"), socket()), false);
    const [row] = await rows();
    assert.deepEqual({ caller: row!.caller, route: row!.route, status: row!.status }, { caller: "chat:chat-live", route: "/ws/events", status: 101 });
  });

  test("neither the record's start nor its note can change an answer", async () => {
    const want = await send("GET", "/api/settings/align", { "x-sova-token": token });
    const callerOf = callerKeys.callerOf.bind(callerKeys);
    callerKeys.callerOf = () => {
      throw new Error("injected");
    };
    try {
      assert.deepEqual(await send("GET", "/api/settings/align", { "x-sova-token": token, "x-sova-caller": liveKey }), want);
    } finally {
      callerKeys.callerOf = callerOf;
    }
    const note = commandAudit.note.bind(commandAudit);
    commandAudit.note = () => {
      throw new Error("injected");
    };
    try {
      assert.deepEqual(await send("GET", "/api/settings/align", { "x-sova-token": token }), want);
      assert.equal(refuseUpgrade(upgradeReq({ "x-sova-token": token }), socket()), false);
    } finally {
      commandAudit.note = note;
    }
    // The HTTP path queues through queued(): a throw there changes no answer either.
    const queued = commandAudit.queued.bind(commandAudit);
    commandAudit.queued = () => {
      throw new Error("injected");
    };
    try {
      assert.deepEqual(await send("GET", "/api/settings/align", { "x-sova-token": token }), want);
    } finally {
      commandAudit.queued = queued;
    }
  });
});

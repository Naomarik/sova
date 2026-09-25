// Login sync, whole-service, in one process: N "hosts", each with its own scratch agent dir
// (pi auth.json), Claude config dir (driven by the store-shape simulator) and sidecar, talking over
// an in-memory peer transport that a test can partition. pi's OWN refresh code runs for real
// (ModelRuntime.getAuth → pi-ai's refresh under pi's lock), with its token endpoint routed to the
// mock rotating token server. Nothing outside the scratch root is read or written.
//
// These are the credential-sync.md §5.5 scenarios at unit level; the Docker lab reruns them with
// real processes, real Tailscale and the HTTP transport.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CredentialSync, type SyncPeer } from "./logins";
import { CLAUDE_OAUTH_KEY, ClaudeCredentialStore, PiAuthStore, piRefresher } from "./logins-stores";
import { createMockTokenState } from "../../scripts/mesh-lab/mock-token-server/server.mjs";
import * as claudeSim from "../../scripts/mesh-lab/mock-token-server/claude-sim.mjs";

const root = mkdtempSync(join(tmpdir(), "sova-cred-sync-"));
after(() => rmSync(root, { recursive: true, force: true }));

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { AuthStorage } = (await import(pathToFileURL(join(piEntry, "..", "core", "auth-storage.js")).href)) as {
  AuthStorage: { create(path: string): { modify(p: string, fn: (cur: unknown) => Promise<unknown>): Promise<unknown>; delete(p: string): Promise<void> } };
};

// ---------------------------------------------------------------- the mock, reached by pi's fetch

const mock = createMockTokenState({ accessTtlS: 90 });
const realFetch = globalThis.fetch;
const { createServer } = await import("node:http");
const { createHandler } = await import("../../scripts/mesh-lab/mock-token-server/server.mjs");
const mockServer = createServer(createHandler(mock));
await new Promise<void>((r) => mockServer.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`;
// pi-ai posts to the fixed https://auth.openai.com/oauth/token; in the lab that name resolves to
// the mock, here the fetch is routed to it.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://auth.openai.com/")) return realFetch(new URL(new URL(url).pathname, mockUrl), init);
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  mockServer.close();
});

// ---------------------------------------------------------------- hosts

const CODEX = "pi:openai-codex";
const CLAUDE = `claude:${CLAUDE_OAUTH_KEY}`;
let meshSeq = 0;

class Host {
  offset = 0;
  online = true;
  sync!: CredentialSync;
  readonly dir: string;
  readonly authPath: string;
  readonly claudeDir: string;
  readonly logs: string[] = [];
  constructor(
    readonly id: string,
    private readonly mesh: Host[],
    base: string,
  ) {
    this.dir = join(base, id);
    this.authPath = join(this.dir, "agent", "auth.json");
    this.claudeDir = join(this.dir, "claude");
    mkdirSync(join(this.dir, "agent"), { recursive: true });
    mkdirSync(this.claudeDir, { recursive: true });
    this.boot();
  }
  boot() {
    this.sync = new CredentialSync({
      hostId: this.id,
      stores: [new PiAuthStore(this.authPath), new ClaudeCredentialStore(this.claudeDir)],
      sidecarPath: join(this.dir, "agent", "login-sync.json"),
      peers: () => this.mesh.filter((h) => h !== this).map((h) => this.peerTo(h)),
      now: () => Date.now() + this.offset,
      log: (m) => this.logs.push(m),
      refreshers: { pi: piRefresher(this.authPath) },
      debounceMs: 50,
    });
  }
  /** In-memory transport; a partitioned host is unreachable both ways. */
  peerTo(target: Host): SyncPeer {
    const reach = () => {
      if (!this.online || !target.online) throw new Error(`${this.id} cannot reach ${target.id}`);
    };
    return {
      id: target.id,
      manifest: async () => (reach(), structuredClone(target.sync.manifest())),
      entry: async (key) => {
        reach();
        const got = await target.sync.entry(key);
        if (!got) throw new Error("404");
        return structuredClone(got);
      },
      push: async (body) => (reach(), target.sync.receivePush(this.id, structuredClone(body))),
    };
  }
  auth(): Record<string, Record<string, unknown>> {
    return existsSync(this.authPath) ? JSON.parse(readFileSync(this.authPath, "utf8")) : {};
  }
  claude(): Record<string, unknown> | undefined {
    const p = join(this.claudeDir, ".credentials.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8"))[CLAUDE_OAUTH_KEY] : undefined;
  }
  /** `/login` as pi does it: a modify under pi's own lock. */
  async piLogin(provider = "openai-codex") {
    const { lineage, credential } = mock.login({ shape: "pi" });
    await AuthStorage.create(this.authPath).modify(provider, async () => credential);
    await this.sync.observe("pi");
    return lineage as string;
  }
  /** A request through pi: refreshes when inside pi's 5-minute window (90s tokens: always). */
  async piRefresh(provider = "openai-codex"): Promise<"ok" | "failed"> {
    try {
      await piRefresher(this.authPath)(provider, 0);
      return "ok";
    } catch {
      return "failed";
    } finally {
      await this.sync.observe("pi");
    }
  }
}

function makeMesh(n: number): Host[] {
  const base = join(root, `mesh${++meshSeq}`);
  const hosts: Host[] = [];
  for (let i = 0; i < n; i++) hosts.push(new Host(String.fromCharCode(97 + i), hosts, base));
  return hosts;
}

async function converge(hosts: Host[], rounds = 3) {
  for (let r = 0; r < rounds; r++) for (const h of hosts) if (h.online) await h.sync.syncAll();
}

const sha = (s: unknown) => createHash("sha256").update(String(s)).digest("hex");
const latest = (lineage: string) => mock.summary()[lineage] as { refreshSha256: string; refreshes: number; invalidGrants: number; revoked: boolean };
const piRefreshSha = (h: Host, provider = "openai-codex") => {
  const e = h.auth()[provider];
  return e ? sha(e.refresh) : undefined;
};
const fp = (h: Host, key: string) => h.sync.recordsSnapshot()[key]?.meta?.fingerprint;

// ---------------------------------------------------------------- scenarios

test("mesh off: constructing the service reads and writes nothing", async () => {
  const dir = join(root, "off");
  mkdirSync(dir);
  new CredentialSync({ hostId: "x", stores: [new PiAuthStore(join(dir, "auth.json"))], sidecarPath: join(dir, "sidecar.json") });
  assert.deepEqual(readdirSync(dir), []);
});

test("H1: a login propagates to every host, 0600, no temp or lock files left", async () => {
  const [a, b, c] = makeMesh(3);
  const lineage = await a!.piLogin();
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) {
    assert.equal(piRefreshSha(h), latest(lineage).refreshSha256, h.id);
    assert.equal(fp(h, CODEX), fp(a!, CODEX), h.id);
    assert.equal(statSync(h.authPath).mode & 0o777, 0o600, h.id);
    assert.deepEqual(readdirSync(join(h.dir, "agent")).sort(), ["auth.json", "login-sync.json"], h.id);
  }
  // The login's metadata travels unchanged: origin a, loginAt set once.
  const meta = b!.sync.recordsSnapshot()[CODEX]!.meta!;
  assert.equal(meta.origin, "a");
  assert.ok(meta.loginAt > 0);
});

test("H1 with watchers: a login on A reaches B by itself", async () => {
  const [a, b] = makeMesh(2);
  await a!.sync.start();
  await b!.sync.start();
  try {
    const { credential } = mock.login({ shape: "pi" });
    await AuthStorage.create(a!.authPath).modify("openai-codex", async () => credential);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && b!.auth()["openai-codex"]?.refresh !== credential.refresh) await new Promise((r) => setTimeout(r, 25));
    assert.equal(b!.auth()["openai-codex"]?.refresh, credential.refresh);
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("H2 (pi): two hosts refresh the same lineage at once; the loser keeps its entry, then adopts the winner's", async () => {
  const [a, b] = makeMesh(2);
  const lineage = await a!.piLogin();
  await converge([a!, b!]);
  const results = await Promise.all([a!.piRefresh(), b!.piRefresh()]);
  assert.deepEqual(results.slice().sort(), ["failed", "ok"], "one refresh, one invalid_grant");
  assert.equal(latest(lineage).refreshes, 1);
  assert.equal(latest(lineage).invalidGrants, 1);
  const loser = results[0] === "failed" ? a! : b!;
  assert.ok(loser.auth()["openai-codex"], "pi does not clear its entry on a failed refresh");
  await converge([a!, b!]);
  for (const h of [a!, b!]) assert.equal(piRefreshSha(h), latest(lineage).refreshSha256, h.id);
  // The loser's next request works, from the pulled entry (pi reads the renamed file).
  assert.equal(await loser.piRefresh(), "ok");
});

test("H2 (Claude): the loser clears to a dead marker, pushes nothing, pulls, and ends on the winner's lineage", async () => {
  const [a, b, c] = makeMesh(3);
  const { lineage } = await claudeSim.login(a!.claudeDir, mockUrl);
  await a!.sync.observe("claude");
  await converge([a!, b!, c!]);
  assert.equal(b!.claude()?.refreshToken, a!.claude()?.refreshToken);
  const outcomes = await Promise.all([claudeSim.refresh(a!.claudeDir, mockUrl), claudeSim.refresh(b!.claudeDir, mockUrl)]);
  assert.deepEqual(outcomes.slice().sort(), ["invalid_grant", "ok"]);
  const loser = outcomes[0] === "invalid_grant" ? a! : b!;
  assert.equal(loser.claude()?.expiresAt, 0);
  for (const h of [a!, b!]) await h.sync.observe("claude");
  assert.equal(loser.sync.recordsSnapshot()[CLAUDE]?.meta?.dead, true);
  assert.equal(loser.sync.manifest().entries[CLAUDE]?.meta, undefined, "a dead marker is never advertised");
  await converge([c!, loser]); // the loser talks to C first: C must not take the dead marker
  assert.notEqual(c!.claude()?.expiresAt, 0);
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) assert.equal(sha(h.claude()?.refreshToken), latest(lineage).refreshSha256, h.id);
});

test("H3: origin offline, two others refresh together; one becomes the new origin and all converge", async () => {
  const [a, b, c] = makeMesh(3);
  const lineage = await a!.piLogin();
  await converge([a!, b!, c!]);
  a!.online = false;
  const results = await Promise.all([b!.piRefresh(), c!.piRefresh()]);
  assert.deepEqual(results.slice().sort(), ["failed", "ok"]);
  const winner = results[0] === "ok" ? b! : c!;
  a!.online = true;
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) {
    assert.equal(piRefreshSha(h), latest(lineage).refreshSha256, h.id);
    assert.equal(h.sync.recordsSnapshot()[CODEX]!.meta!.origin, winner.id, `${h.id}: c-lite moves with origin`);
  }
});

test("H4: a stale host with a skewed clock and a touched file never spreads its entry; merge waits for the clock", async () => {
  const [a, b, c] = makeMesh(3);
  const lineage = await a!.piLogin();
  await converge([a!, b!, c!]);
  c!.online = false;
  assert.equal(await a!.piRefresh(), "ok");
  assert.equal(await a!.piRefresh(), "ok");
  await converge([a!, b!]);
  c!.offset = 3_600_000;
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(c!.authPath, future, future);
  assert.equal(await c!.piRefresh(), "failed", "C's refresh token was rotated away");
  c!.online = true;
  const states = await Promise.all([c!.sync.syncWith(c!.peerTo(a!)), a!.sync.syncWith(a!.peerTo(c!))]);
  assert.deepEqual(states.map((s) => s.state), ["clock-skew", "clock-skew"]);
  assert.equal(c!.sync.status().peers.a?.state, "clock-skew");
  assert.notEqual(piRefreshSha(c!), latest(lineage).refreshSha256, "no merge across the skew");
  c!.offset = 0;
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) assert.equal(piRefreshSha(h), latest(lineage).refreshSha256, h.id);
  assert.equal(latest(lineage).refreshes, 2);
});

test("H4 (push): a stale entry pushed at a host is rejected as older, and a dead one as dead", async () => {
  const [a, b] = makeMesh(2);
  await a!.piLogin();
  await converge([a!, b!]);
  const stale = structuredClone((await a!.sync.entry(CODEX))!);
  assert.equal(await a!.piRefresh(), "ok");
  const now = Date.now();
  const r1 = await a!.sync.receivePush("b", { hostId: "b", now, entries: { [CODEX]: stale } });
  assert.deepEqual(r1.rejected, [{ key: CODEX, reason: "older" }]);
  const dead = { record: { meta: { ...stale.record.meta!, dead: true, expires: 0 } }, secret: { ...stale.secret, access: "", expires: 0 } };
  const r2 = await a!.sync.receivePush("b", { hostId: "b", now, entries: { [CODEX]: dead } });
  assert.deepEqual(r2.rejected, [{ key: CODEX, reason: "dead" }]);
  // A secret that isn't the entry its metadata describes is refused, even when it would win.
  const forged = structuredClone((await a!.sync.entry(CODEX))!);
  forged.record.meta!.expires = forged.record.meta!.expires! + 10_000_000;
  const r3 = await b!.sync.receivePush("a", { hostId: "a", now, entries: { [CODEX]: forged } });
  assert.deepEqual(r3.rejected, [{ key: CODEX, reason: "invalid" }]);
  const r4 = await b!.sync.receivePush("a", { hostId: "a", now: now + 3_600_000, entries: { [CODEX]: stale } });
  assert.deepEqual(r4.rejected, [{ key: CODEX, reason: "clock-skew" }]);
});

test("H6: logout tombstones reach every host and remove the entry; a later login resurrects everywhere", async () => {
  const [a, b, c] = makeMesh(3);
  await a!.piLogin();
  await claudeSim.login(a!.claudeDir, mockUrl);
  await a!.sync.observe("claude");
  await converge([a!, b!, c!]);
  await a!.sync.logout(CODEX);
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) {
    assert.equal(h.auth()["openai-codex"], undefined, h.id);
    assert.equal(h.sync.status().entries.find((e) => e.key === CODEX)?.state, "logged-out", h.id);
    assert.ok(h.claude(), `${h.id}: other keys untouched`);
  }
  const lineage = await b!.piLogin();
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) assert.equal(piRefreshSha(h), latest(lineage).refreshSha256, h.id);
});

test("H6 (Claude): Claude Code's own logout (file deleted) is a logout everywhere", async () => {
  const [a, b] = makeMesh(2);
  const { lineage } = await claudeSim.login(a!.claudeDir, mockUrl);
  await a!.sync.observe("claude");
  await converge([a!, b!]);
  await claudeSim.logout(a!.claudeDir, mockUrl);
  await a!.sync.observe("claude");
  await converge([a!, b!]);
  assert.equal(b!.claude(), undefined);
  assert.equal(existsSync(join(b!.claudeDir, ".credentials.json")), false);
  assert.equal(latest(lineage).revoked, true);
});

test("H7: a host that missed the logout and refreshed afterwards is logged out too (a refresh is not a login)", async () => {
  const [a, b, c] = makeMesh(3);
  await a!.piLogin();
  await converge([a!, b!, c!]);
  const loginAt = a!.sync.recordsSnapshot()[CODEX]!.meta!.loginAt;
  c!.online = false;
  await a!.sync.logout(CODEX);
  await converge([a!, b!]);
  const before = c!.sync.recordsSnapshot()[CODEX]!.meta!;
  assert.equal(await c!.piRefresh(), "ok", "C still holds a live lineage and refreshes it");
  const cMeta = c!.sync.recordsSnapshot()[CODEX]!.meta!;
  assert.notEqual(cMeta.fingerprint, before.fingerprint, "C's entry really changed");
  assert.equal(cMeta.loginAt, loginAt, "the refresh kept the lineage's login stamp");
  c!.online = true;
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) assert.equal(h.auth()["openai-codex"], undefined, h.id);
});

test("H8: deleting auth.json by hand is not a logout by default: the host re-pulls everything", async () => {
  const [a, b] = makeMesh(2);
  await a!.piLogin();
  await AuthStorage.create(a!.authPath).modify("zai", async () => ({ type: "api_key", key: "sk-lab-zai" }));
  await a!.sync.observe("pi");
  await converge([a!, b!]);
  rmSync(b!.authPath);
  await b!.sync.observe("pi");
  await converge([a!, b!]);
  assert.deepEqual(Object.keys(b!.auth()).sort(), ["openai-codex", "zai"]);
  assert.deepEqual(Object.keys(a!.auth()).sort(), ["openai-codex", "zai"]);
});

test("H8 (flag on): with treatPiFileDeleteAsLogout, deleting auth.json logs every pi entry out everywhere", async () => {
  const [a, b] = makeMesh(2);
  await a!.piLogin();
  await converge([a!, b!]);
  b!.sync = new CredentialSync({
    hostId: "b",
    stores: [new PiAuthStore(b!.authPath)],
    sidecarPath: join(b!.dir, "agent", "login-sync.json"),
    peers: () => [b!.peerTo(a!)],
    treatPiFileDeleteAsLogout: true,
  });
  await b!.sync.observe("pi");
  rmSync(b!.authPath);
  await b!.sync.observe("pi");
  await converge([a!, b!]);
  assert.equal(a!.auth()["openai-codex"], undefined);
});

test("H9: a torn auth.json is never merged or pushed; the complete file is, once", async () => {
  const [a, b] = makeMesh(2);
  await a!.piLogin();
  await converge([a!, b!]);
  const good = readFileSync(a!.authPath, "utf8");
  const withZai = JSON.stringify({ ...JSON.parse(good), zai: { type: "api_key", key: "sk-new" } }, null, 2);
  writeFileSync(a!.authPath, withZai.slice(0, withZai.length - 20));
  await a!.sync.observe("pi");
  await converge([a!, b!]);
  assert.equal(b!.auth().zai, undefined);
  assert.deepEqual(b!.auth()["openai-codex"], JSON.parse(good)["openai-codex"], "B untouched");
  writeFileSync(a!.authPath, withZai);
  await a!.sync.observe("pi");
  await converge([a!, b!]);
  assert.deepEqual(b!.auth().zai, { type: "api_key", key: "sk-new" });
});

test("H10: a restarted host reloads its sidecar and pulls the newest lineage before anything else", async () => {
  const [a, b] = makeMesh(2);
  const lineage = await a!.piLogin();
  await converge([a!, b!]);
  b!.online = false;
  assert.equal(await a!.piRefresh(), "ok");
  b!.online = true;
  b!.boot(); // a fresh process: same files, new service
  await b!.sync.start();
  try {
    await b!.sync.syncAll();
    assert.equal(piRefreshSha(b!), latest(lineage).refreshSha256);
    assert.ok(b!.sync.recordsSnapshot()[CODEX]!.meta!.loginAt > 0, "the sidecar kept the login stamp");
  } finally {
    b!.sync.stop();
  }
});

test("api keys: a changed key on any host becomes the key everywhere; a !command key never travels", async () => {
  const [a, b, c] = makeMesh(3);
  await AuthStorage.create(a!.authPath).modify("zai", async () => ({ type: "api_key", key: "sk-1" }));
  await AuthStorage.create(c!.authPath).modify("deepseek", async () => ({ type: "api_key", key: "!pass show deepseek" }));
  for (const h of [a!, c!]) await h.sync.observe("pi");
  await converge([a!, b!, c!]);
  await new Promise((r) => setTimeout(r, 5)); // a later issuedAt
  await AuthStorage.create(b!.authPath).modify("zai", async () => ({ type: "api_key", key: "sk-2" }));
  await b!.sync.observe("pi");
  await converge([a!, b!, c!]);
  for (const h of [a!, b!, c!]) assert.deepEqual(h.auth().zai, { type: "api_key", key: "sk-2" }, h.id);
  assert.equal(a!.auth().deepseek, undefined);
  assert.deepEqual(c!.auth().deepseek, { type: "api_key", key: "!pass show deepseek" });
  // ...and a host holding one as device config refuses a pushed literal for that provider.
  await AuthStorage.create(a!.authPath).modify("deepseek", async () => ({ type: "api_key", key: "sk-literal" }));
  await a!.sync.observe("pi");
  await converge([a!, b!, c!]);
  assert.deepEqual(c!.auth().deepseek, { type: "api_key", key: "!pass show deepseek" });
  assert.deepEqual(b!.auth().deepseek, { type: "api_key", key: "sk-literal" });
});

test("c-lite: the origin refreshes early through pi itself, and the others adopt it without refreshing", async () => {
  const [a, b] = makeMesh(2);
  const lineage = await a!.piLogin();
  await converge([a!, b!]);
  await a!.sync.refreshNow(CODEX);
  await converge([a!, b!]);
  assert.equal(latest(lineage).refreshes, 1);
  assert.equal(latest(lineage).invalidGrants, 0);
  for (const h of [a!, b!]) assert.equal(piRefreshSha(h), latest(lineage).refreshSha256, h.id);
  const meta = b!.sync.recordsSnapshot()[CODEX]!.meta!;
  assert.equal(meta.origin, "a");
  await b!.sync.refreshNow(CODEX); // B may refresh too (harness `refresh <host>`), becoming origin
  await converge([a!, b!]);
  assert.equal(a!.sync.recordsSnapshot()[CODEX]!.meta!.origin, "b");
  assert.equal(a!.sync.recordsSnapshot()[CODEX]!.meta!.loginAt, meta.loginAt, "a refresh keeps the login stamp");
});

test("H11: many hosts, random partitions and refreshes: all converge on the latest lineage", async () => {
  const hosts = makeMesh(6);
  const lineage = await hosts[0]!.piLogin();
  await converge(hosts);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let step = 0; step < 40; step++) {
    const h = hosts[Math.floor(rand() * hosts.length)]!;
    const roll = rand();
    if (roll < 0.25) h.online = !h.online;
    else if (roll < 0.6) await Promise.all(hosts.filter(() => rand() < 0.3).map((x) => x.piRefresh()));
    else await h.sync.syncAll();
    // Invariant at every step: no host holds nothing while some host holds a live entry.
    const anyLive = hosts.some((x) => x.sync.status().entries.some((e) => e.key === CODEX && e.state === "live"));
    if (anyLive) for (const x of hosts) assert.ok(x.auth()["openai-codex"], `step ${step}: ${x.id} empty`);
  }
  for (const h of hosts) h.online = true;
  // Hosts left on a rotated-away lineage fail their next refresh and pull; a final round settles.
  await converge(hosts);
  for (const h of hosts) assert.equal(piRefreshSha(h), latest(lineage).refreshSha256, h.id);
});

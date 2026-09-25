// The sync wiring: its peer routes, its gate, its lifecycle, and two hosts talking over the real
// route handlers (JSON both ways) with a fake mesh standing in for server/mesh. Scratch dirs only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { MeshLogins, MeshSettings, SyncStatus } from "../../shared/protocol";
import type { MeshApi } from "../mesh";
import { claudeSyncDir, mountSync, type SyncRuntime } from "./index";

const root = mkdtempSync(join(tmpdir(), "sova-sync-wiring-"));
after(() => rmSync(root, { recursive: true, force: true }));
// Every default path the wiring could fall back to points into the scratch root: the extensions
// manifest (server/extensions.ts reads it per call) and the agent dir.
process.env.SOVA_EXTENSIONS_FILE = join(root, "extensions.json");
process.env.PI_CODING_AGENT_DIR = join(root, "default-agent");
let seq = 0;

interface FakeHost {
  id: string;
  app: Hono;
  rt: SyncRuntime;
  agentDir: string;
  settings: MeshSettings;
  fire: { start(): void; stop(): void; peerUp(id: string): void; settings(): void };
  status: () => SyncStatus[];
  seen: Set<string>;
}

/** A host with a fake mesh: the gate puts the caller in env.meshPeer, as the peer listener does. */
function host(id: string, others: Map<string, FakeHost>): FakeHost {
  const dir = join(root, `w${++seq}`, id);
  const agentDir = join(dir, "agent");
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  const app = new Hono();
  app.use("/api/peer/*", async (c, next) => ((c.env as { meshPeer?: unknown } | undefined)?.meshPeer ? next() : c.json({ error: "Not found" }, 404)));
  const hooks = { start: [] as Array<() => void>, stop: [] as Array<() => void>, up: [] as Array<(id: string) => void>, settings: [] as Array<() => void> };
  let statusProvider: () => SyncStatus[] = () => [];
  const settings: MeshSettings = { hostLabel: id, sync: { settings: true, themes: true, extensions: true, logins: true }, frontDoor: null };
  const peerEntry = (pid: string) => ({ id: pid, label: pid, nodeId: `n-${pid}`, dnsName: `${pid}.lab` });
  const mesh = {
    enabled: () => true,
    peers: () => [...others.keys()].filter((k) => k !== id).map(peerEntry),
    self: () => ({ id, label: id }),
    settings: () => settings,
    peerFetch: async (peerId: string, path: string, init?: RequestInit) => {
      const target = others.get(peerId);
      if (!target) throw new Error(`unknown peer ${peerId}`);
      // As mesh-core's gate does: a peer's own call is proof it is up.
      if (!target.seen.has(id)) {
        target.seen.add(id);
        target.fire.peerUp(id);
      }
      return target.app.request(path, init, { meshPeer: peerEntry(id) });
    },
    requestPeer: (c: Context) => (c.env as { meshPeer?: ReturnType<typeof peerEntry> } | undefined)?.meshPeer ?? null,
    onMeshStart: (fn: () => void) => hooks.start.push(fn),
    onMeshStop: (fn: () => void) => hooks.stop.push(fn),
    onPeerUp: (fn: (id: string) => void) => hooks.up.push(fn),
    onSettingsChange: (fn: () => void) => hooks.settings.push(fn),
    onSyncStatus: (fn: () => SyncStatus[]) => {
      statusProvider = fn;
    },
  } as unknown as MeshApi;
  const rt = mountSync(app, mesh, { agentDir: () => agentDir, stateDir: () => join(agentDir, "sova"), claudeDir: () => null });
  const h: FakeHost = {
    id,
    app,
    rt,
    agentDir,
    settings,
    fire: {
      start: () => hooks.start.forEach((f) => f()),
      stop: () => hooks.stop.forEach((f) => f()),
      peerUp: (pid) => hooks.up.forEach((f) => f(pid)),
      settings: () => hooks.settings.forEach((f) => f()),
    },
    status: () => statusProvider(),
    seen: new Set(),
  };
  others.set(id, h);
  return h;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
const auth = (h: FakeHost) => JSON.parse(readFileSync(join(h.agentDir, "auth.json"), "utf8"));
const writeAuth = (h: FakeHost, data: unknown) => writeFileSync(join(h.agentDir, "auth.json"), JSON.stringify(data, null, 2), { mode: 0o600 });

test("the Claude store is never the real ~/.claude on a hermetic agent dir", () => {
  assert.equal(claudeSyncDir({ PI_CODING_AGENT_DIR: "/x/.agent" }), null);
  assert.equal(claudeSyncDir({ PI_CODING_AGENT_DIR: "/x/.agent", HOME: "/home/u" }), null);
  assert.equal(claudeSyncDir({ PI_CODING_AGENT_DIR: "/x/.agent", SOVA_SYNC_CLAUDE_DIR: "/lab/claude" }), "/lab/claude");
  assert.equal(claudeSyncDir({ CLAUDE_CONFIG_DIR: "/cfg" }), "/cfg");
  assert.match(claudeSyncDir({})!, /\/\.claude$/);
});

test("mesh off: routes are 404 and nothing is read or written", async () => {
  const hosts = new Map<string, FakeHost>();
  const a = host("a", hosts);
  writeAuth(a, { zai: { type: "api_key", key: "sk-a" } });
  const before = readdirSync(a.agentDir).sort();
  for (const [path, init] of [
    ["/api/peer/credentials/manifest", undefined],
    ["/api/peer/credentials/entry?key=pi:zai", undefined],
    ["/api/peer/credentials/push", { method: "POST", body: "{}" }],
    ["/api/peer/sync/manifest", undefined],
    ["/api/peer/sync/doc?key=settings:mode.json", undefined],
    ["/api/peer/sync/push", { method: "POST", body: "{}" }],
    ["/api/peer/sync/extensions", undefined],
    ["/api/mesh/logins", undefined],
    ["/api/mesh/logins/claim", { method: "POST", body: JSON.stringify({ key: "pi:zai" }), headers: { "content-type": "application/json" } }],
  ] as const) {
    // As a browser, and as a verified peer, but the mesh never started: still 404.
    assert.equal((await a.app.request(path, init)).status, 404, path);
    assert.equal((await a.app.request(path, init, { meshPeer: { id: "b" } })).status, 404, path);
  }
  assert.equal(a.rt.credentials, null);
  assert.equal(a.rt.docs, null);
  assert.equal(a.rt.extensions, null);
  assert.deepEqual(readdirSync(a.agentDir).sort(), before);
  assert.deepEqual(readdirSync(join(a.agentDir, "sova")), []);
});

test("peer routes answer verified peers only, and never a request that came through a browser proxy", async () => {
  const hosts = new Map<string, FakeHost>();
  const a = host("a", hosts);
  writeAuth(a, { zai: { type: "api_key", key: "sk-a" } });
  a.fire.start();
  try {
    assert.equal(await until(() => !!a.rt.credentials?.manifest().entries["pi:zai"]), true);
    const peer = { meshPeer: { id: "b" } };
    assert.equal((await a.app.request("/api/peer/credentials/manifest")).status, 404, "not a peer");
    const proxied = await a.app.request("/api/peer/credentials/entry?key=pi:zai", { headers: { "X-Forwarded-Host": "a.lab:5173" } }, peer);
    assert.equal(proxied.status, 404, "proxied from a browser");
    const ok = await a.app.request("/api/peer/credentials/entry?key=pi:zai", undefined, peer);
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { secret: unknown }).secret, { type: "api_key", key: "sk-a" });
    assert.equal((await a.app.request("/api/peer/credentials/entry?key=pi:nope", undefined, peer)).status, 404);
    const bad = await a.app.request("/api/peer/credentials/push", { method: "POST", body: "not json", headers: { "content-type": "application/json" } }, peer);
    assert.equal(bad.status, 400);
    const huge = await a.app.request(
      "/api/peer/credentials/push",
      { method: "POST", body: JSON.stringify({ pad: "x".repeat(300 * 1024) }), headers: { "content-type": "application/json" } },
      peer,
    );
    assert.equal(huge.status, 413);
  } finally {
    a.fire.stop();
  }
  assert.equal(a.rt.credentials, null, "stop drops the service");
});

test("two hosts over the real routes: start pulls, a change propagates, a logout propagates, status reports", async () => {
  const hosts = new Map<string, FakeHost>();
  const a = host("a", hosts);
  const b = host("b", hosts);
  writeAuth(a, { zai: { type: "api_key", key: "sk-a" }, local: { type: "api_key", key: "!pass show x" } });
  a.fire.start();
  b.fire.start();
  try {
    assert.equal(await until(() => existsSync(join(b.agentDir, "auth.json")) && !!auth(b).zai), true, "B pulled at start");
    assert.deepEqual(auth(b), { zai: { type: "api_key", key: "sk-a" } }, "the !command key stayed on A");
    // A change on B's disk (as /login would write it) reaches A by the watcher and a push.
    writeAuth(b, { ...auth(b), deepseek: { type: "api_key", key: "sk-ds" } });
    assert.equal(await until(() => !!auth(a).deepseek), true, "B's new key reached A");
    // Logout from A reaches B.
    await a.rt.credentials!.logout("pi:deepseek");
    assert.equal(await until(() => !auth(b).deepseek), true, "the logout reached B");
    const st = a.status();
    assert.deepEqual(st.map((r) => [r.category, r.state]), [["logins", "ok"], ["settings", "ok"], ["themes", "ok"], ["extensions", "ok"]]);
    assert.ok(!JSON.stringify(st).includes("sk-"), "no secret in status");
    assert.ok(!JSON.stringify(a.rt.credentials!.status()).includes("sk-"), "no secret in the detailed status");
    // The user's switch: off, nothing is offered or taken.
    b.settings.sync.logins = false;
    assert.deepEqual(b.rt.credentials!.manifest().entries, {});
    assert.equal(b.status().find((r) => r.category === "logins")!.state, "off");
    writeAuth(a, { ...auth(a), fresh: { type: "api_key", key: "sk-fresh" } });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(auth(b).fresh, undefined, "B took nothing while its switch is off");
    // Switched back on: the settings hook reconciles at once.
    b.settings.sync.logins = true;
    b.fire.settings();
    assert.equal(await until(() => !!auth(b).fresh), true, "B caught up when switched back on");
  } finally {
    a.fire.stop();
    b.fire.stop();
  }
});

test("two hosts over the real routes: a settings file and a theme propagate; the proxied route stays shut", async () => {
  const hosts = new Map<string, FakeHost>();
  const a = host("a", hosts);
  const b = host("b", hosts);
  a.fire.start();
  b.fire.start();
  try {
    const mode = `${JSON.stringify({ mode: "delegate", minorModes: [], strict: false }, null, 2)}\n`;
    writeFileSync(join(a.agentDir, "mode.json"), mode);
    mkdirSync(join(a.agentDir, "sova", "themes"), { recursive: true });
    writeFileSync(join(a.agentDir, "sova", "themes", "ocean.json"), JSON.stringify({ name: "Ocean", base: "dark", colors: {} }));
    const bMode = join(b.agentDir, "mode.json");
    const bTheme = join(b.agentDir, "sova", "themes", "ocean.json");
    assert.equal(await until(() => existsSync(bMode) && existsSync(bTheme), 4000), true);
    assert.equal(readFileSync(bMode, "utf8"), mode);
    const proxied = await b.app.request("/api/peer/sync/doc?key=settings:mode.json", { headers: { "X-Forwarded-Host": "b.lab" } }, { meshPeer: { id: "a" } });
    assert.equal(proxied.status, 404);
  } finally {
    a.fire.stop();
    b.fire.stop();
  }
});

test("a pushed extension list is stored under the verified caller, whatever the body claims", async () => {
  const hosts = new Map<string, FakeHost>();
  const a = host("a", hosts);
  host("b", hosts); // in a's peers.json (a list from a host that isn't would be dropped), not started
  a.fire.start();
  try {
    const list = { hostId: "someone-else", now: Date.now(), entries: [{ id: "pushed", title: "Pushed", dist: "/nonexistent/dist", api: "http://127.0.0.1:7010" }] };
    const res = await a.app.request("/api/peer/sync/extensions", { method: "POST", body: JSON.stringify(list), headers: { "content-type": "application/json" } }, { meshPeer: { id: "b" } });
    assert.equal(res.status, 200);
    assert.deepEqual(a.rt.extensions!.peerEntries().map((p) => [p.entry.id, p.from, p.installed]), [["pushed", "b", false]]);
    const proxied = await a.app.request("/api/peer/sync/extensions", { method: "POST", body: JSON.stringify(list), headers: { "content-type": "application/json", "X-Forwarded-Host": "a.lab" } }, { meshPeer: { id: "b" } });
    assert.equal(proxied.status, 404);
  } finally {
    a.fire.stop();
  }
});

test("login conflicts over the browser routes: listed without secrets, settled by a claim, shut to peers", async () => {
  const hosts = new Map<string, FakeHost>();
  const a = host("a", hosts);
  const b = host("b", hosts);
  // Different keys on both hosts before either synced: a conflict, both kept.
  writeAuth(a, { zai: { type: "api_key", key: "sk-current" } });
  writeAuth(b, { zai: { type: "api_key", key: "sk-old" } });
  const json = { "content-type": "application/json" };
  const claim = (h: FakeHost, body: string, env?: object) => h.app.request("/api/mesh/logins/claim", { method: "POST", body, headers: json }, env);
  const logins = async (h: FakeHost) => (await (await h.app.request("/api/mesh/logins")).json()) as MeshLogins;
  a.fire.start();
  b.fire.start();
  try {
    const zai = async (h: FakeHost) => (await logins(h)).entries.find((e) => e.key === "pi:zai");
    let row = await zai(a);
    for (const end = Date.now() + 3000; !row?.conflictWith && Date.now() < end; row = await zai(a)) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(row?.conflictWith, ["b"], "A lists the conflict with B");
    assert.equal(row?.store, "pi");
    assert.equal(row?.state, "live");
    assert.equal(row?.loginAt, 0, "found before sync");
    const res = await a.app.request("/api/mesh/logins");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("sk-"), "no secret in the body");
    assert.ok(!/fingerprint|tombstone/.test(text), "no fingerprint or tombstone internals");
    assert.deepEqual(auth(a).zai.key, "sk-current");
    assert.deepEqual(auth(b).zai.key, "sk-old", "nothing moved while in conflict");

    // Shut to peer-listener callers, verified or proxied through it.
    assert.equal((await a.app.request("/api/mesh/logins", undefined, { meshPeer: { id: "b" } })).status, 404);
    assert.equal((await claim(a, JSON.stringify({ key: "pi:zai" }), { meshPeer: { id: "b" } })).status, 404);
    assert.equal(auth(b).zai.key, "sk-old", "a peer's claim did nothing");

    // Bad bodies and keys this host doesn't know.
    assert.equal((await claim(a, "not json")).status, 400);
    assert.equal((await claim(a, JSON.stringify({}))).status, 400);
    assert.equal((await claim(a, JSON.stringify({ key: "pi:nope" }))).status, 400);
    assert.equal((await claim(a, JSON.stringify({ key: "nostore:zai" }))).status, 400);
    // The switch off: refused, nothing stamped.
    a.settings.sync.logins = false;
    assert.equal((await claim(a, JSON.stringify({ key: "pi:zai" }))).status, 409);
    a.settings.sync.logins = true;
    assert.deepEqual((await zai(a))?.conflictWith, ["b"]);

    // The user keeps A's: it wins on both hosts and the conflict is gone.
    const ok = await claim(a, JSON.stringify({ key: "pi:zai" }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(await until(() => auth(b).zai?.key === "sk-current"), true, "B took A's login");
    const after = await zai(a);
    assert.equal(after?.conflictWith, undefined);
    assert.equal(after?.origin, "a");
    assert.ok((after?.loginAt ?? 0) > 0, "a claim is a login made now");
    assert.equal(a.status().find((r) => r.category === "logins")?.state, "ok");
    assert.ok(!JSON.stringify(await logins(b)).includes("sk-"));
  } finally {
    a.fire.stop();
    b.fire.stop();
  }
  // Stopped (the mesh went OFF): 404 again.
  assert.equal((await a.app.request("/api/mesh/logins")).status, 404);
});

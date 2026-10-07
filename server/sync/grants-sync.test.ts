// Run: pnpm test -- server/sync/grants-sync.test.ts
// Sync under per-peer grants (§mesh.peers/grants), in process: two hosts over an in-memory transport
// that, like the real routes, tells the serving host who is asking. Logins move only as each host's
// grant to the other lists them (both directions, logouts included); settings and themes only in the
// categories granted. Without a `shares` option every key and category moves, as before grants.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CredentialSync, type SyncPeer } from "./logins";
import { PiAuthStore } from "./logins-stores";
import { DocSync, type DocCategory, type DocPeer } from "./docs";

const root = mkdtempSync(join(tmpdir(), "sova-grants-sync-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { AuthStorage } = (await import(pathToFileURL(join(piEntry, "..", "core", "auth-storage.js")).href)) as {
  AuthStorage: { create(path: string): { modify(p: string, fn: (cur: unknown) => Promise<unknown>): Promise<unknown>; delete(p: string): Promise<void> } };
};

// ---- logins ------------------------------------------------------------------------------------

class LoginHost {
  sync: CredentialSync;
  readonly authPath: string;
  /** Which keys this host shares with each peer; absent = no `shares` option at all. */
  constructor(
    readonly id: string,
    readonly mesh: LoginHost[],
    base: string,
    readonly shares?: Record<string, string[]>,
    debounceMs = 60_000,
  ) {
    const dir = join(base, id, "agent");
    mkdirSync(dir, { recursive: true });
    this.authPath = join(dir, "auth.json");
    this.sync = new CredentialSync({
      hostId: id,
      stores: [new PiAuthStore(this.authPath)],
      sidecarPath: join(dir, "login-sync.json"),
      peers: () => this.mesh.filter((h) => h !== this).map((h) => this.peerTo(h)),
      log: () => {},
      debounceMs,
      ...(shares ? { shares: (peer: string, key: string) => (shares[peer] ?? []).includes(key) } : {}),
    });
  }
  peerTo(t: LoginHost): SyncPeer {
    return {
      id: t.id,
      manifest: async () => structuredClone(t.sync.manifest(this.id)),
      entry: async (key) => {
        const got = await t.sync.entry(key, this.id);
        if (!got) throw new Error("404");
        return structuredClone(got);
      },
      push: async (body) => t.sync.receivePush(this.id, structuredClone(body)),
    };
  }
  async key(provider: string, key: string) {
    await AuthStorage.create(this.authPath).modify(provider, async () => ({ type: "api_key", key }));
    await this.sync.observe("pi");
  }
  async logout(provider: string) {
    await AuthStorage.create(this.authPath).delete(provider);
    await this.sync.observe("pi");
  }
  auth(): Record<string, { key?: string }> {
    return existsSync(this.authPath) ? JSON.parse(readFileSync(this.authPath, "utf8")) : {};
  }
}

function loginMesh(shares: Record<string, Record<string, string[]> | undefined>): LoginHost[] {
  const base = join(root, `l${++seq}`);
  const hosts: LoginHost[] = [];
  for (const id of Object.keys(shares)) hosts.push(new LoginHost(id, hosts, base, shares[id]));
  return hosts;
}
const converge = async (hosts: LoginHost[]) => {
  for (let r = 0; r < 3; r++) for (const h of hosts) await h.sync.syncAll();
};

test("logins: without a shares option every login moves, as before grants", async () => {
  const [a, b] = loginMesh({ a: undefined, b: undefined });
  for (const h of [a!, b!]) await h.sync.start();
  try {
    await a!.key("zai", "sk-zai");
    await a!.key("anthropic", "sk-ant");
    await converge([a!, b!]);
    assert.equal(b!.auth().zai?.key, "sk-zai");
    assert.equal(b!.auth().anthropic?.key, "sk-ant");
  } finally {
    for (const h of [a!, b!]) h.sync.stop();
  }
});

test("logins: only the chosen logins go to a peer; the manifest and entry never name the others", async () => {
  const [a, b] = loginMesh({ a: { b: ["pi:zai"] }, b: { a: ["pi:zai", "pi:anthropic"] } });
  for (const h of [a!, b!]) await h.sync.start();
  try {
    await a!.key("zai", "sk-zai");
    await a!.key("anthropic", "sk-ant");
    await converge([a!, b!]);
    assert.equal(b!.auth().zai?.key, "sk-zai");
    assert.equal(b!.auth().anthropic, undefined, "a doesn't share anthropic with b");
    assert.deepEqual(Object.keys(a!.sync.manifest("b").entries), ["pi:zai"]);
    assert.equal(await a!.sync.entry("pi:anthropic", "b"), null);
    assert.ok(await a!.sync.entry("pi:anthropic"), "its own (unnamed caller) view still has it");
  } finally {
    for (const h of [a!, b!]) h.sync.stop();
  }
});

test("logins: a host never takes a login it doesn't share with that peer, pushed or offered", async () => {
  const [a, b] = loginMesh({ a: { b: [] }, b: { a: ["pi:deepseek"] } });
  for (const h of [a!, b!]) await h.sync.start();
  try {
    await b!.key("deepseek", "sk-ds");
    await converge([a!, b!]);
    assert.equal(a!.auth().deepseek, undefined, "b offers it, a doesn't take it");
    // Pushed straight at a, past b's own planning: refused.
    const got = await b!.sync.entry("pi:deepseek");
    const reply = await a!.sync.receivePush("b", { hostId: "b", now: Date.now(), entries: { "pi:deepseek": got! } });
    assert.deepEqual(reply.rejected, [{ key: "pi:deepseek", reason: "disabled" }]);
    assert.equal(a!.auth().deepseek, undefined);
  } finally {
    for (const h of [a!, b!]) h.sync.stop();
  }
});

test("logins: turning one off stops future exchanges, logouts included, but can't recall the copy sent", async () => {
  const shares: Record<string, string[]> = { b: ["pi:zai"] };
  const [a, b] = loginMesh({ a: shares, b: { a: ["pi:zai"] } });
  for (const h of [a!, b!]) await h.sync.start();
  try {
    await a!.key("zai", "sk-1");
    await converge([a!, b!]);
    assert.equal(b!.auth().zai?.key, "sk-1");
    shares.b = []; // the user turns zai off for b on a's Mesh page
    await a!.key("zai", "sk-2");
    await converge([a!, b!]);
    assert.equal(b!.auth().zai?.key, "sk-1", "the copy b already holds stays; the new key never goes");
    await a!.logout("zai");
    await converge([a!, b!]);
    assert.equal(b!.auth().zai?.key, "sk-1", "nor does the logout");
  } finally {
    for (const h of [a!, b!]) h.sync.stop();
  }
});

test("logins: a key a host takes from one peer goes on to another at its next exchange, never at once", async () => {
  // A shares the key with C only; C shares everything with B (§mesh.peers/grants: sync still
  // replicates through other hosts). Taking A's key schedules nothing on C: its watcher sees its
  // own write, whose fingerprint its records already hold. B gets the key on C's next exchange
  // (the 5-minute reconcile, a peer-up, or a settings save), and never the key A keeps.
  const KEEP = "pi:lab-keep";
  const HELD = "pi:lab-held";
  const base = join(root, `l${++seq}`);
  const hosts: LoginHost[] = [];
  // A short debounce: any sync the adoption scheduled would fire inside the wait below.
  hosts.push(new LoginHost("a", hosts, base, { c: [KEEP] }, 20));
  hosts.push(new LoginHost("b", hosts, base, { a: [KEEP, HELD], c: [KEEP, HELD] }, 20));
  hosts.push(new LoginHost("c", hosts, base, { a: [KEEP, HELD], b: [KEEP, HELD] }, 20));
  const [a, b, c] = hosts as [LoginHost, LoginHost, LoginHost];
  for (const h of hosts) await h.sync.start();
  try {
    await a.key("lab-keep", "sk-keep");
    await a.key("lab-held", "sk-held");
    await a.sync.syncWith(a.peerTo(c));
    assert.equal(c.auth()["lab-keep"]?.key, "sk-keep");
    // What C's watcher does on its own write, run here rather than waited for: it finds nothing new,
    // so no onward sync is scheduled.
    await c.sync.observe("pi");
    assert.equal((c.sync as unknown as { syncTimer?: unknown }).syncTimer, undefined, "taking a key schedules no onward push");
    assert.equal(b.auth()["lab-keep"], undefined, "B has nothing from it");
    await c.sync.syncAll(); // C's next exchange
    assert.equal(b.auth()["lab-keep"]?.key, "sk-keep");
    await converge(hosts);
    for (const h of [b, c]) assert.equal(h.auth()["lab-held"], undefined, `${h.id} never gets the key A keeps`);
  } finally {
    for (const h of hosts) h.sync.stop();
  }
});

// ---- settings and themes -----------------------------------------------------------------------

class DocHost {
  sync: DocSync;
  readonly agentDir: string;
  constructor(
    readonly id: string,
    readonly mesh: DocHost[],
    base: string,
    shares?: Record<string, DocCategory[]>,
  ) {
    this.agentDir = join(base, id, "agent");
    const stateDir = join(this.agentDir, "sova");
    mkdirSync(join(stateDir, "themes"), { recursive: true });
    this.sync = new DocSync({
      hostId: id,
      agentDir: this.agentDir,
      stateDir,
      sidecarPath: join(stateDir, "doc-sync.json"),
      peers: () => this.mesh.filter((h) => h !== this).map((h) => this.peerTo(h)),
      log: () => {},
      debounceMs: 60_000,
      ...(shares ? { shares: (peer: string, c: DocCategory) => (shares[peer] ?? []).includes(c) } : {}),
    });
  }
  peerTo(t: DocHost): DocPeer {
    return {
      id: t.id,
      manifest: async () => structuredClone(t.sync.manifest(this.id)),
      doc: async (key) => {
        const d = t.sync.doc(key, this.id);
        if (!d) throw new Error("404");
        return structuredClone(d);
      },
      push: async (body) => t.sync.receivePush(this.id, structuredClone(body)),
    };
  }
  write(rel: string, content: string) {
    const p = join(this.agentDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  read(rel: string): string | undefined {
    const p = join(this.agentDir, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }
}

const modeJson = (mode: string) => `${JSON.stringify({ mode, minorModes: [], strict: false }, null, 2)}\n`;
const theme = (name: string) => JSON.stringify({ name, base: "dark", colors: {} });

test("settings and themes: only the granted category moves, both ways", async () => {
  const base = join(root, `d${++seq}`);
  const hosts: DocHost[] = [];
  const a = new DocHost("a", hosts, base, { b: ["themes"] });
  const b = new DocHost("b", hosts, base, { a: ["themes", "settings"] });
  hosts.push(a, b);
  await a.sync.start();
  await b.sync.start();
  try {
    a.write("mode.json", modeJson("delegate"));
    a.write("sova/themes/ocean.json", theme("Ocean"));
    b.write("sova/themes/reef.json", theme("Reef"));
    a.sync.observe();
    b.sync.observe();
    for (let r = 0; r < 2; r++) for (const h of hosts) await h.sync.syncAll();
    assert.equal(b.read("sova/themes/ocean.json"), theme("Ocean"));
    assert.equal(a.read("sova/themes/reef.json"), theme("Reef"));
    assert.equal(b.read("mode.json"), undefined, "a doesn't share settings with b");
    // b's settings are never merged into a either, even pushed straight at it.
    b.write("mode.json", modeJson("normal"));
    b.sync.observe();
    const key = Object.keys(b.sync.manifest().docs).find((k) => k.includes("mode.json"));
    assert.ok(key);
    const doc = b.sync.doc(key);
    assert.ok(doc);
    const reply = a.sync.receivePush("b", { hostId: "b", now: Date.now(), docs: { [key]: doc! } });
    assert.deepEqual(reply.rejected, [{ key, reason: "disabled" }]);
    assert.equal(a.read("mode.json"), modeJson("delegate"));
  } finally {
    a.sync.stop();
    b.sync.stop();
  }
});

// Session profiles under per-peer grants (§mesh.sync/categories, §mesh.peers/grants): a profile's
// first message runs as a session's opening prompt here, so session-profiles.json goes only to a
// peer this host also grants sessions. Every other settings document still moves with settings
// alone. In process (DocSync between scratch hosts), then through the real wiring (mountSync's
// routes with a fake mesh standing in for server/mesh).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { MeshCap } from "../../shared/mesh-access";
import type { MeshSettings } from "../../shared/protocol";
import type { MeshApi } from "../mesh";
import { DocSync, settingsDocs, type DocCategory, type DocPeer } from "./docs";
import { mountSync } from "./index";

const root = mkdtempSync(join(tmpdir(), "sova-docs-grants-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

const PROFILES = "settings:sova/session-profiles.json";
const FAVORITES = "settings:model-favorites.json";
const profiles = (label: string) => JSON.stringify({ version: 1, profiles: [{ id: "reviewer", label, firstMessage: "hi", grant: ["sessions.all"], overseerMayStart: true }] });
const favorites = (id: string) => JSON.stringify({ version: 1, models: [{ provider: "zai", id }] });

/** What this host grants each peer: its capabilities. Absent = no grant options at all. */
type Grants = Record<string, MeshCap[]>;

class DocHost {
  sync: DocSync;
  readonly agentDir: string;
  constructor(
    readonly id: string,
    readonly mesh: DocHost[],
    base: string,
    grants?: Grants,
  ) {
    this.agentDir = join(base, id, "agent");
    const stateDir = join(this.agentDir, "sova");
    mkdirSync(join(stateDir, "themes"), { recursive: true });
    const allows = (peer: string, cap: MeshCap) => (grants?.[peer] ?? []).includes(cap);
    this.sync = new DocSync({
      hostId: id,
      agentDir: this.agentDir,
      stateDir,
      sidecarPath: join(stateDir, "doc-sync.json"),
      peers: () => this.mesh.filter((h) => h !== this).map((h) => this.peerTo(h)),
      log: () => {},
      debounceMs: 60_000,
      ...(grants ? { shares: (peer: string, c: DocCategory) => allows(peer, c === "settings" ? "sync.settings" : "sync.themes"), allows } : {}),
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

async function withHosts(make: (hosts: DocHost[], base: string) => DocHost[], run: (hosts: DocHost[]) => Promise<void>) {
  const base = join(root, `d${++seq}`);
  const hosts: DocHost[] = [];
  hosts.push(...make(hosts, base));
  for (const h of hosts) await h.sync.start();
  try {
    await run(hosts);
  } finally {
    for (const h of hosts) h.sync.stop();
  }
}

const rounds = async (hosts: DocHost[], n = 2) => {
  for (const h of hosts) h.sync.observe();
  for (let r = 0; r < n; r++) for (const h of hosts) await h.sync.syncAll();
};

test("session profiles need sessions too: a settings-only peer neither gets nor gives them, and still swaps favorites", async () => {
  await withHosts(
    (hosts, base) => [new DocHost("a", hosts, base, { b: ["sync.settings"] }), new DocHost("b", hosts, base, { a: ["sync.settings"] })],
    async ([a, b]) => {
      a!.write("sova/session-profiles.json", profiles("A's reviewer"));
      a!.write("model-favorites.json", favorites("glm-5.3"));
      await rounds([a!, b!]);
      assert.equal(b!.read("model-favorites.json"), favorites("glm-5.3"), "favorites still move with settings alone");
      assert.equal(b!.read("sova/session-profiles.json"), undefined, "a's profiles never reach b");
      // Not offered, not served.
      assert.equal(a!.sync.manifest("b").docs[PROFILES], undefined);
      assert.ok(a!.sync.manifest("b").docs[FAVORITES]);
      assert.equal(a!.sync.doc(PROFILES, "b"), null);
      assert.ok(a!.sync.manifest().docs[PROFILES], "with no peer named the document is there");
      // Never taken from b, even pushed straight at a and newer.
      b!.write("sova/session-profiles.json", profiles("B's planted reviewer"));
      b!.sync.observe();
      const doc = b!.sync.doc(PROFILES);
      assert.ok(doc);
      const reply = a!.sync.receivePush("b", { hostId: "b", now: Date.now(), docs: { [PROFILES]: doc! } });
      assert.deepEqual(reply.rejected, [{ key: PROFILES, reason: "disabled" }]);
      assert.equal(a!.read("sova/session-profiles.json"), profiles("A's reviewer"));
    },
  );
});

test("session profiles: never pulled from a settings-only peer that offers them anyway", async () => {
  // b grants a everything (no grant options), so it offers its profiles; a grants b settings only.
  await withHosts(
    (hosts, base) => [new DocHost("a", hosts, base, { b: ["sync.settings"] }), new DocHost("b", hosts, base)],
    async ([a, b]) => {
      b!.write("sova/session-profiles.json", profiles("B's planted reviewer"));
      b!.write("model-favorites.json", favorites("kimi"));
      b!.sync.observe();
      await a!.sync.syncWith(a!.peerTo(b!));
      assert.equal(a!.read("model-favorites.json"), favorites("kimi"));
      assert.equal(a!.read("sova/session-profiles.json"), undefined, "a never pulls b's profiles");
    },
  );
});

test("session profiles: a sessions + settings peer exchanges them both ways, favorites too", async () => {
  const caps: MeshCap[] = ["sessions", "sync.settings"];
  await withHosts(
    (hosts, base) => [new DocHost("a", hosts, base, { b: caps }), new DocHost("b", hosts, base, { a: caps })],
    async ([a, b]) => {
      a!.write("sova/session-profiles.json", profiles("A's reviewer"));
      b!.write("model-favorites.json", favorites("kimi"));
      await rounds([a!, b!]);
      assert.equal(b!.read("sova/session-profiles.json"), profiles("A's reviewer"));
      assert.equal(a!.read("model-favorites.json"), favorites("kimi"));
      b!.write("sova/session-profiles.json", profiles("B's edit"));
      await rounds([a!, b!]);
      assert.equal(a!.read("sova/session-profiles.json"), profiles("B's edit"), "b's newer edit reaches a");
    },
  );
});

test("session profiles: without grant options (no mesh-access.json, every peer full) they move as before", async () => {
  await withHosts(
    (hosts, base) => [new DocHost("a", hosts, base), new DocHost("b", hosts, base)],
    async ([a, b]) => {
      a!.write("sova/session-profiles.json", profiles("A's reviewer"));
      await rounds([a!, b!]);
      assert.equal(b!.read("sova/session-profiles.json"), profiles("A's reviewer"));
    },
  );
});

test("session profiles: still replicate through a host that grants both sides everything", async () => {
  // a keeps profiles from b (settings only), but c is full with both, so they reach b through c.
  await withHosts(
    (hosts, base) => [
      new DocHost("a", hosts, base, { b: ["sync.settings"], c: ["sessions", "sync.settings"] }),
      new DocHost("b", hosts, base, { a: ["sync.settings"], c: ["sessions", "sync.settings"] }),
      new DocHost("c", hosts, base),
    ],
    async (all) => {
      const [a, b] = all;
      a!.write("sova/session-profiles.json", profiles("A's reviewer"));
      await rounds(all, 3);
      assert.equal(b!.read("sova/session-profiles.json"), profiles("A's reviewer"));
    },
  );
});

test("only session profiles need more than their category", () => {
  const needs = Object.fromEntries(settingsDocs("/a", "/a/sova").map((s) => [s.key, s.needs ?? []]));
  assert.deepEqual(needs[PROFILES], ["sessions"]);
  for (const [key, n] of Object.entries(needs)) if (key !== PROFILES) assert.deepEqual(n, [], key);
});

// ---- through the real wiring -------------------------------------------------------------------

test("wiring: the peer routes hold session profiles back from a peer granted settings but not sessions", async () => {
  const agentDir = join(root, `w${++seq}`, "agent");
  const stateDir = join(agentDir, "sova");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "session-profiles.json"), profiles("Mine"));
  writeFileSync(join(agentDir, "model-favorites.json"), favorites("glm-5.3"));
  const grants: Grants = { s: ["sync.settings"], full: ["sessions", "sync.settings"] };
  const app = new Hono();
  const hooks = { start: [] as Array<() => void>, stop: [] as Array<() => void> };
  const settings: MeshSettings = { hostLabel: "h", sync: { settings: true, themes: true, extensions: true, logins: true }, frontDoor: null };
  const mesh = {
    enabled: () => true,
    peers: () => [],
    self: () => ({ id: "h", label: "h" }),
    settings: () => settings,
    peerFetch: async () => {
      throw new Error("no peers");
    },
    requestPeer: (c: Context) => (c.env as { meshPeer?: { id: string } } | undefined)?.meshPeer ?? null,
    mayShareWith: (peerId: string, cap: MeshCap) => (grants[peerId] ?? []).includes(cap),
    onMeshStart: (fn: () => void) => hooks.start.push(fn),
    onMeshStop: (fn: () => void) => hooks.stop.push(fn),
    onPeerUp: () => {},
    onSettingsChange: () => {},
    onSyncStatus: () => {},
  } as unknown as MeshApi;
  const rt = mountSync(app, mesh, { agentDir: () => agentDir, stateDir: () => stateDir, claudeDir: () => null });
  hooks.start.forEach((f) => f());
  try {
    const end = Date.now() + 10_000;
    while (!rt.docs?.manifest().docs[PROFILES] && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const as = (peer: string, path: string, init?: RequestInit) => app.request(path, init, { meshPeer: { id: peer } });
    const manifest = async (peer: string) => ((await (await as(peer, "/api/peer/sync/manifest")).json()) as { docs: Record<string, unknown> }).docs;
    const s = await manifest("s");
    assert.ok(s[FAVORITES], "favorites offered with settings alone");
    assert.equal(s[PROFILES], undefined, "profiles not offered without sessions");
    assert.equal((await as("s", `/api/peer/sync/doc?key=${encodeURIComponent(PROFILES)}`)).status, 404);
    assert.ok((await manifest("full"))[PROFILES], "a sessions + settings peer is offered profiles");
    assert.equal((await as("full", `/api/peer/sync/doc?key=${encodeURIComponent(PROFILES)}`)).status, 200);
    // A push from the settings-only peer is refused for profiles, taken for favorites.
    const content = profiles("Planted");
    const { createHash } = await import("node:crypto");
    const meta = (text: string) => ({ hash: createHash("sha256").update(text).digest("hex"), modifiedAt: Date.now() + 1000, origin: "s" });
    const push = { hostId: "s", now: Date.now(), docs: { [PROFILES]: { meta: meta(content), content }, [FAVORITES]: { meta: meta(favorites("kimi")), content: favorites("kimi") } } };
    const reply = (await (await as("s", "/api/peer/sync/push", { method: "POST", body: JSON.stringify(push), headers: { "content-type": "application/json" } })).json()) as {
      accepted: string[];
      rejected: { key: string; reason: string }[];
    };
    assert.deepEqual(reply.rejected, [{ key: PROFILES, reason: "disabled" }]);
    assert.deepEqual(reply.accepted, [FAVORITES]);
    assert.equal(readFileSync(join(stateDir, "session-profiles.json"), "utf8"), profiles("Mine"));
    assert.equal(readFileSync(join(agentDir, "model-favorites.json"), "utf8"), favorites("kimi"));
  } finally {
    hooks.stop.forEach((f) => f());
  }
});

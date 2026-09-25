// Extensions across the mesh: each host publishes its own manifest entries; peers list the ones
// they lack, and a peer entry whose dist isn't installed here is marked so (never proxied).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExtension, listExtensions, setPeerExtensions, validateExtension, type ExtensionEntry } from "../extensions";
import { ExtensionSync, type ExtensionPeer } from "./extensions";

const root = mkdtempSync(join(tmpdir(), "sova-ext-sync-"));
after(() => rmSync(root, { recursive: true, force: true }));
// This host's manifest for the hook tests (read per call by server/extensions.ts).
process.env.SOVA_EXTENSIONS_FILE = join(root, "extensions.json");
let seq = 0;

const entry = (id: string, dist: string, port = 7001): ExtensionEntry => ({ id, title: id, dist, api: `http://127.0.0.1:${port}` });

function host(id: string, local: ExtensionEntry[], peers: () => ExtensionPeer[], extra: { peerIds?: () => string[]; enabled?: () => boolean } = {}) {
  const dir = join(root, `h${++seq}`);
  mkdirSync(dir, { recursive: true });
  const sync = new ExtensionSync({ hostId: id, file: join(dir, "mesh-extensions.json"), local: () => local, validate: validateExtension, peers, ...extra });
  return { sync, dir, local };
}
const as = (id: string, s: ExtensionSync): ExtensionPeer => ({ id, extensions: async () => structuredClone(s.published()), notify: async () => {} });

test("a peer's extensions are listed here; installed only where its dist exists here; a local id wins", async () => {
  const installed = join(root, "installed-dist");
  mkdirSync(installed);
  const a = host("a", [entry("notes", installed), entry("board", "/nonexistent/board/dist"), entry("shared", installed, 7005)], () => []);
  const b = host("b", [entry("shared", installed, 7100)], () => [as("a", a.sync)]);
  await b.sync.syncAll();
  const got = b.sync.peerEntries();
  assert.deepEqual(
    got.map((p) => [p.entry.id, p.from, p.installed]),
    [
      ["notes", "a", true],
      ["board", "a", false],
    ],
  );
  assert.equal(got.find((p) => p.entry.id === "shared"), undefined, "B's own 'shared' wins");
  // The file B keeps holds A's list, not B's own manifest.
  assert.deepEqual(readdirSync(b.dir), ["mesh-extensions.json"]);
});

test("removing an entry at its origin removes it here at the next exchange; a removed peer's list is dropped", async () => {
  const dist = join(root, "d2");
  mkdirSync(dist);
  const aLocal = [entry("x", dist), entry("y", dist)];
  const a = host("a", aLocal, () => []);
  let peerIds = ["a"];
  const b = host("b", [], () => [as("a", a.sync)], { peerIds: () => peerIds });
  await b.sync.syncAll();
  assert.deepEqual(b.sync.peerEntries().map((p) => p.entry.id), ["x", "y"]);
  aLocal.pop();
  await b.sync.syncAll();
  assert.deepEqual(b.sync.peerEntries().map((p) => p.entry.id), ["x"]);
  peerIds = [];
  assert.deepEqual(b.sync.peerEntries(), []);
});

test("a peer's entries are re-validated with the manifest's own rules; off lists and publishes nothing", async () => {
  const bad: ExtensionPeer = {
    id: "evil",
    notify: async () => {},
    extensions: async () => ({
      hostId: "evil",
      now: Date.now(),
      entries: [
        { id: "remote-api", title: "x", dist: "/tmp", api: "http://10.0.0.5:80" } as ExtensionEntry,
        { id: "../up", title: "x", dist: "/tmp", api: "http://127.0.0.1:1" } as ExtensionEntry,
        { id: "rel", title: "x", dist: "relative/dist", api: "http://127.0.0.1:1" } as ExtensionEntry,
        entry("fine", "/nonexistent"),
      ],
    }),
  };
  let on = true;
  const b = host("b", [entry("mine", "/x")], () => [bad], { enabled: () => on });
  await b.sync.syncAll();
  assert.deepEqual(b.sync.peerEntries().map((p) => p.entry.id), ["fine"]);
  on = false;
  assert.deepEqual(b.sync.peerEntries(), []);
  assert.deepEqual(b.sync.published().entries, []);
});

test("the peers' lists survive a restart (the file), and a down peer keeps its last list", async () => {
  const a = host("a", [entry("x", "/nowhere")], () => []);
  const dir = join(root, "restart");
  mkdirSync(dir);
  const file = join(dir, "mesh-extensions.json");
  let up = true;
  const peer: ExtensionPeer = {
    id: "a",
    extensions: async () => (up ? structuredClone(a.sync.published()) : Promise.reject(new Error("down"))),
    notify: async () => {},
  };
  const b1 = new ExtensionSync({ hostId: "b", file, local: () => [], validate: validateExtension, peers: () => [peer] });
  await b1.syncAll();
  up = false;
  const b2 = new ExtensionSync({ hostId: "b", file, local: () => [], validate: validateExtension, peers: () => [peer] });
  await b2.syncAll();
  assert.deepEqual(b2.peerEntries().map((p) => p.entry.id), ["x"]);
  assert.equal(b2.peers().a?.state, "error");
});

test("server/extensions hook: unset, the listing and lookup are exactly the manifest's; set, peers' entries join", async () => {
  const dist = join(root, "hook-dist");
  mkdirSync(dist);
  // A port nothing listens on (bound, then released).
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const dead = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  writeFileSync(
    process.env.SOVA_EXTENSIONS_FILE!,
    JSON.stringify({ version: 1, extensions: [{ id: "local", title: "Local", dist, api: `http://127.0.0.1:${dead}` }] }),
  );
  const before = { list: await listExtensions(), local: findExtension("local"), peer: findExtension("peer-here") };
  setPeerExtensions(() => [
    { entry: entry("peer-here", dist, dead), installed: true },
    { entry: { ...entry("peer-elsewhere", "/nonexistent/dist", dead), description: "d", icon: "grid" }, installed: false },
  ]);
  try {
    const list = await listExtensions();
    assert.deepEqual(
      list.map((e) => [e.id, e.status, e.error]),
      [
        ["local", "down", "connection refused"],
        ["peer-here", "down", "on another host; add it to this host's extensions.json to use it here"],
        ["peer-elsewhere", "down", "not installed on this host"],
      ],
    );
    assert.equal(list[2]!.icon, "grid");
    // Never served, whatever its dist: a peer's `dist: "/"` and loopback `api` would otherwise hand
    // it this host's files and ports.
    assert.equal(findExtension("peer-here"), undefined, "a peer entry is never served here");
    assert.equal(findExtension("peer-elsewhere"), undefined);
    assert.equal(findExtension("local")?.id, "local");
  } finally {
    setPeerExtensions(null);
  }
  assert.deepEqual({ list: await listExtensions(), local: findExtension("local"), peer: findExtension("peer-here") }, before);
  assert.equal(before.peer, undefined);
});

test("a change to this host's manifest is pushed to peers by itself (no reconcile wait)", async () => {
  const dir = join(root, "watched");
  mkdirSync(dir);
  const manifest = join(dir, "extensions.json");
  const dist = join(root, "watched-dist");
  mkdirSync(dist);
  const readLocal = (): ExtensionEntry[] => {
    try {
      const d = JSON.parse(readFileSync(manifest, "utf8")) as { extensions: unknown[] };
      return d.extensions.map((r) => validateExtension(r)).flatMap((v) => ("entry" in v ? [v.entry] : []));
    } catch {
      return [];
    }
  };
  const b = host("b", [], () => []);
  const aDir = join(root, "watched-a");
  mkdirSync(aDir);
  const a = new ExtensionSync({
    hostId: "a",
    file: join(aDir, "mesh-extensions.json"),
    local: readLocal,
    validate: validateExtension,
    peers: () => [{ id: "b", extensions: async () => structuredClone(b.sync.published()), notify: async (list) => b.sync.receive("a", structuredClone(list)) }],
  });
  a.start(manifest, 30);
  try {
    writeFileSync(manifest, JSON.stringify({ version: 1, extensions: [entry("fresh", dist)] }));
    const end = Date.now() + 3000;
    while (!b.sync.peerEntries().some((p) => p.entry.id === "fresh") && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(b.sync.peerEntries().map((p) => [p.entry.id, p.from]), [["fresh", "a"]]);
  } finally {
    a.stop();
  }
});

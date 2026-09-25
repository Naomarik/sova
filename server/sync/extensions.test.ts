// Extensions across the mesh: each host publishes its own manifest entries; peers list the ones
// they lack, and a peer entry whose dist isn't installed here is marked so (never proxied).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExtension, type ExtensionEntry } from "../extensions";
import { ExtensionSync, type ExtensionPeer } from "./extensions";

const root = mkdtempSync(join(tmpdir(), "sova-ext-sync-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

const entry = (id: string, dist: string, port = 7001): ExtensionEntry => ({ id, title: id, dist, api: `http://127.0.0.1:${port}` });

function host(id: string, local: ExtensionEntry[], peers: () => ExtensionPeer[], extra: { peerIds?: () => string[]; enabled?: () => boolean } = {}) {
  const dir = join(root, `h${++seq}`);
  mkdirSync(dir, { recursive: true });
  const sync = new ExtensionSync({ hostId: id, file: join(dir, "mesh-extensions.json"), local: () => local, validate: validateExtension, peers, ...extra });
  return { sync, dir, local };
}
const as = (id: string, s: ExtensionSync): ExtensionPeer => ({ id, extensions: async () => structuredClone(s.published()) });

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
  const peer: ExtensionPeer = { id: "a", extensions: async () => (up ? structuredClone(a.sync.published()) : Promise.reject(new Error("down"))) };
  const b1 = new ExtensionSync({ hostId: "b", file, local: () => [], validate: validateExtension, peers: () => [peer] });
  await b1.syncAll();
  up = false;
  const b2 = new ExtensionSync({ hostId: "b", file, local: () => [], validate: validateExtension, peers: () => [peer] });
  await b2.syncAll();
  assert.deepEqual(b2.peerEntries().map((p) => p.entry.id), ["x"]);
  assert.equal(b2.peers().a?.state, "error");
});

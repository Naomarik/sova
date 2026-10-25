// Run: pnpm test -- server/extension-keys.test.ts
// Each extension backend's own key (§app.extensions/backend-key), the registry alone: issue, storage
// (hash first, plaintext only in the backend's 0600 file), call-time revocation, rotation by delete,
// a bad manifest that changes nothing, case-free file names, crash-safe ordering, and the sockets a
// key opened, closed when it is revoked or replaced (and only by a sync).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-keys-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
const { ExtensionKeys, keyFileName } = await import("./extension-keys");
after(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let n = 0;
/** A registry over its own folder, with the installed ids as the test sets them. */
function rig(opts: { io?: Record<string, unknown> } = {}) {
  const root = join(tmp, `r${n++}`);
  fs.mkdirSync(root, { recursive: true });
  let ids: string[] | null = [];
  const keys = new ExtensionKeys({
    dir: () => join(root, "extension-keys"),
    hashFile: () => join(root, "extension-key-hashes.json"),
    installed: () => ids,
    isInstalled: (id) => !!ids?.includes(id),
    io: opts.io as never,
    log: () => {},
  });
  const set = (next: string[] | null) => void (ids = next);
  const key = (id: string) => readFileSync(keys.fileOf(id), "utf8").trim();
  const hashes = () => JSON.parse(readFileSync(join(root, "extension-key-hashes.json"), "utf8")) as { keys: Record<string, { hash: string }> };
  return { root, keys, set, key, hashes };
}
/** A socket stand-in: destroy() ends it with a close, as a net.Socket's does. */
function fakeSocket(): Duplex & { closed: boolean } {
  const s = new EventEmitter() as EventEmitter & { destroyed: boolean; closed: boolean; destroy(): void };
  s.destroyed = false;
  s.closed = false;
  s.destroy = () => {
    if (s.destroyed) return;
    s.destroyed = true;
    s.closed = true;
    s.emit("close");
  };
  return s as unknown as Duplex & { closed: boolean };
}

test("a key per installed id: 0600 in a 0700 folder, its hash alone on record, admitted by hash", () => {
  const { root, keys, set, key, hashes } = rig();
  set(["notes", "Foo", "foo"]);
  keys.sync();
  for (const id of ["notes", "Foo", "foo"]) {
    const k = key(id);
    assert.match(k, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(keys.fileOf(id)).mode & 0o777, 0o600, id);
    assert.equal(keys.idOf(k), id);
    assert.equal(hashes().keys[id]!.hash, sha(k));
    assert.ok(!readFileSync(join(root, "extension-key-hashes.json"), "utf8").includes(k), "no plaintext on record");
  }
  assert.equal(statSync(join(root, "extension-keys")).mode & 0o777, 0o700);
  // Case-free names: Foo and foo never share a file, so neither backend reads the other's key.
  assert.notEqual(keyFileName("Foo").toLowerCase(), keyFileName("foo").toLowerCase());
  assert.notEqual(key("Foo"), key("foo"));
  assert.match(keyFileName("Foo"), /^foo-[0-9a-f]{8}\.key$/);
  // Another extension's key, a wrong length, junk: nobody.
  assert.equal(keys.idOf(key("notes").slice(1)), null);
  assert.equal(keys.idOf("x".repeat(43)), null);
  assert.equal(keys.isKey(key("notes")), true);
  assert.equal(keys.isKey("x".repeat(43)), false);
});

test("a sync with nothing changed keeps every key; a fresh registry over the same files does too", () => {
  const { root, keys, set, key } = rig();
  set(["notes"]);
  keys.sync();
  const k = key("notes");
  keys.sync();
  keys.sync();
  assert.equal(key("notes"), k);
  const again = new ExtensionKeys({ dir: () => join(root, "extension-keys"), hashFile: () => join(root, "extension-key-hashes.json"), installed: () => ["notes"], isInstalled: () => true, log: () => {} });
  again.sync();
  assert.equal(again.idOf(k), "notes", "a restart keeps the key");
  assert.equal(key("notes"), k);
});

test("uninstall refuses at once; the second sync in a row without it removes file and hash; reinstalling mints a new key", () => {
  const { keys, set, key, hashes } = rig();
  set(["notes", "other"]);
  keys.sync();
  const k = key("notes");
  const file = keys.fileOf("notes");
  set(["other"]);
  assert.equal(keys.idOf(k), null, "refused before any sync");
  keys.sync();
  assert.equal(fs.existsSync(file), true, "one sync without it keeps the key");
  keys.sync();
  assert.equal(fs.existsSync(file), false);
  assert.equal(hashes().keys.notes, undefined);
  assert.equal(keys.isKey(k), false);
  set(["other", "notes"]);
  keys.sync();
  assert.notEqual(key("notes"), k, "never the old key again");
  assert.equal(keys.idOf(k), null);
  assert.equal(keys.idOf(key("notes")), "notes");
});

test("rotate by deleting the file: the old key is refused at once, the next sync writes a new one", () => {
  const { keys, set, key } = rig();
  set(["notes"]);
  keys.sync();
  const k = key("notes");
  rmSync(keys.fileOf("notes"));
  assert.equal(keys.idOf(k), null);
  keys.sync();
  const k2 = key("notes");
  assert.notEqual(k2, k);
  assert.equal(keys.idOf(k2), "notes");
  assert.equal(keys.idOf(k), null);
});

test("a key file someone edited is never accepted: the next sync replaces it", () => {
  const { keys, set, key } = rig();
  set(["notes"]);
  keys.sync();
  const k = key("notes");
  const chosen = "C".repeat(43);
  writeFileSync(keys.fileOf("notes"), `${chosen}\n`);
  assert.equal(keys.idOf(chosen), null, "a file never makes a key");
  keys.sync();
  const k2 = key("notes");
  assert.notEqual(k2, chosen);
  assert.notEqual(k2, k);
  assert.equal(keys.idOf(k2), "notes");
});

test("a manifest that can't be read whole changes no key, and closes no socket", () => {
  const { keys, set, key } = rig();
  set(["notes"]);
  keys.sync();
  const k = key("notes");
  const s = fakeSocket();
  keys.socket("notes", s);
  set(null); // garbage, a half-written save
  keys.sync();
  keys.sync();
  assert.equal(fs.existsSync(keys.fileOf("notes")), true);
  assert.equal(s.closed, false, "a bad save never cuts a backend's socket");
  set(["notes"]);
  keys.sync();
  assert.equal(key("notes"), k, "the same key after the manifest reads whole again");
  assert.equal(keys.idOf(k), "notes");
});

test("through the real manifest: garbage, an empty file, then the whole file again, and the same key", () => {
  const manifest = process.env.SOVA_EXTENSIONS_FILE!;
  const whole = JSON.stringify({ version: 1, extensions: [{ id: "real", dist: "/x", api: "http://127.0.0.1:4999" }] });
  writeFileSync(manifest, whole);
  const keys = new ExtensionKeys({ log: () => {} });
  keys.sync();
  const k = readFileSync(keys.fileOf("real"), "utf8").trim();
  assert.equal(keys.idOf(k), "real");
  for (const bad of ["{\"version\": 1, \"extensions\": [", "", "{\"version\": 2, \"extensions\": []}"]) {
    writeFileSync(manifest, bad);
    assert.equal(keys.idOf(k), null, "refused while the manifest is bad");
    keys.sync();
    assert.equal(fs.existsSync(keys.fileOf("real")), true, JSON.stringify(bad));
  }
  writeFileSync(manifest, whole);
  keys.sync();
  assert.equal(readFileSync(keys.fileOf("real"), "utf8").trim(), k);
  assert.equal(keys.idOf(k), "real");
  // A save that moves the file away for a moment (rename-away, then write): one sync over the gap
  // keeps the key.
  rmSync(manifest);
  assert.equal(keys.idOf(k), null, "refused while it is gone");
  keys.sync();
  writeFileSync(manifest, whole);
  keys.sync();
  assert.equal(readFileSync(keys.fileOf("real"), "utf8").trim(), k);
  assert.equal(keys.idOf(k), "real");
  // Gone for two syncs in a row: revoked.
  rmSync(manifest);
  keys.sync();
  assert.equal(fs.existsSync(keys.fileOf("real")), true);
  keys.sync();
  assert.equal(fs.existsSync(keys.fileOf("real")), false);
});

test("the absence count starts over when the id comes back", () => {
  const { keys, set, key } = rig();
  set(["notes"]);
  keys.sync();
  const k = key("notes");
  for (let i = 0; i < 4; i++) {
    set([]);
    keys.sync();
    set(["notes"]);
    keys.sync();
  }
  assert.equal(key("notes"), k, "never two in a row: never revoked");
  set([]);
  keys.sync();
  set(null); // a bad read between two absences neither counts nor resets
  keys.sync();
  set([]);
  keys.sync();
  assert.equal(fs.existsSync(keys.fileOf("notes")), false);
});

test("the hash is recorded before the file: a failed hash write writes no key; a failed key write is re-minted", () => {
  let failHash = true;
  let failKey = false;
  const io = {
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (failHash && String(to).endsWith("extension-key-hashes.json")) throw new Error("disk full (hash)");
      if (failKey && String(to).endsWith(".key")) throw new Error("disk full (key)");
      fs.renameSync(from, to);
    },
  };
  const { keys, set, key, hashes } = rig({ io });
  set(["notes"]);
  keys.sync();
  assert.equal(fs.existsSync(keys.fileOf("notes")), false, "no key file without its hash on record");
  failHash = false;
  failKey = true;
  keys.sync();
  assert.equal(fs.existsSync(keys.fileOf("notes")), false);
  assert.ok(hashes().keys.notes, "the hash landed first");
  failKey = false;
  keys.sync();
  const k = key("notes");
  assert.equal(hashes().keys.notes!.hash, sha(k), "file and record agree");
  assert.equal(keys.idOf(k), "notes");
});

test("sockets a key opened close when it is revoked or replaced, by a sync only; a closed one is forgotten", () => {
  const { keys, set, key } = rig();
  set(["notes", "other"]);
  keys.sync();
  const notesKey = key("notes");
  const a = fakeSocket();
  const b = fakeSocket();
  const o = fakeSocket();
  keys.socket("notes", a);
  keys.socket("notes", b);
  keys.socket("other", o);
  assert.equal(keys.openSockets("notes"), 2);
  // A socket the route refused, or that ended, leaves nothing behind.
  b.destroy();
  assert.equal(keys.openSockets("notes"), 1);
  // The call-time refusal alone never closes a socket.
  set(["other"]);
  assert.equal(keys.idOf(notesKey), null, "refused at the call");
  assert.equal(a.closed, false, "but its socket waits for the sync");
  keys.sync();
  assert.equal(a.closed, false, "one sync without it is not yet an uninstall");
  keys.sync();
  assert.equal(a.closed, true, "uninstalled: closed");
  assert.equal(o.closed, false, "another extension's socket stays");
  // Rotation closes the old key's sockets too.
  rmSync(keys.fileOf("other"));
  keys.sync();
  assert.equal(o.closed, true, "re-minted: closed");
  assert.equal(keys.openSockets("other"), 0);
});

test("an already-ended socket is never held", () => {
  const { keys, set } = rig();
  set(["notes"]);
  keys.sync();
  const s = fakeSocket();
  s.destroy();
  keys.socket("notes", s);
  assert.equal(keys.openSockets("notes"), 0);
});

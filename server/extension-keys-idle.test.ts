// Run: pnpm test -- server/extension-keys-idle.test.ts
// The key sync's schedule (§app.extensions/backend-key): with nothing installed and no key held it
// reads nothing until the manifest's folder says it changed; a new manifest's keys appear at once;
// a revocation still takes two whole reads in a row; a manifest that can't be watched keeps the
// 3 s timer.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-ext-keys-idle-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
const { ExtensionKeys, startExtensionKeys, SYNC_MS } = await import("./extension-keys");
type KeySyncClock = import("./extension-keys").KeySyncClock;
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A registry counting its manifest reads, and a clock the test advances by hand. */
function rig(opts: { watchable?: boolean } = {}) {
  const root = join(tmp, `r${n++}`);
  fs.mkdirSync(root, { recursive: true });
  let ids: string[] | null = [];
  let reads = 0;
  const keys = new ExtensionKeys({
    dir: () => join(root, "extension-keys"),
    hashFile: () => join(root, "extension-key-hashes.json"),
    installed: () => (reads++, ids),
    isInstalled: (id) => !!ids?.includes(id),
    log: () => {},
  });
  let timers: { fn: () => void; ms: number }[] = [];
  let onChange: (() => void) | null = null;
  const clock: KeySyncClock = {
    every(fn, ms) {
      const t = { fn, ms };
      timers.push(t);
      return () => void (timers = timers.filter((x) => x !== t));
    },
    watch: (cb) => (opts.watchable === false ? null : ((onChange = cb), () => void (onChange = null))),
  };
  /** `ms` of time passing: each timer fires once per its period. */
  const advance = (ms: number) => {
    for (let t = SYNC_MS; t <= ms; t += SYNC_MS) for (const x of [...timers]) x.fn();
  };
  const stop = startExtensionKeys(keys, clock);
  after(stop);
  return {
    keys,
    set: (next: string[] | null) => void (ids = next),
    reads: () => reads,
    timers: () => timers.length,
    advance,
    changed: () => onChange?.(),
    has: (id: string) => fs.existsSync(keys.fileOf(id)),
  };
}

test("nothing installed and no key held: one read at start, then none for 30 s, and no timer", () => {
  const r = rig();
  r.advance(30_000);
  assert.equal(r.reads(), 1);
  assert.equal(r.timers(), 0);
});

test("a manifest appears: its keys at once, on the folder's word, and the timer follows it from then", () => {
  const r = rig();
  r.set(["notes"]);
  r.changed();
  assert.ok(r.has("notes"), "the key is written at once, inside the 3 s bound");
  assert.equal(r.timers(), 1);
  const before = r.reads();
  r.advance(SYNC_MS * 2);
  assert.equal(r.reads(), before + 2);
});

test("an uninstall still takes two whole reads in a row; then the timer stops", () => {
  const r = rig();
  r.set(["notes"]);
  r.changed();
  r.set([]);
  r.changed(); // the save's own folder event, while the timer follows: never counted as a read
  r.changed();
  assert.ok(r.has("notes"), "folder events alone never revoke");
  r.advance(SYNC_MS);
  assert.ok(r.has("notes"), "one whole read without it keeps the key");
  r.advance(SYNC_MS);
  assert.ok(!r.has("notes"), "the second whole read in a row removes it");
  assert.equal(r.timers(), 0);
  const before = r.reads();
  r.advance(30_000);
  assert.equal(r.reads(), before);
});

test("a manifest that can't be read whole keeps the timer", () => {
  const r = rig();
  r.set(null);
  r.changed();
  assert.equal(r.timers(), 1);
});

test("through the real folder watch: no manifest, then one written, and its key appears inside the 3 s bound", async () => {
  const manifest = process.env.SOVA_EXTENSIONS_FILE!;
  rmSync(manifest, { force: true });
  const keys = new ExtensionKeys({ log: () => {} });
  const stop = startExtensionKeys(keys);
  after(stop);
  assert.equal(keys.idle(), true);
  const at = Date.now();
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, extensions: [{ id: "watched", dist: "/x", api: "http://127.0.0.1:4999" }] }));
  while (!fs.existsSync(keys.fileOf("watched")) && Date.now() - at < SYNC_MS) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(keys.fileOf("watched")), "the key is written once the folder says the manifest changed");
  stop();
});

test("a folder that can't be watched keeps the 3 s timer, as before", () => {
  const r = rig({ watchable: false });
  r.advance(30_000);
  assert.equal(r.reads(), 11);
  assert.equal(r.timers(), 1);
});

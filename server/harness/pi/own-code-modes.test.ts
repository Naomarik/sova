// The modes owner in the loader (Settings → Experimental "Sova runs chat modes"): the mode extension's
// slot taken by Sova's entry under withModesEntry, bound to the package manager for its life, and a
// worker's listed mode files mapped in place.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isModeExtension, modeFileOf, patchResolve, withModesEntry, workerModePaths } from "./own-code";

const t = realpathSync(mkdtempSync(join(tmpdir(), "own-code-modes-")));
after(() => rmSync(t, { recursive: true, force: true }));
const touch = (p: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "export default () => {};\n");
};
const live = join(t, "live");
const ext = (name: string, file = "index.ts") => join(live, "pi-config", "extensions", name, file);
touch(ext("mode"));
touch(ext("mode", "spec-worker.ts"));
touch(ext("mode", "project-tools-worker.ts"));
touch(ext("spec"));
touch(join(t, "other", "extensions", "mode", "index.ts")); // a "mode" outside any pi-config
mkdirSync(join(t, "agent", "extensions"), { recursive: true });
symlinkSync(join(live, "pi-config", "extensions", "mode"), join(t, "agent", "extensions", "mode"));
const ENTRY = join(t, "sova", "server", "harness", "pi", "modes-entry.ts");
const entries = { entry: ENTRY, specWorker: join(t, "sova", "spec-w.ts"), projectToolsWorker: join(t, "sova", "pt-w.ts") };

test("the mode extension is recognised as a directory, its index.ts, or through the agent dir's link; nothing else is", () => {
  assert.equal(isModeExtension(join(live, "pi-config", "extensions", "mode")), true);
  assert.equal(isModeExtension(ext("mode")), true);
  assert.equal(isModeExtension(join(t, "agent", "extensions", "mode")), true);
  assert.equal(isModeExtension(join(t, "agent", "extensions", "mode", "index.ts")), true);
  assert.equal(isModeExtension(ext("spec")), false);
  assert.equal(isModeExtension(ext("mode", "spec-worker.ts")), false);
  assert.equal(isModeExtension(join(t, "other", "extensions", "mode", "index.ts")), false, "not under pi-config");
  assert.equal(modeFileOf(ext("mode", "spec-worker.ts")), "specWorker");
  assert.equal(modeFileOf(ext("mode", "project-tools-worker.ts")), "projectToolsWorker");
  assert.equal(modeFileOf(join(t, "agent", "extensions", "mode")), "entry");
  assert.equal(modeFileOf(ext("spec")), null);
});

function fakePm() {
  const meta = { source: "local", scope: "user", origin: "top-level" };
  return class FakePm {
    async resolve() {
      return {
        extensions: [
          { path: ext("spec"), enabled: true, metadata: meta },
          { path: join(t, "agent", "extensions", "mode", "index.ts"), enabled: false, metadata: meta },
          { path: join(t, "pkg", "a.ts"), enabled: true, metadata: meta },
        ],
      };
    }
  };
}

test("under withModesEntry the mode extension's slot becomes the entry, its flags kept; elsewhere nothing changes", async () => {
  const Pm = fakePm();
  const unpatch = patchResolve(Pm as never, null);
  try {
    const sova = await withModesEntry(ENTRY, () => new Pm().resolve());
    assert.deepEqual(sova.extensions.map((r) => r.path), [ext("spec"), ENTRY, join(t, "pkg", "a.ts")], "same slot, nothing added or dropped");
    assert.equal(sova.extensions[1]!.enabled, false, "pi's enabled flag kept");
    const off = await withModesEntry(null, () => new Pm().resolve());
    assert.equal(off.extensions[1]!.path, join(t, "agent", "extensions", "mode", "index.ts"), "flag off: the extension");
    const none = await new Pm().resolve();
    assert.equal(none.extensions[1]!.path, join(t, "agent", "extensions", "mode", "index.ts"), "no scope: the extension");
  } finally {
    unpatch();
  }
});

test("a package manager keeps the owner it was built under on a later resolve() outside the scope (a pi reload)", async () => {
  const Pm = fakePm();
  const unpatch = patchResolve(Pm as never, null);
  try {
    const sovaPm = new Pm();
    const extPm = new Pm();
    await withModesEntry(ENTRY, () => sovaPm.resolve());
    await withModesEntry(null, () => extPm.resolve());
    assert.equal((await sovaPm.resolve()).extensions[1]!.path, ENTRY);
    assert.equal((await withModesEntry(null, () => sovaPm.resolve())).extensions[1]!.path, ENTRY, "never flips mid-life");
    assert.equal((await withModesEntry(ENTRY, () => extPm.resolve())).extensions[1]!.path, join(t, "agent", "extensions", "mode", "index.ts"));
  } finally {
    unpatch();
  }
});

test("a Sova-owned worker's mode files map in place, order kept; flags and other paths untouched", () => {
  const list = [ext("spec"), join(t, "agent", "extensions", "mode"), ext("mode", "spec-worker.ts"), ext("mode", "project-tools-worker.ts"), "npm:x", join(t, "pkg", "a.ts")];
  assert.deepEqual(workerModePaths(list, true, entries, null), [ext("spec"), entries.entry, entries.specWorker, entries.projectToolsWorker, "npm:x", join(t, "pkg", "a.ts")]);
});

test("a Sova-owned worker's mode slot maps even when the tree's mode extension lies outside any pi-config", () => {
  const odd = join(t, "other", "extensions", "mode");
  assert.deepEqual(workerModePaths([odd, join(odd, "index.ts")], true, entries, null), [entries.entry, entries.entry]);
  assert.deepEqual(workerModePaths([odd], false, entries, null), [odd], "the extension's way: the tree's copy, as before");
});

test("a worker whose parent ran the extension keeps every mode file it lists, but one this copy lacks maps instead of failing", () => {
  const list = [ext("mode"), ext("mode", "spec-worker.ts"), ext("mode", "project-tools-worker.ts")];
  assert.deepEqual(workerModePaths(list, false, entries, null), list, "exactly today");
  const gone = join(live, "pi-config", "extensions", "mode", "retired-spec-worker");
  const retired = [join(gone, "..", "spec-worker-old.ts"), join(t, "gen", "pi-config", "extensions", "mode", "spec-worker.ts")];
  assert.deepEqual(workerModePaths(retired, false, entries, null), [retired[0], entries.specWorker], "only a known worker file that is missing maps");
});

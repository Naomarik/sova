// Run: npm test (or npx tsx --test server/folders.test.ts)
// Builds a throwaway tree in the OS temp dir and removes it afterwards.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listFolders } from "./folders";

const root = mkdtempSync(join(tmpdir(), "sova-folders-test-"));
for (const d of ["beta", "Alpha", "gamma", ".hidden", "locked"]) mkdirSync(join(root, d));
writeFileSync(join(root, "file.txt"), "x");
writeFileSync(join(root, "aaa-file"), "x");
symlinkSync(join(root, "gamma"), join(root, "link-to-dir"));
symlinkSync(join(root, "file.txt"), join(root, "link-to-file"));
symlinkSync(join(root, "missing"), join(root, "dangling"));
chmodSync(join(root, "locked"), 0o000);
after(() => {
  chmodSync(join(root, "locked"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

const ok = async (...args: Parameters<typeof listFolders>) => {
  const r = await listFolders(...args);
  assert.ok(r.ok, JSON.stringify(r));
  return r.listing;
};

test("lists only directories, case-insensitively sorted; files, symlink→file and dangling links are left out", async () => {
  const l = await ok(root);
  assert.deepEqual(
    l.entries.map((e) => e.name),
    ["Alpha", "beta", "gamma", "link-to-dir", "locked"],
  );
  assert.equal(l.path, root);
  assert.equal(l.truncated, false);
  assert.ok(l.entries.every((e) => e.path === join(root, e.name)));
});

test("a symlink to a directory is flagged; real directories aren't", async () => {
  const l = await ok(root);
  assert.equal(l.entries.find((e) => e.name === "link-to-dir")?.symlink, true);
  assert.equal(l.entries.find((e) => e.name === "gamma")?.symlink, undefined);
});

test("dot folders only with hidden", async () => {
  assert.ok(!(await ok(root)).entries.some((e) => e.name === ".hidden"));
  assert.equal((await ok(root, { hidden: true })).entries[0]?.name, ".hidden");
});

test("truncates to the cap in sort order", async () => {
  const l = await ok(root, { cap: 2 });
  assert.deepEqual(l.entries.map((e) => e.name), ["Alpha", "beta"]);
  assert.equal(l.truncated, true);
});

test("normalizes the path and reports its parent; root has none", async () => {
  const l = await ok(`${root}/gamma/../beta/`);
  assert.equal(l.path, join(root, "beta"));
  assert.equal(l.parent, root);
  assert.equal((await ok("/")).parent, null);
});

test("no path lists $HOME", async () => {
  assert.equal((await ok(undefined)).path, homedir());
});

test("errors: not absolute → 400, missing → 404, a file → 404", async () => {
  assert.deepEqual(await listFolders("relative/dir"), { ok: false, status: 400, error: "path must be an absolute path" });
  const missing = await listFolders(join(root, "nope"));
  assert.ok(!missing.ok && missing.status === 404);
  const file = await listFolders(join(root, "file.txt"));
  assert.ok(!file.ok && file.status === 404);
});

test("an unreadable folder → 403", { skip: process.getuid?.() === 0 ? "root can read anything" : false }, async () => {
  const r = await listFolders(join(root, "locked"));
  assert.ok(!r.ok && r.status === 403, JSON.stringify(r));
});

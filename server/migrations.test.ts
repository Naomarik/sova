import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { migrationsDue } from "../migrations/due.mjs";

/**
 * migrations/: temporary code that keeps something older working, one folder per migration, each listed in
 * migrations/manifest.json with the version that drops it. This file fails once Sova's version reaches a migration's
 * removeIn: clear it out of git then (its folder, its entry, the call sites its paths name).
 */
const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "migrations");

interface Migration {
  id: string;
  what: string;
  since: string;
  removeIn: string;
  paths: string[];
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (v: string): number[] => {
  const m = VERSION_RE.exec(v);
  assert.ok(m, `${v} is a version x.y.z`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
/** a < b, as versions. */
const before = (a: string, b: string): boolean => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
};

const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as Migration[];
const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

test("the version comparison orders versions by number, not by text", () => {
  assert.ok(before("0.16.0", "0.18.0"));
  assert.ok(before("0.9.9", "0.10.0"));
  assert.ok(!before("0.18.0", "0.18.0"));
  assert.ok(!before("1.0.0", "0.18.0"));
});

test("no migration is due at Sova's version (the backstop of the release's own gate, migrations/due.mjs)", () => {
  assert.deepEqual(migrationsDue(version, manifest), [], `due at ${version}: delete each due migration's folder, entry and the files its paths name`);
  for (const m of manifest) assert.ok(before(version, m.removeIn), `${m.id} is due for removal in ${m.removeIn} (Sova is ${version}): delete migrations/${m.id}/, its entry and the call sites its paths name`);
});

test("each entry is whole, began before it ends, and its folder and paths are there", () => {
  const ids = manifest.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const m of manifest) {
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(m.id), m.id);
    assert.ok(m.what.trim(), `${m.id}: what`);
    assert.ok(before(m.since, m.removeIn), `${m.id}: since ${m.since} is before removeIn ${m.removeIn}`);
    assert.ok(m.paths.includes(`migrations/${m.id}`), `${m.id}: its folder is among its paths`);
    for (const p of m.paths) assert.ok(existsSync(join(ROOT, p)), `${m.id}: ${p} is there`);
  }
});

test("each code file a migration lists names it, so a search for its id finds every place to remove", () => {
  for (const m of manifest)
    for (const p of m.paths.filter((x) => /\.(ts|mjs)$/.test(x) && !x.endsWith(".test.ts"))) assert.ok(readFileSync(join(ROOT, p), "utf8").includes(m.id), `${p} names ${m.id}`);
});

test("every file that imports a migration is among that migration's paths", () => {
  // Sova's own code, its system playbooks, its config playbooks, pi-config and scripts: wherever an import could sit.
  const roots = ["server", "shared", "src", "pi-config", "system-playbooks", "playbooks", "scripts", ".sova/playbook-config"];
  const skip = new Set(["node_modules", ".cache", "dist"]);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(join(ROOT, d))) {
      if (skip.has(n)) continue;
      const rel = `${d}/${n}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs|js)$/.test(n)) files.push(rel);
    }
  };
  for (const r of roots) if (existsSync(join(ROOT, r))) walk(r);
  const importing = new Map<string, string[]>();
  for (const f of files)
    for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["'][^"']*migrations\/([a-z0-9-]+)\/index(?:\.mjs)?["']/g)) importing.set(m[1]!, [...new Set([...(importing.get(m[1]!) ?? []), f])]);
  assert.ok((importing.get("system-playbooks-old-paths") ?? []).length > 0, "the scan finds the imports it checks");
  for (const [id, fs] of importing) {
    const entry = manifest.find((m) => m.id === id);
    assert.ok(entry, `${fs.join(", ")} import migrations/${id}, which the manifest doesn't list`);
    for (const f of fs) assert.ok(entry.paths.includes(f), `${f} imports migrations/${id} but isn't among its paths`);
  }
});

test("every folder under migrations/ is a listed migration", () => {
  const folders = readdirSync(DIR).filter((n) => statSync(join(DIR, n)).isDirectory());
  assert.deepEqual(folders.sort(), manifest.map((m) => m.id).sort());
});

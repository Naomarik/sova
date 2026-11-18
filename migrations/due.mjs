// Which of Sova's migrations are due for removal at a version: the one rule Sova's release gate
// (.sova/playbook-config/release/scripts/sova-release.mjs migrations-due) and server/migrations.test.ts share.
// Not a migration: this folder's own tool, kept while the folder is. Node builtins only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** A version's x.y.z, or null; a pre-release counts as the version it leads to. */
export const versionCore = (/** @type {string} */ v) => {
  const m = VERSION.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** The manifest's entries, from the tree at `root` (default the tree this file is in). */
export function readMigrations(root = fileURLToPath(new URL("..", import.meta.url))) {
  let text;
  try {
    text = readFileSync(join(root, "migrations", "manifest.json"), "utf8");
  } catch {
    return [];
  }
  return JSON.parse(text);
}

/**
 * The migrations due for removal at `version`: each whose `removeIn` is at or below it. Throws on a version that isn't
 * x.y.z (a pre-release allowed) and on an entry whose removeIn isn't one.
 * @param {string} version
 * @param {{ id: string, removeIn: string }[]} [list]
 * @returns {{ id: string, removeIn: string }[]}
 */
export function migrationsDue(version, list = readMigrations()) {
  const v = versionCore(version);
  if (!v) throw new Error(`${version} is not a version X.Y.Z`);
  return list
    .filter((m) => {
      const r = versionCore(m.removeIn);
      if (!r) throw new Error(`migrations/manifest.json: ${m.id}'s removeIn ${m.removeIn} is not a version`);
      for (let i = 0; i < 3; i++) if (v[i] !== r[i]) return v[i] > r[i];
      return true;
    })
    .map((m) => ({ id: m.id, removeIn: m.removeIn }));
}

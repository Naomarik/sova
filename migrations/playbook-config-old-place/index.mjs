// Temporary: migrations/manifest.json "playbook-config-old-place". A project's add-ons for Sova-run chats moved from
// .sova/playbooks/<id> to .sova/playbook-config/<id>. Until this is removed, a project that has only the old folder
// is read there, and the old default paths still count as the defaults. Node builtins only: server code, the
// worktrees extension's callers and playbook scripts all import it.

/** The old place of a project's add-on `id`, relative to its root. */
export const oldConfigDir = (/** @type {string} */ id) => `.sova/playbooks/${id}`;

/**
 * The folder to read add-on `id` from, relative to the project root: `dir` (its new place), unless only the old place
 * has it. `has` answers whether a folder (relative to the root) is there.
 * @param {string} id
 * @param {string} dir
 * @param {(rel: string) => boolean} has
 * @returns {string}
 */
export function configDirOf(id, dir, has) {
  const old = oldConfigDir(id);
  return !has(dir) && has(old) ? old : dir;
}

/** configDirOf for a `has` that asks Git (a folder at a commit). */
export async function configDirOfAsync(/** @type {string} */ id, /** @type {string} */ dir, /** @type {(rel: string) => Promise<boolean>} */ has) {
  const old = oldConfigDir(id);
  return !(await has(dir)) && (await has(old)) ? old : dir;
}

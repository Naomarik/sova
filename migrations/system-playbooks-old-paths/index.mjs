// Temporary: migrations/manifest.json "system-playbooks-old-paths". Sova's six own playbooks moved from
// <install>/playbooks/<id> to <install>/system-playbooks/<id>. A chat started before the move (a Setup chat, a
// Project verbs run, the merge thread) names the old folder in its first message; this reads it at the new place.
// Node builtins only: server code and playbook scripts both import it.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The ids that moved. */
export const MOVED_TO_SYSTEM = ["merge-queue", "release", "release-maker", "project-setup", "project-deploy", "project-verbs"];

/**
 * A playbook folder named before the move (`<install>/playbooks/<id>`, one of the six) read at its new place
 * (`<install>/system-playbooks/<id>`) when the old folder is gone and the new one is there; any other folder as it is.
 * @param {string} dir an absolute folder
 * @param {(p: string) => boolean} [exists]
 * @returns {string}
 */
export function movedPlaybookDir(dir, exists = existsSync) {
  const clean = dir.replace(/[\\/]+$/, "");
  const id = basename(clean);
  const parent = dirname(clean);
  if (!MOVED_TO_SYSTEM.includes(id) || basename(parent) !== "playbooks") return dir;
  const moved = join(dirname(parent), "system-playbooks", id);
  return !exists(clean) && exists(moved) ? moved : dir;
}

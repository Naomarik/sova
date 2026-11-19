// Temporary: migrations/manifest.json "system-playbooks-old-paths". Sova's six own playbooks moved from
// <install>/playbooks/<id> to <install>/system-playbooks/<id>. A chat started before the move (a Setup chat, a
// Project verbs run, the merge thread) names the old folder in its first message; this reads it at the new place.
// Node builtins only: server code and playbook scripts both import it.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** This Sova's own repository root (the folder that holds migrations/). */
const SOVA_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** An absolute `<repo>/playbooks/<id>` of one of the six, anywhere in a text. */
const OLD_DIR_RE = /(\/[^\s`'"()<>,;]*?)\/playbooks\/(merge-queue|release-maker|release|project-setup|project-deploy|project-verbs)(?![-\w])/g;
/** How a release chat's first message named the method before the move (a bare name, resolved in Sova's repo). */
const OLD_RELEASE_METHOD = "Sova's release method (playbooks/release)";

/**
 * The lines Sova adds to a chat's next turn when its conversation (`texts`: its user messages, the first one Sova's)
 * names a playbook folder of the six that moved: one per moved folder, naming the new one. None when every folder it
 * names is still there (a chat on an older copy of the code) or none moved.
 * @param {readonly string[]} texts
 * @param {(p: string) => boolean} [exists]
 * @returns {string[]}
 */
export function movedPlaybookLines(texts, exists = existsSync) {
  const moved = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(OLD_DIR_RE)) {
      const old = `${m[1]}/playbooks/${m[2]}`;
      const now = movedPlaybookDir(old, exists);
      if (now !== old) moved.add(now);
    }
    if (text.includes(OLD_RELEASE_METHOD)) {
      const now = join(SOVA_ROOT, "system-playbooks", "release");
      if (!exists(join(SOVA_ROOT, "playbooks", "release")) && exists(now)) moved.add(now);
    }
  }
  return [...moved].map((dir) => `Your playbook moved: read it and run its scripts from ${dir}; the old folder is gone.`);
}

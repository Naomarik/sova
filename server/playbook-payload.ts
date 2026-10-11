import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { HEntry } from "../shared/harness-history";
import { changedReads, decideLoad, foldHeld, renderBlock, type BundleRef, type Load } from "../shared/playbook-delivery";
import { MEMORY, MODE } from "./harness/state-kinds";
import { defaultMemoryChoice } from "./memory/settings";
import { playbookVersions, shaOf, type PlaybookVersions } from "./playbook-versions";

/**
 * The playbook block a fire carries into one session (§chat.schedules/delivery): the session's
 * active branch says what it holds, the bundle's files say what is there now, and the kept
 * versions give the old text a diff needs.
 */

/** Detail files bigger than this are refused by playbook_read and never hashed. */
export const MAX_BUNDLE_FILE = 512 * 1024;

/**
 * A file inside a playbook's folder, contained (§chat.schedules/playbook-read): `rel` must be a
 * relative path that stays in the folder after links are followed. Its text, or why not.
 */
export function bundleFile(dir: string, rel: string): { abs: string; text: string } | { error: string; missing?: true } {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) return { error: `"${rel}" must be a path inside the playbook's folder, relative to it.` };
  const norm = normalize(rel);
  if (norm === ".." || norm.startsWith(`..${sep}`)) return { error: `"${rel}" leaves the playbook's folder.` };
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return { error: `The playbook's folder ${dir} is gone.`, missing: true };
  }
  let abs: string;
  try {
    abs = realpathSync(join(dir, norm));
  } catch {
    return { error: `No file "${rel}" in the playbook's folder.`, missing: true };
  }
  if (!abs.startsWith(`${root}${sep}`)) return { error: `"${rel}" points outside the playbook's folder.` };
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { error: `"${rel}" is not a file.` };
    if (st.size > MAX_BUNDLE_FILE) return { error: `"${rel}" is over ${MAX_BUNDLE_FILE / 1024} KB.` };
    return { abs, text: readFileSync(abs, "utf8") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The sha of a bundle file as it is now, null when it is gone (or can't be read). */
export const currentShaOf = (dir: string) => (rel: string): string | null => {
  const f = bundleFile(dir, rel);
  return "text" in f ? shaOf(f.text) : null;
};

function newest<T>(branch: readonly HEntry[], kind: { type: string; parse(d: unknown): T | null }): T | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (h.kind !== "state" || h.key !== kind.type) continue;
    const v = kind.parse(h.data);
    if (v) return v;
  }
  return null;
}

/** Memory is on as UniiChat: each turn's view replaces older history, so a playbook goes whole. */
export function memoryReplacesHistory(branch: readonly HEntry[]): boolean {
  const mode = newest(branch, MODE);
  if (!mode?.active.minorModes.includes("memory")) return false;
  const type = newest(branch, MEMORY)?.type ?? defaultMemoryChoice().type;
  return type === "uniichat";
}

export interface Payload {
  block: string;
  load: Load;
  sha: string;
}

/**
 * The block for `bundle` into a session whose active branch is `branch` (null: a new session),
 * with `cwd` its folder (for relative read paths). Throws when the entry can't be read.
 */
export function playbookPayload(bundle: BundleRef, session: { branch: readonly HEntry[]; cwd: string } | null, versions: PlaybookVersions = playbookVersions()): Payload {
  const entry = bundleFile(bundle.dir, bundle.entry);
  if ("error" in entry) throw new Error(entry.error);
  const sha = versions.keep(entry.text);
  const currentSha = currentShaOf(bundle.dir);
  if (!session) {
    const d = decideLoad(undefined, { sha, text: entry.text }, null, true);
    return { block: renderBlock(bundle, sha, d, []), load: d.load, sha };
  }
  const held = foldHeld(session.branch, bundle, {
    hash: shaOf,
    knownVersion: (s) => versions.has(s),
    resolve: (p) => (isAbsolute(p) ? p : resolve(session.cwd, p)),
    currentSha,
  });
  const old = held.entry ? versions.get(held.entry) : null;
  const d = decideLoad(held.entry, { sha, text: entry.text }, old, memoryReplacesHistory(session.branch));
  return { block: renderBlock(bundle, sha, d, changedReads(held, bundle.entry, currentSha)), load: d.load, sha };
}

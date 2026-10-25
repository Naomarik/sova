import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { draftOfficial } from "../pi-config/extensions/spec/core/official.mjs";

/**
 * Which of a worktree's spec drafts aren't official yet (§chat.worktrees/readiness), by the draft tool's own
 * rule (§tools.spec/draft-official, `official.mjs`), the one the merge round's check reads too: run here
 * on the drafts' files, never as a spec tool or a subprocess. Cached per folder until a stat of anything
 * it read changes.
 */

/** What the cache compares: the modification time and the size, so a rewrite within one tick still shows. */
const stamp = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
};

const cache = new Map<string, { stamps: string; names: string[] }>();

/** The names of the drafts in `<dir>/.sova/spec/drafts/` not official (or unreadable), sorted (§chat.worktrees/ready-to-land);
    undefined when the folder has none. */
export function unofficialDrafts(dir: string): string[] | undefined {
  const specRoot = join(dir, ".sova", "spec");
  const draftsDir = join(specRoot, "drafts");
  let names: string[];
  try {
    names = readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const hit = cache.get(dir);
  if (hit && hit.stamps === stampOf(hit.stamps)) return [...hit.names];
  const left: string[] = [];
  const read: string[] = [draftsDir];
  for (const n of names) {
    const r = draftOfficial(specRoot, join(draftsDir, n), draftsDir);
    // Unreadable: nobody knows its state, so it isn't official (as the merge round's check reads it too).
    if (r) read.push(...r.read);
    else read.push(join(draftsDir, n, "draft.json"));
    if (!r?.official) left.push(n);
  }
  const stamps = JSON.stringify([...new Set(read)].map((p) => [p, stamp(p)]));
  if (cache.size > 200) cache.clear();
  cache.set(dir, { stamps, names: left });
  return [...left];
}

/** The same stamps re-read now: equal means nothing that was read has changed. */
function stampOf(stamps: string): string {
  try {
    const list = JSON.parse(stamps) as [string, string][];
    return JSON.stringify(list.map(([p]) => [p, stamp(p)]));
  } catch {
    return "";
  }
}

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * How many of a worktree's spec drafts are not promoted yet (§chat.worktrees/readiness, the branch
 * status line), read from the drafts' own files: never a spec tool, never a subprocess. A draft
 * (`<dir>/.sova/spec/drafts/<name>/`) records in its `draft.json` the hash of every spec file it
 * started from; a file whose draft copy differs from that hash is one it changed. The draft counts
 * as promoted when each file it changed reads the same in the worktree's current `.sova/spec/`, or
 * a promotion its `draft.json` records wrote that file after the draft's last edit to it.
 * Cached per folder until a stat of anything it read changes.
 */

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const readOr = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};
const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
};
/** What the cache compares: the modification time and the size, so a rewrite within one tick still shows. */
const stamp = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
};

/** Every file under `dir`, relative, `/`-separated. */
function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Whether one draft is promoted into the worktree's current spec. undefined: not a readable draft. */
export function draftPromoted(specRoot: string, draftDir: string): { promoted: boolean; read: string[] } | undefined {
  const raw = readOr(join(draftDir, "draft.json"));
  if (!raw) return undefined;
  let base: Record<string, string>;
  /** Each recorded promotion: when it ran and the spec files it wrote. */
  let promotions: { at: number; files: Set<string> }[] = [];
  try {
    const d = JSON.parse(raw.toString("utf8"));
    base = d?.base?.files && typeof d.base.files === "object" ? d.base.files : {};
    if (Array.isArray(d?.promotions))
      promotions = d.promotions
        .map((p: any) => ({ at: Date.parse(p?.at), files: new Set<string>(Array.isArray(p?.files) ? p.files.filter((f: unknown) => typeof f === "string") : []) }))
        .filter((p: { at: number }) => Number.isFinite(p.at));
  } catch {
    return undefined;
  }
  const draftSpec = join(draftDir, "spec");
  const read = [join(draftDir, "draft.json")];
  for (const rel of filesUnder(draftSpec)) {
    const mine = readOr(join(draftSpec, rel));
    if (!mine) continue;
    const h = sha(mine);
    if (base[rel] === h) continue; // not changed by this draft
    const cur = join(specRoot, rel);
    read.push(join(draftSpec, rel), cur);
    const now = readOr(cur);
    if (now && sha(now) === h) continue;
    // Promoted into a spec that had moved (master's edits merged in): the current file is the
    // merge, not the draft's bytes. It counts when a recorded promotion wrote this file after the
    // draft's last edit to it.
    const edited = mtime(join(draftSpec, rel));
    if (now && promotions.some((p) => p.files.has(rel) && p.at >= Math.floor(edited))) continue;
    return { promoted: false, read };
  }
  return { promoted: true, read };
}

const cache = new Map<string, { stamps: string; count: number }>();

/** The number of drafts in `<dir>/.sova/spec/drafts/` not promoted; undefined when the folder has none. */
export function unpromotedDrafts(dir: string): number | undefined {
  const specRoot = join(dir, ".sova", "spec");
  const draftsDir = join(specRoot, "drafts");
  let names: string[];
  try {
    names = readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const hit = cache.get(dir);
  if (hit && hit.stamps === stampOf(hit.stamps)) return hit.count;
  let count = 0;
  const read: string[] = [draftsDir];
  for (const n of names) {
    const r = draftPromoted(specRoot, join(draftsDir, n));
    if (!r) continue;
    read.push(...r.read);
    if (!r.promoted) count++;
  }
  const stamps = JSON.stringify(read.map((p) => [p, stamp(p)]));
  if (cache.size > 200) cache.clear();
  cache.set(dir, { stamps, count });
  return count;
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

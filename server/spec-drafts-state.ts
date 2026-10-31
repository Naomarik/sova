import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** The spec drafts as a Land It sees them (§chat.worktrees/landing-answers): one hash over every file under each
    draft's `spec/` (lines `<draft>/<path under spec/> <sha256>`, sorted, joined by "\n"; `draft.json`, where notes,
    evidence and receipts go, apart), each draft's own hash over its lines, and the names. The draft tool's `land`
    and the merge round compute the same. undefined: no drafts. */
export interface DraftsHash {
  hash: string;
  names: string[];
  each: Record<string, string>;
}

const DRAFT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const readOr = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
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

export function draftsHash(dir: string): DraftsHash | undefined {
  const draftsDir = join(dir, ".sova", "spec", "drafts");
  let names: string[];
  try {
    names = readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && DRAFT_NAME.test(e.name)).map((e) => e.name).sort();
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const hashOf = (lines: string[]) => createHash("sha256").update([...lines].sort().join("\n")).digest("hex");
  const all: string[] = [];
  const each: Record<string, string> = {};
  for (const n of names) {
    const lines: string[] = [];
    for (const rel of filesUnder(join(draftsDir, n, "spec"))) {
      const buf = readOr(join(draftsDir, n, "spec", rel));
      if (buf) lines.push(`${n}/${rel} ${sha(buf)}`);
    }
    each[n] = hashOf(lines);
    all.push(...lines);
  }
  return { hash: hashOf(all), names, each };
}

/** The drafts that changed since a Land It recorded `pressed`, sorted; [] when none did. Without per-draft hashes a
    changed whole names every draft (the merge round's draftsChanged). */
export function draftsChanged(pressed: { hash: string; names: string[]; each?: Record<string, string> } | undefined, now: DraftsHash | undefined): string[] {
  if (!pressed || (now?.hash ?? null) === pressed.hash) return [];
  const names = [...new Set([...pressed.names, ...(now?.names ?? [])])].sort();
  if (!pressed.each) return names;
  return names.filter((n) => (pressed.each![n] ?? null) !== (now?.each[n] ?? null));
}

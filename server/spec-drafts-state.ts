import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { draftOfficial } from "../pi-config/extensions/spec/core/official.mjs";

/**
 * Which of a worktree's spec drafts aren't official yet (§chat.worktrees/readiness), by the draft tool's own
 * rule (§tools.spec/draft-official, `official.mjs`), the one the merge queue's docs step reads too: run here
 * on the drafts' files, never as a spec tool or a subprocess. Cached per folder until a stat of anything
 * it read changes.
 */

/** What the cache compares: the inode, size and both times, so a rewrite that keeps the size and puts the time back still shows. */
const stamp = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return "-";
  }
};

/** The same to the nanosecond: what a file's hash may be reused on. */
const fileStamp = (st: { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string => `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;

/** A file written this recently may be written again within one clock tick, unseen by its stat: no hash of it is kept. */
const SETTLED_MS = 2000;
const MAX_HASHES = 100_000;
/** A draft's own files, most of them what its base says: their hashes, while their stats stand. */
const hashes = new Map<string, { stamp: string; hash: string | undefined }>();

/** One spec file's claims by name and content: `cut` is a function of the two, and most worktrees of a repository hold
    the same files. Bounded by the bytes they were cut from, oldest first. */
const MAX_CUT_BYTES = 64 * 1024 * 1024;
const cuts = new Map<string, { value: unknown; bytes: number }>();
let cutBytes = 0;

function keepCut(key: string, value: unknown, bytes: number): void {
  cuts.set(key, { value, bytes });
  cutBytes += bytes;
  for (const [k, v] of cuts) {
    if (cutBytes <= MAX_CUT_BYTES) break;
    cuts.delete(k);
    cutBytes -= v.bytes;
  }
}

/** What judging one folder's drafts shares: each file read once, each draft's meta parsed once, and the record files
    cut once, however many drafts ask. `seen` lists every path the answer rests on. */
function draftPass(seen: Set<string>) {
  const files = new Map<string, Buffer | null>();
  const metas = new Map<string, unknown>();
  return {
    seen: (path: string) => void seen.add(path),
    read(path: string): Buffer | null {
      if (!files.has(path)) {
        seen.add(path);
        draftWork.reads++;
        files.set(path, readOr(path));
      }
      return files.get(path)!;
    },
    hash(path: string): string | undefined {
      let st;
      try {
        st = statSync(path, { bigint: true });
      } catch {
        return undefined;
      }
      const now = fileStamp(st);
      const hit = hashes.get(path);
      if (hit?.stamp === now) return hit.hash;
      draftWork.reads++;
      const buf = readOr(path);
      const hash = buf ? sha(buf) : undefined;
      if (Date.now() - Number(st.mtimeNs / 1_000_000n) > SETTLED_MS && Date.now() - Number(st.ctimeNs / 1_000_000n) > SETTLED_MS) {
        if (hashes.size >= MAX_HASHES) hashes.clear();
        hashes.set(path, { stamp: now, hash });
      }
      return hash;
    },
    cut<T>(rel: string, buf: Buffer | null, cut: (rel: string, buf: Buffer | null) => T): T {
      if (!buf) return cut(rel, buf);
      const key = `${rel}\0${sha(buf)}`;
      const hit = cuts.get(key);
      if (hit) {
        cuts.delete(key);
        cuts.set(key, hit);
        return hit.value as T;
      }
      draftWork.cuts++;
      const value = cut(rel, buf);
      keepCut(key, value, buf.length);
      return value;
    },
    json<T>(dir: string, parse: (dir: string) => T): T {
      const path = join(dir, "draft.json");
      seen.add(path);
      if (!metas.has(path)) metas.set(path, parse(dir));
      return metas.get(path) as T;
    },
  };
}

/** Tests: the work done, cumulative; a shared read or cut doesn't count. */
export const draftWork = { reads: 0, cuts: 0 };

const cache = new Map<string, { stamps: [path: string, stamp: string][]; names: string[] }>();

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
  if (hit && hit.stamps.every(([p, was]) => stamp(p) === was)) return [...hit.names];
  const left: string[] = [];
  const read = new Set<string>([draftsDir]);
  const pass = draftPass(read);
  for (const n of names) {
    const r = draftOfficial(specRoot, join(draftsDir, n), draftsDir, pass);
    // Unreadable: nobody knows its state, so it isn't official (as the merge queue's docs step reads it too).
    if (r) for (const p of r.read) read.add(p);
    else read.add(join(draftsDir, n, "draft.json"));
    if (!r?.official) left.push(n);
  }
  const stamps = [...read].map((p): [string, string] => [p, stamp(p)]);
  if (cache.size > 200) cache.clear();
  cache.set(dir, { stamps, names: left });
  return [...left];
}

/** The spec drafts as an approval pins them (§chat.worktrees/landing-answers): one hash over every file under each
    draft's `spec/` (lines `<draft>/<path under spec/> <sha256>`, sorted, joined by "\n"; `draft.json`, where notes,
    evidence and receipts go, apart), each draft's own hash over its lines, and the names. The draft tool's `land`
    and the merge queue compute the same. undefined: no drafts. */
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

/** The drafts that changed since an approval recorded `pressed`, sorted; [] when none did. Without per-draft hashes a
    changed whole names every draft. */
export function draftsChanged(pressed: { hash: string; names: string[]; each?: Record<string, string> } | undefined, now: DraftsHash | undefined): string[] {
  if (!pressed || (now?.hash ?? null) === pressed.hash) return [];
  const names = [...new Set([...pressed.names, ...(now?.names ?? [])])].sort();
  if (!pressed.each) return names;
  return names.filter((n) => (pressed.each![n] ?? null) !== (now?.each[n] ?? null));
}

/** A cheap stamp of a worktree's drafts folder (every file under `.sova/spec/drafts/`, by path, size and mtime): a
    drafts edit moves it, with no commit (the merge queue's watch on a branch sent back for its drafts). "" when none. */
export function draftsStamp(dir: string): string {
  const draftsDir = join(dir, ".sova", "spec", "drafts");
  const parts: string[] = [];
  for (const rel of filesUnder(draftsDir).sort()) {
    try {
      const st = statSync(join(draftsDir, rel));
      parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${rel}:-`);
    }
  }
  return parts.join("\n");
}

/** A content hash over every file under a worktree's `.sova/spec/drafts/` (each draft's `draft.json`, where notes and
    evidence go, included): what a fix that only records a note moves, which `draftsHash` leaves out by design.
    undefined: no drafts folder. */
export function draftsFingerprint(dir: string): string | undefined {
  const draftsDir = join(dir, ".sova", "spec", "drafts");
  try {
    statSync(draftsDir);
  } catch {
    return undefined;
  }
  const lines: string[] = [];
  for (const rel of filesUnder(draftsDir).sort()) {
    const buf = readOr(join(draftsDir, rel));
    lines.push(`${rel} ${buf ? sha(buf) : "-"}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

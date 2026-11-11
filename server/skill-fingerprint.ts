import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { real } from "./mcp/folder";

/**
 * A skill's fingerprint: its WHOLE folder, not its SKILL.md alone, so an edited script or an added file beside
 * it reads as "Changed since you approved". sha256 over the sorted (relative path, content sha256) pairs of every
 * regular file under the skill's folder. A symlink to a file is recorded by its target and that file's content
 * (read through the link, one file); the walk never goes through a link, so a link to a folder, a dangling link,
 * or a folder or file that can't be read can't be covered and makes the fingerprint partial. Each file's hash is
 * kept in memory by (real path, size, mtimeMs, ctimeMs, ino): ctime is the kernel's, so resetting a file's times
 * after an edit never hides it. Past FINGERPRINT_MAX_FILES files or FINGERPRINT_MAX_BYTES bytes it falls back to
 * a listing fingerprint (paths, sizes, times), also partial: the row says it is too large to fingerprint fully.
 */

export const FINGERPRINT_MAX_FILES = 2000;
export const FINGERPRINT_MAX_BYTES = 20 * 1024 * 1024;
/** The walk stops listing past this many entries (the listing fingerprint then says so). */
const LIST_MAX = 20_000;
const CACHE_MAX = 50_000;

export interface Fingerprint {
  sha256: string;
  /** Not every byte is covered: too large (the hash is of the listing), or a part can't be read or followed. */
  partial?: true;
}

/** File reads made to hash contents (tests count them). */
export const fingerprintIo = { reads: 0 };

const fileHashes = new Map<string, string>();

interface Entry {
  rel: string;
  kind: "file" | "link";
  /** A file's, or a file link's target's. */
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  /** A link's target as written. */
  target?: string;
  /** A file link's target, real: what its content is read from. */
  targetFile?: string;
}

const posix = (p: string) => p.split(sep).join("/");
const stamp = (st: Stats) => ({ size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino });

/** Every regular file and symlink under `dir`, by path relative to it, never walking through a symlink.
    `uncovered`: something here can't be fingerprinted (an unreadable folder or entry, a link to no file). */
function listFolder(dir: string): { entries: Entry[]; truncated: boolean; uncovered: boolean } {
  const entries: Entry[] = [];
  const queue = [""];
  let truncated = false;
  let uncovered = false;
  while (queue.length && !truncated) {
    const rel = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(join(dir, rel)).sort();
    } catch {
      uncovered = true;
      continue;
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const abs = join(dir, r);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        uncovered = true;
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(abs);
        } catch {
          uncovered = true;
        }
        // A link to a file: that file's content counts (read through the link, never walked). Anything else can't be covered.
        let to: Stats | null = null;
        try {
          to = statSync(abs);
        } catch {
          to = null;
        }
        if (to?.isFile()) entries.push({ rel: posix(r), kind: "link", ...stamp(to), target, targetFile: real(abs) });
        else {
          uncovered = true;
          entries.push({ rel: posix(r), kind: "link", ...stamp(st), size: 0, target });
        }
      } else if (st.isDirectory()) queue.push(r);
      else if (st.isFile()) entries.push({ rel: posix(r), kind: "file", ...stamp(st) });
      if (entries.length >= LIST_MAX) {
        truncated = true;
        break;
      }
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { entries, truncated, uncovered };
}

/** A file's content sha256, cached by its stamp; null when it can't be read. */
function hashOfFile(abs: string, e: Pick<Entry, "size" | "mtimeMs" | "ctimeMs" | "ino">): string | null {
  const key = `${abs}\0${e.size}\0${e.mtimeMs}\0${e.ctimeMs}\0${e.ino}`;
  const hit = fileHashes.get(key);
  if (hit) return hit;
  let sha: string;
  try {
    fingerprintIo.reads++;
    sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
  if (fileHashes.size >= CACHE_MAX) fileHashes.clear();
  fileHashes.set(key, sha);
  return sha;
}

/** The fingerprint of the skill whose SKILL.md is `skillFile` (its folder, whole). */
export function skillFolderFingerprint(skillFile: string, caps: { maxFiles?: number; maxBytes?: number } = {}): Fingerprint {
  // A skill that is one file in a skills folder (not a SKILL.md in its own folder) is that file alone, read through a link.
  if (basename(skillFile) !== "SKILL.md") {
    let st;
    try {
      st = statSync(skillFile);
    } catch {
      return { sha256: "" };
    }
    const sha = hashOfFile(real(skillFile), stamp(st));
    return sha ? { sha256: createHash("sha256").update("file\n").update(sha).digest("hex") } : { sha256: "" };
  }
  const dir = real(dirname(skillFile));
  const { entries, truncated, uncovered } = listFolder(dir);
  const counted = entries.filter((e) => e.kind === "file" || e.targetFile);
  const bytes = counted.reduce((n, e) => n + e.size, 0);
  const h = createHash("sha256");
  if (truncated || counted.length > (caps.maxFiles ?? FINGERPRINT_MAX_FILES) || bytes > (caps.maxBytes ?? FINGERPRINT_MAX_BYTES)) {
    h.update(`listing${truncated ? " truncated" : ""}\n`);
    for (const e of entries) h.update(`${e.kind === "link" ? "L" : "F"}\t${e.rel}\t${e.target ?? ""}\t${e.size}\t${e.mtimeMs}\t${e.ctimeMs}\n`);
    return { sha256: h.digest("hex"), partial: true };
  }
  let partial = uncovered;
  h.update("contents\n");
  for (const e of entries) {
    if (e.kind === "link" && !e.targetFile) {
      h.update(`L\t${e.rel}\t${e.target}\t-\n`);
      continue;
    }
    const sha = hashOfFile(e.targetFile ?? join(dir, e.rel), e);
    if (!sha) partial = true;
    h.update(e.kind === "link" ? `L\t${e.rel}\t${e.target}\t${sha ?? "unreadable"}\n` : `F\t${e.rel}\t${sha ?? "unreadable"}\n`);
  }
  return partial ? { sha256: h.digest("hex"), partial: true } : { sha256: h.digest("hex") };
}

/** Tests: forget every cached file hash. */
export function forgetFingerprintsForTest(): void {
  fileHashes.clear();
}

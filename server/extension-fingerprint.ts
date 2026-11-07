// An extension's code folders: the description file, its page folder and its
// program folder, read two ways. `sig` is their files' sizes and times, cheap enough for the background
// pass; `hash` is their bytes, only when the sig moved or at Review, Approve and a program start. Both are
// generators that yield every few files, so the same walk runs whole at a server's start and in steps
// after, never holding a page's request. Nothing on a request's path calls these.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";

export const EXTENSION_DESCRIPTION = "sova-extension.json";

/** Never counted, wherever they are: libraries and git history never ask again. */
const SKIP_ANYWHERE = new Set([".git", "node_modules", ".worktrees", ".agent"]);
/** Never counted directly in the extension's folder, its place for data and logs. A library's own `data` is code. */
const SKIP_AT_TOP = new Set(["data", "logs"]);

/** The folder approval skips on a path inside an extension's folder, given that path's parts from its top; null when none. */
export const skippedPart = (parts: string[]): string | null => parts.find((part, i) => SKIP_ANYWHERE.has(part) || (i === 0 && SKIP_AT_TOP.has(part))) ?? null;
const SKIP_FILE = /\.log$/;
const FILE_BYTES = 4 * 1024 * 1024;
const FILES_MAX = 20_000;
const YIELD_EVERY = 64;

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface CodeFolders {
  /** Single files that count (the description). */
  files: string[];
  folders: string[];
  /** Another folder that never counts: this Sova's data folder for it, when it lies inside. */
  skip?: string;
  /** The extension's folder, where `data` and `logs` don't count. An entry with none has no such place. */
  top?: string;
}

/** What an entry's approval covers. An entry with no `folder` covers its `dist`. */
export function codeFoldersOf(raw: Record<string, unknown>, skip?: string): CodeFolders {
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const folder = str("folder");
  const dist = str("dist");
  if (!folder) return { files: [], folders: dist ? [dist] : [], ...(skip ? { skip } : {}) };
  const program = raw.run === undefined ? undefined : (str("programFolder") ?? folder);
  const folders = [...new Set([dist, program].filter((p): p is string => !!p))].sort();
  return { files: [join(folder, EXTENSION_DESCRIPTION)], folders, top: folder, ...(skip ? { skip } : {}) };
}

type Mode = "sig" | "hash";

function* lines(code: CodeFolders, mode: Mode): Generator<void, string[]> {
  const out: string[] = [];
  let skip: string | undefined;
  try {
    if (code.skip) skip = realpathSync(code.skip);
  } catch {
    skip = undefined;
  }
  const real = (p: string): string | undefined => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const top = code.top === undefined ? undefined : real(code.top);
  const one = (label: string, path: string, st: Stats): void => {
    if (st.isSymbolicLink()) out.push(`${label}\0link:${readlinkSync(path)}`);
    else if (!st.isFile()) out.push(`${label}\0other`);
    else if (mode === "sig") out.push(`${label}\0${st.size}:${st.mtimeMs}`);
    else if (st.size > FILE_BYTES) out.push(`${label}\0big:${st.size}:${st.mtimeMs}`);
    else out.push(`${label}\0${sha(readFileSync(path))}`);
  };
  for (const file of [...code.files].sort()) {
    try {
      one(file, file, lstatSync(file));
    } catch {
      out.push(`${file}\0unreadable`);
    }
  }
  for (const root of [...code.folders].sort()) {
    out.push(`# ${root}`);
    const realRoot = real(root);
    let count = 0;
    const stack: string[] = [""];
    while (stack.length) {
      const rel = stack.pop()!;
      let names: string[];
      try {
        names = readdirSync(join(root, rel)).sort();
      } catch {
        out.push(`${root}/${rel}\0unreadable`);
        continue;
      }
      for (const name of names) {
        const child = rel ? `${rel}/${name}` : name;
        const path = join(root, child);
        try {
          const st = lstatSync(path);
          if (st.isDirectory()) {
            if (SKIP_ANYWHERE.has(name)) continue;
            if (SKIP_AT_TOP.has(name) && top !== undefined && realRoot !== undefined && join(realRoot, rel) === top) continue;
            if (skip && (path === skip || path.startsWith(skip + sep) || resolve(path) === skip)) continue;
            stack.push(child);
            continue;
          }
          if (SKIP_FILE.test(name)) continue;
          if (++count > FILES_MAX) {
            out.push(`${root}\0too-many`);
            stack.length = 0;
            break;
          }
          one(child, path, st);
        } catch {
          out.push(`${child}\0unreadable`);
        }
        if (count % YIELD_EVERY === 0) yield;
      }
    }
  }
  return out.sort();
}

function* reading(code: CodeFolders, mode: Mode): Generator<void, string> {
  return sha((yield* lines(code, mode)).join("\n")).slice(0, 32);
}

function whole<T>(g: Generator<void, T>): T {
  for (;;) {
    const n = g.next();
    if (n.done) return n.value;
  }
}

async function steps<T>(g: Generator<void, T>): Promise<T> {
  for (;;) {
    const n = g.next();
    if (n.done) return n.value;
    await new Promise<void>((done) => setImmediate(done));
  }
}

/** At a server's start, before it answers anything. */
export const codeSigNow = (code: CodeFolders): string => whole(reading(code, "sig"));
export const codeHashNow = (code: CodeFolders): string => whole(reading(code, "hash"));
/** Everywhere else: never holds a request up for long. */
export const codeSig = (code: CodeFolders): Promise<string> => steps(reading(code, "sig"));
export const codeHash = (code: CodeFolders): Promise<string> => steps(reading(code, "hash"));

import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { CODE_CLOSE, CODE_OPEN, cutBytes, defuse, maskNames, projectOutsider, wrapCode } from "./spec-lookup-projection";

/**
 * Reading a project's code without changing it (§app.spec-lookup/code-read): `code_read`'s engine,
 * for outsider-facing chats. Read only, inside the project root, on the main line: in a Git root
 * the committed tree of the main branch (git ls-tree / grep / show, never the working tree); in a
 * root without Git the files, never through a link leading out, never a file with more than one hard
 * link. A deny list keeps credentials out of every listing, search and read; key-shaped lines are
 * masked. Results are wrapped as untrusted data.
 */

export const READ_MAX = 32 * 1024;
export const FILE_MAX = 256 * 1024;
export const HITS_MAX = 50;
const LIST_MAX = 300;
const WALK_FILES_MAX = 5000;
const GIT_TIMEOUT_MS = 10_000;

export const OUTSIDE = "That path is outside the project.";
export const DENIED = "That file can't be read here.";
export const NOT_FOUND = "There is no such file or folder in the project.";
export const HIDDEN = "[hidden]";

/** Folders never entered (any path part). */
const DENY_DIRS = new Set([".git", ".sova", "node_modules", ".ssh", "secrets", ".gnupg", ".aws", ".docker", ".kube"]);
/** File names never read. */
const DENY_FILE = [
  /^\.env(?:\..*)?$/i,
  /\.env$/i,
  /\.(?:pem|key|p12|pfx|keystore|jks|crt|cer|der|asc|gpg|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^\.htpasswd$/i,
  /^auth\.json$/i,
  /^credentials/i,
];
/** A path part naming a secret. */
const SECRET_PART = /secret|token|password|passwd|credential|private[-_]?key/i;

/** Whether a root-relative path (forward slashes) is on the deny list. Pure. */
export function deniedPath(rel: string): boolean {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) if (DENY_DIRS.has(p.toLowerCase()) || SECRET_PART.test(p)) return true;
  const name = parts[parts.length - 1]!;
  return DENY_FILE.some((r) => r.test(name));
}

const KEY_LINE = [
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|KEY)-----/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /pass(?:word|wd)?\s*["']?\s*[:=]/i,
  /api[_-]?key\s*["']?\s*[:=]/i,
  /(?:secret|token|private[_-]?key)\s*["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Text with every key-shaped line read as `[hidden]`; a PEM block is hidden whole. Pure. */
export function maskSecrets(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (inBlock) {
      if (/-----END [A-Z ]*-----/.test(line)) inBlock = false;
      continue;
    }
    if (/-----BEGIN [A-Z ]*-----/.test(line)) {
      out.push(HIDDEN);
      inBlock = !/-----END [A-Z ]*-----/.test(line);
      continue;
    }
    out.push(KEY_LINE.some((r) => r.test(line)) ? HIDDEN : line);
  }
  return out.join("\n");
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0);
const isProse = (rel: string): boolean => /\.(?:md|markdown|txt|rst|adoc)$/i.test(rel);

/** A model's path, as a clean root-relative path, or null when it leaves the root. Pure. */
export function relPath(input: unknown): string | null {
  const raw = typeof input === "string" ? input.trim().replace(/\\/g, "/") : "";
  if (!raw || raw === "." || raw === "./" || raw === "/") return "";
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) return null;
  const parts: string[] = [];
  for (const p of raw.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") return null;
    parts.push(p);
  }
  return parts.join("/");
}

/** Where code is read from: a Git commit's tree, or the files of a root without Git. */
export type CodeSource = { kind: "git"; top: string; rev: string; prefix: string } | { kind: "fs"; root: string } | { kind: "none" };

export const NO_MAIN_LINE = "This project has no main branch (master or main) to read yet.";

interface Entry {
  name: string;
  dir: boolean;
  size: number;
}

export interface CodeBackend {
  list(rel: string): Promise<Entry[] | null>;
  /** Null: no such file. */
  file(rel: string): Promise<{ size: number; bytes: () => Promise<Buffer> } | null>;
  search(words: string): Promise<{ path: string; line: number; text: string }[]>;
}

function git(top: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<{ code: number; out: Buffer }> {
  return new Promise((done) => {
    execFile("git", ["-C", top, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: "buffer" }, (err, stdout) => {
      done({ code: err ? ((err as { code?: number }).code ?? 1) || 1 : 0, out: stdout ?? Buffer.alloc(0) });
    });
  });
}

const join2 = (a: string, b: string) => (a && b ? `${a}/${b}` : a || b);

export function gitBackend(s: Extract<CodeSource, { kind: "git" }>): CodeBackend {
  const full = (rel: string) => join2(s.prefix, rel);
  return {
    async list(rel) {
      const r = await git(s.top, ["ls-tree", "-l", "-z", s.rev, rel || s.prefix ? `${full(rel)}/` : "."]);
      if (r.code !== 0) return null;
      const items = r.out.toString("utf8").split("\0").filter(Boolean);
      if (!items.length) return null;
      return items.map((l) => {
        const tab = l.indexOf("\t");
        const meta = l.slice(0, tab).trim().split(/\s+/);
        const path = l.slice(tab + 1);
        return { name: path.split("/").pop()!, dir: meta[1] === "tree", size: Number(meta[3]) || 0 };
      });
    },
    async file(rel) {
      const spec = `${s.rev}:${full(rel)}`;
      const t = await git(s.top, ["cat-file", "-t", spec]);
      if (t.code !== 0 || t.out.toString().trim() !== "blob") return null;
      const sz = await git(s.top, ["cat-file", "-s", spec]);
      return { size: Number(sz.out.toString().trim()) || 0, bytes: async () => (await git(s.top, ["cat-file", "blob", spec], FILE_MAX + 1024)).out };
    },
    async search(words) {
      const r = await git(s.top, ["grep", "-z", "-n", "-I", "-F", "-i", "--max-count=5", "-e", words, s.rev, "--", s.prefix || "."], 16 * 1024 * 1024);
      const hits: { path: string; line: number; text: string }[] = [];
      for (const rec of r.out.toString("utf8").split("\n")) {
        const parts = rec.split("\0");
        if (parts.length < 3) continue;
        const path = parts[0]!.slice(s.rev.length + 1);
        const rel = s.prefix ? (path.startsWith(`${s.prefix}/`) ? path.slice(s.prefix.length + 1) : null) : path;
        if (rel === null) continue;
        hits.push({ path: rel, line: Number(parts[1]) || 0, text: parts.slice(2).join(" ") });
      }
      return hits;
    },
  };
}

export function fsBackend(rootIn: string): CodeBackend {
  const root = realpathSync(rootIn);
  const inside = (p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  /** The real path of `rel`, or null when it leaves the root or doesn't exist. */
  const real = (rel: string): string | null => {
    try {
      const r = realpathSync(join(root, rel));
      return inside(r) ? r : null;
    } catch {
      return null;
    }
  };
  const fileOk = (abs: string) => {
    const st = lstatSync(abs);
    return st.isFile() && st.nlink <= 1 ? st : null;
  };
  return {
    async list(rel) {
      const dir = real(rel);
      if (!dir) return null;
      // The folder's real path must itself be allowed: a link named innocently can't open a denied folder.
      if (deniedPath(relative(root, dir).split(sep).join("/"))) throw new CodeReadRefusal(DENIED);
      try {
        return readdirSync(dir, { withFileTypes: true }).flatMap((d): Entry[] => {
          const abs = join(dir, d.name);
          const r = real(relative(root, abs));
          if (!r || deniedPath(relative(root, r).split(sep).join("/"))) return [];
          const st = lstatSync(r);
          return st.isDirectory() ? [{ name: d.name, dir: true, size: 0 }] : st.isFile() && st.nlink <= 1 ? [{ name: d.name, dir: false, size: st.size }] : [];
        });
      } catch {
        return null;
      }
    },
    async file(rel) {
      const abs = real(rel);
      if (!abs) return null;
      // The real path must itself be allowed: a link named innocently can't lead to a secret.
      if (deniedPath(relative(root, abs).split(sep).join("/"))) return null;
      const st = fileOk(abs);
      if (!st) return null;
      return { size: st.size, bytes: async () => readFileSync(abs) };
    },
    async search(words) {
      const needle = words.toLowerCase();
      const hits: { path: string; line: number; text: string }[] = [];
      let seen = 0;
      const walk = (relDir: string) => {
        if (hits.length >= HITS_MAX || seen >= WALK_FILES_MAX) return;
        const dir = real(relDir);
        if (!dir) return;
        let ents;
        try {
          ents = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of ents) {
          const rel = join2(relDir, d.name);
          if (deniedPath(rel) || d.isSymbolicLink()) continue;
          if (d.isDirectory()) walk(rel);
          else if (d.isFile()) {
            if (++seen > WALK_FILES_MAX || hits.length >= HITS_MAX) return;
            const abs = join(dir, d.name);
            const st = fileOk(abs);
            if (!st || st.size > FILE_MAX) continue;
            const buf = readFileSync(abs);
            if (isBinary(buf)) continue;
            let n = 0;
            for (const [i, line] of buf.toString("utf8").split("\n").entries())
              if (line.toLowerCase().includes(needle)) {
                hits.push({ path: rel, line: i + 1, text: line });
                if (++n >= 5 || hits.length >= HITS_MAX) break;
              }
          }
        }
      };
      walk("");
      return hits;
    },
  };
}

/** A Git root with no main branch: nothing to read (never the checked-out branch). */
const noneBackend: CodeBackend = {
  list: async () => {
    throw new CodeReadRefusal(NO_MAIN_LINE);
  },
  file: async () => {
    throw new CodeReadRefusal(NO_MAIN_LINE);
  },
  search: async () => {
    throw new CodeReadRefusal(NO_MAIN_LINE);
  },
};

export const backendOf = (s: CodeSource): CodeBackend => (s.kind === "git" ? gitBackend(s) : s.kind === "fs" ? fsBackend(s.root) : noneBackend);

export class CodeReadRefusal extends Error {}

export interface CodeReadParams {
  op?: unknown;
  words?: unknown;
  path?: unknown;
  from?: unknown;
}

/** One `code_read` call over `backend`: the result's text, wrapped; a refusal throws CodeReadRefusal. */
export async function codeRead(backend: CodeBackend, params: CodeReadParams, names: readonly string[] = []): Promise<string> {
  const op = params.op;
  if (op === "search") {
    const words = typeof params.words === "string" ? params.words.trim() : "";
    if (!words || words.length > 200) throw new CodeReadRefusal("Give search a few words to look for (literal text).");
    const all = (await backend.search(words)).filter((h) => !deniedPath(h.path));
    const hits = all.slice(0, HITS_MAX);
    if (!hits.length) return wrapCode(`No match for "${defuse(words)}".`);
    const lines = hits.map((h) => `${h.path}:${h.line}: ${maskSecrets(h.text.length > 240 ? `${h.text.slice(0, 240)}…` : h.text).trim()}`);
    const body = `${hits.length} match${hits.length === 1 ? "" : "es"}${all.length > HITS_MAX ? ` (the first ${HITS_MAX})` : ""}:\n${lines.join("\n")}`;
    return wrapCode(defuse(maskNames(body, names)));
  }
  const rel = relPath(params.path);
  if (rel === null) throw new CodeReadRefusal(OUTSIDE);
  if (op === "list") {
    if (rel && deniedPath(rel)) throw new CodeReadRefusal(DENIED);
    const ents = await backend.list(rel);
    if (!ents) throw new CodeReadRefusal(NOT_FOUND);
    const shown = ents
      .filter((e) => !deniedPath(join2(rel, e.name)) && (e.dir || e.size <= FILE_MAX))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    const lines = shown.slice(0, LIST_MAX).map((e) => (e.dir ? `${e.name}/` : `${e.name} (${e.size < 1024 ? `${e.size} B` : `${Math.round(e.size / 1024)} KB`})`));
    const body = `${rel || "The project's top folder"}:\n${lines.join("\n") || "(empty)"}${shown.length > LIST_MAX ? `\n(${shown.length - LIST_MAX} more not shown)` : ""}`;
    return wrapCode(defuse(body));
  }
  if (op === "read") {
    if (!rel) throw new CodeReadRefusal("Name a file to read (list shows them).");
    if (deniedPath(rel)) throw new CodeReadRefusal(DENIED);
    const f = await backend.file(rel);
    if (!f) throw new CodeReadRefusal(NOT_FOUND);
    if (f.size > FILE_MAX) throw new CodeReadRefusal(DENIED);
    const buf = await f.bytes();
    if (buf.length > FILE_MAX || isBinary(buf)) throw new CodeReadRefusal(DENIED);
    const from = typeof params.from === "number" && Number.isFinite(params.from) && params.from >= 1 ? Math.floor(params.from) : 1;
    const all = buf.toString("utf8").split("\n");
    if (from > all.length) throw new CodeReadRefusal(`It has ${all.length} lines.`);
    // Cut the file's own lines first, so `from` keeps counting the file's lines whatever the cleaning drops.
    const { text: raw, cut: wasCut } = cutBytes(all.slice(from - 1).join("\n"), READ_MAX);
    const shownLines = raw.split("\n").length;
    const masked = maskSecrets(raw);
    const text = isProse(rel) ? projectOutsider(masked, { names }) : maskNames(masked, names);
    const tail = wasCut ? `\n[Cut here: continue with from ${from + shownLines}.]` : "";
    return wrapCode(defuse(`${rel}${from > 1 ? ` (from line ${from})` : ""}:\n${text}${tail}`));
  }
  throw new CodeReadRefusal('op must be "search", "list" or "read".');
}

export { CODE_CLOSE, CODE_OPEN };

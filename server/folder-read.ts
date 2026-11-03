import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FOLDER_BUILTINS, type FolderFile, type FolderFileKind, type FolderListing, type FolderSource } from "../shared/folder-read";
import { cutBytes } from "./spec-lookup-projection";
import { deniedPath, FILE_MAX, isBinary, maskSecrets, relPath } from "./code-read";

/**
 * A folder of files, read only (§app/folder-viewer): the files under one folder of a registered project as they
 * are at a ref (its committed tree, never the working tree; a project without Git: its files), or one of Sova's
 * own shipped folders (FOLDER_BUILTINS, as the running server has them). Any screen that shows a folder reuses it.
 * Nothing is ever run: a script is text. The code reader's rules hold (server/code-read.ts): its deny list
 * (credentials, `.git`, `node_modules`, secret-named parts), except that a registered project's own `.sova` folder
 * may be read in its committed tree (never on disk, never its secret-named files); no link is followed; key-shaped lines read as `[hidden]`; a binary file or one over FILE_MAX is listed but
 * never read; a file is cut at READ_CAP.
 */

/** The most files one listing returns. */
export const LIST_FILES_MAX = 500;
/** How deep a listing goes below its folder. */
export const LIST_DEPTH_MAX = 8;
/** A file's text is cut here. */
export const READ_CAP = 128 * 1024;
const GIT_TIMEOUT_MS = 10_000;

/** Sova's install: the folder holding server/. */
export const SOVA_ROOT = fileURLToPath(new URL("..", import.meta.url));

export class FolderRefusal extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

const OUTSIDE = "That path is outside the folder.";
const NOT_FOUND = "There is no such file or folder there.";
const DENIED = "That file can't be shown here.";

/** The deny list; `committed`: a registered project's committed tree, where its own `.sova` folder may be read. */
const deny = (rel: string, committed = true) => deniedPath(rel, { sovaOk: committed });

/** Rendered as a document, or shown as text. Pure. */
export function kindOf(rel: string): "markdown" | "text" {
  return /\.(?:md|markdown|mdx)$/i.test(rel) ? "markdown" : "text";
}

function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<{ code: number; out: Buffer }> {
  return new Promise((done) => {
    execFile("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: "buffer" }, (err, stdout) => {
      done({ code: err ? ((err as { code?: number }).code ?? 1) || 1 : 0, out: stdout ?? Buffer.alloc(0) });
    });
  });
}

/** A ref the caller named, when it is safe to hand to git (never an option, never a range). Pure. */
export function safeRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const r = ref.trim();
  if (!r || r.length > 200 || r.startsWith("-") || r.includes("..") || r.includes("@{") || !/^[A-Za-z0-9/._-]+$/.test(r)) return null;
  return r;
}

/** A `src` the caller sent, checked. Pure. */
export function parseSource(raw: unknown): FolderSource {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new FolderRefusal(400, "src must be a JSON folder source");
    }
  }
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new FolderRefusal(400, "src must be a folder source object");
  if (o.kind === "builtin") {
    if (typeof o.id !== "string" || !Object.hasOwn(FOLDER_BUILTINS, o.id)) throw new FolderRefusal(404, `No Sova folder "${String(o.id)}" (known: ${Object.keys(FOLDER_BUILTINS).join(", ")}).`);
    return { kind: "builtin", id: o.id };
  }
  if (o.kind === "project") {
    if (typeof o.project !== "string" || !o.project || o.project.length > 100) throw new FolderRefusal(400, "Name the project by its id.");
    const ref = typeof o.ref === "string" ? o.ref : "";
    const dir = typeof o.dir === "string" ? o.dir : "";
    return { kind: "project", project: o.project, ref, dir };
  }
  throw new FolderRefusal(400, 'src.kind is "project" or "builtin"');
}

type Resolved = { kind: "git"; top: string; commit: string; prefix: string; dir: string } | { kind: "fs"; root: string; dir: string };

export interface FolderDeps {
  /** A registered project's root by its id; throws (status 404) when there is none. */
  rootOf: (projectId: string) => string | Promise<string>;
  /** Sova's install (tests). */
  sovaRoot?: string;
}

/** A folder path the caller named: root-relative and allowed. */
function folderPath(input: string): string {
  const rel = relPath(input);
  if (rel === null) throw new FolderRefusal(400, OUTSIDE);
  if (rel && deny(rel)) throw new FolderRefusal(400, DENIED);
  return rel;
}

async function resolve(src: FolderSource, deps: FolderDeps): Promise<Resolved> {
  if (src.kind === "builtin") return { kind: "fs", root: deps.sovaRoot ?? SOVA_ROOT, dir: FOLDER_BUILTINS[src.id]! };
  const dir = folderPath(src.dir);
  const root = await deps.rootOf(src.project);
  const top0 = await git(root, ["rev-parse", "--show-toplevel"]);
  const top = top0.code === 0 ? top0.out.toString().trim() : "";
  if (!top) {
    if (src.ref) throw new FolderRefusal(400, "This project has no Git history: only its files as they are can be shown.");
    // Files on disk are never a `.sova` folder's: that exception is for committed trees only.
    if (dir && deny(dir, false)) throw new FolderRefusal(400, DENIED);
    return { kind: "fs", root, dir };
  }
  let ref: string | null = src.ref ? safeRef(src.ref) : null;
  if (src.ref && !ref) throw new FolderRefusal(400, "Name a branch, tag or commit (letters, digits and / . _ -).");
  if (!ref) {
    for (const b of ["master", "main"])
      if ((await git(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`])).code === 0) {
        ref = b;
        break;
      }
    if (!ref) throw new FolderRefusal(404, "This project has no main branch (master or main) to read yet.");
  }
  const c = await git(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const commit = c.out.toString().trim();
  if (c.code !== 0 || !commit) throw new FolderRefusal(404, `No branch, tag or commit "${ref}" in this project.`);
  const prefix = relative(realpathSync(top), realpathSync(root)).split(sep).join("/");
  return { kind: "git", top, commit, prefix, dir };
}

const join2 = (a: string, b: string) => (a && b ? `${a}/${b}` : a || b);
const kindBySize = (rel: string, size: number): FolderFileKind => (size > FILE_MAX ? "too-large" : kindOf(rel));

/** The files of one folder, each by its path inside it. */
export async function listFolder(src: FolderSource, deps: FolderDeps): Promise<FolderListing> {
  const r = await resolve(src, deps);
  const files: FolderListing["files"] = [];
  let truncated = false;
  const add = (inner: string, size: number, kind?: FolderFileKind) => {
    if (files.length >= LIST_FILES_MAX) return void (truncated = true);
    files.push({ path: inner, size, kind: kind ?? kindBySize(inner, size) });
  };
  if (r.kind === "git") {
    const full = join2(r.prefix, r.dir);
    const out = await git(r.top, ["ls-tree", "-r", "-l", "-z", r.commit, "--", full ? `${full}/` : "."]);
    const items = out.code === 0 ? out.out.toString("utf8").split("\0").filter(Boolean) : [];
    if (!items.length) throw new FolderRefusal(404, NOT_FOUND);
    for (const l of items) {
      const tab = l.indexOf("\t");
      const meta = l.slice(0, tab).trim().split(/\s+/);
      // Links and submodules are never followed.
      if (meta[1] !== "blob" || meta[0] === "120000") continue;
      const path = l.slice(tab + 1);
      const rel = r.prefix ? path.slice(r.prefix.length + 1) : path;
      const inner = r.dir ? rel.slice(r.dir.length + 1) : rel;
      if (deny(rel) || inner.split("/").length > LIST_DEPTH_MAX) continue;
      add(inner, Number(meta[3]) || 0);
    }
  } else {
    const root = realpathSync(r.root);
    let start: string;
    try {
      start = realpathSync(join(root, r.dir));
    } catch {
      throw new FolderRefusal(404, NOT_FOUND);
    }
    if (!(start === root || start.startsWith(root + sep)) || !lstatSync(start).isDirectory()) throw new FolderRefusal(404, NOT_FOUND);
    const walk = (innerDir: string, depth: number) => {
      if (depth > LIST_DEPTH_MAX || truncated) return;
      let ents;
      try {
        ents = readdirSync(join(start, innerDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of ents) {
        const inner = join2(innerDir, d.name);
        if (deny(join2(r.dir, inner), false) || d.isSymbolicLink()) continue;
        if (d.isDirectory()) walk(inner, depth + 1);
        else if (d.isFile()) {
          const st = lstatSync(join(start, inner));
          if (st.nlink <= 1) add(inner, st.size);
        }
      }
    };
    walk("", 1);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...(r.kind === "git" ? { commit: r.commit } : {}), files, ...(truncated ? { truncated: true } : {}) };
}

/** One file of a folder (`path` inside it), as text: never run. */
export async function readFolderFile(src: FolderSource, pathIn: unknown, deps: FolderDeps): Promise<FolderFile> {
  const inner = relPath(pathIn);
  if (inner === null) throw new FolderRefusal(400, OUTSIDE);
  if (!inner) throw new FolderRefusal(400, "Name a file of the folder.");
  const r = await resolve(src, deps);
  const rel = join2(r.dir, inner);
  if (deny(rel, r.kind === "git")) throw new FolderRefusal(400, DENIED);
  let size: number;
  let bytes: () => Promise<Buffer>;
  if (r.kind === "git") {
    const path = join2(r.prefix, rel);
    const ls = await git(r.top, ["ls-tree", "-l", "-z", r.commit, "--", path]);
    const meta = ls.out.toString("utf8").split("\t")[0]?.trim().split(/\s+/) ?? [];
    if (ls.code !== 0 || meta[1] !== "blob" || meta[0] === "120000") throw new FolderRefusal(404, NOT_FOUND);
    size = Number(meta[3]) || 0;
    bytes = async () => (await git(r.top, ["cat-file", "blob", `${r.commit}:${path}`], FILE_MAX + 1024)).out;
  } else {
    const root = realpathSync(r.root);
    let abs: string;
    try {
      abs = realpathSync(join(root, rel));
    } catch {
      throw new FolderRefusal(404, NOT_FOUND);
    }
    // The real path must itself be inside and allowed: a link named innocently can't lead out or to a secret.
    if (!abs.startsWith(root + sep) || deny(relative(root, abs).split(sep).join("/"), false)) throw new FolderRefusal(404, NOT_FOUND);
    if (r.dir && !relative(root, abs).split(sep).join("/").startsWith(`${r.dir}/`)) throw new FolderRefusal(404, NOT_FOUND);
    const st = lstatSync(abs);
    if (!st.isFile() || st.nlink > 1) throw new FolderRefusal(404, NOT_FOUND);
    size = st.size;
    bytes = async () => readFileSync(abs);
  }
  if (size > FILE_MAX) throw new FolderRefusal(400, `It is too large to show here (over ${Math.round(FILE_MAX / 1024)} KB).`);
  const buf = await bytes();
  if (buf.length > FILE_MAX) throw new FolderRefusal(400, `It is too large to show here (over ${Math.round(FILE_MAX / 1024)} KB).`);
  if (isBinary(buf)) throw new FolderRefusal(400, "It isn't text: it can't be shown here.");
  const { text, cut } = cutBytes(buf.toString("utf8"), READ_CAP);
  return { path: inner, kind: kindOf(inner), text: maskSecrets(text), ...(cut ? { truncated: true } : {}) };
}

// ---- routes ---------------------------------------------------------------------------------------

/**
 * GET /api/folders/list?src=<FolderSource as JSON>            the folder's files
 * GET /api/folders/read?src=<FolderSource as JSON>&path=<path> one of them, as text
 * Reads only, read with a chat (the mesh's `sessions` need, as /api/folders). A project is a registered one, by id.
 */
export function registerFolderReadRoutes(app: import("hono").Hono<any>, deps?: Partial<FolderDeps>): void {
  const NO_STORE = { "Cache-Control": "no-store" };
  const full: FolderDeps = {
    rootOf:
      deps?.rootOf ??
      (async (id: string) => {
        const { projectOf } = await import("./project-overseer-store");
        try {
          return projectOf(id).root;
        } catch {
          throw new FolderRefusal(404, `No project ${id}.`);
        }
      }),
    ...(deps?.sovaRoot ? { sovaRoot: deps.sovaRoot } : {}),
  };
  const run = async (c: import("hono").Context, fn: () => Promise<unknown>) => {
    try {
      return c.json(await fn(), 200, NO_STORE);
    } catch (err) {
      if (err instanceof FolderRefusal) return c.json({ error: err.message }, err.status);
      throw err;
    }
  };
  app.get("/api/folders/list", (c) => run(c, () => listFolder(parseSource(c.req.query("src") ?? ""), full)));
  app.get("/api/folders/read", (c) => run(c, () => readFolderFile(parseSource(c.req.query("src") ?? ""), c.req.query("path"), full)));
}

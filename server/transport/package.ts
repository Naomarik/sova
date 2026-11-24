// The package (§app.transport/package): made when it is sent, never kept in advance. One tar, zstd
// compressed: `package.json` (what it is, the source's folders, every file's hash), the chat's home
// under `home/` (every conversation cut at its last complete line, the unsent draft left out), and
// per worktree its code under `code/` (git-snapshot.ts). The same state packs to the same bytes.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, open, readdir, readlink, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { type LooseFile, packWorktrees, type RepoMeta, type WorktreeMeta, type WorktreeSurvey } from "./git-snapshot";
import { listTar, type TarEntry, writeTar } from "./tar";

export const PACKAGE_VERSION = 1;

/** What the destination needs to know to rebuild the chat, inside the package. */
export interface PackageManifest {
  v: typeof PACKAGE_VERSION;
  tid: string;
  mode: "move" | "copy";
  chat: { id: string; title: string; cwd: string; file: string };
  /** The source's folders, for the path map on arrival. */
  source: { nodeLabel: string; stateRoot: string; agentDir: string; home: string; homeDir: string; codeRoot: string };
  /** Each file of `home/` and its sha256 (as packed: a conversation cut at its last line). */
  home: Record<string, string>;
  worktrees: { name: string; path: string; meta: WorktreeMeta }[];
  /** What a Move stopped at the switch; who was interrupted or wrapped up. */
  stopped: { jobs: string[]; copies: string[] };
  interrupted: string[];
  wrapped: string[];
  /** sha256 of `usage.json`, the chat's usage and time records cut from the source's stores (a Move's). */
  usage?: string;
  /** The repository travels too (the destination lacks it and can't clone it): its default branch and the branches it carries. */
  repo?: RepoMeta;
}

/** Files of a home never sent: the unsent draft stays with the person who typed it, and an earlier
    transport's safety copy (`transport/`) stays on the device it was left on. */
const NOT_SENT = new Set(["chat/draft.json", "transport"]);

async function sha256Prefix(file: string, size: number): Promise<string> {
  const h = createHash("sha256");
  if (size > 0) for await (const c of createReadStream(file, { start: 0, end: size - 1 })) h.update(c as Buffer);
  return h.digest("hex");
}

/** The length of `file` up to and including its last newline (a log's last complete line). */
async function lastLineEnd(file: string, size: number): Promise<number> {
  if (size === 0) return 0;
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - buf.length);
      const { bytesRead } = await fh.read(buf, 0, end - start, start);
      const at = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (at >= 0) return start + at + 1;
      end = start;
    }
    return 0;
  } finally {
    await fh.close();
  }
}

/** Every file, folder and link of a home, sorted, as package entries; a log cut at its last line. */
async function homeEntries(home: string): Promise<{ entries: TarEntry[]; hashes: Record<string, string>; bytes: number }> {
  const entries: TarEntry[] = [];
  const hashes: Record<string, string> = {};
  let bytes = 0;
  const walk = async (rel: string): Promise<void> => {
    const names = (await readdir(join(home, rel))).sort();
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (NOT_SENT.has(r)) continue;
      const st = await lstat(join(home, r));
      const mtime = Math.floor(st.mtimeMs / 1000);
      if (st.isDirectory()) {
        entries.push({ name: `home/${r}`, type: "dir", mode: st.mode & 0o7777, mtime });
        await walk(r);
      } else if (st.isSymbolicLink()) {
        const target = await readlink(join(home, r));
        entries.push({ name: `home/${r}`, type: "symlink", target, mode: 0o777, mtime });
        hashes[r] = `L ${target}`;
      } else if (st.isFile()) {
        const size = n.endsWith(".jsonl") ? await lastLineEnd(join(home, r), st.size) : st.size;
        entries.push({ name: `home/${r}`, type: "file", mode: st.mode & 0o7777, mtime, size, from: join(home, r) });
        hashes[r] = await sha256Prefix(join(home, r), size);
        bytes += size;
      }
    }
  };
  await walk("");
  return { entries, hashes, bytes };
}

async function dirEntries(root: string, under: string): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const n of (await readdir(join(root, rel))).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (r.startsWith(".")) continue; // the scratch store and index copies
      const st = await stat(join(root, r));
      if (st.isDirectory()) {
        out.push({ name: `${under}/${r}`, type: "dir", mode: 0o700, mtime: 0 });
        await walk(r);
      } else out.push({ name: `${under}/${r}`, type: "file", mode: 0o600, mtime: 0, size: st.size, from: join(root, r) });
    }
  };
  await walk("");
  return out;
}

export interface Packed {
  file: string;
  sha256: string;
  size: number;
  manifest: PackageManifest;
  /** Bytes of the home as sent (before compression). */
  homeBytes: number;
}

/**
 * Pack a chat into `<spool>/<tid>.tar.zst`: its home and its worktrees. `skip` leaves a loose file out
 * (unticked, or over the size limit and not ticked). Everything that writes the chat's files must
 * already have stopped for a Move; a Copy is cut where each log's last line ends.
 */
export async function buildPackage(o: {
  tid: string;
  spool: string;
  mode: "move" | "copy";
  chat: PackageManifest["chat"];
  source: PackageManifest["source"];
  trees: readonly WorktreeSurvey[];
  haves: readonly string[];
  skip?: (name: string, f: LooseFile) => boolean;
  stopped?: PackageManifest["stopped"];
  interrupted?: string[];
  wrapped?: string[];
  /** The chat's usage cut (server/usage-export.ts), carried as `usage.json` beside the home, never in it. */
  usage?: Buffer | null;
  /** The repository itself travels: its default branch and the worktrees' branches, with their history. */
  repo?: boolean;
}): Promise<Packed> {
  const work = join(o.spool, `${o.tid}.work`);
  await rm(work, { recursive: true, force: true });
  const codeDir = join(work, "code");
  let metas: WorktreeMeta[] = [];
  let repo: RepoMeta | undefined;
  if (o.trees.length) {
    const packed = await packWorktrees({ tid: o.tid, trees: o.trees, haves: o.repo ? [] : o.haves, outDir: codeDir, ...(o.skip ? { skip: o.skip } : {}), ...(o.repo ? { repo: true } : {}) });
    metas = packed.metas;
    repo = packed.repo;
  }
  const home = await homeEntries(o.source.home);
  const manifest: PackageManifest = {
    v: PACKAGE_VERSION,
    tid: o.tid,
    mode: o.mode,
    chat: o.chat,
    source: o.source,
    home: home.hashes,
    worktrees: o.trees.map((t, i) => ({ name: t.name, path: t.path, meta: metas[i]! })),
    stopped: o.stopped ?? { jobs: [], copies: [] },
    interrupted: o.interrupted ?? [],
    wrapped: o.wrapped ?? [],
    ...(o.usage ? { usage: createHash("sha256").update(o.usage).digest("hex") } : {}),
    ...(repo ? { repo } : {}),
  };
  const entries: TarEntry[] = [
    { name: "package.json", type: "data", mode: 0o600, mtime: 0, data: Buffer.from(`${JSON.stringify(manifest)}\n`) },
    { name: "home", type: "dir", mode: 0o700, mtime: 0 },
    ...home.entries,
    ...(o.usage ? [{ name: "usage.json", type: "data" as const, mode: 0o600, mtime: 0, data: o.usage }] : []),
    ...(existsSync(codeDir) ? [{ name: "code", type: "dir" as const, mode: 0o700, mtime: 0 }, ...(await dirEntries(codeDir, "code"))] : []),
  ];
  const tarFile = join(o.spool, `${o.tid}.tar`);
  await writeTar(tarFile, entries);
  const out = join(o.spool, `${o.tid}.tar.zst`);
  await pipeline(createReadStream(tarFile), createZstdCompress(), createWriteStream(out, { mode: 0o600 }));
  await rm(tarFile, { force: true });
  await rm(work, { recursive: true, force: true });
  const h = createHash("sha256");
  for await (const c of createReadStream(out)) h.update(c as Buffer);
  const size = (await stat(out)).size;
  return { file: out, sha256: h.digest("hex"), size, manifest, homeBytes: home.bytes };
}

/** A package's files checked against its manifest, after it is unpacked at `staged` (§app.transport/arrival). */
export async function verifyHome(staged: string, manifest: PackageManifest): Promise<string | null> {
  for (const [rel, want] of Object.entries(manifest.home)) {
    const abs = join(staged, "home", rel);
    let have: string;
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) have = `L ${await readlink(abs)}`;
      else have = await sha256Prefix(abs, st.size);
    } catch {
      have = "missing";
    }
    if (have !== want) return `${rel} didn't arrive exactly`;
  }
  if (manifest.usage) {
    const at = join(staged, "usage.json");
    const st = await lstat(at).catch(() => null);
    if (!st?.isFile() || (await sha256Prefix(at, st.size)) !== manifest.usage) return "its usage records didn't arrive exactly";
  }
  return null;
}

/**
 * A whole folder, as it is (ignored files, build output and dependencies included, links kept as links),
 * compressed into `out` (§app.transport/moved-row: the old code folder goes into the safety copy). The
 * archive's members are read back and matched against the walk before it is kept: only then may the
 * caller remove the folder. Throws when it can't vouch for every entry.
 */
export async function compressFolder(dir: string, out: string): Promise<{ entries: number; size: number }> {
  const base = dir.split("/").filter(Boolean).at(-1) ?? "folder";
  const entries: TarEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? join(dir, rel) : dir;
    for (const n of (await readdir(abs)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = await lstat(join(dir, r));
      const mtime = Math.floor(st.mtimeMs / 1000);
      const name = `${base}/${r}`;
      if (st.isSymbolicLink()) entries.push({ name, type: "symlink", target: await readlink(join(dir, r)), mode: 0o777, mtime });
      else if (st.isDirectory()) {
        entries.push({ name, type: "dir", mode: st.mode & 0o777, mtime });
        await walk(r);
      } else if (st.isFile()) entries.push({ name, type: "file", mode: st.mode & 0o777, mtime, size: st.size, from: join(dir, r) });
      else throw new Error(`${join(dir, r)} is neither a file, a folder nor a link, so it can't be kept`);
    }
  };
  await walk("");
  const tmp = `${out}.tar`;
  await writeTar(tmp, entries);
  try {
    const got = (await listTar(tmp)).map((m) => m.name.replace(/\/$/, ""));
    const want = entries.map((e) => e.name);
    if (got.length !== want.length || got.some((n, i) => n !== want[i])) throw new Error(`the archive of ${dir} doesn't hold every entry`);
    // Something wrote the folder while it was archived (a job still using it): what was kept isn't what is there.
    for (const e of entries) {
      if (e.type !== "file") continue;
      const st = await lstat(e.from).catch(() => null);
      if (!st || st.size !== e.size || Math.floor(st.mtimeMs / 1000) !== e.mtime) throw new Error(`${e.from} changed while it was archived`);
    }
    const now: string[] = [];
    const again = async (rel: string): Promise<void> => {
      for (const n of (await readdir(rel ? join(dir, rel) : dir)).sort()) {
        const r = rel ? `${rel}/${n}` : n;
        now.push(`${base}/${r}`);
        const st = await lstat(join(dir, r));
        if (st.isDirectory() && !st.isSymbolicLink()) await again(r);
      }
    };
    await again("");
    if (now.length !== want.length || now.some((n, i) => n !== want[i])) throw new Error(`${dir} gained or lost files while it was archived`);
    await pipeline(createReadStream(tmp), createZstdCompress(), createWriteStream(out, { mode: 0o600 }));
    return { entries: entries.length, size: (await stat(out)).size };
  } finally {
    await rm(tmp, { force: true });
  }
}

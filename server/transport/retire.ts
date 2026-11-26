// A Move's old code folder, kept and then removed (§app.transport/moved-row): the folder goes whole into the Moved
// chat's safety copy, and so does its submodules' git data (the worktree's own git folder's `modules/`, which isn't in
// the folder), each archive read back before anything goes; only then is the worktree removed, so its branch can't be
// landed from two devices. Move Back puts both back beside what the package rebuilt, replacing nothing.
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { git, gitlinksOf } from "./git-snapshot";
import { compressFolder } from "./package";
import { checkMembers, listTar, listTarStream, type TarMemberHead } from "./tar";

/** The archive of the folder itself, and of its submodules' git data, in the safety copy's `transport/` folder. */
export const keptFolder = (keep: string, tid: string, name: string): string => join(keep, `${tid}-code-${name}.tar.zst`);
export const keptGitData = (keep: string, tid: string, name: string): string => join(keep, `${tid}-git-${name}.tar.zst`);

export type Retired = { removed: true; common: string; entries: number; size: number } | { removed: false; why: string };

/**
 * Keep the linked worktree at `p` in `keep` (its folder whole; with submodules, its git folder's `modules/` too),
 * each archive read back, then remove it. git refuses to remove a worktree holding submodules without --force, and
 * with it deletes their git data: so that data is kept first, then it and the submodules' `.git` links are moved aside
 * (no git refuses then) and the worktree removed; were that refused, they are put back as they were and the
 * worktree stays. A folder that can't be kept whole stays.
 */
export async function keepAndRemoveTree(p: string, keep: string, tid: string, name: string): Promise<Retired> {
  const common = (await git(p, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const gitDir = (await git(p, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  if (!common || !gitDir) return { removed: false, why: "git can't read it" };
  await mkdir(keep, { recursive: true, mode: 0o700 });
  const modules = join(gitDir, "modules");
  const hasModules = existsSync(modules);
  let c: { entries: number; size: number };
  try {
    c = await compressFolder(p, keptFolder(keep, tid, name));
    if (hasModules) {
      const g = await compressFolder(modules, keptGitData(keep, tid, name));
      c = { entries: c.entries + g.entries, size: c.size + g.size };
    }
  } catch (err) {
    return { removed: false, why: `it couldn't be kept whole (${err instanceof Error ? err.message : String(err)})` };
  }
  // Kept: what makes git refuse goes aside (never deleted before the removal succeeds).
  const aside = `${modules}.retired-${tid}`;
  const links: { file: string; text: string }[] = [];
  if (hasModules) {
    for (const l of await gitlinksOf(p)) {
      const file = join(p, l.path, ".git");
      if (await lstat(file).then((st) => st.isFile(), () => false)) links.push({ file, text: await readFile(file, "utf8") });
    }
    await rename(modules, aside);
    for (const l of links) await rm(l.file, { force: true });
  }
  const r = await git(dirname(common), ["--git-dir", common, "worktree", "remove", "--force", p]);
  if (r.code !== 0) {
    if (hasModules) {
      await rename(aside, modules).catch(() => {});
      for (const l of links) await writeFile(l.file, l.text).catch(() => {});
    }
    return { removed: false, why: r.stderr.trim() || `git exited ${r.code}` };
  }
  return { removed: true, common, ...c };
}

/** A zstd archive read into a plain tar at `out`. */
export async function unzstd(file: string, out: string): Promise<void> {
  await pipeline(createReadStream(file), createZstdDecompress(), createWriteStream(out, { mode: 0o600 }));
}

/** A safety copy whose members may not be written where Move Back puts them: why, said once, nothing restored. */
export class KeptRefused extends Error {
  constructor(readonly why: string) {
    super(`The safety copy was refused: ${why}. Nothing was restored.`);
  }
}

/** Is `rel` under `dir` a link already (a member may never be written through it)? */
const linkThere = (dir: string | null) => (rel: string): boolean => {
  if (!dir) return false;
  try {
    return lstatSync(join(dir, rel)).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Why `members` may not be extracted into `dir` (null: no folder yet), or null: the package's own checks
    (checkMembers): no absolute name or `..`, only files, folders and links, no special bits, nothing through a link. */
function refusalOf(members: readonly TarMemberHead[], dir: string | null): string | null {
  return checkMembers(members, linkThere(dir));
}

/** Why a zstd safety copy may not go into `dir`, or null; read as a stream, never whole, nothing written. */
export async function keptRefusal(zst: string, dir: string | null): Promise<string | null> {
  let members: TarMemberHead[] = [];
  try {
    await pipeline(createReadStream(zst), createZstdDecompress(), async (src: AsyncIterable<Buffer>) => {
      members = await listTarStream(src);
    });
  } catch (err) {
    return `it holds ${err instanceof Error ? err.message : String(err)}`;
  }
  return refusalOf(members, dir);
}

/** Extract `tarFile` into `dir`, never replacing a file already there (GNU tar's --skip-old-files, bsdtar's -k).
    Its members are checked first (read through a file handle, never whole): a refused one writes nothing (KeptRefused). */
export async function extractKeeping(tarFile: string, dir: string): Promise<void> {
  let members: TarMemberHead[];
  try {
    members = await listTar(tarFile);
  } catch (err) {
    throw new KeptRefused(`it holds ${err instanceof Error ? err.message : String(err)}`);
  }
  const why = refusalOf(members, dir);
  if (why) throw new KeptRefused(why);
  const run = (flag: string) =>
    new Promise<number>((done) => execFile("tar", ["-x", "-p", "--no-same-owner", flag, "-f", tarFile, "-C", dir], { maxBuffer: 8 * 1024 * 1024 }, (err) => done(err ? ((err as { code?: number }).code ?? 1) : 0)));
  const code = await run("--skip-old-files");
  if (code === 0) return;
  if ((await run("-k")) !== 0) throw new Error(`tar couldn't restore into ${dir}`);
}

/**
 * Move Back, after the package rebuilt the worktree at `path`: what never travelled comes back from its kept folder
 * (build output, unticked files) beside what is there, and its submodules' git data (their other branches, reflogs,
 * stashes) into its git folder's `modules/`, each replacing nothing the rebuild wrote. `work` is a scratch folder.
 * Both archives are checked before either is written: one refused restores nothing (KeptRefused).
 */
export async function restoreKept(keep: string, tid: string, name: string, path: string, work: string): Promise<void> {
  const folder = keptFolder(keep, tid, name);
  const data = keptGitData(keep, tid, name);
  const hasFolder = existsSync(folder);
  const hasData = existsSync(data);
  let gitDir = "";
  if (hasData) {
    gitDir = (await git(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    if (!gitDir) throw new Error(`${path} isn't a checkout, so its submodules' git data can't go back`);
  }
  if (hasFolder) await unzstd(folder, join(work, `${name}.tar`));
  if (hasData) await unzstd(data, join(work, `${name}.git.tar`));
  for (const [tar, into, has] of [[join(work, `${name}.tar`), dirname(path), hasFolder], [join(work, `${name}.git.tar`), gitDir, hasData]] as const) {
    if (!has) continue;
    let members: TarMemberHead[];
    try {
      members = await listTar(tar);
    } catch (err) {
      throw new KeptRefused(`it holds ${err instanceof Error ? err.message : String(err)}`);
    }
    const why = refusalOf(members, into);
    if (why) throw new KeptRefused(why);
  }
  if (hasFolder) await extractKeeping(join(work, `${name}.tar`), dirname(path));
  if (hasData) await extractKeeping(join(work, `${name}.git.tar`), gitDir);
}

/**
 * Why Move Back may not start (checked before the other device is asked to stop it), or null: every archive of the
 * safety copy that exists is checked as a stream against where it goes. A missing one isn't refused here (Move Back
 * stops at it and says so, as before).
 */
export async function moveBackRefusal(home: string, tid: string, removed: readonly { name: string; path: string }[]): Promise<string | null> {
  if (!removed.length) return null;
  const keep = join(home, "transport");
  const checks: [string, string | null][] = [[join(keep, `${tid}.tar.zst`), null]];
  for (const x of removed) checks.push([keptFolder(keep, tid, x.name), dirname(x.path)], [keptGitData(keep, tid, x.name), null]);
  for (const [zst, into] of checks) {
    if (!existsSync(zst)) continue;
    const why = await keptRefusal(zst, into);
    if (why) return new KeptRefused(why).message;
  }
  return null;
}

/** A chat here that isn't the moved one or its team, and isn't archived: its folder and the worktrees it tracks. */
export interface TreeUser {
  id: string;
  cwd: string;
  trees: readonly string[];
}

export interface RetireChoice {
  name: string;
  path: string;
  retire: boolean;
  /** Why it stays here. */
  why?: string;
}

const realOf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (p: string, tree: string): boolean => p === tree || p.startsWith(`${tree}/`);

/**
 * Which of a Move's packed worktrees end here (§app.transport/moved-row). Every worktree that travelled is the chat's
 * code, whoever made it (the chat, its team, a script, you): it is retired, so its branch can't be landed from two
 * devices. Two stay: the repository's main checkout (the project itself), and a worktree another chat here still
 * works in (its folder is in it, or it tracks it). Pure but for resolving links in paths.
 */
export function treesToRetire(packed: readonly { name: string; path: string; main: boolean }[], users: readonly TreeUser[], real: (p: string) => string = realOf): RetireChoice[] {
  return packed.map((t) => {
    if (t.main) return { name: t.name, path: t.path, retire: false, why: "it is the repository's main checkout" };
    const at = real(t.path);
    const u = users.find((x) => inside(real(x.cwd), at) || x.trees.some((y) => real(y) === at));
    return u ? { name: t.name, path: t.path, retire: false, why: `chat ${u.id} still works in it` } : { name: t.name, path: t.path, retire: true };
  });
}

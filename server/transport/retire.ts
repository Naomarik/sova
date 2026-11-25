// A Move's old code folder, kept and then removed (§app.transport/moved-row): the folder goes whole into the Moved
// chat's safety copy, and so does its submodules' git data (the worktree's own git folder's `modules/`, which isn't in
// the folder), each archive read back before anything goes; only then is the worktree removed, so its branch can't be
// landed from two devices. Move Back puts both back beside what the package rebuilt, replacing nothing.
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { git, gitlinksOf } from "./git-snapshot";
import { compressFolder } from "./package";

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

/** Extract `tarFile` into `dir`, never replacing a file already there (GNU tar's --skip-old-files, bsdtar's -k). */
export function extractKeeping(tarFile: string, dir: string): Promise<void> {
  const run = (flag: string) =>
    new Promise<number>((done) => execFile("tar", ["-x", "-p", flag, "-f", tarFile, "-C", dir], { maxBuffer: 8 * 1024 * 1024 }, (err) => done(err ? ((err as { code?: number }).code ?? 1) : 0)));
  return run("--skip-old-files").then((code) => (code === 0 ? undefined : run("-k").then((c) => (c === 0 ? undefined : Promise.reject(new Error(`tar couldn't restore into ${dir}`))))));
}

/**
 * Move Back, after the package rebuilt the worktree at `path`: what never travelled comes back from its kept folder
 * (build output, unticked files) beside what is there, and its submodules' git data (their other branches, reflogs,
 * stashes) into its git folder's `modules/`, each replacing nothing the rebuild wrote. `work` is a scratch folder.
 */
export async function restoreKept(keep: string, tid: string, name: string, path: string, work: string): Promise<void> {
  const folder = keptFolder(keep, tid, name);
  if (existsSync(folder)) {
    await unzstd(folder, join(work, `${name}.tar`));
    await extractKeeping(join(work, `${name}.tar`), dirname(path));
  }
  const data = keptGitData(keep, tid, name);
  if (existsSync(data)) {
    const gitDir = (await git(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    if (!gitDir) throw new Error(`${path} isn't a checkout, so its submodules' git data can't go back`);
    await unzstd(data, join(work, `${name}.git.tar`));
    await extractKeeping(join(work, `${name}.git.tar`), gitDir);
  }
}

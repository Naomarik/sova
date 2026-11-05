// The background "merged by content" probes' trial merge (`git merge-tree --write-tree`), run so that nothing git
// writes for it can land in a checkout. A configured merge driver (a project's `merge.<name>.driver`, such as Sova's
// spec claims driver) gets its three inputs as `.merge_file_XXXXXX` files that git creates in its own working
// directory and unlinks after the driver returns; a probe killed at its timeout in the middle of a driver used to
// leave them in the checkout as untracked files. So git runs with its working directory in a throwaway folder and the
// repository named by --git-dir, and reads the same answers as before:
// - attributes: the checkout's own .gitattributes files as they are on disk (committed or not, at any depth), copied
//   into a throwaway tree that the merge reads them from (`attr.tree`);
// - each driver's command runs from the checkout's top as before, its three inputs named by absolute path.
// Objects the probe makes (the attributes' tree, the merge) go to the same throwaway folder: the repository is never
// written. The folder goes when the probe ends.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult, GitRunner } from "./worktrees";

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A driver's command run from `top`, with %O, %A and %B (git's names of its input files, relative to git's own
    working directory) made absolute; `%%` stays git's literal percent. */
export function driverFromTop(command: string, top: string): string {
  return `d=$(pwd); cd ${sq(top)} && ${command.replace(/%(%|[OAB])/g, (m, c: string) => (c === "%" ? m : `"$d"/%${c}`))}`;
}

/** The configured merge drivers, `merge.<name>.driver`, from `git config --get-regexp` output. */
export function parseDrivers(stdout: string): { name: string; command: string }[] {
  const out: { name: string; command: string }[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^merge\.(.+)\.driver(?: (.*))?$/.exec(line);
    if (m && m[2]) out.push({ name: m[1]!, command: m[2] });
  }
  return out;
}

export interface TrialMerge {
  /** The checkout's top folder: its .gitattributes are read, and drivers run from here, as git would. */
  top: string;
  /** The checkout's git dir (the common dir for a main checkout). */
  gitDir: string;
  commonDir: string;
  base: string;
  head: string;
  /** Where the throwaway folder is made (default the temp dir). */
  scratchParent?: string;
}

/** The checkout's .gitattributes files on disk (tracked, or untracked and not ignored), as a tree in the throwaway
    object directory `env` names: its id, or null when there is none (or it can't be read: git then reads none). */
async function attributesTree(git: GitRunner, top: string, env: Record<string, string>): Promise<string | null> {
  const listed = await git(["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", ":(glob)**/.gitattributes"], { cwd: top });
  if (listed.code !== 0) return null;
  const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))].filter((p) => existsSync(join(top, p))).sort();
  if (!paths.length) return null;
  const blobs = await git(["hash-object", "-w", "--", ...paths], { cwd: top, env });
  const shas = blobs.stdout.split("\n").filter(Boolean);
  if (blobs.code !== 0 || shas.length !== paths.length) return null;
  const add = await git(["update-index", "--add", ...paths.flatMap((p, i) => ["--cacheinfo", `100644,${shas[i]},${p}`])], { cwd: top, env });
  if (add.code !== 0) return null;
  const tree = await git(["write-tree"], { cwd: top, env });
  return tree.code === 0 && tree.stdout.trim() ? tree.stdout.trim() : null;
}

/** `git merge-tree --write-tree --no-messages base head` for `t`, outside every checkout. Never throws for git's own
    failure (its result says it); throws only when the throwaway folder can't be made. */
export async function trialMergeTree(git: GitRunner, t: TrialMerge): Promise<GitResult & { cwd: string }> {
  const drivers = await git(["config", "--get-regexp", "^merge\\..*\\.driver$"], { cwd: t.top });
  const overrides = parseDrivers(drivers.code === 0 ? drivers.stdout : "").flatMap((d) => ["-c", `merge.${d.name}.driver=${driverFromTop(d.command, t.top)}`]);
  const root = await mkdtemp(join(t.scratchParent ?? tmpdir(), "sova-merge-tree-"));
  try {
    const objects = join(root, "objects");
    const cwd = join(root, "work");
    await Promise.all([mkdir(objects), mkdir(cwd)]);
    const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(t.commonDir, "objects") };
    const attrs = await attributesTree(git, t.top, { ...env, GIT_INDEX_FILE: join(root, "attributes-index") });
    const r = await git(["--git-dir", t.gitDir, ...(attrs ? ["-c", `attr.tree=${attrs}`] : []), ...overrides, "merge-tree", "--write-tree", "--no-messages", t.base, t.head], { cwd, env });
    return { ...r, cwd };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

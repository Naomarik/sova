/**
 * Conflicts between a branch and the target, and the mechanical sanity check of a resolution the merge thread made.
 *
 * A resolution is a merge commit whose parents are a commit of the target (its head, or an ancestor of it) and the
 * pinned commit. It passes only when, against git's own remerge of those two parents (the tree with conflict
 * markers), it changes only files that conflicted, only lines inside their conflict regions, and makes no mode,
 * rename, copy, type, binary, add or delete change. Anything else is read as "behaviour differs": the user decides.
 */
import { gitProc } from "./copy";

export interface Sanity {
  ok: boolean;
  why?: string;
  /** The files that conflicted (git's remerge of the resolution's parents). */
  files: string[];
}

/** The files two commits conflict in (git merge-tree, nothing written to any work tree), and the remerged tree. */
export async function conflictsBetween(root: string, a: string, b: string, timeoutMs?: number): Promise<{ tree: string; files: string[] } | { error: string }> {
  const r = await gitProc(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b], timeoutMs ? { timeoutMs } : {});
  if (r.timedOut) return { error: "git merge-tree took too long" };
  if (r.code !== 0 && r.code !== 1) return { error: r.out.trim().split("\n")[0] || `git merge-tree exited ${r.code}` };
  const lines = r.out.split("\n").map((l) => l.trim());
  const tree = lines[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return { error: `git merge-tree gave no tree (${r.out.trim().split("\n")[0] ?? ""})` };
  return { tree, files: r.code === 1 ? [...new Set(lines.slice(1).filter(Boolean))] : [] };
}

/** The conflict regions of a file with markers: [first, last] 1-based line numbers, markers included. */
export function conflictRegions(text: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("<<<<<<< ") || l === "<<<<<<<") start = i + 1;
    else if ((l.startsWith(">>>>>>> ") || l === ">>>>>>>") && start) {
      out.push([start, i + 1]);
      start = 0;
    }
  }
  return out;
}

/** Hunks of a `-U0` diff: the old side's [start, count] (count 0: an insertion after line `start`). */
export function hunksOf(diff: string): { start: number; count: number }[] {
  const out: { start: number; count: number }[] = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) out.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  return out;
}

/** Whether every hunk lies inside one conflict region (an insertion strictly within one). */
export function hunksInside(hunks: readonly { start: number; count: number }[], regions: readonly [number, number][]): boolean {
  const within = (a: number, b: number) => regions.some(([s, e]) => a >= s && b <= e);
  return hunks.every((h) => (h.count === 0 ? regions.some(([s, e]) => h.start >= s && h.start < e) : within(h.start, h.start + h.count - 1)));
}

/** The mechanical sanity check of `resolution` for merging `commit` onto `base`. */
export async function sanityCheck(root: string, o: { base: string; commit: string; resolution: string; timeoutMs?: number }): Promise<Sanity> {
  const no = (why: string, files: string[] = []): Sanity => ({ ok: false, why, files });
  const parents = await gitProc(root, ["rev-list", "--parents", "-n", "1", o.resolution]);
  if (parents.code !== 0) return no(`${o.resolution.slice(0, 12)} isn't a commit here`);
  const ps = parents.out.trim().split(/\s+/).slice(1);
  if (ps.length !== 2) return no(`the resolution has ${ps.length} parent${ps.length === 1 ? "" : "s"}, not two`);
  const full = async (rev: string) => (await gitProc(root, ["rev-parse", "--verify", "-q", `${rev}^{commit}`])).out.trim();
  const [p1, p2] = ps as [string, string];
  if (p2 !== (await full(o.commit))) return no(`its second parent is ${p2.slice(0, 12)}, not the approved commit ${o.commit.slice(0, 12)}`);
  if ((await gitProc(root, ["merge-base", "--is-ancestor", p1, o.base])).code !== 0) return no(`its first parent ${p1.slice(0, 12)} isn't on the target`);
  const re = await conflictsBetween(root, p1, p2, o.timeoutMs);
  if ("error" in re) return no(re.error);
  const files = re.files;
  if (!files.length) return no("its parents merge without a conflict: there is nothing to resolve", files);
  const raw = await gitProc(root, ["diff", "--raw", "-M", "-C", "--no-ext-diff", re.tree, `${o.resolution}^{tree}`]);
  if (raw.code !== 0) return no(`git diff failed: ${raw.out.trim().split("\n")[0]}`, files);
  const changed: string[] = [];
  for (const line of raw.out.split("\n").filter((l) => l.startsWith(":"))) {
    const [meta, ...paths] = line.split("\t");
    const [om, nm, , , status] = meta!.slice(1).split(/\s+/);
    const path = paths.join("\t");
    if (!status!.startsWith("M")) return no(`it ${({ A: "adds", D: "deletes", R: "renames", C: "copies", T: "changes the type of" } as Record<string, string>)[status![0]!] ?? "changes"} ${paths.join(" → ")}`, files);
    if (om !== nm) return no(`it changes the mode of ${path}`, files);
    if (!files.includes(path)) return no(`it changes ${path}, which didn't conflict`, files);
    changed.push(path);
  }
  for (const path of changed) {
    const num = await gitProc(root, ["diff", "--numstat", re.tree, `${o.resolution}^{tree}`, "--", path]);
    if (/^-\t-\t/m.test(num.out)) return no(`${path} is binary`, files);
    const marked = await gitProc(root, ["cat-file", "blob", `${re.tree}:${path}`]);
    if (marked.code !== 0) return no(`can't read the remerged ${path}`, files);
    const diff = await gitProc(root, ["diff", "-U0", "--no-ext-diff", "--no-color", re.tree, `${o.resolution}^{tree}`, "--", path]);
    if (!hunksInside(hunksOf(diff.out), conflictRegions(marked.out))) return no(`it changes ${path} outside its conflict regions`, files);
  }
  // Every conflict must be resolved: no marker left in the resolution.
  for (const path of files) {
    const after = await gitProc(root, ["cat-file", "blob", `${o.resolution}:${path}`]);
    if (after.code === 0 && conflictRegions(after.out).length) return no(`${path} still holds conflict markers`, files);
  }
  return { ok: true, files };
}

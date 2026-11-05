/**
 * A setup branch (§app.merge-queue/setup): one whose changes reach the project's pipeline, the sections of
 * `.sova/project.json` the merge queue, releases and deploys act on (`merge`, `release`, `deploy`; a service only when a merge check requires it, the rest are conformance's), or
 * the files of the project's release playbook folder. The queue checks a branch with the target's checks, not the
 * branch's own, so such a branch is offered Land only once a trial (merge.try) of its exact head passed.
 *
 * Read from Git alone, at the two commits (never a worktree's files).
 */
import type { MergeRun, MergeTrial } from "../../shared/merge-queue";
import { CONTRACT_FILE, type MergeCheckDecl } from "../../shared/project-contract";
import type { Git } from "./guard";

/** The definition's sections a setup branch changes. */
export const PIPELINE_SECTIONS = ["merge", "release", "deploy"] as const;
/** The release playbook folder when the definition names none. */
export const DEFAULT_RELEASE_PLAYBOOK = ".sova/playbooks/release";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A value's text with its keys sorted, so two equal sections compare equal. Pure. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** The definition's raw JSON at a commit; null when absent or not JSON. */
async function rawAt(git: Git, root: string, commit: string): Promise<Record<string, unknown> | null> {
  const r = await git(["show", `${commit}:${CONTRACT_FILE}`], root);
  if (r.code !== 0) return null;
  try {
    return obj(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

/** The services a definition's merge checks require (its `merge.checks[].requires`). Pure. */
export function requiredServices(def: Record<string, unknown> | null): Set<string> {
  const checks = obj(def?.merge).checks;
  const out = new Set<string>();
  if (Array.isArray(checks)) for (const c of checks) for (const r of Array.isArray(obj(c).requires) ? (obj(c).requires as unknown[]) : []) if (typeof r === "string") out.add(r);
  return out;
}

/** The services added, removed or edited between two raw definitions, by name. Pure. */
export function changedServices(base: Record<string, unknown> | null, head: Record<string, unknown> | null): string[] {
  // Services are a list of {name, …} or a map keyed by name.
  const byName = (d: Record<string, unknown> | null): Map<string, string> => {
    const v = d?.services;
    if (Array.isArray(v)) return new Map(v.map((s) => [String(obj(s).name ?? ""), stable(s)] as const));
    return new Map(Object.entries(obj(v)).map(([n, s]) => [n, stable(s)] as const));
  };
  const a = byName(base);
  const b = byName(head);
  return [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n));
}

/**
 * Which pipeline sections differ between two raw definitions (absent counts as its own value). `services` counts only
 * when a service a merge check requires (on either side) was added, removed or edited: the others are conformance's. Pure.
 */
export function changedSections(base: Record<string, unknown> | null, head: Record<string, unknown> | null): string[] {
  const out: string[] = PIPELINE_SECTIONS.filter((k) => stable(base?.[k]) !== stable(head?.[k]));
  const required = new Set([...requiredServices(base), ...requiredServices(head)]);
  if (changedServices(base, head).some((n) => required.has(n))) out.unshift("services");
  return out;
}

/** The release playbook folders a change could touch: the one each side names, else the default. Pure. */
export function releaseFolders(base: Record<string, unknown> | null, head: Record<string, unknown> | null): string[] {
  const named = [obj(base?.release).playbook, obj(head?.release).playbook].filter((p): p is string => typeof p === "string" && !!p.trim());
  return [...new Set([...named.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, "")), DEFAULT_RELEASE_PLAYBOOK])];
}

/** What makes a branch a setup branch: the sections it changes and the release playbook files; empty when it isn't one. */
export interface SetupChange {
  sections: string[];
  files: string[];
}

/** The setup change between `base` (the target's head, or the merge base) and `head`; null when Git can't tell. */
export async function setupChangeOf(git: Git, root: string, base: string, head: string): Promise<SetupChange | null> {
  const mb = await git(["merge-base", base, head], root);
  const from = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
  const diff = await git(["diff", "--name-only", "--no-renames", from, head], root);
  if (diff.code !== 0) return null;
  const paths = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!paths.length) return { sections: [], files: [] };
  const [a, b] = paths.includes(CONTRACT_FILE) ? await Promise.all([rawAt(git, root, from), rawAt(git, root, head)]) : [null, null];
  const sections = paths.includes(CONTRACT_FILE) ? changedSections(a, b) : [];
  const folders = releaseFolders(a, b);
  const files = paths.filter((p) => folders.some((f) => p === f || p.startsWith(`${f}/`)));
  return { sections, files };
}

/**
 * A trial's release checks: each one new or changed against the target's release section, or named for the trial,
 * runs; the rest are reported not run (unchanged). Pure.
 */
export function trialReleaseChecks(branch: readonly MergeCheckDecl[], target: readonly MergeCheckDecl[], named: readonly string[]): { run: MergeCheckDecl[]; notRun: MergeCheckDecl[] } {
  const run: MergeCheckDecl[] = [];
  const notRun: MergeCheckDecl[] = [];
  for (const c of branch) {
    const was = target.find((t) => t.id === c.id);
    (named.includes(c.id) || !was || stable(was) !== stable(c) ? run : notRun).push(c);
  }
  return { run, notRun };
}

/** One file a branch changes, as the Setup chat's proposal lists it: `setup` by the land gate's own rule. */
export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D" | "R";
  setup: boolean;
}

/**
 * Every file a branch changes against its target at `head` (from the merge base; renames as their new path), each
 * marked setup when the land gate counts it: `.sova/project.json` when its counted sections changed, and the release
 * playbook folder's files. Sorted by path; null when Git can't tell.
 */
export async function changedFilesOf(git: Git, root: string, base: string, head: string): Promise<ChangedFile[] | null> {
  const mb = await git(["merge-base", base, head], root);
  const from = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
  const diff = await git(["diff", "--name-status", "-M", from, head], root);
  if (diff.code !== 0) return null;
  const change = await setupChangeOf(git, root, base, head);
  const setupFiles = new Set(change?.files ?? []);
  const out: ChangedFile[] = [];
  for (const line of diff.stdout.split("\n")) {
    const parts = line.split("\t");
    const code = (parts[0] ?? "").trim();
    if (!code) continue;
    const path = (code.startsWith("R") ? parts[2] : parts[1]) ?? "";
    const status = (code[0] === "A" || code[0] === "D" || code[0] === "R" ? code[0] : "M") as ChangedFile["status"];
    const setup = path === CONTRACT_FILE ? !!change && change.sections.length > 0 : setupFiles.has(path) || (code.startsWith("R") && setupFiles.has(parts[1] ?? ""));
    out.push({ path, status, setup });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export const isSetupChange = (c: SetupChange | null): boolean => !!c && (c.sections.length > 0 || c.files.length > 0);

/** The newest trial of exactly `commit`, if any. Pure. */
export function trialOf(trials: readonly MergeTrial[] | undefined, commit: string): MergeTrial | undefined {
  return (trials ?? []).find((t) => t.commit === commit);
}

/** Why a setup branch at `commit` can't land yet, or null when a trial of that exact commit passed. Pure. */
export function untriedWhy(trials: readonly MergeTrial[] | undefined, commit: string): string | null {
  const t = trialOf(trials, commit);
  if (t?.verdict === "passed") return null;
  const head = commit.slice(0, 7);
  if (!t) return `This setup branch has no passing trial at ${head}: run a trial of it first.`;
  if (t.verdict === "running") return `This setup branch's trial at ${head} is still running: land it once it passes.`;
  return `This setup branch's trial at ${head} did not pass (${t.why ?? t.verdict}): fix it and run a trial again.`;
}

const seconds = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

/** The wake a chat gets when its trial ends: the verdict, each check's result and time, and how to read a log. Pure. */
export function trialEndedText(t: MergeTrial, run: MergeRun): string {
  const what = `${t.branch ?? "the commit"} at ${t.commit.slice(0, 7)}`;
  const head = t.verdict === "passed" ? `The trial of ${what} passed: every proposed check passed in the merge copy. Nothing was saved or merged.` : `The trial of ${what} did not pass (${t.why ?? t.verdict}). Nothing was saved or merged.`;
  const lines = [head];
  for (const s of run.steps.filter((x) => x.kind === "check" || x.kind === "setup" || x.kind === "rerun-tip")) lines.push(`- ${s.label}: ${s.result}, ${seconds(s.ms)}${s.detail ? ` (${s.detail})` : ""} · merge.logs {run: "${run.id}", step: "${s.id}"}`);
  for (const c of t.notRun ?? []) lines.push(`- ${c.label}: not run (unchanged release check; name it in checks to run it)`);
  lines.push(t.verdict === "passed" ? "Land is offered on this branch at this exact commit; a new commit needs a new trial." : "Fix what failed, commit, and run merge.try again.");
  return lines.join("\n");
}

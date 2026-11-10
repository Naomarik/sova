import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { trialMergeTree, mergeTreeOid } from "./merge-tree-probe";
import { type AncestorCheck, type DraftProof, draftProofVia, draftsLeft } from "./spec-drafts-state";
import { stateRoot } from "./state-root";
import { execGit, type GitRunner } from "./worktrees";
import type { LeftAnswer } from "../shared/merge-queue";

export type { LeftAnswer };

/**
 * The one answer to "does this branch have anything of its own left to land?" (§chat.worktrees/nothing-left): worked
 * out from git, the queue's landings and the branch's spec drafts, with no model call. Readiness (worktrees.ts compare),
 * the queue's Ready list and Land gate read it and keep no rule of their own. It decides labels, lists, counts and Land:
 * nothing that removes a folder or a branch reads it, and a run's merge decides again from git in its copy.
 *
 * It rests on every landing the queue has (`LandingRecords`), never on the view's newest 20, so a branch's answer can't
 * change as newer landings arrive. Only a new commit or an edited draft changes it.
 */

/** Which rule answered. Past `work` and `unknown`, nothing of the branch's code is left. */
export type CodeKind = "ancestor" | "catch-up" | "landed" | "past-landing" | "content" | "work" | "unknown";

export interface CodeLeft {
  kind: CodeKind;
  /** Something of the branch's code is left, or git couldn't tell (`unknown`: never treat as finished). */
  left: boolean;
  /** `work`: files a trial merge into the target conflicts on. */
  conflicts?: number;
  /** `unknown`: what git said. */
  error?: string;
}

export interface BranchLeft {
  /** The whole reading: the code and the spec drafts. Only this can say a branch is finished. */
  whole: LeftAnswer;
  /** The code-only reading: the commits alone. */
  codeOnly: LeftAnswer;
  /** `whole === "nothing"`. */
  nothingLeft: boolean;
  code: CodeLeft;
  /** The drafts in the folder not proved landed, by name. They always count as something left. */
  drafts: string[];
}

/** What a queue knows of a branch's landings: every landed entry's pinned commit (newest first), and the commits the
    queue moved the target to or the host merged. */
export interface LandingRecords {
  pins: readonly string[];
  landed: readonly string[];
}

export type TrialAnswer = boolean | { conflicts: number } | string;

export const NO_LANDINGS: LandingRecords = { pins: [], landed: [] };

// ---- the queue's reading of each repository ------------------------------------------------------------------------

/** What a loaded queue answers, from all its entries: no view, no window. */
export interface QueueReading {
  landings(branch: string): LandingRecords;
  /** The branch this queue lands on, once known. */
  target?(): string | null;
  /** The branch's entry that is still under way: in line, checking, waiting on the user or with its chat. */
  open?(branch: string): { id: string; state: string } | null;
  /** The user approved exactly this commit, and that approval is in line, checking, waiting or landed (not with its chat). */
  approvedAt(branch: string, head: string): boolean;
}

const canonicalOf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const readers = new Map<string, QueueReading>();
/** A project's queue says what it knows. → undo. */
export function registerQueueReading(root: string, reading: QueueReading): () => void {
  const key = canonicalOf(root);
  readers.set(key, reading);
  return () => {
    if (readers.get(key) === reading) readers.delete(key);
  };
}

/** The queue reading for a repository: by its main checkout, or its git common dir (`<root>/.git`). */
export function queueReadingAt(rootOrCommonDir: string): QueueReading | null {
  const p = canonicalOf(rootOrCommonDir);
  return readers.get(p) ?? (basename(p) === ".git" ? readers.get(dirname(p)) : undefined) ?? null;
}

/** The branch a repository's queue lands on, by its main checkout or git common dir; null: no queue here, or not known yet. */
export function queueTargetAt(rootOrCommonDir: string): string | null {
  return queueReadingAt(rootOrCommonDir)?.target?.() ?? null;
}

export function landingRecordsAt(rootOrCommonDir: string, branch: string | undefined): LandingRecords {
  return branch ? (queueReadingAt(rootOrCommonDir)?.landings(branch) ?? NO_LANDINGS) : NO_LANDINGS;
}

/** The branch's open entry at `root`, from the loaded queue's every entry; null: none, or no queue. */
export function openQueueEntry(root: string, branch: string): { id: string; state: string } | null {
  return queueReadingAt(root)?.open?.(branch) ?? null;
}

type LandedListener = (root: string, branch: string) => void;
const landedListeners = new Set<LandedListener>();
/** Told at every landing, local or on the host. → unsubscribe. */
export function onBranchLanded(fn: LandedListener): () => void {
  landedListeners.add(fn);
  return () => landedListeners.delete(fn);
}
export function branchLanded(root: string, branch: string): void {
  for (const fn of landedListeners) {
    try {
      fn(root, branch);
    } catch (err) {
      console.warn(`[nothing-left] a landing listener failed: ${(err as Error).message}`);
    }
  }
}

// ---- heads whose trial merge changed nothing, kept ---------------------------------------------------------------

/** Heads that read nothing left because merging changed nothing keep that answer once the target moves on and the same
    merge would conflict: the only thing here that isn't a function of git as it is now. */
const KEEP_NO_OPS = 5000;
const REAL_SHA = /^[0-9a-f]{40,64}$/;
/** `<target name> <head>` → the target's oid the trial ran against. While the target stays there, the trial itself still
    decides (a changed merge driver reads it again); once it has moved on, this is the answer. */
let noOps: { file: string; heads: Map<string, string> } | null = null;

const noOpFile = () => join(stateRoot(), "nothing-left.json");
function noOpHeads(): { file: string; heads: Map<string, string> } {
  const file = noOpFile();
  if (noOps?.file === file) return noOps;
  const heads = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: number; heads?: unknown };
    if (raw?.v === 1 && raw.heads && typeof raw.heads === "object") for (const [k, v] of Object.entries(raw.heads)) if (typeof v === "string") heads.set(k, v);
  } catch {
    // none yet, or unreadable: each head is read again
  }
  noOps = { file, heads };
  return noOps;
}
const noOpKey = (head: string, target: string) => `${target} ${head}`;
function keepNoOp(head: string, target: { name: string; oid: string }): void {
  if (!REAL_SHA.test(head)) return;
  const kept = noOpHeads();
  const key = noOpKey(head, target.name);
  if (kept.heads.has(key)) return;
  kept.heads.set(key, target.oid);
  while (kept.heads.size > KEEP_NO_OPS) kept.heads.delete(kept.heads.keys().next().value!);
  try {
    mkdirSync(dirname(kept.file), { recursive: true });
    const tmp = `${kept.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, heads: Object.fromEntries(kept.heads) })}\n`);
    renameSync(tmp, kept.file);
  } catch (err) {
    console.warn(`[nothing-left] couldn't keep ${head.slice(0, 7)}: ${(err as Error).message}`);
  }
}

/** Tests: forget everything kept in memory. */
export function resetNothingLeft(): void {
  noOps = null;
  codeMemo.clear();
  commonDirs.clear();
}

// ---- the rules -----------------------------------------------------------------------------------------------------

export interface CodeQuestion {
  git: GitRunner;
  cwd: string;
  head: string;
  /** `name` is what a kept no-op is kept under, `oid` what git compares with. */
  target: { name: string; oid: string };
  landings?: LandingRecords | undefined;
  /** Whether merging the head into the target would leave its tree as it is; undefined: this git can't tell, so the
      rule is skipped. */
  trial?: (() => Promise<TrialAnswer>) | undefined;
}

const count = async (git: GitRunner, cwd: string, args: string[]): Promise<number | null> => {
  const r = await git(["rev-list", "--count", ...args], { cwd });
  if (r.code !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
};

/** The rules, in order, cheapest first. Any answer but `work`/`unknown` is settled for that head and target. */
export async function codeLeft(q: CodeQuestion): Promise<CodeLeft> {
  const { git, cwd, head, target } = q;
  const anc = await git(["merge-base", "--is-ancestor", head, target.oid], { cwd });
  if (anc.code === 0) return { kind: "ancestor", left: false };
  if (anc.code !== 1) return { kind: "unknown", left: true, error: `merge-base --is-ancestor: ${anc.stderr.split("\n", 1)[0]?.trim() || `exit ${anc.code ?? "killed"}`}` };
  // Every commit the target doesn't have is a merge. A count git can't give says nothing, so the next rule decides.
  if ((await count(git, cwd, ["--no-merges", `${target.oid}..${head}`])) === 0) return { kind: "catch-up", left: false };
  const l = q.landings ?? NO_LANDINGS;
  if (l.pins.includes(head) || l.landed.includes(head)) return { kind: "landed", left: false };
  // Merges only, past the newest landing on this line, a squash on the host included (its pin isn't on the target).
  for (const pin of l.pins) {
    if ((await git(["merge-base", "--is-ancestor", pin, head], { cwd })).code !== 0) continue;
    if ((await count(git, cwd, ["--no-merges", head, `^${pin}`, `^${target.oid}`])) === 0) return { kind: "past-landing", left: false };
    break;
  }
  const kept = REAL_SHA.test(head) ? noOpHeads().heads.get(noOpKey(head, target.name)) : undefined;
  if (kept !== undefined && kept !== target.oid) return { kind: "content", left: false };
  const answer = q.trial ? await q.trial() : false;
  if (answer === true) {
    keepNoOp(head, target);
    return { kind: "content", left: false };
  }
  if (typeof answer === "string") return { kind: "unknown", left: true, error: answer };
  return typeof answer === "object" ? { kind: "work", left: true, conflicts: answer.conflicts } : { kind: "work", left: true };
}

/** A trial merge outside the checkout (merge-tree-probe.ts): true when it leaves the target's tree as it is. */
export async function trialNoOp(git: GitRunner, o: { top: string; gitDir: string; commonDir: string; target: string; head: string; scratchParent?: string }): Promise<TrialAnswer> {
  try {
    const [merged, tree] = await Promise.all([
      trialMergeTree(git, { top: o.top, gitDir: o.gitDir, commonDir: o.commonDir, base: o.target, head: o.head, ...(o.scratchParent ? { scratchParent: o.scratchParent } : {}) }),
      git(["rev-parse", `${o.target}^{tree}`], { cwd: o.top }),
    ]);
    if (merged.code === 1) return { conflicts: conflictsOf(merged.stdout) };
    if (merged.code !== 0) return `merge-tree: ${merged.stderr.split("\n", 1)[0]?.trim() || `exit ${merged.code ?? "killed"}`}`;
    if (tree.code !== 0) return `rev-parse ${o.target}^{tree}: ${tree.stderr.split("\n", 1)[0]?.trim()}`;
    return mergeTreeOid(merged.stdout) === tree.stdout.trim();
  } catch (err) {
    return `merge-tree: ${(err as Error).message}`;
  }
}

/** Distinct files in merge-tree's conflicted-file lines, after the tree's oid. */
export function conflictsOf(stdout: string): number {
  const lines = stdout.split("\n");
  // After what a merge driver printed there, when it did.
  const at = Math.max(0, lines.map((l) => /^[0-9a-f]{40,64}$/.test(l.trim())).lastIndexOf(true));
  const files = new Set<string>();
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") break;
    const tab = line.indexOf("\t");
    files.add(tab >= 0 ? line.slice(tab + 1) : line);
  }
  return files.size;
}

// ---- the whole answer ----------------------------------------------------------------------------------------------

/** Settled per head, target and landings, so a pass over every worktree after the target moves asks git once. */
const codeMemo = new Map<string, CodeLeft>();
const MAX_CODE_MEMO = 5000;
const commonDirs = new Map<string, string>();

async function commonDirOf(git: GitRunner, cwd: string): Promise<string | null> {
  const hit = commonDirs.get(cwd);
  if (hit) return hit;
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (r.code !== 0) return null;
  const dir = r.stdout.trim();
  commonDirs.set(cwd, dir);
  return dir;
}

const ancestorVia = (git: GitRunner): AncestorCheck => async (commit, ref, cwd) => (await git(["merge-base", "--is-ancestor", commit, ref], { cwd }).catch(() => ({ code: 1 }))).code === 0;

export interface BranchQuestion {
  /** The main checkout, or any folder of the repository. */
  root: string;
  /** The linked tree holding the branch's drafts. Absent or gone: no drafts to read. */
  folder?: string | undefined;
  branch?: string | undefined;
  head: string;
  target: { name: string; oid: string };
  git?: GitRunner;
  /** Who proves drafts landed; default from `git`. */
  proof?: DraftProof;
}

/** What a rule's answer comes to: never nothing unless git said so. */
export const answerOf = (c: CodeLeft): LeftAnswer => (c.kind === "unknown" ? "unknown" : c.left ? "work" : "nothing");

export async function branchLeft(o: BranchQuestion): Promise<BranchLeft> {
  const git = o.git ?? execGit;
  const commonDir = await commonDirOf(git, o.root);
  const landings = commonDir ? landingRecordsAt(commonDir, o.branch) : NO_LANDINGS;
  const key = `${o.head}\0${o.target.oid}\0${o.target.name}\0${landings.pins.join(",")}\0${landings.landed.includes(o.head) ? 1 : 0}`;
  let code = codeMemo.get(key);
  if (!code) {
    code = await codeLeft({
      git,
      cwd: o.root,
      head: o.head,
      target: o.target,
      landings,
      ...(commonDir ? { trial: () => trialNoOp(git, { top: o.root, gitDir: commonDir, commonDir, target: o.target.oid, head: o.head }) } : {}),
    }).catch((err: Error): CodeLeft => ({ kind: "unknown", left: true, error: err.message }));
    if (code.kind !== "unknown") {
      codeMemo.set(key, code);
      while (codeMemo.size > MAX_CODE_MEMO) codeMemo.delete(codeMemo.keys().next().value!);
    }
  }
  const drafts = o.folder && existsSync(o.folder) ? ((await draftsLeft(o.folder, ancestorVia(git), o.proof ?? draftProofVia(git, o.target))) ?? []) : [];
  const codeOnly = answerOf(code);
  const whole = drafts.length ? "work" : codeOnly;
  return { whole, codeOnly, nothingLeft: whole === "nothing", code, drafts };
}

// The gate on a change to automatic cleanup (§app.merge-queue/approve): a branch of Sova's own repository that changes
// the code retiring and removing worktrees lands only once a rehearsal passed at exactly that commit, on a private copy
// of the user's real state taken the same day. The rehearsal runs outside the queue, started by the user; this only reads
// its record, `<state root>/retire-rehearsals.json`. A record that can't be read is no pass. A person writes the pass with
// `node scripts/retire-rehearsal/run.mjs record <full commit>`, on branch feat/retire-rehearsal until that lands.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import labJson from "../../shared/retire-lab.json";
import { stateRoot } from "../state-root";

export const rehearsalsFile = (): string => join(stateRoot(), "retire-rehearsals.json");

/** One passing rehearsal. */
export interface RehearsalPass {
  /** The exact commit it passed at. */
  commit: string;
  /** When the private copy of the user's state was taken, ms. */
  snapshotAt: number;
  /** When it passed, ms. */
  passedAt: number;
}

const passesOf = (file: string): RehearsalPass[] => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { passes?: unknown };
    if (!Array.isArray(raw.passes)) return [];
    return raw.passes.filter((p): p is RehearsalPass => {
      const r = p as Partial<RehearsalPass> | null;
      return !!r && typeof r.commit === "string" && typeof r.snapshotAt === "number" && typeof r.passedAt === "number";
    });
  } catch {
    return [];
  }
};

const sameLocalDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** Whether a rehearsal passed at exactly `commit` on a copy of the state taken the same day as `now`. */
export function rehearsalPassedAt(commit: string, now: number, file = rehearsalsFile()): boolean {
  return passesOf(file).some((p) => p.commit === commit && sameLocalDay(p.snapshotAt, now));
}

const globRe = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
const TRIGGERS = (labJson as { triggers: string[] }).triggers.map(globRe);

/** Whether any of these changed paths is code the retire-lab group covers. Pure. */
export const touchesCleanup = (paths: readonly string[]): boolean => paths.some((p) => TRIGGERS.some((r) => r.test(p)));

/** Sova's own repository: the only one this gate is about. */
const isSovaRepo = (root: string): boolean => existsSync(join(root, "shared", "retire-lab.json"));

export const REHEARSAL_NEEDED = "Rehearsal needed";

/** The Land refusal's sentence (§design.copy-deck/merge-queue). */
export const rehearsalRefusal = (branch: string, commit: string): string =>
  `Rehearsal needed: ${branch} changes automatic cleanup and has no passing rehearsal at ${commit.slice(0, 7)} on a copy of your state taken today. Nothing was queued.`;

type DiffGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/** Which commits change cleanup's code, by branch tip and the target it forked from: a commit's own files don't change. */
const touches = new Map<string, boolean>();

async function changesCleanup(git: DiffGit, root: string, head: string, commit: string): Promise<boolean> {
  const key = `${root}\0${head}\0${commit}`;
  const hit = touches.get(key);
  if (hit !== undefined) return hit;
  const r = await git(["diff", "--name-only", `${head}...${commit}`], root);
  if (r.code !== 0) return true; // can't say: it waits, as a setup branch does
  const value = touchesCleanup(r.stdout.split("\n").filter(Boolean));
  touches.set(key, value);
  if (touches.size > 500) touches.delete(touches.keys().next().value!);
  return value;
}

/** Whether Land must wait for a rehearsal at `commit`: Sova's own repository, a change to cleanup's code, no pass today. */
export async function needsRehearsal(git: DiffGit, root: string, head: string, commit: string, now: number, file = rehearsalsFile()): Promise<boolean> {
  if (!isSovaRepo(root)) return false;
  if (rehearsalPassedAt(commit, now, file)) return false;
  return changesCleanup(git, root, head, commit);
}

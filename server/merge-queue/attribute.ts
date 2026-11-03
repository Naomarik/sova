/**
 * Whose failure is it (the decided rule, mechanised). A failure is blamed on the branch only after the same check
 * passes on the target alone, in the same copy. Pure: run.ts gathers the facts (reruns on the tip, then on the
 * target), this decides.
 *
 * - Setup (or the offline install) fails with the branch: rerun it on the target alone. Fails there too: machine
 *   (the queue retries once, then pauses; no branch is told). Passes there: the branch's.
 * - A check fails naming test files: those files run again on the tip. Each that passes is flaky (noted, not
 *   blocking). Each still failing runs on the target alone: fails there too, master's (noted, not blocking); passes
 *   there, or doesn't exist there, the branch's.
 * - A check fails naming tests but no file (Kaocha): the same per name, the whole check rerun each time.
 * - A check fails naming no file: it runs again whole on the tip (passes: flaky), then on the target alone (passes:
 *   the branch's). Fails there too: when both runs name their failures, a failure the target doesn't have is the
 *   branch's (the same count with other names included), else master's; when either names none, whose it is can't
 *   be told: "unattributed", never landed as master's, it waits for the user.
 * - A timeout, an abort, a stopped server: void (run again from the start, nobody blamed).
 * - A conflict resolution the merge thread judged safe that then fails a check: "resolution", back to the user; the
 *   branch isn't blamed.
 */
import type { Blame, MergeNote } from "../../shared/merge-queue";

export type OnTarget = "passes" | "fails" | "absent";

/** A failing test file's blame from its rerun on the tip and, when still failing, on the target alone. */
export function blameFile(o: { passesOnTip: boolean; onTarget?: OnTarget }): Exclude<Blame, "machine" | "resolution" | "reviewer"> {
  if (o.passesOnTip) return "flaky";
  return o.onTarget === "fails" ? "master" : "branch";
}

/** A whole check's blame (it named no file, or can't rerun files alone). */
export function blameCheck(o: { passesOnTip: boolean; onTarget?: Exclude<OnTarget, "absent"> }): Exclude<Blame, "machine" | "resolution" | "reviewer"> {
  if (o.passesOnTip) return "flaky";
  return o.onTarget === "fails" ? "master" : "branch";
}

/** Setup's (or the install's) blame from its run on the target alone. */
export const blameSetup = (onTarget: "passes" | "fails"): "branch" | "machine" => (onTarget === "passes" ? "branch" : "machine");

/** One check's attributed result. */
export interface CheckBlame {
  id: string;
  label: string;
  /** Per failing file; absent for a whole-check failure. */
  files?: { file: string; blame: Blame }[];
  /** A whole-check failure's blame; "unattributed": red on the merge and on the target, naming no failure. */
  whole?: Blame | "unattributed";
}

export interface Attribution {
  /** Anything blamed on the branch (or on the resolution): the run fails. Else a check no side can be blamed for:
   *  unattributed (waits for the user). */
  verdict: "passed" | "failed" | "unattributed";
  blame?: Blame;
  /** One line for the entry's row. */
  why?: string;
  /** Flaky and master-red failures, noted on the landing (never blocking). */
  notes: Omit<MergeNote, "at">[];
  /** Whole checks red on the target alone (the strip says "<target> is red: <label>"). */
  targetRed: string[];
  /** The checks whose failure can't be attributed (unattributed). */
  unclear: { id: string; label: string; why: string }[];
}

const list = (xs: string[], n = 3) => `${xs.slice(0, n).join(", ")}${xs.length > n ? `, +${xs.length - n} more` : ""}`;

/** The run's verdict from each red check's blame. `resolution`: the merge was the thread's conflict resolution. */
export function summarize(reds: readonly CheckBlame[], o: { resolution?: boolean; target?: string } = {}): Attribution {
  const target = o.target ?? "master";
  const notes: Attribution["notes"] = [];
  const targetRed: string[] = [];
  const branchy: string[] = [];
  const unclear: Attribution["unclear"] = [];
  for (const c of reds) {
    if (c.files?.length) {
      const by = (b: Blame) => c.files!.filter((f) => f.blame === b).map((f) => f.file);
      if (by("flaky").length) notes.push({ kind: "flaky", text: `${c.label}: ${list(by("flaky"))} failed, then passed on a rerun (flaky; not blocking)` });
      if (by("master").length) notes.push({ kind: "master-red", text: `${c.label}: ${list(by("master"))} also fail on ${target} alone (not blocking)` });
      if (by("branch").length) branchy.push(`${c.label} failed: ${list(by("branch"))}`);
    } else if (c.whole === "flaky") notes.push({ kind: "flaky", text: `${c.label} failed, then passed on a rerun (flaky; not blocking)` });
    else if (c.whole === "master") {
      notes.push({ kind: "master-red", text: `${c.label} also fails on ${target} alone (not blocking)` });
      targetRed.push(c.label);
    } else if (c.whole === "unattributed") {
      unclear.push({ id: c.id, label: c.label, why: `can't tell whose failure: ${c.label} fails on ${target} too and names no tests` });
      targetRed.push(c.label);
    } else if (c.whole === "branch") branchy.push(`${c.label} failed`);
  }
  if (!branchy.length && unclear.length) return { verdict: "unattributed", why: unclear.map((u) => u.why).join("; "), notes, targetRed, unclear };
  if (!branchy.length) return { verdict: "passed", notes, targetRed, unclear };
  const blame: Blame = o.resolution ? "resolution" : "branch";
  const why = `${branchy.join("; ")}${o.resolution ? " (with the conflict resolution; passes on " + target + " alone)" : ` (passes on ${target} alone)`}`;
  return { verdict: "failed", blame, why, notes, targetRed, unclear };
}

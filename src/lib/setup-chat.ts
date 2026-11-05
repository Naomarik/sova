// A project's Setup chat as the pages draw it: the one standing chat per project that investigates it, asks what it
// can't find, draws the merge, release and deploy plan, trial-runs the proposed checks on its own branch, and proposes
// the whole pipeline there for you to land. The words each surface says, and whether Land is offered. Pure.
import type { SetupChatView, SetupProposal, SetupStatus, SetupTrial, SetupTrialCheck } from "../../shared/setup-chat";

export type { SetupChatView, SetupProposal, SetupStatus, SetupTrial, SetupTrialCheck };

/** The surfaces that offer the Setup chat. */
export type SetupSurface = "merge-queue" | "releases" | "deploy" | "settings";

/** The button: Set Up with a Chat until the part is set up, then Change Setup (both open the same chat). */
export const setupButtonLabel = (setUp: boolean): string => (setUp ? "Change Setup" : "Set Up with a Chat");

/**
 * What a surface says while its part isn't set up: what the part does, then what setting up changes, in plain
 * sentences; `target` is the branch everything lands on.
 */
export function notSetUpWords(surface: SetupSurface, target: string): { title: string; body: string } {
  switch (surface) {
    case "merge-queue":
    case "settings":
      return {
        title: "No merge queue settings are set up for this project",
        body:
          `Until they are, its chats merge branches into ${target} themselves when you ask. ` +
          `Every branch you approve is merged onto ${target} in a separate copy and checked there; ${target} then moves to exactly that commit. ` +
          "Once it is set up, branches land here only through the queue.",
      };
    case "releases":
      return {
        title: "Releases aren't set up for this project",
        body:
          `A release tags ${target} with a version, writes its notes and runs each step you agree on; until releases are set up, nothing here starts one. ` +
          "The Setup chat reads the project, asks how it releases, then proposes a release playbook and a release section of .sova/project.json on a branch to land, with the merge queue and deploys.",
      };
    case "deploy":
      return {
        title: "Main declares no deploy yet.",
        body: "A deploy ships a commit to a place you name, verifies it there, and can roll it back. The Setup chat asks how each target ships and proposes it on a branch; it runs nothing.",
      };
  }
}

/** The chat's state in a few words, for the line beside its button (null: nothing worth a line). */
export function chatLine(c: SetupChatView | null | undefined): { word: string; tone: "accent" | "warn" | "neutral"; live?: true } | null {
  if (!c) return null;
  if (c.state === "waiting") return { word: c.questions ? `${c.questions} ${c.questions === 1 ? "question" : "questions"} for you` : "Waiting on you", tone: "warn" };
  if (c.state === "working") return { word: "Working", tone: "accent", live: true };
  if (c.state === "proposed") return { word: "Proposed", tone: "warn" };
  return null;
}

/** A check's trial result, as its chip says it. */
export function trialChip(c: SetupTrialCheck): { word: string; tone: "success" | "error" | "accent" | "neutral"; live?: true } {
  if (c.state === "passed") return { word: "Passed", tone: "success" };
  if (c.state === "failed") return { word: "Failed", tone: "error" };
  if (c.state === "running") return { word: "Running", tone: "accent", live: true };
  if (c.state === "not-run") return { word: "Not run (unchanged)", tone: "neutral" };
  if (c.state === "skipped") return { word: "Skipped", tone: "neutral" };
  return { word: "Waiting", tone: "neutral" };
}

/** A duration in the trial's words: "48s", "3m 12s". */
export function durationWords(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** The trial in one line: "Trial of {sha}: passed", failed or running; null before the first one. */
export function trialLine(p: Pick<SetupProposal, "trial">): string | null {
  const t = p.trial;
  if (!t) return null;
  const sha = t.commit.slice(0, 7);
  if (t.state === "running") return `Trial of ${sha}: running`;
  if (t.state === "passed") return `Trial of ${sha}: passed`;
  if (t.state === "failed") return `Trial of ${sha}: failed`;
  // Stopped by the machine, or called off: no result for the branch either way.
  return `Trial of ${sha}: didn't finish${t.why ? `, ${t.why.replace(/[.]\s*$/, "")}` : ""}`;
}

/** The trial shown tried an older commit than the branch's head (the host sends the head's own, so this is a guard). */
export const trialStale = (p: Pick<SetupProposal, "trial" | "commit">): boolean => !!p.trial && p.trial.commit !== p.commit;

/**
 * What the proposal's main button is now, and the line beside it. A setup branch can be landed (a served project) or
 * merged (one the queue doesn't serve) only once a trial of its exact head passed: the queue checks a branch with the
 * target's checks, not the branch's own. Until then Run Trial stands in its place. The host's own word (`land`) has
 * the last say after that.
 */
export function landState(p: SetupProposal): { action: "land" | "merge" | "trial" | "wait"; can: boolean; why?: string } {
  const merge = p.served ? "land" : "merge";
  const sha = p.commit.slice(0, 7);
  if (p.problem) return { action: merge, can: false, why: `The setup on its branch doesn't read: ${p.problem.replace(/[.]\s*$/, "")}.` };
  const t = p.trial && p.trial.commit === p.commit ? p.trial : null;
  if (t?.state === "running") return { action: "wait", can: false, why: `Trial of ${sha}: running` };
  if (!t || t.state !== "passed") return { action: "trial", can: true, why: `Run a trial of ${sha} first: it lands only once its own checks pass.` };
  if (!p.land.can) return { action: merge, can: false, why: p.land.why ?? "Not ready to land." };
  return { action: merge, can: true };
}

/**
 * A path the setup itself owns, when the host doesn't say: the project's definition, a playbook under
 * .sova/playbooks/, or the release playbook folder the proposal names (`playbookDir`). The fallback only: the host's
 * own mark (the land gate's rule) wins.
 */
export const isSetupFile = (path: string, playbookDir?: string): boolean => {
  const dir = playbookDir?.replace(/^\.\//, "").replace(/\/+$/, "");
  return path === ".sova/project.json" || path.startsWith(".sova/playbooks/") || (!!dir && path.startsWith(`${dir}/`));
};

/** One changed file as the host may send it: a bare path, or the path with its status and the gate's own mark. */
export type ChangedFile = string | { path: string; status?: string; setup?: boolean };

/**
 * What Land or Merge Branch brings in, as the card lists it: every file the branch changes against its target, the
 * setup's own first, then the rest, which the card flags (they land too). null while the host hasn't said.
 */
export function changedFiles(files: readonly ChangedFile[] | undefined, playbookDir?: string): { setup: string[]; other: string[]; count: number } | null {
  if (!files) return null;
  const setup: string[] = [];
  const other: string[] = [];
  for (const f of files) {
    const path = typeof f === "string" ? f : f.path;
    const mine = typeof f === "object" && typeof f.setup === "boolean" ? f.setup : isSetupFile(path, playbookDir);
    (mine ? setup : other).push(path);
  }
  return { setup, other, count: files.length };
}

/** The heading's count: "Changes 3 files". */
export const changesHead = (n: number): string => `Changes ${n} ${n === 1 ? "file" : "files"}`;

// A setup branch's dry run in the words every screen says (§app.merge-queue/dry-runs, §app.merge-queue/fix,
// §app.merge-queue/dry-run-explainer): its chip, its line, the one sentence beside it, the explainer, the buttons a row
// offers, and the Fix line. Pure: the Merge Queue tab, the worktrees control, the session pane, the run page and the
// landing bar all read these, so they say the same thing.
import type { BranchDryRun, BranchFailure, FixOffer, MergeTrial, TrialBy } from "../../shared/merge-queue";
import type { Tone } from "./merge-queue";

export type { BranchDryRun, BranchFailure, FixOffer, MergeTrial, TrialBy };

const sha7 = (sha: string | undefined): string => (sha ?? "").slice(0, 7);
const stripDot = (s: string): string => s.trim().replace(/[.]\s*$/, "");

/** The one plain sentence beside every dry-run chip and line. */
export const DRY_RUN_SENTENCE = "A dry run checks the merge checks this branch adds or changes before they judge every branch after it.";
/** The explainer's link, beside the sentence. */
export const DRY_RUN_LINK = "What's a dry run?";
/** Checking now's line while a dry run holds the merge copy. */
export const DRY_RUN_NOW_LINE = "Runs this branch's new or changed checks on its own commit. Nothing lands from a dry run; landings wait until it ends.";
/** The run page's line in place of a landing's "Nothing has merged from this run". */
export const NOTHING_LANDS = "Nothing lands from a dry run.";
/** The Approved · dry run first line. */
export const LAND_STANDS = "Your Land stands: it lands by itself once its dry run passes.";
/** The docs page the explainer ends with. */
export const DRY_RUN_DOCS = "https://sova.naomarik.com/docs/dry-runs/";

/** The explainer (§app.merge-queue/dry-run-explainer), in its four parts; {target} is the branch everything lands on. */
export function explainerWords(target: string): { title: string; intro: string; parts: { heading: string; body: string }[]; docs: string } {
  return {
    title: "What's a dry run?",
    intro: "A dry run runs the merge checks a branch adds or changes on its exact commit, in the merge copy. Nothing lands from it and nothing is saved.",
    parts: [
      {
        heading: "Why not just run the tests?",
        body:
          `A landing is checked with ${target}'s checks, never the branch's own, so a branch can't weaken the checks that judge it. ` +
          "That means a new or changed check never runs while its own branch lands. The dry run proves it works before it judges every branch after it. " +
          "Running the tests checks the code; a dry run checks the checks.",
      },
      {
        heading: "Which branches need one",
        body: "Only branches that change the project's pipeline settings: its merge checks, release checks or playbook, deploy targets, or a service a merge check needs. Each new commit needs a new one.",
      },
      {
        heading: "What it costs",
        body: "Only the new or changed checks and the setup steps run, so it's usually short. It uses the one merge copy, so landings wait while it runs. Land runs it first, then lands by itself.",
      },
    ],
    docs: "Dry runs in the docs",
  };
}

/** Who started it, as "started by {who}" says: "you", "your Land", the chat's title (else "its chat"). */
export function whoStarted(by: TrialBy | undefined, chatTitle?: (session: string) => string | undefined): string {
  if (!by || by.kind === "operator") return "you";
  if (by.kind === "land") return "your Land";
  return (by.session && chatTitle?.(by.session)) || "its chat";
}

/** Who stopped it: "by you", "by {chat}", "by a Sova restart", "by a newer dry run"; "" when nothing recorded who
    (a dry run saved before stops were recorded, or one aborted): never "by you" when nobody pressed Stop. */
export function stoppedBy(stopped: MergeTrial["stopped"] | undefined, chatTitle?: (session: string) => string | undefined): string {
  switch (stopped?.by) {
    case "operator":
      return "by you";
    case "chat":
      return `by ${(stopped.session && chatTitle?.(stopped.session)) || "its chat"}`;
    case "restart":
      return "by a Sova restart";
    case "superseded":
      return "by a newer dry run";
    default:
      return "";
  }
}
const stoppedWords = (stopped: MergeTrial["stopped"] | undefined, chatTitle?: (session: string) => string | undefined): string => {
  const by = stoppedBy(stopped, chatTitle);
  return by ? `Dry run stopped ${by}` : "Dry run stopped";
};

/** "1st", "2nd", "3rd", "11th". */
export const nth = (n: number): string => {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
};

/** A row's dry-run chip: the state's word and tone (a dot and the word, never hue alone). */
export function dryRunChip(d: Pick<BranchDryRun, "state" | "land"> & Partial<Pick<BranchDryRun, "failure">>): { label: string; tone: Tone; live?: true } {
  switch (d.state) {
    case "needed":
      return d.land ? { label: "Approved · dry run first", tone: "info" } : { label: "Needs a dry run", tone: "info" };
    case "waiting":
      return d.land ? { label: "Approved · dry run first", tone: "info" } : { label: "Dry run waiting", tone: "info" };
    case "running":
      return { label: "Dry run running", tone: "accent", live: true };
    case "passed":
      return { label: "Dry run passed", tone: "success" };
    case "failed":
      return d.failure?.whose === "unclear" ? { label: "Can't tell whose failure", tone: "warn" } : { label: "Dry run failed", tone: "error" };
    case "stopped":
      return { label: "Dry run stopped", tone: "warn" };
    case "machine":
      return { label: "Dry run couldn't run", tone: "warn" };
  }
}

/**
 * A row's dry-run line, always with why when it is needed, waits or runs: "Needs a dry run: adds the merge check
 * Playbook tests", "Dry run waiting · starts after the landing of feat/x: …", "Dry run running · check 2 of 3: …",
 * "Dry run passed at abc1234", the failure line, "Dry run stopped by you. Run it again.", "Dry run couldn't run: …".
 * `stand`: the Land's second line when one stands ("Your Land stands: …").
 */
export function dryRunLine(
  d: BranchDryRun,
  target: string,
  chatTitle?: (session: string) => string | undefined,
): { text: string; stand?: string; older?: string } {
  const why = stripDot(d.why);
  // An older commit's dry run is a note while the head has none of its own that passed; once it has, it says nothing.
  const older = d.older && d.older.commit !== d.commit && d.state !== "passed" ? olderNote(d.older) : undefined;
  const extra = { ...(older ? { older } : {}), ...(d.land && (d.state === "needed" || d.state === "waiting" || d.state === "running") ? { stand: LAND_STANDS } : {}) };
  switch (d.state) {
    case "needed":
      return { text: `Needs a dry run: ${why}`, ...extra };
    case "waiting": {
      const place = d.position ? ` · ${nth(d.position)}` : "";
      const head = d.land ? `Approved · dry run first${place}` : `Dry run waiting${place}`;
      return { text: `${head}${d.after ? ` · starts after ${stripDot(d.after)}` : ""}: ${why}`, ...extra };
    }
    case "running":
      return { text: `Dry run running${d.progress ? ` · check ${d.progress.at} of ${d.progress.of}` : ""}: ${why}`, ...extra };
    case "passed":
      return { text: `Dry run passed at ${sha7(d.commit)}`, ...extra };
    case "failed":
      return { text: d.failure ? failureLine(d.failure, target) : `Dry run failed at ${sha7(d.commit)}.`, ...extra };
    case "stopped":
      return { text: `${stoppedWords(d.stopped, chatTitle)}. Run it again.`, ...extra };
    case "machine": {
      const w = d.failure?.line ? stripDot(d.failure.line.replace(/^Dry run couldn't run:\s*/i, "")) : "the merge copy couldn't be made ready";
      return { text: `Dry run couldn't run: ${w}. That's the machine, not this branch: run it again.`, ...extra };
    }
  }
}

/** An older commit's dry run, never the branch's current one: "Dry run passed at abc1234, an older commit." */
export function olderNote(o: NonNullable<BranchDryRun["older"]>): string {
  const word = o.verdict === "passed" ? "passed" : o.verdict === "failed" ? "failed" : o.verdict === "running" ? "running" : o.verdict === "machine" ? "couldn't run" : "stopped";
  return `Dry run ${word} at ${sha7(o.commit)}, an older commit.`;
}

/** Whose a failure is, in the Fix row's words. */
export function whoseWords(whose: BranchFailure["whose"], target: string): string {
  switch (whose) {
    case "branch":
      return "This branch's change breaks it.";
    case "master":
      return `Fails on ${target} too: not this branch's.`;
    case "unclear":
      return `Can't tell whose failure: it fails on ${target} alone too.`;
    case "machine":
      return "That's the machine, not this branch.";
  }
}

/** The failing tests, up to 3, then "+{n} more". */
export function testsWords(tests: NonNullable<BranchFailure["checks"][number]["tests"]>): string {
  const names = tests.map((t) => t.name ?? t.file ?? "").filter(Boolean);
  if (!names.length) return "";
  const shown = names.slice(0, 3).join(", ");
  return `${names.length} failing ${names.length === 1 ? "test" : "tests"} (${shown}${names.length > 3 ? ` +${names.length - 3} more` : ""})`;
}

/**
 * The failure line beside Fix: the server's own line when it names whose it is, else built from its checks:
 * "{check} fails at {sha}: {n} failing tests (…). This branch's change breaks it."
 */
export function failureLine(f: BranchFailure, target: string): string {
  const whose = whoseWords(f.whose, target);
  if (f.line && (f.whose === "machine" || /not this branch's|breaks it|can't tell/i.test(f.line))) return /[.]$/.test(f.line.trim()) ? f.line.trim() : `${f.line.trim()}.`;
  const c = f.checks[0];
  if (!c) return f.line ? `${stripDot(f.line)}. ${whose}` : whose;
  const tests = c.tests?.length ? testsWords(c.tests) : "";
  const more = f.checks.length > 1 ? ` (and ${f.checks.length - 1} more ${f.checks.length === 2 ? "check" : "checks"})` : "";
  return `${c.label}${more} fails at ${sha7(f.commit)}${tests ? `: ${tests}` : ""}. ${whose}`;
}

/** The buttons a branch row's dry run gives it (§app.merge-queue/dry-runs). `primary` is Land's place: Land, or Fix. */
export interface DryRunActions {
  primary: "land" | "fix";
  /** Run Dry Run (none ran at this commit) or Run Dry Run Again, as its own button beside the primary. */
  run?: "run" | "again";
  /** Stop Dry Run: a running dry run, or one waiting for the merge copy. */
  stop?: boolean;
  /** The ▾ menu's dry-run items, first: Fix in New Chat, the action Fix took the place of, Land Anyway. */
  menu: ("fix-new-chat" | "land" | "again" | "land-anyway")[];
}

/** Which buttons a row's dry run offers. `land`: the row offers Land at all (a branch whose Land already stands
    shows none, and only Run / Stop / Fix). */
export function dryRunActions(d: Pick<BranchDryRun, "state" | "run" | "land" | "failure">, land = true): DryRunActions {
  const again = d.run ? "again" : "run";
  switch (d.state) {
    case "needed":
      return { primary: "land", run: again, menu: [] };
    case "stopped":
    case "machine":
      return { primary: "land", run: "again", menu: [] };
    case "waiting":
    case "running":
      return { primary: "land", stop: true, menu: [] };
    case "failed": {
      // A failure master shares, or one that can't be placed, stops and asks: Fix, Run Dry Run Again beside it, and
      // in the menu Fix in New Chat, the Land it took the place of and Land Anyway where a Land stands on it.
      if (d.failure?.whose === "master" || d.failure?.whose === "unclear") return { primary: "fix", run: "again", menu: ["fix-new-chat", ...(land ? (["land"] as const) : []), ...(d.land ? (["land-anyway"] as const) : [])] };
      return { primary: "fix", menu: ["fix-new-chat", "again", ...(land ? (["land"] as const) : [])] };
    }
    case "passed":
      return { primary: "land", menu: [] };
  }
}

/** The Dry runs tab's chip of one dry run, by its verdict. */
export function trialChip(t: Pick<MergeTrial, "verdict" | "failure">): { label: string; tone: Tone; live?: true } {
  switch (t.verdict) {
    case "running":
      return { label: "Dry run running", tone: "accent", live: true };
    case "passed":
      return { label: "Dry run passed", tone: "success" };
    case "failed":
      return t.failure?.whose === "unclear" ? { label: "Can't tell whose failure", tone: "warn" } : { label: "Dry run failed", tone: "error" };
    case "machine":
      return { label: "Dry run couldn't run", tone: "warn" };
    case "void":
      return { label: "Dry run stopped", tone: "warn" };
  }
}

/** A Dry runs tab row's one line under its chip: why it was needed, then what came of it. */
export function trialLine(t: MergeTrial, target: string, chatTitle?: (session: string) => string | undefined): string | null {
  if (t.verdict === "failed" && t.failure) return failureLine(t.failure, target);
  if (t.verdict === "machine") return `Dry run couldn't run${t.why ? `: ${stripDot(t.why)}` : ""}. That's the machine, not this branch.`;
  if (t.verdict === "void") return `${stoppedWords(t.stopped, chatTitle)}.`;
  return null;
}

/** How long it took: "took 4 min", "took 48 s". */
export function tookWords(start: string, end: string | undefined): string | null {
  const ms = end ? Date.parse(end) - Date.parse(start) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms >= 60_000 ? `took ${Math.round(ms / 60_000)} min` : `took ${Math.max(1, Math.round(ms / 1000))} s`;
}

/** What a dry run runs, for Checking now: "Runs 2 of 9 merge checks: the ones this branch adds or changes." */
export function scopeWords(t: Pick<MergeTrial, "ran" | "skipped">): string | null {
  const ran = t.ran?.length ?? 0;
  const skipped = t.skipped?.length ?? 0;
  if (!ran && !skipped) return null;
  if (!ran) return "Runs the setup steps only: it changes no check.";
  return `Runs ${ran} of ${ran + skipped} ${ran + skipped === 1 ? "check" : "checks"}: the ones this branch adds or changes.`;
}

/** Fix's refusal, or null when it can send now. */
export const fixWhyNot = (o: FixOffer | undefined): string | null => (!o ? "No chat is known for this branch." : o.chat.ok ? null : o.chat.why);
/** Fix in New Chat's refusal, or null. */
export const newChatWhyNot = (o: FixOffer | undefined): string | null => (!o ? null : o.newChat.ok ? null : (o.newChat.why ?? "Fix in New Chat can't start now."));

/** Fix in New Chat's menu line: where the new chat works. */
export const newChatLine = (o: FixOffer | undefined, target: string): string =>
  o?.newChat.on === "new-branch" ? `Starts a chat with the failure, on a new branch from ${target}.` : "Starts a chat with the failure, on this branch.";

/** The toasts. */
export const fixToast = (chat: string): string => `Sent the failure to ${chat}.`;
export const newChatToast = (check: string, branch: string, on: FixOffer["newChat"]["on"], target: string): string =>
  on === "new-branch" ? `Started a chat to fix ${check} on a new branch from ${target}.` : `Started a chat to fix ${check} on ${branch}.`;
export const startedToast = (branch: string, commit: string): string => `Started a dry run of ${branch} at ${sha7(commit)}.`;
/** Run Dry Run's toast: started, or waiting for the merge copy (the answer's `waiting`). */
export const runToast = (branch: string, commit: string, waiting?: { after: string }): string =>
  waiting ? `Dry run of ${branch} waiting · starts after ${waiting.after}.` : startedToast(branch, commit);
export const stoppedToast = (branch: string): string => `Stopped the dry run of ${branch}.`;

/** The empty-tab fact while a dry run runs: "1 dry run running." / "1 dry run running, 2 waiting." */
export const dryRunFact = (waiting: number): string => (waiting ? `1 dry run running, ${waiting} waiting.` : "1 dry run running.");

/** Land's confirm line on a setup branch whose head has no passing dry run. */
export const landFirstLine = (commit: string, why: string): string => `A dry run of ${sha7(commit)} runs first: ${stripDot(why)}. Once it passes, it lands by itself.`;

/** The state lets Land's confirm say a dry run comes first. */
export const runsFirst = (d: Pick<BranchDryRun, "state"> | undefined): boolean => !!d && d.state !== "passed";

/** The waiting dry run's id for Stop Dry Run, when the branch's own state carries it (BranchDryRun.waiting). */
export const waitingIdOf = (d: BranchDryRun | undefined): string | undefined => (d?.state === "waiting" ? d.waiting : undefined);

/** A held-up entry's chip when its Land's dry run failed on a check the target fails too: the queue holds it as a
    decision ("can't tell whose" by kind), but the screens say what it is, never "can't tell". Null otherwise. */
export const heldDryRunLabel = (e: { failure?: Pick<BranchFailure, "kind" | "whose"> }): string | null =>
  e.failure?.kind === "dry-run" && e.failure.whose === "master" ? "Dry run failed · waiting for you" : null;

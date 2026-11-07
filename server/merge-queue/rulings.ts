/**
 * The merge thread's rulings and the queue's automatic send-back (al_3 track B), as pure helpers:
 * - the verdicts `merge.resolve` takes for a conflict, and the rulings `merge.rule` takes for everything else;
 * - what is the user's to decide (the definition the thread and the chat both rule by);
 * - the same-failure fingerprint a send-back carries (the tries counter compares them);
 * - the text of a send-back request: what failed, where its log is, the thread's diagnosis. Built from the run and
 *   the cause it is about only, so a request never repeats an earlier conflict's or review's text.
 * No fs, no queue state: queue.ts calls these.
 */
import { join } from "node:path";
import type { MergeEntry, MergeRun, SentBackFor } from "../../shared/merge-queue";

/** merge.resolve's verdicts on a conflict. "behaviour-differs" (the old word) reads as "needs-user". */
export const RESOLVE_VERDICTS = ["no-behaviour-change", "chat-fixes", "needs-user"] as const;
export type ResolveVerdict = (typeof RESOLVE_VERDICTS)[number];
export function resolveVerdict(v: unknown): ResolveVerdict | null {
  if (v === "behaviour-differs") return "needs-user";
  return (RESOLVE_VERDICTS as readonly unknown[]).includes(v) ? (v as ResolveVerdict) : null;
}

/**
 * merge.rule's rulings (the thread's, on anything but a conflict's resolution):
 * - `chat-fixes`: the branch's chat fixes it; `text` is the diagnosis, sent with the request.
 * - `try-again`: put it back in line (a failure that wasn't the branch's, or after a machine pause); after a chat's
 *   "Can't", `text` is the other approach, sent to the chat as a new request (once).
 * - `needs-user`: the user decides; `text` is the question, `choices` its options.
 * - `checked` / `beyond`: a fix (by its request id) changes only what was asked / changes more (`text` says what).
 */
export const RULINGS = ["chat-fixes", "try-again", "needs-user", "checked", "beyond"] as const;
export type Ruling = (typeof RULINGS)[number];
export const isRuling = (v: unknown): v is Ruling => (RULINGS as readonly unknown[]).includes(v);

/** How long a failure blamed on the branch waits for the thread's diagnosis before it goes back without one. */
export const RULING_WAIT_MS = 5 * 60_000;
/** At most this many choices on a decision, each at most CHOICE_MAX characters. */
export const CHOICES_MAX = 4;
export const CHOICE_MAX = 200;
/** A question, a diagnosis, an approach: at most this long. */
export const RULING_TEXT_MAX = 2000;

/** What is the user's to decide, and what is not (al_3 q3), in the words the thread and the chat both rule by. */
export const NEEDS_USER_RULE = [
  "The user's: anything a person sees or does differently (wording, layout, controls, defaults, notifications, noticeable timing, data kept or deleted, permissions and safety), a change of meaning to a promise the user agreed, and anything the branch's task never decided.",
  "Not the user's: regenerated files, recorded test outputs, lockfiles, list order with no visible effect, compile fixes, internal logs.",
].join(" ");

/** Choices as given: trimmed, empties dropped, at most CHOICES_MAX of at most CHOICE_MAX characters. */
export function cleanChoices(choices: unknown): string[] {
  if (!Array.isArray(choices)) return [];
  return choices
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().slice(0, CHOICE_MAX))
    .filter(Boolean)
    .slice(0, CHOICES_MAX);
}

/** The failing tests of a run's failed steps that are the branch's (or unblamed), "file › name". */
export function branchFailures(run: MergeRun): { step: string; label: string; detail?: string; log: string; tests: string[]; messages: string[] }[] {
  return run.steps
    .filter((s) => s.result === "failed" && s.kind !== "rerun-master" && s.kind !== "rerun-tip")
    .map((s) => {
      const f = (s.failures ?? []).filter((x) => x.blame === "branch" || !x.blame);
      return {
        step: s.id,
        label: s.label,
        ...(s.detail ? { detail: s.detail } : {}),
        log: s.log,
        tests: f.map((x) => [x.file, x.name].filter(Boolean).join(" › ")).filter(Boolean),
        messages: f.map((x) => x.message?.split("\n")[0]?.slice(0, 240) ?? "").filter(Boolean),
      };
    });
}

/**
 * The same-failure fingerprint (al_3 q2): two runs fail "the same way" when these match. A failed check: the cause, the
 * failing steps and their failing tests or files; a conflict: the conflicting files; a review: its findings; drafts:
 * the docs step's detail. Order never matters.
 */
export function fingerprintOf(f: { cause: SentBackFor | "review"; run?: MergeRun; files?: string[]; review?: string; why?: string; tails?: Record<string, string> }): string {
  const sorted = (xs: string[]) => [...new Set(xs)].sort().join(",");
  switch (f.cause) {
    case "conflict":
      return `conflict:${sorted(f.files ?? [])}`;
    case "review":
      return `review:${normalise(f.review ?? "")}`;
    case "checks":
    case "drafts": {
      // A step with no parsed tests (a typecheck, a build, the docs step) is told apart by what it says: its detail and
      // first messages, with the file paths they name kept whole (normalise drops digits, so paths are taken first).
      // `tails`: the last lines of each such step's log, when the caller read them.
      const said = (s: ReturnType<typeof branchFailures>[number]) => [s.detail ?? "", ...s.messages, f.tails?.[s.step] ?? ""].join(" ");
      const parts = f.run ? branchFailures(f.run).map((s) => `${s.step}[${s.tests.length ? sorted(s.tests) : `${sorted(pathsIn(said(s)))}|${normalise(said(s))}`}]`) : [];
      return `${f.cause}:${parts.length ? sorted(parts) : normalise(f.why ?? "")}`;
    }
    default:
      return `${f.cause}:${normalise(f.why ?? "")}`;
  }
}

/** The file paths a line names ("src/a.ts", "server/x.test.ts:12" → "server/x.test.ts"). */
function pathsIn(t: string): string[] {
  return [...t.matchAll(/[\w.@-]+(?:\/[\w.@-]+)*\.[a-z]{1,5}\b/gi)].map((m) => m[0]);
}

/** Words only, lower case, digits and hex ids dropped: two reviews of the same findings, or two whys, compare equal. */
function normalise(t: string): string {
  return t
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "")
    .replace(/[0-9]+/g, "")
    .replace(/[^a-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** One send-back, as the queue knows it at that moment. */
export interface SendBackFacts {
  cause: SentBackFor | "review";
  /** One line: why it went back. */
  why: string;
  /** The run it came from (absent: before a run, e.g. what still blocks a finished branch). */
  run?: MergeRun;
  /** The run's log folder (merge.logs reads the same). */
  logDir?: string;
  /** conflict: the files as they conflict on the newest target, from this run only. */
  files?: string[];
  /** review: the reviewer's findings. */
  review?: string;
  /** The merge thread's diagnosis, when it gave one. */
  diagnosis?: string;
  /** This try and the tries the standing approval has. */
  attempt?: { try: number; of: number };
}

/**
 * The request a send-back puts on the branch's chat queue: what failed, where its log is, the merge thread's
 * diagnosis, and what to answer. Never more than this send-back is about.
 */
export function sendBackText(e: Pick<MergeEntry, "branch" | "target" | "commit">, f: SendBackFacts): string {
  const lines: string[] = [];
  const tryWords = f.attempt ? ` (try ${f.attempt.try} of ${f.attempt.of})` : "";
  switch (f.cause) {
    case "conflict": {
      const files = f.files ?? [];
      lines.push(`${e.branch} conflicts with ${e.target}${files.length ? ` in ${files.join(", ")}` : ""}, as ${e.target} is now${tryWords}.`);
      lines.push(`Merge ${e.target} into ${e.branch}, resolve the conflicts and commit.`);
      break;
    }
    case "review":
      lines.push(`The merge queue's review found problems in ${e.branch} at ${e.commit.slice(0, 7)}${tryWords}:`);
      if (f.review?.trim()) lines.push(f.review.trim());
      lines.push("Address each finding and commit.");
      break;
    case "drafts":
      lines.push(`${e.branch}'s spec drafts don't fit at landing${tryWords}: ${f.why}.`);
      lines.push("Make them fit in your drafts (that needs no commit); a new or changed promise isn't a fit: answer Needs you for it.");
      break;
    default: {
      lines.push(`${e.branch} didn't land${tryWords}: ${f.why}.`);
      for (const s of f.run ? branchFailures(f.run).slice(0, 4) : []) {
        lines.push(`- ${s.label}${s.detail ? `: ${s.detail}` : ""}${s.tests.length ? ` (${s.tests.slice(0, 3).join("; ")})` : ""}${f.logDir ? ` · log ${join(f.logDir, s.log)}` : ""}`);
        for (const m of s.messages.slice(0, 3)) lines.push(`  ${m}`);
      }
      if (f.cause === "checks") lines.push(`It passes on ${e.target} alone in the same copy, so it is this branch's to fix. Fix it and commit.`);
    }
  }
  if (f.diagnosis?.trim()) lines.push(`The merge thread's diagnosis: ${f.diagnosis.trim()}`);
  // How to answer (merge.respond, fixed / needs-you with choices / cant) is the batch's own line (MERGE_QUEUE_ANSWER_LINE).
  lines.push("Change only what this asks, then answer this request by its id. The user's Land stands: your checked fix goes back in line by itself.");
  return lines.join("\n");
}

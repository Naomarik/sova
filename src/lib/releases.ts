// The Releases tab's words and rules: pure, so the rules run under tsx --test and
// the tab, the Overview card and the Deploy card read them alike. Types only from the wire.
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import type { ReleaseHistoryItem, ReleaseRecord, ReleaseState, ReleaseStep, ReleaseView, StepState } from "../../shared/release";

export type ChipTone = "info" | "warn" | "error" | "success" | "accent" | undefined;
export interface ChipWord {
  word: string;
  tone: ChipTone;
  live?: boolean;
}

/** A step's state as its chip says it. */
export const STEP_CHIP: Record<StepState, ChipWord> = {
  waiting: { word: "Waiting", tone: undefined },
  running: { word: "Running", tone: "accent", live: true },
  done: { word: "Done", tone: "success" },
  failed: { word: "Failed", tone: "error" },
  skipped: { word: "Skipped", tone: undefined },
  held: { word: "Held for you", tone: "warn" },
};

/** A release's state as its chip says it. */
export const RELEASE_CHIP: Record<ReleaseState, ChipWord> = {
  preparing: { word: "Preparing", tone: "accent", live: true },
  checking: { word: "Checking", tone: "accent", live: true },
  ready: { word: "Ready to publish", tone: "warn" },
  publishing: { word: "Publishing", tone: "accent", live: true },
  published: { word: "Published", tone: "success" },
  abandoned: { word: "Abandoned", tone: undefined },
  withdrawn: { word: "Withdrawn", tone: "warn" },
};

/** Open: the queue is frozen on it and only one may be. */
export { isReleaseOpen as isOpen } from "../../shared/release";
import { isReleaseOpen as isOpen } from "../../shared/release";

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : "");

/** The release's name: its version once picked, else the plain words. */
export const releaseName = (r: Pick<ReleaseRecord, "version" | "tag">): string => r.tag ?? r.version ?? "The new release";

/** "479 landings since v0.9.0", "No landings since v0.9.0", or null with no release yet. */
export function sinceLine(v: Pick<ReleaseView, "latest" | "landingsSince">): string | null {
  if (!v.latest) return null;
  const n = v.landingsSince;
  if (n === null || n === undefined) return null;
  if (n === 0) return `No landings since ${v.latest}`;
  return `${n} ${n === 1 ? "landing" : "landings"} since ${v.latest}`;
}

/** A step still has work for its chat or for you. */
const unsettled = (s: Pick<ReleaseStep, "state">): boolean => s.state === "waiting" || s.state === "running" || s.state === "failed" || s.state === "held";

/** The record to show on the tab: the open one, else the newest one while it still has work: after-publish steps
    of a published release, after-withdraw steps of a withdrawn one. A record whose steps are all settled is history. */
export function shownRecord(v: Pick<ReleaseView, "open" | "last">): ReleaseRecord | null {
  if (v.open) return v.open;
  const l = v.last;
  if (!l) return null;
  const phase = l.state === "published" ? "after" : l.state === "withdrawn" ? "withdraw" : null;
  return phase && l.steps.some((s) => s.phase === phase && unsettled(s)) ? l : null;
}

/** The steps a record lists: after-withdraw steps only once it was withdrawn. */
export const visibleSteps = (r: Pick<ReleaseRecord, "steps" | "state">): ReleaseStep[] => (r.state === "withdrawn" ? r.steps : r.steps.filter((s) => s.phase !== "withdraw"));

/** Where a step sits, said under its label (prepare steps say nothing). */
export const PHASE_WORD: Record<ReleaseStep["phase"], string | null> = { prepare: null, sova: "Sova", check: "Before publish", after: "After publish", withdraw: "After withdraw" };

/** Where the release is, in one line under its title: "Step 3 of 7 · Bump the files", "Every step done". */
export function progressLine(r: Pick<ReleaseRecord, "steps" | "state">): string {
  const steps = visibleSteps(r);
  const settled = (s: ReleaseStep) => s.state === "done" || s.state === "skipped";
  const done = steps.filter(settled).length;
  const now = steps.find((s) => s.state === "running" || s.state === "held" || s.state === "failed") ?? steps.find((s) => s.state === "waiting");
  if (!now) return `All ${steps.length} steps done`;
  const i = steps.indexOf(now) + 1;
  const what = now.state === "held" ? `${now.label}, held for you` : now.state === "failed" ? `${now.label} failed` : now.label;
  return `Step ${i} of ${steps.length} · ${what} · ${done} done`;
}

/** The actions a step offers the operator: Continue on a held step, Retry Step on a failed one (but Publish). Only while its
    release can still act: open, published (its after-publish steps), withdrawn (its after-withdraw steps). */
export function stepActions(r: Pick<ReleaseRecord, "state">, s: Pick<ReleaseStep, "id" | "state" | "phase">): { continue: boolean; retry: boolean } {
  const live = isOpen(r.state) || (r.state === "published" && s.phase === "after") || (r.state === "withdrawn" && s.phase === "withdraw");
  // A failed Publish is retried from the Publish button, with its confirm: the step alone publishes nothing.
  return { continue: live && s.state === "held", retry: live && s.state === "failed" && s.id !== "publish" };
}

/** The Publish button's words: Retry Publish after a failed one, which offers the same confirm. */
export const publishLabel = (r: Pick<ReleaseRecord, "steps" | "tag" | "version">): string => (r.steps.some((s) => s.id === "publish" && s.state === "failed") ? "Retry Publish" : `Publish ${releaseName(r)}`);

/** Why Publish isn't offered yet, as one sentence; null when it is. */
export function publishBlocked(v: Pick<ReleaseView, "gates">, r: Pick<ReleaseRecord, "state">): string | null {
  if (r.state === "publishing") return "Publishing now.";
  const why = (v.gates?.why ?? []).filter(Boolean);
  // A gate that still says why holds Publish even on a ready release (a push the queue can't make yet).
  // The gates' reasons are sentences of their own: listed after one lead-in, never fitted into "until".
  if (r.state !== "ready" || why.length) return why.length ? `Not ready to publish: ${why.map((x) => x.trim().replace(/[.]$/, "")).join("; ")}.` : "Not ready to publish: steps before it aren't done yet.";
  return null;
}

/** The Publish confirm: what goes out, then what can't be undone. */
export function publishConfirmLine(r: Pick<ReleaseRecord, "tag" | "version" | "channels">, v: Pick<ReleaseView, "remote" | "target">): string {
  const name = releaseName(r);
  const ch = r.channels.length ? ` and moves ${list(r.channels)} to it` : "";
  if (!v.remote) return `Publishing tags ${name} on this machine${ch}. Nothing is pushed. The number is never moved or deleted; Withdraw only moves ${r.channels.length ? list(r.channels) : "a channel"} back.`;
  const pushes = [v.target, name, ...r.channels].join(", ");
  return `Publishing pushes ${pushes} to origin in one step${ch ? ", and anyone installing or checking for updates sees it at once" : ""}. The number is never moved or deleted; Withdraw only moves ${r.channels.length ? list(r.channels) : "a channel"} back.`;
}

/** The Withdraw confirm: what moves, then what stays. */
export function withdrawConfirmLine(item: Pick<ReleaseHistoryItem, "tag" | "channels">, previous: string | null, remote: boolean): string {
  const moves = item.channels.length
    ? `${list(item.channels)} ${item.channels.length === 1 ? "moves" : "move"} back to ${previous ?? "no release"}${remote ? " on origin too" : ""}.`
    : "No channel points at it, so nothing moves.";
  return `${moves} ${item.tag} itself stays, marked withdrawn with your reason; copies running it are told so. Deploy targets keep running it until you roll them back on the Deploy card.`;
}

/** The Abandon confirm. */
export function abandonConfirmLine(r: Pick<ReleaseRecord, "entry" | "commit" | "base">): string {
  const landed = !!r.entry && !!r.commit && r.commit !== r.base;
  return `The release chat stops and nothing is published.${landed ? " If its release commit already landed, it's reverted as a landing on the target." : ""} Landings waiting in the queue go ahead.`;
}

/** The newest release before `tag` that isn't withdrawn: where Withdraw moves the channels. */
export function previousRelease(history: readonly ReleaseHistoryItem[], tag: string): string | null {
  const i = history.findIndex((h) => h.tag === tag);
  if (i < 0) return null;
  return history.slice(i + 1).find((h) => !h.withdrawn)?.tag ?? null;
}

/** The release a commit is, by its sha (a Deploy row's "Runs v0.9.0"). */
export function releaseAt(history: readonly ReleaseHistoryItem[] | undefined, sha: string | null | undefined): ReleaseHistoryItem | null {
  if (!history || !sha) return null;
  return history.find((h) => h.sha === sha || (sha.length >= 7 && h.sha.startsWith(sha))) ?? null;
}

/** The release a deploy target runs: the history item that lists it, newest first. */
export const releaseOfTarget = (history: readonly ReleaseHistoryItem[] | undefined, target: string): ReleaseHistoryItem | null =>
  history?.find((h) => h.deployedTo.includes(target)) ?? null;

/** The power's waiting period: "Publishes in 4:32", "Publishing now"; `now` in ms. */
export function countdown(until: string, now: number): string {
  const left = Math.max(0, Date.parse(until) - now);
  if (!left) return "Publishing now";
  const s = Math.ceil(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `Publishes in ${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${ss}`;
}

/** The Overview card's line: "Latest v0.9.0 · 479 landings since", or what is open. */
export function cardLine(v: Pick<ReleaseView, "initialized" | "latest" | "landingsSince" | "open">): string {
  // The card's chip says the state: the line names the release only.
  if (v.open) return `${releaseName(v.open)} in progress`;
  if (!v.latest) return v.initialized ? "No release yet." : "Releases aren't set up for this project.";
  const n = v.landingsSince;
  return `Latest ${v.latest}${n === null || n === undefined ? "" : ` · ${n === 0 ? "no" : n} ${n === 1 ? "landing" : "landings"} since`}`;
}

/** "A", "A and B", "A, B and C". */
function list(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Who started it, in the record's own words. */
export const startedByWord = (by: ReleaseRecord["startedBy"]): string => (by === "power" ? "the release power" : "you");

/** A Set Up Releases run (the release playbook maker) as the not-set-up view shows it: live (running, or waiting on your
    answers) with its chat, or proposed on its branch for you to review and land; null when none is. */
export type SetupRun = { kind: "live"; waiting: boolean; path?: string; questions?: number } | { kind: "proposed"; branch: string; path?: string };
export function setupRun(v: Pick<ProjectRuntimeView, "playbook" | "playbookState"> | undefined): SetupRun | null {
  const pb = v?.playbook;
  if (!pb || pb.proposes !== "release") return null;
  if (v!.playbookState === "running" || v!.playbookState === "waiting")
    return { kind: "live", waiting: v!.playbookState === "waiting", ...(pb.path ? { path: pb.path } : {}), ...(pb.questions ? { questions: pb.questions } : {}) };
  if (v!.playbookState === "proposed") return { kind: "proposed", branch: pb.branch ?? "its branch", ...(pb.path ? { path: pb.path } : {}) };
  return null;
}

/** The live run's line: "Setup chat running", or what it waits on. */
export const setupLiveLine = (r: Extract<SetupRun, { kind: "live" }>): string =>
  r.waiting ? `Setup chat waiting on your answers${r.questions ? ` · ${r.questions} ${r.questions === 1 ? "question" : "questions"}` : ""}` : "Setup chat running";

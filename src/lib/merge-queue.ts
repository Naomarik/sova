// The merge queue as words: one vocabulary for the composer's worktrees control, its modal, the
// session pane's Worktrees rows and the project's Merge Queue tab, so the four always agree. Pure: no
// Solid, no DOM. The shapes are the queue's (shared/merge-queue.ts); the verb calls live in
// merge-queue-client.ts.
import type { SessionWorktreeInfo } from "../../shared/protocol";
import { newerWords, ordinal } from "../../shared/merge-queue";
import type { MergeEntry, MergeNote, MergeProjectInfo, MergeQueueView, MergeRun, RunStep, WorktreeQueueInfo } from "./merge-queue-types";
import { requestChip, requestReason } from "./merge-queue-requests";

export type { MergeEntry, MergeProjectInfo, MergeQueueView, MergeRun, RunStep, WorktreeQueueInfo };
export { ordinal };

export const short = (sha: string | undefined): string => (sha ?? "").slice(0, 7);

/** A line from the queue as a sentence: capitalised, ending in a stop, so the next one can follow it. */
export const sentence = (s: string | undefined): string => {
  const t = (s ?? "").trim();
  if (!t) return "";
  const up = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(up) ? up : `${up}.`;
};

/** Minutes, rounded up, never 0: "4 min". */
export const mins = (ms: number | undefined): string => `${Math.max(1, Math.ceil((ms ?? 0) / 60_000))} min`;

/** A step's time: "0:48", "12:05", "1:02:10". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export type Tone = "success" | "warn" | "error" | "info" | "accent" | "neutral";

/** A row's one action. Land carries a ▾ with Land Without Review (only where the project has a
    review kit) and Land Without Its Specs…. */
export type RowAction = "land" | "setup" | "cancel" | "accept" | "land-anyway" | "none";

export type RowKey =
  | "uncommitted"
  | "no-commits"
  | "ready"
  | "queued"
  | "checking"
  | "conflict"
  | "behaviour-differs"
  | "review-flagged"
  | "unattributed"
  | "needs-fix"
  | "drafts-changed"
  | "landed"
  | "request-review"
  | "requested"
  | "pushed"
  | "closed"
  | "merged"
  | "dropped"
  | "removed";

/** One worktree row in the queue's words. */
export interface QueueRow {
  key: RowKey;
  /** The chip's word; the same everywhere. */
  label: string;
  tone: Tone;
  /** The chip pulses: being checked right now. */
  live?: boolean;
  /** Mono facts after the chip: "a1b2c3d", "starts in ~4 min · takes ~9 min", "as 2b8e1f0". */
  detail?: string;
  /** The line under it: why it waits, what failed, what each side wants. */
  reason?: string;
  /** "1 newer commit not included". */
  newer?: string;
  /** The branch against the target's head: "3 commits · +40 −2". */
  size?: string;
  /** Notes on it (the merge thread's first), each with what kind it is. */
  notes: { label: string; text: string }[];
  action: RowAction;
  /** Send Back beside the action (behaviour differs, review flagged). */
  sendBack?: boolean;
  /** A run to See Why on. */
  run?: string;
}

/** The label a note's kind reads with. */
export const NOTE_LABEL: Record<MergeNote["kind"], string> = {
  thread: "Merge thread",
  operator: "You",
  review: "Review",
  flaky: "Flaky",
  "master-red": "Red on the target too",
  resolved: "Conflict resolved",
  "no-checks": "No checks declared",
};

/** The notes in reading order: the merge thread's (or yours) first, then the rest, newest kind once. */
export function notesOf(notes: readonly MergeNote[] | undefined): { label: string; text: string }[] {
  if (!notes?.length) return [];
  const rank = (k: MergeNote["kind"]) => (k === "operator" ? 0 : k === "thread" ? 1 : 2);
  // Latest wins per kind; an operator's note replaces the thread's.
  const latest = new Map<MergeNote["kind"], MergeNote>();
  for (const n of notes) latest.set(n.kind, n);
  if (latest.has("operator")) latest.delete("thread");
  return [...latest.values()].sort((a, b) => rank(a.kind) - rank(b.kind)).map((n) => ({ label: NOTE_LABEL[n.kind], text: n.text }));
}

export type QueueRowInput = Pick<SessionWorktreeInfo, "status" | "exists" | "readiness" | "branch"> &
  // mergeServed: the repo is one the merge queue serves (listed, merge setup done): only then does a row offer Land.
  Partial<Pick<SessionWorktreeInfo, "merge" | "mergedInto" | "gone" | "mergeStats" | "mergeServed">> & { queue?: WorktreeQueueInfo; mergeProject?: MergeProjectInfo };

/** A finished branch's line where the queue doesn't serve the repo: the chat merges it plainly. */
export const PLAIN_MERGE_LINE = "Say “land it” in the chat to merge it into main.";

/** "3 commits · +40 −2": the branch's side against the target's head. */
export const sizeWords = (s: { ahead: number; added: number; removed: number } | undefined): string | undefined =>
  s ? `${s.ahead} ${s.ahead === 1 ? "commit" : "commits"} · +${s.added} −${s.removed}` : undefined;

/** The commit a Land pins: the head the row's numbers were read at, else the one readiness found finished. */
export const shownCommit = (w: Partial<Pick<SessionWorktreeInfo, "readiness" | "mergeStats">>): string | undefined =>
  w.mergeStats?.head ?? w.readiness?.landing?.commit;

/** Rows past the queue (landed, merged, gone) carry no size: there's nothing left to land. */
const SIZED: RowKey[] = ["ready", "uncommitted", "queued", "checking", "conflict", "behaviour-differs", "review-flagged", "unattributed", "needs-fix", "drafts-changed", "request-review"];

/** The words for one worktree, from its tracked state, its readiness and its queue entry. */
export function queueRow(w: QueueRowInput): QueueRow {
  const r = queueRowOf(w);
  const size = SIZED.includes(r.key) ? sizeWords(w.mergeStats) : undefined;
  return size ? { ...r, size } : r;
}
function queueRowOf(w: QueueRowInput): QueueRow {
  const e = w.queue;
  const base = { notes: notesOf(e?.notes), newer: newerWords(e?.newerCommits) ?? undefined, run: e?.run };
  if (e) {
    switch (e.state) {
      case "queued":
        return {
          ...base,
          key: "queued",
          label: e.position ? `Queued · ${ordinal(e.position)}` : "Queued",
          tone: "info",
          detail: e.eta ? `starts in ~${mins(e.eta.startsInMs)} · takes ~${mins(e.eta.takesMs)}` : short(e.commit),
          action: "cancel",
        };
      case "checking":
        return { ...base, key: "checking", label: "Checking", tone: "accent", live: true, detail: e.eta ? `~${mins(e.eta.takesMs)} in all` : short(e.commit), reason: e.reason, action: "none" };
      case "conflict":
        return { ...base, key: "conflict", label: "Conflict", tone: "warn", reason: e.reason ?? "The merge thread is judging a conflict with the target. The line moves on meanwhile.", action: "none" };
      case "behaviour-differs": {
        const c = e.conflict;
        return {
          ...base,
          key: "behaviour-differs",
          label: "Behaviour differs",
          tone: "warn",
          reason: c ? `Target: ${c.ours}\nBranch: ${c.theirs}\nProposed: ${c.proposal}` : (e.reason ?? "This branch and the target want different behaviour."),
          action: "accept",
          sendBack: true,
        };
      }
      case "unattributed":
        // A check failed on the merge and on the target alone, naming no tests: nobody is blamed; you decide.
        return { ...base, key: "unattributed", label: "Can't tell whose failure", tone: "warn", reason: unattributedWhy(e.reason), action: "land-anyway", sendBack: true };
      case "review-flagged":
        return { ...base, key: "review-flagged", label: "Review flagged", tone: "warn", reason: e.review?.text ?? e.reason ?? "The review found something that blocks it.", action: "land-anyway", sendBack: true };
      case "drafts-changed":
        return { ...base, key: "drafts-changed", label: "Drafts changed", tone: "warn", reason: e.reason ?? "Its spec drafts changed since you approved. Land again to approve them.", action: "land" };
      case "needs-fix":
        return { ...base, key: "needs-fix", label: "Needs a fix", tone: "error", reason: e.reason ?? "Sent back to its chat. Commit a fix, then Land again.", action: "land" };
      case "landed":
        return {
          ...base,
          newer: undefined,
          key: "landed",
          label: "Landed",
          tone: "success",
          detail: e.landed ? `as ${short(e.landed.sha)}${e.landed.pushed === "not-pushed" ? " · not pushed" : ""}` : undefined,
          action: "none",
        };
      case "request-review":
      case "requested":
      case "pushed":
      case "closed": {
        // Past Sova's checks on a request or push project: the host's words (merge-queue-requests.ts).
        const chip = requestChip(e.state, e.request, e.reason);
        // The host merged it while the queue hasn't moved the entry yet: it reads as landed.
        const key: RowKey = e.state === "requested" && e.request?.facts?.state === "merged" ? "landed" : e.state;
        return {
          ...base,
          newer: e.state === "requested" || e.state === "pushed" ? base.newer : undefined,
          key,
          label: chip.label,
          tone: chip.tone,
          ...(chip.live ? { live: true } : {}),
          reason: requestReason(e.state, e.request, w.mergeProject?.target ?? "the target", e.reason) ?? undefined,
          action: e.state === "closed" ? "land" : "none",
        };
      }
      case "cancelled":
        break; // reads as the worktree itself again, below
    }
  }
  const quiet = { notes: [] as QueueRow["notes"] };
  const merged = w.merge ?? w.mergedInto;
  if (w.status === "merged" || w.mergedInto) return { ...quiet, key: "merged", label: "Merged", tone: "success", detail: merged ? `into ${merged.target} at ${short(merged.sha)}` : undefined, action: "none" };
  if (w.status === "dropped") return { ...quiet, key: "dropped", label: "Dropped", tone: "neutral", action: "none" };
  if (!w.exists || w.gone) return { ...quiet, key: "removed", label: "Removed", tone: "neutral", action: "none" };
  const r = w.readiness;
  if (r?.state === "merged") return { ...quiet, key: "merged", label: "Merged", tone: "success", action: "none" };
  if (r?.dirtyCount)
    return { ...quiet, key: "uncommitted", label: "Uncommitted", tone: "neutral", detail: `${r.dirtyCount} ${r.dirtyCount === 1 ? "file" : "files"} not committed`, reason: w.mergeServed ? "Commit it in its chat, then Land." : "Commit it in its chat.", action: "none" };
  if (r?.noCommits) return { ...quiet, key: "no-commits", label: "No commits yet", tone: "neutral", action: "none" };
  // A repo the queue doesn't serve merges plainly from its chat: no Land, never the queue's words. A listed
  // project with no merge setup keeps Set Up Queue; a repo off the Projects list offers nothing.
  if (!w.mergeServed) {
    const unset = w.mergeProject?.checks === "unset" && !w.mergeProject.invalid;
    return {
      ...quiet,
      key: "ready",
      label: "Ready to merge",
      tone: "success",
      detail: r?.landing?.commit ? short(r.landing.commit) : undefined,
      reason: PLAIN_MERGE_LINE,
      action: unset ? "setup" : "none",
    };
  }
  // The project's .sova/project.json doesn't parse: Land stays (a branch that fixes it is taken, the queue refuses
  // the others with its reason), never Set Up; the line says why the rest wait.
  const invalid = w.mergeProject?.invalid;
  if (invalid)
    return { ...quiet, key: "ready", label: "Ready", tone: "success", detail: r?.landing?.commit ? short(r.landing.commit) : undefined, reason: invalidWords(invalid), action: "land" };
  const unset = w.mergeProject?.checks === "unset";
  return {
    ...quiet,
    key: "ready",
    label: "Ready",
    tone: "success",
    detail: r?.landing?.commit ? short(r.landing.commit) : undefined,
    reason: unset ? "This project's merge queue isn't set up yet." : undefined,
    action: unset ? "setup" : "land",
  };
}

/** A row's buttons, as the Worktrees modal and the session pane draw them, in order. Set Up Queue needs the
    project to link to; Send Back follows the row's one action. */
export type RowButton = "Land" | "Set Up Queue" | "Cancel" | "Accept" | "Land Anyway" | "Send Back";
export function rowButtons(row: Pick<QueueRow, "action" | "sendBack">, projectId: string | undefined): RowButton[] {
  const one: Partial<Record<RowAction, RowButton>> = { land: "Land", cancel: "Cancel", accept: "Accept", "land-anyway": "Land Anyway" };
  const out: RowButton[] = [];
  if (row.action === "setup") {
    if (projectId) out.push("Set Up Queue");
  } else if (one[row.action]) out.push(one[row.action]!);
  if (row.sendBack) out.push("Send Back");
  return out;
}

/** The Worktrees modal's head: the queue's intro (its target) and paused line only where some row's repo is
    one the queue serves; elsewhere branches merge plainly from their chats and the queue isn't mentioned. */
export function modalHead(rows: Pick<QueueRowInput, "mergeServed" | "mergeProject">[]): { intro: string | null; paused: string | null } {
  const served = rows.find((w) => w.mergeServed);
  if (!served) return { intro: null, paused: null };
  const p = rows.find((w) => w.mergeServed && w.mergeProject)?.mergeProject;
  return {
    intro: `Land queues a branch. It's merged onto ${p?.target ?? "the target branch"}, checked there on its own, and lands as exactly the commit that was tested.`,
    paused: p?.paused ? `The queue is paused: ${p.paused}. Land still takes your approval; it's checked once the queue resumes.` : null,
  };
}

/** Can't tell whose failure: the queue's line (which check, that it fails on the target too), else that in general. */
export const unattributedWhy = (reason: string | undefined, target?: string): string =>
  sentence(reason) || `A check failed on the merge and on ${target ?? "the target"} alone, so nobody is blamed.`;

/** One unclear check's line: "Unit tests: fails with this branch and on master alone", or the queue's own why. */
export const unclearLine = (u: { label: string; why?: string }, target?: string): string =>
  u.why?.trim() ? `${u.label}: ${u.why.trim().replace(/[.]$/, "")}` : `${u.label}: fails with this branch and on ${target ?? "the target"} alone, naming no tests`;

/** The order the summary counts in. */
const ORDER: RowKey[] = ["ready", "queued", "checking", "conflict", "behaviour-differs", "review-flagged", "unattributed", "needs-fix", "drafts-changed", "request-review", "requested", "uncommitted", "no-commits", "landed", "pushed", "closed", "merged", "removed", "dropped"];
const COUNT_WORD: Record<RowKey, [string, string]> = {
  ready: ["ready", "ready"],
  queued: ["queued", "queued"],
  checking: ["checking", "checking"],
  conflict: ["conflict", "conflicts"],
  "behaviour-differs": ["behaviour differs", "behaviour differs"],
  "review-flagged": ["review flagged", "reviews flagged"],
  unattributed: ["can't tell whose failure", "can't tell whose failure"],
  "needs-fix": ["needs a fix", "need a fix"],
  "drafts-changed": ["drafts changed", "drafts changed"],
  uncommitted: ["uncommitted", "uncommitted"],
  "no-commits": ["no commits yet", "no commits yet"],
  landed: ["landed", "landed"],
  "request-review": ["request to review", "requests to review"],
  requested: ["waiting on the host", "waiting on the host"],
  pushed: ["pushed", "pushed"],
  closed: ["closed on the host", "closed on the host"],
  merged: ["merged", "merged"],
  removed: ["removed", "removed"],
  dropped: ["dropped", "dropped"],
};

/** "2 ready · 1 queued · 1 landed": the modal's subtitle and the pane's line. */
export function rowsSummary(rows: Pick<QueueRow, "key">[]): string {
  if (rows.length === 0) return "This session tracks no worktrees.";
  const c = new Map<RowKey, number>();
  for (const r of rows) c.set(r.key, (c.get(r.key) ?? 0) + 1);
  return ORDER.filter((k) => c.has(k))
    .map((k) => `${c.get(k)} ${COUNT_WORD[k][c.get(k)! === 1 ? 0 : 1]}`)
    .join(" · ");
}

/** The composer control's words and dot: the one most useful fact. Null with no worktrees (it hides). */
export function controlWords(rows: Pick<QueueRow, "key">[]): { text: string; n: number; dot: "ok" | "warn" | "err" | null } | null {
  const w = controlWordsOf(rows);
  return w && { ...w, n: Number(/^\d+/.exec(w.text)?.[0] ?? rows.length) };
}
function controlWordsOf(rows: Pick<QueueRow, "key">[]): { text: string; dot: "ok" | "warn" | "err" | null } | null {
  if (rows.length === 0) return null;
  const n = (...k: RowKey[]) => rows.filter((r) => k.includes(r.key)).length;
  const you = n("behaviour-differs", "review-flagged", "unattributed", "drafts-changed", "request-review");
  if (you) return { text: `${you} ${you === 1 ? "needs" : "need"} you`, dot: "warn" };
  if (n("needs-fix")) return { text: `${n("needs-fix")} ${n("needs-fix") === 1 ? "needs" : "need"} a fix`, dot: "err" };
  if (n("ready")) return { text: `${n("ready")} ready`, dot: "ok" };
  if (n("checking")) return { text: "1 checking", dot: null };
  if (n("queued")) return { text: `${n("queued")} queued`, dot: null };
  return { text: `${rows.length} ${rows.length === 1 ? "worktree" : "worktrees"}`, dot: null };
}

// ---- the Merge Queue tab ----------------------------------------------------------------------

/** Where a check came from, as its tag says. */
export function sourceTag(s: RunStep["source"]): { label: string; tone: Tone } | null {
  switch (s) {
    case "required":
      return { label: "Required", tone: "neutral" };
    case "trigger":
      return { label: "Triggered", tone: "info" };
    case "picked":
      return { label: "Added by merge thread", tone: "accent" };
    default:
      return null;
  }
}

/** A definition that doesn't parse, as one sentence: the parser's path and message, then what to do. */
export const invalidWords = (invalid: string): string => `This project's .sova/project.json doesn't parse: ${invalid.trim().replace(/[.]$/, "")}. Fix it on the target, or land a branch that fixes it; nothing else lands until it parses.`;

/** The queue's state chip. */
export function queueStateChip(v: Pick<MergeQueueView, "state" | "checks"> & Partial<Pick<MergeQueueView, "invalid">>): { label: string; tone: Tone; live?: boolean } {
  // A definition that doesn't parse reads "unset" too: it is said as what it is, never "Not set up".
  if (v.invalid) return { label: "Definition invalid", tone: "error" };
  if (v.checks === "unset") return { label: "Not set up", tone: "warn" };
  if (v.state === "paused") return { label: "Paused", tone: "warn" };
  if (v.state === "running") return { label: "Running", tone: "accent", live: true };
  return { label: "Idle", tone: "neutral" };
}

/** A run's verdict chip. */
export function verdictChip(r: Pick<MergeRun, "verdict" | "blame">): { label: string; tone: Tone; live?: boolean } {
  switch (r.verdict) {
    case "running":
      return { label: "Checking", tone: "accent", live: true };
    case "passed":
      return { label: "Passed", tone: "success" };
    case "failed":
      if (r.blame === "branch") return { label: "Needs a fix", tone: "error" };
      if (r.blame === "resolution") return { label: "Resolution failed", tone: "warn" };
      return { label: "Didn't land", tone: "error" };
    case "conflict":
      return { label: "Conflict", tone: "warn" };
    case "waiting":
      return { label: "Waiting for you", tone: "warn" };
    case "machine":
      return { label: "Setup failed · nobody blamed", tone: "warn" };
    case "void":
      return { label: "Stopped · will rerun", tone: "neutral" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
  }
}

/** Which steps count as checks on the meter (setup, merge and landing don't). */
const isCheck = (s: RunStep) => s.kind === "check" || s.kind === "review";

/** What runs now, for the Checking now card: "Unit tests · check 4 of 9". */
export function runProgress(r: Pick<MergeRun, "steps">): { label: string; index: number; of: number; done: number } {
  const checks = r.steps.filter((s) => isCheck(s) && s.result !== "skipped");
  const done = checks.filter((s) => s.result === "passed" || s.result === "failed").length;
  const cur = r.steps.find((s) => s.result === "running") ?? checks.find((s) => s.result === "pending");
  return { label: cur?.label ?? "Landing", index: Math.min(done + 1, Math.max(checks.length, 1)), of: checks.length, done };
}

/** "Waiting · 3 · the last one done in ~42 min". */
export function waitingHead(entries: Pick<MergeEntry, "eta">[]): string {
  if (entries.length === 0) return "Waiting · 0";
  const last = entries[entries.length - 1]!;
  const end = last.eta ? last.eta.startsInMs + last.eta.takesMs : 0;
  return `Waiting · ${entries.length}${end ? ` · the last one done in ~${mins(end)}` : ""}`;
}

/** The pushed cell: "Pushed", or why not. "No remote" only for a project that has no origin: one with an
    origin the queue hasn't pushed to yet is read against what origin has (the view fills `pushed` from it). */
export function pushedWords(h: MergeQueueView["heads"]): { label: string; tone: Tone; why?: string } {
  if (h.pushWhy) return { label: "Not pushed", tone: "warn", why: h.pushWhy };
  if (h.hasOrigin === false) return { label: "No remote", tone: "neutral" };
  // An older server sends no hasOrigin: its unset `pushed` still means no remote.
  if (!h.pushed) return h.hasOrigin ? { label: "Not pushed", tone: "warn", why: "not pushed yet: goes out with the next landing" } : { label: "No remote", tone: "neutral" };
  if (h.pushed === h.target) return { label: "Pushed", tone: "success" };
  // The target is ahead of origin (Save Checks' commit, say) and the queue gave no reason: never invisible.
  return { label: "Not pushed", tone: "warn", why: "not pushed yet: goes out with the next landing" };
}

/** The paused banner's title. */
export function pausedTitle(v: Pick<MergeQueueView, "paused">): string {
  const p = v.paused;
  if (!p) return "Paused.";
  switch (p.kind) {
    case "operator":
      return "Paused by you.";
    case "master-moved":
      return "Paused: the target moved outside the queue.";
    case "machine":
      return "Paused: setup failed on the target itself, twice.";
    case "main-checkout-dirty":
      return "Paused: the project folder has uncommitted edits.";
    case "reviewer":
      return "Paused: the reviewer failed twice.";
    case "recovery":
      return "Paused: a landing in flight at a stop needs a look.";
    case "definition-invalid":
      return "Paused: the project's .sova/project.json is invalid.";
  }
}

/** The onboarding's "List its checks": one per line, "Name: command". Lines that aren't are named back. */
export function parseCheckList(text: string): { checks: { label: string; command: string }[]; bad: number[] } {
  const checks: { label: string; command: string }[] = [];
  const bad: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const at = line.indexOf(":");
    const label = at > 0 ? line.slice(0, at).trim() : "";
    const command = at > 0 ? line.slice(at + 1).trim() : "";
    if (label && command) checks.push({ label, command });
    else bad.push(i + 1);
  });
  return { checks, bad };
}

/** "Whose failure is it?": the evidence a red run gathered, in the order it was checked. */
export function attribution(r: Pick<MergeRun, "steps" | "verdict" | "blame">): { question: string; answer: string; result: "ok" | "failed" | "skipped" | "running" }[] | null {
  if (r.verdict !== "failed" && r.verdict !== "machine") return null;
  const of = (kind: RunStep["kind"]) => r.steps.filter((s) => s.kind === kind);
  const res = (steps: RunStep[]): "ok" | "failed" | "skipped" | "running" =>
    steps.length === 0 ? "skipped" : steps.some((s) => s.result === "running" || s.result === "pending") ? "running" : steps.some((s) => s.result === "failed") ? "failed" : "ok";
  const master = of("rerun-master");
  const tip = of("rerun-tip");
  const machine = r.verdict === "machine" || r.blame === "machine";
  return [
    { question: "Machine or setup?", answer: machine ? "Yes: it fails on the target too" : "No: it ran normally", result: machine ? "failed" : "ok" },
    {
      question: "Already failing on the target?",
      answer: master.length === 0 ? "Not reached" : res(master) === "failed" ? "Yes: it fails there too" : res(master) === "running" ? "Checking…" : "No: it passes on the target",
      result: res(master) === "failed" ? "failed" : res(master),
    },
    {
      question: "Flaky?",
      answer: tip.length === 0 ? "Not reached" : res(tip) === "ok" ? "Yes: it passed on a rerun" : res(tip) === "running" ? "Checking…" : "No: it fails again",
      result: tip.length === 0 ? "skipped" : res(tip) === "ok" ? "ok" : res(tip) === "running" ? "running" : "failed",
    },
  ];
}

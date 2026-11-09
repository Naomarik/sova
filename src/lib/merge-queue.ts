// The merge queue as words: one vocabulary for the composer's worktrees control, its modal, the
// session pane's Worktrees rows and the project's Merge Queue tab, so the four always agree. Pure: no
// Solid, no DOM. The shapes are the queue's (shared/merge-queue.ts); the verb calls live in
// merge-queue-client.ts.
import type { SessionSummary, SessionWorktreeInfo, WorktreeReadiness } from "../../shared/protocol";
import { newerWords, ordinal, type BranchPlace, type LandHow, type MergeReady } from "../../shared/merge-queue";
import { clockTime, relativeTime } from "../../pi-config/extensions/stamp/format.ts";
import { readinessChip } from "./worktrees";
import type { MergeEntry, MergeNote, MergeProjectInfo, MergeQueueView, MergeRun, RunStep, WorktreeQueueInfo } from "./merge-queue-types";
import { requestChip, requestReason } from "./merge-queue-requests";
import { DECISION_LABEL, STANDING_LINE, answeredInChat, decisionActions, openDecision, standingWords, type CardDecision, type StandingFacts } from "./merge-standing";

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
export type RowAction = "land" | "setup" | "accept" | "land-anyway" | "none";

export type RowKey =
  | "uncommitted"
  | "no-commits"
  | "ready"
  | "ready-to-merge"
  | "waiting-ok"
  | "landing-specs"
  | "conflicting"
  | "in-progress"
  | "blocked"
  | "stale"
  | "no-reading"
  | "drafts-to-land"
  | "queued"
  | "checking"
  | "conflict"
  | "behaviour-differs"
  | "review-flagged"
  | "unattributed"
  | "needs-fix"
  | "with-chat"
  | "needs-you"
  | "drafts-changed"
  | "landed"
  | "request-review"
  | "requested"
  | "pushed"
  | "closed"
  | "merged"
  | "cleaned-up"
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
  /** When the branch last changed (its head's committer date), drawn after the size: "2d ago". */
  when?: HeadWhen;
  /** Notes on it (the merge thread's first), each with what kind it is. */
  notes: { label: string; text: string }[];
  action: RowAction;
  /** Try Again beside the action (can't tell whose failure: the check is run afresh; it uses no try). */
  tryAgain?: boolean;
  /** Answer in Chat: a decision answered in words, in the chat's message box (§chat.merge-queue/decision). */
  answerInChat?: boolean;
  /** Remove from Queue beside the action, on every stage of an approval that stands: the entry leaves the queue;
   *  nothing is deleted. */
  remove?: boolean;
  /** The decision that waits for the user, when one does (its question and choices). */
  decision?: CardDecision;
  /** With its chat: chat's answer to the queue's newest request ("Fixed: commit a1b2c3d"). */
  answer?: string;
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

/** A branch's queue entry as a row reads it: its state and pinned commit, the rest when the caller has it (the session
    list carries only what the row's words need, shared/protocol.ts SessionBranchQueue). */
export type RowQueueFacts = Pick<WorktreeQueueInfo, "state" | "commit"> & Partial<Omit<WorktreeQueueInfo, "state" | "commit">>;

export type QueueRowInput = Pick<SessionWorktreeInfo, "status" | "exists" | "readiness" | "branch"> &
  // mergeServed: the repo is one the merge queue serves (listed, merge setup done): only then does a row offer Land.
  Partial<Pick<SessionWorktreeInfo, "merge" | "mergedInto" | "gone" | "mergeStats" | "mergeServed">> &
  Partial<Pick<WorktreeReadiness, "left" | "draftsLeft">> & {
    queue?: RowQueueFacts;
    mergeProject?: Pick<MergeProjectInfo, "target" | "checks"> & Partial<MergeProjectInfo>;
    place?: Partial<BranchPlace>;
  };

/** A finished branch's line where the queue doesn't serve the repo: the chat merges it plainly, into the repository's
    real target; with none known it names none. */
export const plainMergeLine = (target: string | undefined): string => `Say “land it” in the chat to merge it${target ? ` into ${target}` : ""}.`;

/** "3 commits · +40 −2": the branch's side against the target's head. */
export const sizeWords = (s: { ahead: number; added: number; removed: number } | undefined): string | undefined =>
  s ? `${s.ahead} ${s.ahead === 1 ? "commit" : "commits"} · +${s.added} −${s.removed}` : undefined;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a branch last changed, as a row draws it in a <time>: `iso` its datetime, `text` relative ("2h ago",
    "yesterday", "3d ago", "Nov 2" past a week: Sova's relativeTime), `full` the date and time for hover and screen
    readers ("Nov 2, 2026, 1:43 PM"). Undefined when there's no date or it doesn't parse. */
export interface HeadWhen {
  iso: string;
  text: string;
  full: string;
}
export function headWhen(headAt: string | undefined, now = Date.now()): HeadWhen | undefined {
  const ms = headAt ? Date.parse(headAt) : NaN;
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return { iso: headAt!, text: relativeTime(ms, now), full: `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${clockTime(ms)}` };
}

/** A Ready to land, not approved row's facts: "da69caa · 3 commits ahead · +1497 −309", then its date apart. */
export const readyFactsWords = (r: Pick<MergeReady, "ahead" | "added" | "removed"> & Partial<Pick<MergeReady, "draftsOnly">>): string =>
  r.draftsOnly ? specDraftsWords(r.draftsOnly) : `${r.ahead} ${r.ahead === 1 ? "commit" : "commits"} ahead${r.added !== undefined && r.removed !== undefined ? ` · +${r.added} −${r.removed}` : ""}`;

/** The chip on a Ready to land, not approved row: its chat's own readiness reading of the branch, in the words and
    colour a Worktrees row's readiness chip uses (worktrees.ts readinessChip: Ready to land, In progress, Waiting for
    your OK…), with a conflict said as such ("Conflicts with master"). No chat: a neutral "No chat". A chat whose
    reading Sova doesn't have (it doesn't track the worktree, or isn't on the page's list): a neutral "No reading". */
export interface ReadyChip {
  label: string;
  tone: Tone;
  title: string;
}
export function readyRowChip(r: Pick<MergeReady, "session" | "sessionArchived" | "worktree" | "branch"> & Partial<Pick<MergeReady, "draftsOnly">>, trees: readonly WorktreeReadiness[] | undefined): ReadyChip {
  if (r.draftsOnly) return { label: "Drafts to land", tone: "info", title: `${draftsLeftWords(r.draftsOnly)}. Land lands just the drafts.` };
  if (!r.session) return { label: "No chat", tone: "neutral", title: "No chat works on this branch: nothing reads it as finished or not." };
  const t = trees?.find((x) => x.path === r.worktree) ?? trees?.find((x) => x.branch === r.branch);
  const noReading = { label: "No reading", tone: "neutral" as const, title: `Sova has no reading of this branch from its chat${r.sessionArchived ? " (archived)" : ""}.` };
  if (!t) return noReading;
  const conflict = t.reason && /^Conflicts with /.test(t.reason) ? t.reason.split(" · ")[0]! : null;
  if (conflict) return { label: conflict, tone: "warn", title: `${t.reason}.` };
  const chip = readinessChip({ readiness: t });
  // Its chat's reading lags: the row is listed, so something is left (§chat.worktrees/nothing-left), whatever it says.
  if (!chip) return noReading;
  return { label: chip.label, tone: chip.tone, title: chip.title };
}

/** The readiness readings a chat recorded by id holds (a worker's, then its top chat's), among `sessions`. */
export function chatTreesOf(id: string | undefined, sessions: readonly Pick<SessionSummary, "id" | "path" | "readiness" | "workerSession" | "workerOf">[] | undefined): WorktreeReadiness[] | undefined {
  if (!id) return undefined;
  const all = sessions ?? [];
  const s = all.find((x) => x.id === id || x.path === id);
  if (!s) return undefined;
  const top = s.workerSession && s.workerOf ? all.find((x) => x.path === s.workerOf!.path || x.id === s.workerOf!.id) : undefined;
  return [...(s.readiness?.trees ?? []), ...(top?.readiness?.trees ?? [])];
}

/** The commit a Land pins: the head the row's numbers were read at, else the one readiness found finished. */
export const shownCommit = (w: Partial<Pick<SessionWorktreeInfo, "readiness" | "mergeStats">>): string | undefined =>
  w.mergeStats?.head ?? w.readiness?.landing?.commit;

/** A sent-back row's line when the queue gave no reason: the user's Land stands while its chat fixes it. */
export const SENT_BACK_LINE = STANDING_LINE;

/** The branch reads finished again at a commit other than the one sent back: the fix is in. */
export const fixedPast = (w: { readiness?: { landing?: { commit: string } } }, sentBack: string): boolean => {
  const c = w.readiness?.landing?.commit;
  return !!c && c !== sentBack;
};

/** Why a Land item that knows only the branch's queue entry (no readiness: the Overseer's coding-worktree menu) is
 *  off, or undefined when it's on. Sent back: off, as on every row (al_4), until the queue says its drafts are fixed
 *  (`redrafted`: sent back for its drafts, changed since, and Sova's docs check reads clean), then on at the same
 *  commit; with no readiness it can't see a fixed, finished commit, so Land comes back on the rows that can. In line:
 *  off. Drafts changed: on (Land re-approves). */
export function entryLandBlock(e: Pick<WorktreeQueueInfo, "state" | "redrafted" | "settled"> | undefined): string | undefined {
  if (!e) return undefined;
  if (e.state === "needs-fix") return e.redrafted || e.settled ? undefined : SENT_BACK_LINE;
  if (e.state === "with-chat") return SENT_BACK_LINE;
  if ((["queued", "checking", "conflict", "behaviour-differs", "review-flagged"] as string[]).includes(e.state)) return "Already in the merge queue.";
  return undefined;
}

/** The tab's Sent back list: only entries that still need a fix. One the queue marks settled (a later entry for its
 *  branch, already in the target, its branch or folder removed) leaves it, and so does one whose branch already reads
 *  ready at a newer commit, or at the same commit once its drafts are fixed (`redrafted`): the Ready to land row, with
 *  Land, stands for it. Capped at 20, after leaving. */
export const stillSentBack = (v: Pick<MergeQueueView, "needsFix" | "ready">): MergeEntry[] =>
  v.needsFix.filter((e) => !e.settled && !e.redrafted && !(v.ready ?? []).some((r) => r.branch === e.branch && r.commit !== e.commit)).slice(0, 20);

/** The tab's Needs you: the view's own list, then any entry whose decision waits for the user that a with-its-chat
 *  list still holds (a server that lists it there), once each. */
export function needsYouOf(v: Pick<MergeQueueView, "needsYou" | "needsFix"> & { withChat?: MergeEntry[] }): MergeEntry[] {
  const seen = new Set<string>();
  return [...v.needsYou, ...(v.withChat ?? []), ...v.needsFix].filter((e) => {
    if (seen.has(e.id)) return false;
    const mine = v.needsYou.includes(e) || (!!openDecision(e) && !e.settled);
    if (mine) seen.add(e.id);
    return mine;
  });
}

/** The tab's With its chat: entries whose standing approval stands while their chat fixes something (state
 *  with-chat, wherever the view lists it), and those still sent back from before (stillSentBack); never one a decision
 *  holds (it is in Needs you). */
export function withItsChat(v: Pick<MergeQueueView, "needsYou" | "needsFix" | "ready" | "waiting"> & { withChat?: MergeEntry[] }): MergeEntry[] {
  const seen = new Set<string>();
  const listed = [...(v.withChat ?? []), ...v.waiting.filter((e) => e.state === "with-chat"), ...v.needsYou.filter((e) => e.state === "with-chat"), ...stillSentBack(v)];
  return listed.filter((e) => !openDecision(e) && !seen.has(e.id) && (seen.add(e.id), true));
}

/** The worktree is merged or removed: that wins over Needs a fix (nothing is left to fix). */
const pastSentBack = (w: RowKeyInput): boolean => w.status === "merged" || !!w.mergedInto || !w.exists || !!w.gone || w.readiness?.state === "merged";

/** Rows past the queue (landed, merged, gone) carry no size: there's nothing left to land. */
const SIZED: RowKey[] = ["ready", "ready-to-merge", "waiting-ok", "landing-specs", "conflicting", "in-progress", "blocked", "no-reading", "uncommitted", "queued", "checking", "conflict", "behaviour-differs", "review-flagged", "unattributed", "needs-fix", "with-chat", "needs-you", "drafts-changed", "request-review"];

/** What a row's key reads: the fields of QueueRowInput the ladder below looks at, and nothing else. */
export type RowKeyInput = Pick<QueueRowInput, "status" | "exists"> &
  Partial<Pick<QueueRowInput, "mergedInto" | "gone" | "left">> & {
    readiness?: Pick<NonNullable<QueueRowInput["readiness"]>, "state" | "dirtyCount" | "noCommits" | "landing"> & Partial<Pick<NonNullable<QueueRowInput["readiness"]>, "merged" | "reason" | "conflicts" | "left">>;
    queue?: Pick<RowQueueFacts, "state" | "commit" | "request" | "settled" | "redrafted" | "newerCommits"> & Partial<Pick<StandingFacts, "decision">>;
  };

/** A decision's row key: the kinds the tab already names keep their key; the rest read "Needs you". */
const decisionKey = (d: CardDecision): RowKey =>
  d.kind === "behaviour-differs" ? "behaviour-differs" : d.kind === "unattributed" ? "unattributed" : d.kind === "drafts-changed" ? "drafts-changed" : "needs-you";

/** The key its queue entry gives a row, or null when the entry doesn't speak for it (none, cancelled, a sent-back
    branch whose fix reads finished at a newer commit, whose drafts the queue says are fixed at the same commit, is
    settled, or whose tree is merged or removed; a state this build doesn't know): the tree's own key then. */
export function entryKeyOf(w: RowKeyInput): RowKey | null {
  const e = w.queue;
  if (!e) return null;
  // A decision waiting for the user speaks for the row, whatever state holds it (unless it settled or moved on).
  const d = e.state !== "landed" && e.state !== "cancelled" && !e.settled ? openDecision(e) : null;
  if (d && !pastSentBack(w)) return decisionKey(d);
  switch (e.state) {
    case "with-chat":
      return pastSentBack(w) ? null : "with-chat";
    case "needs-user":
      return pastSentBack(w) ? null : "needs-you";
    case "queued":
    case "checking":
    case "conflict":
    case "behaviour-differs":
    case "unattributed":
    case "review-flagged":
    case "drafts-changed":
    case "request-review":
    case "pushed":
    case "closed":
      return e.state;
    case "landed":
      // Landed only while nothing is left, however old the landing: the server's reading says so. With no reading (an
      // entry alone) it stays Landed and queueRow says what it left out. Folder gone: what its work came to.
      if (!w.exists || w.gone) return "cleaned-up";
      return w.readiness && hasWorkLeft(w) ? null : "landed";
    case "needs-fix":
      // Sent back: once the branch reads finished again at a newer commit, that commit wins (Ready with Land); sent
      // back for its drafts and the queue says they're fixed (`redrafted`), the same commit reads Ready again.
      // Settled by the queue, or the worktree merged or removed: nothing is left to fix (the tree's own key).
      return e.settled || e.redrafted || fixedPast(w, e.commit) || pastSentBack(w) ? null : "needs-fix";
    case "requested":
      // The host merged it while the queue hasn't moved the entry yet: it reads as landed.
      return e.request?.facts?.state === "merged" ? "landed" : "requested";
    default:
      return null;
  }
}

/** The server's answer to "anything left to land?" (§chat.worktrees/nothing-left), on the row or its reading. */
const leftOf = (w: Pick<RowKeyInput, "left" | "readiness">) => w.readiness?.left ?? w.left;
/** Something of its own is left, by the server's reading. Only drafts left still counts. */
const hasWorkLeft = (w: RowKeyInput): boolean => {
  const left = leftOf(w);
  if (left) return left === "drafts";
  return !w.readiness?.merged && w.readiness?.state !== "merged";
};

/** The key a row reads with no entry speaking for it: from its tracked state, its folder and the server's reading. Never
    Ready by default: Ready is a reading of the branch, and a row with no reading says that. */
export function treeKeyOf(w: RowKeyInput): RowKey {
  const left = leftOf(w);
  const folderThere = w.exists && !w.gone;
  if (folderThere && w.status !== "dropped" && left === "drafts" && !w.readiness?.dirtyCount) return "drafts-to-land";
  if (w.status === "merged" || w.mergedInto) return "merged";
  if (w.status === "dropped") return "dropped";
  const r = w.readiness;
  if (!folderThere) return w.gone === "merged" || r?.merged || r?.state === "merged" ? "cleaned-up" : "removed";
  if (r?.state === "merged") return "merged";
  if (r?.dirtyCount) return "uncommitted";
  if (r?.noCommits) return "no-commits";
  // Stale is its own reading (merged, with uncommitted changes the row hasn't counted): it stays, with no Land.
  if (left === "nothing" && r?.state !== "stale") return "merged";
  if (!r) return "no-reading";
  if (r.landing?.state === "specs") return "landing-specs";
  if (r.landing?.state === "ready") return "ready";
  if (r.conflicts || conflictWords(r.reason)) return "conflicting";
  switch (r.state) {
    case "ready":
      return "ready-to-merge";
    case "waiting-approval":
      return "waiting-ok";
    case "blocked":
      return "blocked";
    case "stale":
      return "stale";
    case "removed":
      return "removed";
    default:
      return "in-progress";
  }
}

/** "Conflicts with master" from a reading's reason ("Conflicts with master · 17 files"), or null. */
const conflictWords = (reason: string | undefined): string | null => (reason && /^Conflicts with /.test(reason) ? reason.split(" · ")[0]! : null);

/** A row's key: the one rule the chat's rows, its composer control and the session list's status read. */
export const rowKeyOf = (w: RowKeyInput): RowKey => entryKeyOf(w) ?? treeKeyOf(w);

/** The words for one worktree, from its tracked state, its readiness and its queue entry. */
export function queueRow(w: QueueRowInput): QueueRow {
  const r = queueRowOf(w);
  if (!SIZED.includes(r.key)) return r;
  const size = sizeWords(w.mergeStats);
  const when = headWhen(w.mergeStats?.headAt);
  return { ...r, ...(size ? { size } : {}), ...(when ? { when } : {}) };
}
function queueRowOf(w: QueueRowInput): QueueRow {
  const e = w.queue;
  const r = w.readiness;
  const base = { notes: notesOf(e?.notes), newer: newerWords(e?.newerCommits) ?? undefined, run: e?.run };
  const key = e ? entryKeyOf(w) : null;
  // Landed, and its folder is gone since: what its work came to, with nothing left to do here.
  if (key === "cleaned-up") return { ...base, newer: undefined, run: undefined, notes: [], key, label: "Landed · cleaned up", tone: "success", action: "none" };
  if (e && key) {
    const auto = e as RowQueueFacts & Partial<StandingFacts>;
    // A decision: its question, its answers on the queue, Answer in Chat when it is answered in words, and Remove.
    const dec = key !== "landed" ? openDecision(auto) : null;
    if (dec) {
      const acts = decisionActions(dec);
      const one = acts.find((a) => a === "accept" || a === "land-anyway" || a === "land");
      return {
        ...base,
        newer: undefined,
        key,
        label: DECISION_LABEL[dec.kind] ?? "Needs you",
        tone: "warn",
        reason: `${dec.question}${dec.cantSettle ? " · can't be settled without you" : ""}`,
        action: (one ?? "none") as RowAction,
        ...(acts.includes("try-again") ? { tryAgain: true } : {}),
        ...(answeredInChat(dec) ? { answerInChat: true } : {}),
        remove: true,
        decision: dec,
      };
    }
    // With its chat: the user's Land stands; the row says where, and offers only Remove from Queue.
    if (key === "with-chat") {
      const st = standingWords(auto) ?? { label: "Back with the chat", tone: "info" as const };
      return { ...base, newer: undefined, key, label: st.label, tone: st.tone, detail: st.detail, reason: e.reason ? `${sentence(e.reason)} ${STANDING_LINE}` : STANDING_LINE, action: "none", remove: true, ...(st.answer ? { answer: st.answer } : {}) };
    }
    if (key === "needs-you") return { ...base, newer: undefined, key, label: "Needs you", tone: "warn", reason: e.reason, action: "none", answerInChat: true, remove: true };
    switch (e.state) {
      case "queued":
        return {
          ...base,
          key: "queued",
          label: e.position ? `Queued · ${ordinal(e.position)}` : "Queued",
          tone: "info",
          detail: e.eta ? `starts in ~${mins(e.eta.startsInMs)} · takes ~${mins(e.eta.takesMs)}` : short(e.commit),
          // Remove from Queue, the one name at every stage (merge.cancel takes it off the line).
          action: "none",
          remove: true,
        };
      case "checking":
        return { ...base, key: "checking", label: "Checking", tone: "accent", live: true, detail: e.eta ? `~${mins(e.eta.takesMs)} in all` : short(e.commit), reason: e.reason, action: "none", remove: true };
      case "conflict":
        return { ...base, key: "conflict", label: "Conflict", tone: "warn", reason: e.reason ?? "The merge thread is judging a conflict with the target. The line moves on meanwhile.", action: "none", remove: true };
      case "behaviour-differs": {
        const c = e.conflict;
        return {
          ...base,
          key: "behaviour-differs",
          label: "Behaviour differs",
          tone: "warn",
          reason: c ? `Target: ${c.ours}\nBranch: ${c.theirs}\nProposed: ${c.proposal}` : (e.reason ?? "This branch and the target want different behaviour."),
          // Accept only a resolution the merge thread proposed; otherwise it is answered in the chat.
          action: c?.proposal ? "accept" : "none",
          answerInChat: true,
          remove: true,
        };
      }
      case "unattributed":
        // A check failed on the merge and on the target alone, naming no tests: nobody is blamed; you decide.
        return { ...base, key: "unattributed", label: "Can't tell whose failure", tone: "warn", reason: unattributedWhy(e.reason), action: "land-anyway", tryAgain: true, remove: true };
      case "review-flagged":
        // Review findings go back to the chat by themselves: nothing to press but Remove from Queue.
        return { ...base, key: "review-flagged", label: "Review flagged", tone: "warn", reason: e.review?.text ?? e.reason ?? "The review found something that blocks it.", action: "none", remove: true };
      case "drafts-changed":
        return { ...base, key: "drafts-changed", label: "Drafts changed", tone: "warn", reason: e.reason ?? "Its spec drafts changed since you approved. Land again to approve them.", action: "land", remove: true };
      case "needs-fix":
        // Sent back and no longer in line (Can't escalated, or from before standing approvals): no re-land and no
        // Land while its chat fixes it; Remove from Queue. Once the branch reads finished again at a newer commit, or
        // its drafts are fixed, entryKeyOf gives no key and the row reads as the worktree itself, Ready with Land.
        return { ...base, newer: undefined, key: "needs-fix", label: "Needs a fix", tone: "error", reason: e.reason ?? SENT_BACK_LINE, action: "none", remove: true };
      case "landed":
        return {
          ...base,
          key: "landed",
          label: "Landed",
          tone: "success",
          detail: e.landed ? `as ${short(e.landed.sha)}${e.landed.pushed === "not-pushed" ? " · not pushed" : ""}` : undefined,
          // No reading of the branch here: real commits past the landing are all that's known, so they keep Land.
          ...(!r && base.newer ? { action: w.mergeServed ? ("land" as const) : ("none" as const) } : { newer: undefined, action: "none" as const }),
        };
      case "request-review":
      case "requested":
      case "pushed":
      case "closed": {
        // Past Sova's checks on a request or push project: the host's words (merge-queue-requests.ts).
        const chip = requestChip(e.state, e.request, e.reason);
        // The host merged it while the queue hasn't moved the entry yet: it reads as landed (entryKeyOf).
        return {
          ...base,
          newer: e.state === "requested" || e.state === "pushed" ? base.newer : undefined,
          key,
          label: chip.label,
          tone: chip.tone,
          ...(chip.live ? { live: true } : {}),
          reason: requestReason(e.state, e.request, w.mergeProject?.target ?? "the target", e.reason) ?? undefined,
          // Land Again on a closed request only where the queue still serves the repo (as every other Land).
          action: e.state === "closed" && w.mergeServed ? "land" : "none",
        };
      }
      default:
        break; // cancelled (entryKeyOf): reads as the worktree itself again, below
    }
  }
  // Real work past a landing keeps the line saying what the landing left out.
  const quiet = { notes: [] as QueueRow["notes"], ...(e?.state === "landed" && base.newer ? { newer: base.newer } : {}) };
  const merged = w.merge ?? w.mergedInto;
  switch (treeKeyOf(w)) {
    case "merged":
      // Its tracked merge or git's says where it went; readiness alone only that it did.
      return { ...quiet, key: "merged", label: "Merged", tone: "success", detail: (w.status === "merged" || w.mergedInto) && merged ? `into ${merged.target} at ${short(merged.sha)}` : undefined, action: "none" };
    case "cleaned-up":
      return { ...quiet, key: "cleaned-up", label: "Landed · cleaned up", tone: "success", action: "none" };
    case "dropped":
      return { ...quiet, key: "dropped", label: "Dropped", tone: "neutral", action: "none" };
    case "removed":
      return { ...quiet, key: "removed", label: "Removed", tone: "neutral", action: "none" };
    case "uncommitted":
      return { ...quiet, key: "uncommitted", label: "Uncommitted", tone: "neutral", detail: `${r!.dirtyCount} ${r!.dirtyCount === 1 ? "file" : "files"} not committed`, reason: w.mergeServed ? "Commit it in its chat, then Land." : "Commit it in its chat.", action: "none" };
    case "no-commits":
      return { ...quiet, key: "no-commits", label: "No commits yet", tone: "neutral", action: "none" };
    case "stale":
      return { ...quiet, key: "stale", label: "Stale", tone: "warn", reason: r?.reason, action: "none" };
    default:
      break; // has work to land, below
  }
  const tree = treeKeyOf(w);
  // A row that isn't ready says its true state. It keeps Land where the queue serves the repo: the work is real, and
  // the queue is what checks it.
  const truth = trueState(tree, r, w.mergeProject?.target, w.draftsLeft ?? r?.draftsLeft);
  // A repo the queue doesn't serve merges plainly from its chat: no Land, never the queue's words. A listed
  // project with no merge setup keeps Set Up Queue; a repo off the Projects list offers nothing.
  if (!w.mergeServed) {
    if (tree !== "ready" && tree !== "ready-to-merge" && tree !== "waiting-ok" && tree !== "landing-specs") return { ...quiet, ...truth, action: "none" };
    const unset = w.mergeProject?.checks === "unset" && !w.mergeProject.invalid;
    return {
      ...quiet,
      key: "ready",
      label: "Ready to merge",
      tone: "success",
      detail: r?.landing?.commit ? short(r.landing.commit) : undefined,
      reason: plainMergeLine(w.place?.target ?? w.mergeProject?.target),
      action: unset ? "setup" : "none",
    };
  }
  // The project's .sova/project.json doesn't parse: Land stays (a branch that fixes it is taken, the queue refuses
  // the others with its reason), never Set Up; the line says why the rest wait.
  const invalid = w.mergeProject?.invalid;
  if (invalid)
    return { ...quiet, ...truth, reason: invalidWords(invalid), action: "land" };
  const unset = w.mergeProject?.checks === "unset";
  return {
    ...quiet,
    ...truth,
    reason: unset ? "This project's merge queue isn't set up yet." : truth.reason,
    action: unset ? "setup" : "land",
  };
}

/** A row with only drafts left: "Code landed · 2 spec drafts not landed". */
export const draftsLeftWords = (n: number | undefined): string => `Code landed · ${specDraftsWords(n)} not landed`;
/** "1 spec draft", "2 spec drafts"; "Spec drafts" with no count. */
export const specDraftsWords = (n: number | undefined): string => (n === undefined ? "spec drafts" : `${n} spec ${n === 1 ? "draft" : "drafts"}`);

/** The chip and line of a row with work to land, in a repo the queue serves: Ready only when truly Ready to land. */
function trueState(key: RowKey, r: QueueRowInput["readiness"], target: string | undefined, drafts: number | undefined): Pick<QueueRow, "key" | "label" | "tone" | "detail" | "reason"> {
  const reason = r?.reason;
  const landing = r?.landing;
  switch (key) {
    case "ready":
      return { key, label: "Ready", tone: "success", detail: landing?.commit ? short(landing.commit) : undefined };
    case "drafts-to-land":
      return { key, label: "Drafts to land", tone: "info", reason: draftsLeftWords(drafts) };
    case "landing-specs":
      return { key, label: "Landing specs", tone: landing?.specsWhy ? "warn" : "info", reason };
    case "ready-to-merge":
      return { key, label: "Ready to merge", tone: "success", reason };
    case "waiting-ok":
      return { key, label: "Waiting for your OK", tone: "success", reason };
    case "conflicting":
      return { key, label: conflictWords(reason) ?? `Conflicts with ${target ?? "the target"}`, tone: "warn", reason };
    case "blocked":
      return { key, label: "Blocked", tone: "warn", reason };
    case "in-progress":
      return { key, label: "In progress", tone: "neutral", reason };
    default:
      return { key: "no-reading", label: "No reading", tone: "neutral" };
  }
}

/** A row's buttons, as the Worktrees modal and the session pane draw them, in order. Set Up Queue needs the
    project to link to. No row has Send Back or a re-land: the user's Land stands while its chat fixes it (al_3). */
export type RowButton = "Land" | "Set Up Queue" | "Accept" | "Land Anyway" | "Try Again" | "Answer in Chat" | "Remove from Queue";
export function rowButtons(row: Pick<QueueRow, "action" | "remove"> & Partial<Pick<QueueRow, "tryAgain" | "answerInChat">>, projectId: string | undefined): RowButton[] {
  const one: Partial<Record<RowAction, RowButton>> = { land: "Land", accept: "Accept", "land-anyway": "Land Anyway" };
  const out: RowButton[] = [];
  if (row.action === "setup") {
    if (projectId) out.push("Set Up Queue");
  } else if (one[row.action]) out.push(one[row.action]!);
  if (row.tryAgain) out.push("Try Again");
  if (row.answerInChat) out.push("Answer in Chat");
  if (row.remove) out.push("Remove from Queue");
  return out;
}

/** The Worktrees modal's head: the queue's intro and one paused line per paused project, only where some row's repo is
    one the queue serves; elsewhere branches merge plainly from their chats and the queue isn't mentioned. */
export function modalHead(rows: Pick<QueueRowInput, "mergeServed" | "mergeProject" | "place">[]): { intro: string | null; paused: string[] } {
  const served = rows.filter((w) => w.mergeServed);
  if (!served.length) return { intro: null, paused: [] };
  const seen = new Set<string>();
  const paused: string[] = [];
  for (const w of served) {
    const p = w.mergeProject;
    if (!p?.paused) continue;
    const key = p.id ?? p.root ?? w.place?.label ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    const who = w.place?.label?.trim();
    paused.push(`${who ? `${who}'s queue` : "The queue"} is paused: ${p.paused}. Land still takes your approval; it's checked once the queue resumes.`);
  }
  return { intro: "Land queues a branch; it lands as the commit that was tested.", paused };
}

/** What Land's confirm says: the branch, how many commits go to the queue (the row's own count, else none named) and
    what moves once the checks pass, by the way of landing when the caller knows it (else the target moves). A chat's
    rows name the branch's place; the project's own Merge Queue tab has no need to, and passes none. */
export function landConfirmWords(branch: string, ahead: number | undefined, target: string | undefined, how?: LandHow, place?: string, drafts?: number): { title: string; line: string; confirm: string } {
  const n = typeof ahead === "number" && ahead > 0 ? ahead : undefined;
  const to = target ?? "the target branch";
  const go = drafts ? `${drafts} spec ${drafts === 1 ? "draft goes" : "drafts go"}` : n === undefined ? "Its commits go" : `${n} ${n === 1 ? "commit goes" : "commits go"}`;
  const after =
    how === "github-pr"
      ? "a pull request opens on GitHub once checks pass."
      : how === "gitlab-mr"
        ? "a merge request opens on GitLab once checks pass."
        : how === "push-branch"
          ? "the branch is pushed once checks pass."
          : `${to} moves once checks pass.`;
  return {
    title: `Land ${branch}?`,
    line: `${go} to ${place ? `${place}'s` : "the"} merge queue; ${after}`,
    confirm: drafts ? `Land ${drafts} ${drafts === 1 ? "Draft" : "Drafts"}` : n === undefined ? "Land Branch" : `Land ${n} ${n === 1 ? "Commit" : "Commits"}`,
  };
}

/** Can't tell whose failure: the queue's line (which check, that it fails on the target too), else that in general. */
export const unattributedWhy = (reason: string | undefined, target?: string): string =>
  sentence(reason) || `A check failed on the merge and on ${target ?? "the target"} alone, so nobody is blamed.`;

/** One unclear check's line: "Unit tests: fails with this branch and on master alone", or the queue's own why. */
export const unclearLine = (u: { label: string; why?: string }, target?: string): string =>
  u.why?.trim() ? `${u.label}: ${u.why.trim().replace(/[.]$/, "")}` : `${u.label}: fails with this branch and on ${target ?? "the target"} alone, naming no tests`;

/** The order the summary counts in. */
const ORDER: RowKey[] = ["ready", "ready-to-merge", "waiting-ok", "landing-specs", "drafts-to-land", "conflicting", "in-progress", "blocked", "stale", "no-reading", "queued", "checking", "conflict", "behaviour-differs", "needs-you", "review-flagged", "unattributed", "needs-fix", "with-chat", "drafts-changed", "request-review", "requested", "uncommitted", "no-commits", "landed", "pushed", "closed", "merged", "cleaned-up", "removed", "dropped"];
const COUNT_WORD: Record<RowKey, [string, string]> = {
  ready: ["ready", "ready"],
  "ready-to-merge": ["ready to merge", "ready to merge"],
  "waiting-ok": ["waiting for your OK", "waiting for your OK"],
  "landing-specs": ["landing specs", "landing specs"],
  "drafts-to-land": ["drafts to land", "drafts to land"],
  conflicting: ["conflicting", "conflicting"],
  "in-progress": ["in progress", "in progress"],
  blocked: ["blocked", "blocked"],
  stale: ["stale", "stale"],
  "no-reading": ["no reading", "no reading"],
  "cleaned-up": ["cleaned up", "cleaned up"],
  queued: ["queued", "queued"],
  checking: ["checking", "checking"],
  conflict: ["conflict", "conflicts"],
  "behaviour-differs": ["behaviour differs", "behaviour differs"],
  "review-flagged": ["review flagged", "reviews flagged"],
  unattributed: ["can't tell whose failure", "can't tell whose failure"],
  "needs-fix": ["needs a fix", "need a fix"],
  "with-chat": ["back with its chat", "back with their chats"],
  "needs-you": ["needs you", "need you"],
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

/** Which fact the headline states, the first that holds: needs you, needs a fix, ready, checking, queued, else how
    many worktrees. */
export type HeadlineKind = "you" | "fix" | "ready" | "checking" | "queued" | "worktrees";

/** The headline's words per fact, the one table the composer control, the session list's row status and the words
    extensions may not take on a row (src/lib/row-place.ts) all read. */
export const HEADLINE_WORDS: Record<HeadlineKind, (n: number) => string> = {
  you: (n) => `${n} ${n === 1 ? "needs" : "need"} you`,
  fix: (n) => `${n} ${n === 1 ? "needs" : "need"} a fix`,
  ready: (n) => `${n} ready`,
  // Said as one, as the control always has.
  checking: () => "1 checking",
  queued: (n) => `${n} queued`,
  worktrees: (n) => `${n} ${n === 1 ? "worktree" : "worktrees"}`,
};

const HEADLINE_DOT: Record<HeadlineKind, "ok" | "warn" | "err" | null> = { you: "warn", fix: "err", ready: "ok", checking: null, queued: null, worktrees: null };

/** The rows' keys that need you (the headline's first fact). */
export const NEEDS_YOU_KEYS: readonly RowKey[] = ["behaviour-differs", "needs-you", "unattributed", "drafts-changed", "request-review"];
/** The rows its chat fixes (the headline's "needs a fix"): back with the chat, waiting for a fix or the merge thread,
    paused by Stop, review findings it was sent; nothing for the user to press. */
export const FIX_KEYS: readonly RowKey[] = ["needs-fix", "with-chat", "review-flagged"];

/** The one most useful fact about a set of rows: which, its words, its number and its dot. Null with no rows. */
export function headline(rows: Pick<QueueRow, "key">[]): { kind: HeadlineKind; text: string; n: number; dot: "ok" | "warn" | "err" | null } | null {
  const kind = headlineKind(rows);
  if (!kind) return null;
  const count = (...k: readonly RowKey[]) => rows.filter((r) => k.includes(r.key)).length;
  const n = kind === "you" ? count(...NEEDS_YOU_KEYS) : kind === "fix" ? count(...FIX_KEYS) : kind === "ready" ? count("ready") : kind === "checking" ? 1 : kind === "queued" ? count("queued") : rows.length;
  const text = HEADLINE_WORDS[kind](n);
  return { kind, text, n: Number(/^\d+/.exec(text)?.[0] ?? rows.length), dot: HEADLINE_DOT[kind] };
}
function headlineKind(rows: Pick<QueueRow, "key">[]): HeadlineKind | null {
  if (rows.length === 0) return null;
  const has = (...k: readonly RowKey[]) => rows.some((r) => k.includes(r.key));
  if (has(...NEEDS_YOU_KEYS)) return "you";
  if (has(...FIX_KEYS)) return "fix";
  if (has("ready")) return "ready";
  if (has("checking")) return "checking";
  if (has("queued")) return "queued";
  return "worktrees";
}

/** The composer control's words and dot: the one most useful fact. Null with no worktrees (it hides). */
export function controlWords(rows: Pick<QueueRow, "key">[]): { text: string; n: number; dot: "ok" | "warn" | "err" | null } | null {
  const h = headline(rows);
  return h && { text: h.text, n: h.n, dot: h.dot };
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

// ---- the run page's Checks and why ------------------------------------------------------------

/** A step's status mark: a check, a cross, a clock, a plain dash (skipped, or setup unchanged since the last run),
    or no icon at all (`null`: an empty muted ring, waiting). Nothing here looks like something to expand. */
export interface StepMark {
  icon: "check" | "close" | "clock" | "minus" | null;
  cls: string;
  word: string;
}
const MARKS: Record<RunStep["result"], StepMark> = {
  passed: { icon: "check", cls: "mq-pass", word: "Passed" },
  failed: { icon: "close", cls: "mq-fail", word: "Failed" },
  running: { icon: "clock", cls: "mq-running", word: "Running" },
  pending: { icon: null, cls: "mq-wait", word: "Waiting" },
  skipped: { icon: "minus", cls: "mq-skip", word: "Skipped" },
};
export const stepMark = (s: Pick<RunStep, "result">): StepMark => MARKS[s.result];

/** A step's time column: "" while waiting or skipped; a running step counts up from its start (`now`); a
    finished one shows what it took. */
export function stepTime(s: Pick<RunStep, "result" | "ms" | "startedAt">, now: number): string {
  if (s.result === "pending" || s.result === "skipped") return "";
  if (s.result === "running") {
    const at = s.startedAt ? Date.parse(s.startedAt) : NaN;
    if (Number.isFinite(at)) return clock(now - at);
    return s.ms > 0 ? clock(s.ms) : "";
  }
  return clock(s.ms);
}

/** A check's test counts, for its description line ("11496 passed", "5 skipped"; `failed` drawn red). None for a
    skipped or waiting step, and none when every count is zero or unknown ("0 passed" says nothing). */
export function stepCounts(s: Pick<RunStep, "result" | "counts">): { text: string; failed?: true }[] {
  const c = s.counts;
  if (!c || s.result === "skipped" || s.result === "pending") return [];
  if (!c.passed && !c.failed && !c.skipped) return [];
  return [
    ...(c.passed != null ? [{ text: `${c.passed} passed` }] : []),
    ...(c.failed ? [{ text: `${c.failed} failed`, failed: true as const }] : []),
    ...(c.skipped ? [{ text: `${c.skipped} skipped` }] : []),
  ];
}

/** Shows every `<home>/…` path inside a line as `~/…`, and the home folder alone as `~`. Only a path that starts
    there counts: at the line's start or after a space, a quote, a bracket, `=`, `:` or `,` (never inside
    `/mnt<home>/…`), and only the folder itself (followed by `/`, a space or the end, never `<home>2/…`). */
export function tildeIn(text: string, home: string | null): string {
  if (!home) return text;
  const h = home.replace(/\/+$/, "");
  if (!h) return text;
  const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(^|[\\s"'\`([{<=:,])${esc}(?=/|\\s|$)`, "g"), "$1~");
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
/** A step's detail with paths shortened (~/…). The queue's own facts (a copy's folder and commit, a merge's commit)
    come back split, the folder and commit marked `mono`; any other detail is one plain part. */
export function stepDetail(s: Pick<RunStep, "id" | "kind" | "result" | "detail">, home: string | null): { text: string; mono?: true }[] {
  if (!s.detail) return [];
  const text = tildeIn(s.detail, home);
  const structured = s.result === "passed" && (s.kind === "copy" || s.kind === "merge" || s.id === "rerun-master:copy");
  if (!structured) return [{ text }];
  const out: { text: string; mono?: true }[] = [];
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    const mono = SHA_RE.test(word) || word.startsWith("/") || word.startsWith("~");
    const last = out[out.length - 1];
    if (!mono && last && !last.mono) last.text += word;
    else out.push(mono ? { text: word, mono: true } : { text: word });
  }
  return out;
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

/** The queue doesn't serve this listed project: it has no merge setup (an invalid one is still a setup, said as such). Pure. */
export const notSetUp = (v: Pick<MergeQueueView, "served" | "checks" | "invalid">): boolean => !v.invalid && (v.served === false || v.checks === "unset");

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

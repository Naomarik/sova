import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttentionItem, AttentionKind, AttentionTier, ReadinessState, SessionReadiness, SessionSummary, WorktreeReadiness } from "../shared/protocol";
import { parseWakeNudge } from "../shared/wake";
import { isLinkMessage } from "../shared/link-message";
import { normalizeMergeDetails, restoreActive, type TrackedWorktree, WORKTREE_MERGE_MESSAGE, WORKTREES_ENTRY_TYPE } from "../pi-config/extensions/worktrees/state.ts";
import { followUpFor, type FollowUpInput, type MergeFollowUps } from "./merge-followup";
import { asksUserOf } from "./signals-store";
import { activeBranch, type Entry } from "./transcript";
import { execGit, type GitRunner, worktreeInsights, type WorktreeInsights } from "./worktrees";

/**
 * Merge readiness (§chat.worktrees/readiness): for each worktree a session tracks and owns, whether
 * it is merged, ready, waiting for the user's go-ahead, in progress, blocked or stale — from git
 * and the session's own file, no model call — plus the routine follow-ups of its merges (restart
 * pending, not pushed, cleanup) and the one follow-up check per merge (server/merge-followup.ts).
 *
 * Git is read in the background (a listing never waits on it): `readinessOverlay` returns the last
 * answer for a row and queues a fresh read when the file or the row's state moved, or the answer is
 * older than READINESS_TTL_MS. Only files that ever wrote a `worktrees` entry are read past a marker
 * search, and those incrementally.
 */

/** An answer stands this long while nothing about the row changes. */
export const READINESS_TTL_MS = 20_000;
/** The reply tail the merge-ask fallback reads. */
export const ASK_TAIL = 600;
/** The reply tail kept for the follow-up check. */
const REPLY_KEEP = 1500;

// --- pure rules -------------------------------------------------------------------------------

/** One tracked worktree's facts: the record and git. */
export interface TreeFacts {
  path: string;
  branch: string;
  /** The session's recorded status. */
  tracked: "active" | "merged";
  /** The folder is there and git could read it. */
  readable: boolean;
  /** Git finds the branch in its base (ancestry or content) after at least one commit of its own. */
  merged?: boolean;
  dirty?: boolean;
  /** Commits past the base. */
  ahead?: number;
  /** A TEMP / WIP / fixup! / squash! / amend! subject on the branch, the newest. */
  tempCommit?: string;
}

/** The session's facts the rules read. */
export interface SessionFacts {
  /** A turn runs, or subagents are working. */
  running: boolean;
  /** Open alignment questions the session waits on (SessionSummary.align). */
  openQuestions: number;
  /** The newest check run (test, typecheck, build) on the branch. */
  lastCheck?: { at: number; ok: boolean };
  /** The last reply asks the user something (the attention signal, else the merge-ask fallback). */
  asks: boolean;
}

/** One worktree's state and a few words why (§chat.worktrees/readiness). */
export function treeReadiness(t: TreeFacts, s: SessionFacts): { state: ReadinessState; why?: string } {
  // A folder git can't read: the record is all there is.
  if (!t.readable) return t.tracked === "merged" ? { state: "merged", why: "worktree folder gone" } : { state: "in-progress", why: "worktree folder gone" };
  if (t.merged) {
    // Uncommitted work vetoes "merged": the tree is being worked on, or was left dirty.
    if (t.dirty) return s.running ? { state: "in-progress", why: "uncommitted changes" } : { state: "stale", why: "merged, with uncommitted changes" };
    return t.tracked === "active" ? { state: "merged", why: "still tracked active" } : { state: "merged" };
  }
  if (s.running) return { state: "in-progress", why: "working now" };
  if (s.openQuestions > 0) return { state: "blocked", why: `${s.openQuestions} open question${s.openQuestions === 1 ? "" : "s"}` };
  if (t.dirty) return { state: "in-progress", why: "uncommitted changes" };
  if (!t.ahead) return { state: "in-progress", why: "no commits yet" };
  if (t.tempCommit) return { state: "in-progress", why: `temporary commit: ${t.tempCommit}` };
  if (s.lastCheck && !s.lastCheck.ok) return { state: "in-progress", why: "the last check failed" };
  const why = s.lastCheck ? "checks passed" : "no check run seen";
  return s.asks ? { state: "waiting-approval", why } : { state: "ready", why };
}

const TEMP_RE = /^(?:temp|wip)\b|^(?:fixup|squash|amend)!/i;
/** The newest temporary commit subject, if any. */
export const tempCommitOf = (subjects: readonly string[]): string | undefined => subjects.find((s) => TEMP_RE.test(s.trim()));

/** A bash command that runs a check: tests, a typecheck or a build. */
export const CHECK_RE =
  /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+|exec\s+)?(?:test|typecheck|build|check|lint|tsc|vitest)\b|\btsc\b|\bvitest\b|\b(?:node|tsx)\b[^\n|;&]*\s--test\b|\bcargo\s+(?:test|build|check|clippy)\b|\bgo\s+(?:test|build|vet)\b|\bpytest\b|\bmake\s+(?:test|check)\b/;
/** A check's output that says it failed even when the exit code was piped away. */
const CHECK_FAILED_RE = /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+[1-9]|\b[1-9]\d*\s+(?:failed|failing)\b|\berror TS\d+|ELIFECYCLE|Tests?:\s+[1-9]\d*\s+failed|\bFAIL\b\s+\S/;
export const checkFailed = (isError: boolean, output: string): boolean => isError || CHECK_FAILED_RE.test(output);

/** The reply's end asking to merge (the fallback when no attention answer covers the reply). */
const MERGE_ASK_RE =
  /\b(?:shall|should|can|may)\s+i\s+(?:\S+\s+){0,6}?merge\b|\bwant\s+me\s+to\s+(?:\S+\s+){0,4}?merge\b|\b(?:ok|okay|good)\s+to\s+merge\b|\bready\s+to\s+merge\b|\bsay\s+["“'`]?merge\b|\bmerge\s+(?:it|this|the\s+branch)\b[^.?!\n]{0,80}\?/i;
/** The reply without its closing spec lines ("Also changes:", "Deferred:", "Plumbing:", "Spec check override:"). */
export const replyBody = (reply: string): string => reply.replace(/(?:\n\s*(?:Also changes|Deferred|Plumbing|Spec check override):[^\n]*)+\s*$/i, "").trimEnd();
export const asksToMerge = (reply: string): boolean => MERGE_ASK_RE.test(replyBody(reply).slice(-ASK_TAIL));

/** A changed file that needs the server restarted: server-side code, never src/, docs or tests. */
export const needsRestart = (file: string): boolean =>
  (/^(?:server|shared|pi-config)\//.test(file) && !/\.md$|\.test\.[cm]?[jt]sx?$/.test(file)) || file === "package.json" || file === "pnpm-lock.yaml";

/** The session's routine and judged follow-ups, as the badge and digest read them. */
export interface MergeFlags {
  /** Newest merge card: when, and its branch. */
  lastMerge?: { at: number; branch: string };
  restartPending?: boolean;
  pushPending?: boolean;
  followUp?: SessionReadiness["followUp"];
}

/** The session's readiness from its trees' states and its merges (§chat.worktrees/readiness). */
export function sessionReadinessOf(trees: WorktreeReadiness[], flags: MergeFlags, lastReplyAt: number): SessionReadiness | undefined {
  if (trees.length === 0) return undefined;
  const cleanup = trees.filter((t) => t.state === "merged" && t.why === "still tracked active").length;
  const out: SessionReadiness = {
    trees,
    since: lastReplyAt,
    ...(flags.restartPending ? { restartPending: true as const } : {}),
    ...(flags.pushPending ? { pushPending: true as const } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(flags.followUp ? { followUp: flags.followUp } : {}),
  };
  const waiting = trees.find((t) => t.state === "waiting-approval");
  const ready = trees.find((t) => t.state === "ready");
  if (waiting) return { ...out, badge: "waiting", branch: waiting.branch };
  if (ready) return { ...out, badge: "ready", branch: ready.branch };
  if (trees.some((t) => t.state !== "merged")) return out;
  const branch = flags.lastMerge?.branch ?? trees[trees.length - 1]!.branch;
  const since = flags.lastMerge?.at ?? lastReplyAt;
  if (flags.restartPending) return { ...out, badge: "restart", branch, since };
  const followUps = cleanup + (flags.followUp ? 1 : 0);
  return { ...out, badge: "merged", branch, since, ...(followUps ? { followUps } : {}) };
}

/** The digest's merge items of one session (§app.overseer/attention-digest): decide tier. */
export function readinessItems(s: SessionSummary): { tier: AttentionTier; kind: AttentionKind; since: number; detail: string }[] {
  const r = s.readiness;
  if (!r || s.archived) return [];
  const running = s.busy || s.activity?.state === "working";
  const out: { tier: AttentionTier; kind: AttentionKind; since: number; detail: string }[] = [];
  if (r.badge === "waiting" && r.branch && !running) out.push({ tier: "decide", kind: "ready-to-merge", since: r.since, detail: `Ready to merge: ${r.branch}` });
  if (r.followUp?.weight === "significant") out.push({ tier: "decide", kind: "merged-open-work", since: r.since, detail: `Merged with open work: ${r.followUp.cue}` });
  return out;
}

/** The one restart item of the whole server (no session), or none. */
export function restartItems(sessions: readonly SessionSummary[]): AttentionItem[] {
  const pending = sessions.filter((s) => s.readiness?.restartPending && !s.workerSession);
  if (pending.length === 0) return [];
  const newest = [...pending].sort((a, b) => (b.readiness!.since || 0) - (a.readiness!.since || 0))[0]!;
  const merges = pending.map((s) => s.readiness!.branch ?? s.title);
  const n = pending.length;
  return [
    {
      id: "restart-pending",
      path: "",
      title: "Server",
      where: "this server",
      tier: "decide",
      kind: "restart-pending",
      since: newest.readiness!.since,
      detail: `Restart pending: ${n} merge${n === 1 ? "" : "s"} changed the server since it started (${merges.join(", ")}).`,
      href: `#/s/${encodeURIComponent(newest.path)}`,
    },
  ];
}

// --- the file ---------------------------------------------------------------------------------

/** A merge card on the branch and the first reply that ends a turn after it. */
export interface MergeCard {
  id: string;
  at: number;
  path: string;
  branch: string;
  target: string;
  sha: string;
  commits: number;
  added: number;
  removed: number;
  fastForward: boolean;
  reply?: { id: string; at: number; text: string };
}

/** What the rules read from a session's active branch. */
export interface FileFacts {
  trees: TrackedWorktree[];
  merges: MergeCard[];
  lastCheck?: { at: number; ok: boolean };
  /** The branch's last word is this reply (no user prompt after it). */
  lastReply?: { id: string; at: number; text: string };
}

/** One session entry, only as far as readiness needs it. */
interface ScanEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  at?: number;
  customType?: string;
  data?: unknown;
  merge?: Omit<MergeCard, "id" | "at" | "reply">;
  /** An assistant message: whether it ended the turn, and its text's tail. */
  reply?: { stop: boolean; text: string };
  /** An assistant message's check-run tool calls. */
  checkCalls?: string[];
  /** A check run's result. */
  check?: { toolCallId: string; ok: boolean };
  userPrompt?: true;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n") : "";
const timeOf = (v: unknown): number | undefined => (typeof v === "string" ? Date.parse(v) || undefined : typeof v === "number" ? v : undefined);

const HEAD = /^\{"type":"([^"]+)","id":"([^"]+)","parentId":(?:null|"([^"]*)")/;

/** A line as a ScanEntry. `checkIds` are the check calls seen so far (their results come after). */
export function scanLine(line: string, checkIds: Set<string>): ScanEntry | null {
  const head = HEAD.exec(line);
  const wanted =
    line.includes(`"customType":"${WORKTREES_ENTRY_TYPE}"`) ||
    line.includes(`"customType":"${WORKTREE_MERGE_MESSAGE}"`) ||
    line.includes('"role":"assistant"') ||
    line.includes('"role":"user"') ||
    (line.includes('"role":"toolResult"') && [...checkIds].some((id) => line.includes(id)));
  if (head && !wanted) return { type: head[1]!, id: head[2]!, parentId: head[3] ?? null };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.type !== "string") return null;
  const e: ScanEntry = { type: v.type };
  if (typeof v.id === "string") e.id = v.id;
  if (typeof v.parentId === "string" || v.parentId === null) e.parentId = v.parentId as string | null;
  const at = timeOf(v.timestamp);
  if (at !== undefined) e.at = at;
  if (v.type === "custom" && v.customType === WORKTREES_ENTRY_TYPE) {
    e.customType = v.customType;
    e.data = v.data;
  }
  if (v.type === "custom_message" && v.customType === WORKTREE_MERGE_MESSAGE) {
    const d = normalizeMergeDetails(v.details);
    if (d) e.merge = { path: d.path, branch: d.branch, target: d.target, sha: d.sha, commits: d.commits, added: d.added, removed: d.removed, fastForward: d.fastForward };
  }
  const m = v.message;
  if (v.type === "message" && isRecord(m)) {
    if (m.role === "assistant") {
      const text = textOf(m.content);
      e.reply = { stop: m.stopReason === "stop", text: text.length > REPLY_KEEP ? text.slice(-REPLY_KEEP) : text };
      if (e.at === undefined) e.at = timeOf(m.timestamp);
      const calls: string[] = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!isRecord(b) || b.type !== "toolCall" || typeof b.id !== "string" || b.name !== "bash") continue;
        const cmd = isRecord(b.arguments) && typeof b.arguments.command === "string" ? b.arguments.command : "";
        if (CHECK_RE.test(cmd)) calls.push(b.id);
      }
      if (calls.length) {
        e.checkCalls = calls;
        for (const c of calls) checkIds.add(c);
      }
    } else if (m.role === "toolResult" && typeof m.toolCallId === "string" && checkIds.has(m.toolCallId)) {
      e.check = { toolCallId: m.toolCallId, ok: !checkFailed(m.isError === true, textOf(m.content).slice(-4000)) };
    } else if (m.role === "user") {
      const text = textOf(m.content);
      if (parseWakeNudge(text) === null && !isLinkMessage(text)) e.userPrompt = true;
    }
  }
  return e;
}

/** The facts of a branch (root first). */
export function factsOf(branch: readonly ScanEntry[]): FileFacts {
  const set = restoreActive(branch as { type: string; customType?: string; data?: unknown }[]);
  const merges: MergeCard[] = [];
  let lastCheck: FileFacts["lastCheck"];
  let lastReply: FileFacts["lastReply"];
  for (const e of branch) {
    if (e.merge && e.id) merges.push({ ...e.merge, id: e.id, at: e.at ?? 0 });
    if (e.reply?.stop && e.id) {
      const reply = { id: e.id, at: e.at ?? 0, text: e.reply.text };
      lastReply = reply;
      for (const c of merges) c.reply ??= reply;
    }
    if (e.userPrompt) lastReply = undefined;
    if (e.check) lastCheck = { at: e.at ?? 0, ok: e.check.ok };
  }
  return { trees: set?.trees ?? [], merges, ...(lastCheck ? { lastCheck } : {}), ...(lastReply ? { lastReply } : {}) };
}

/** How far a file's read got (the marker search, then its compact entries). */
export interface ReadinessScan {
  size: number;
  found: boolean;
  entries?: ScanEntry[];
  checkIds?: Set<string>;
}

const MARKER = Buffer.from(`"customType":"${WORKTREES_ENTRY_TYPE}"`);
const CHUNK = 256 * 1024;

async function hasMarker(path: string, from: number, size: number): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    let pos = Math.max(0, from - MARKER.length);
    const buf = Buffer.alloc(CHUNK + MARKER.length);
    while (pos < size) {
      const want = Math.min(buf.length, size - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) return false;
      if (buf.subarray(0, bytesRead).includes(MARKER)) return true;
      // The end, or a file that shrank since its size was read: a short read makes no progress.
      if (pos + bytesRead >= size || bytesRead < want) return false;
      pos += bytesRead - MARKER.length;
    }
    return false;
  } finally {
    await fh.close();
  }
}

async function appendLines(path: string, from: number, size: number, into: ScanEntry[], checkIds: Set<string>): Promise<number> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = from;
    let carry = Buffer.alloc(0);
    let consumed = from;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = data.toString("utf8", start, nl);
        if (line.trim() !== "") {
          const e = scanLine(line, checkIds);
          if (e) into.push(e);
        }
        start = nl + 1;
      }
      consumed += start;
      carry = Buffer.from(data.subarray(start));
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

async function atLineStart(path: string, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(1);
    const { bytesRead } = await fh.read(b, 0, 1, offset - 1);
    return bytesRead === 1 && b[0] === 10;
  } finally {
    await fh.close();
  }
}

/**
 * A session file's readiness facts, read incrementally like the align read (server/align-state.ts):
 * a file that never wrote a `worktrees` entry is only searched for the marker; once one is seen,
 * its entries are kept compact and only lines appended since are parsed. Never throws.
 */
export async function readReadinessScan(path: string, size: number, prev: ReadinessScan | null): Promise<{ scan: ReadinessScan; facts: FileFacts | null }> {
  try {
    const grown = prev !== null && size >= prev.size;
    if (!(grown && prev.found)) {
      const found = await hasMarker(path, grown ? prev.size : 0, size);
      if (!found) return { scan: { size, found: false }, facts: null };
    }
    let entries: ScanEntry[];
    let checkIds: Set<string>;
    let from: number;
    if (grown && prev.found && prev.entries && prev.checkIds && (await atLineStart(path, prev.size))) {
      entries = prev.entries;
      checkIds = prev.checkIds;
      from = prev.size;
    } else {
      entries = [];
      checkIds = new Set();
      from = 0;
    }
    const end = from === size ? size : await appendLines(path, from, size, entries, checkIds);
    return { scan: { size: end, found: true, entries, checkIds }, facts: factsOf(activeBranch(entries as Entry[]) as ScanEntry[]) };
  } catch {
    return { scan: { size, found: false }, facts: null };
  }
}

// --- git --------------------------------------------------------------------------------------

/** This server process's start: a merge after it isn't running here yet. */
export const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

export interface ReadinessDeps {
  insights: Pick<WorktreeInsights, "treeStatus">;
  git: GitRunner;
  /** The folder this server's code runs from (its checkout). */
  serverDir: string;
  processStart: number;
  now: () => number;
  /** The one follow-up check per merge; absent = never asked. */
  followUps?: MergeFollowUps;
  /** Whether a session counts as a terminal one for the privacy gate. */
  terminal?: (s: SessionSummary) => boolean;
  /** The attention answer for the session's last classified reply. */
  asksUser?: (sessionId: string) => { turnId: string; asks: boolean } | undefined;
}

const defaultDeps = (): ReadinessDeps => ({
  insights: worktreeInsights,
  git: execGit,
  serverDir: dirname(fileURLToPath(import.meta.url)),
  processStart: PROCESS_START_MS,
  now: Date.now,
  asksUser: (id) => asksUserOf(id),
});

let deps: ReadinessDeps = defaultDeps();

/** index.ts wires the follow-up check and the privacy gate's terminal test; tests swap git. */
export function configureReadiness(over: Partial<ReadinessDeps>): void {
  deps = { ...deps, ...over };
}

let serverCheckout: Promise<{ top: string; branch: string } | null> | null = null;
function checkout(): Promise<{ top: string; branch: string } | null> {
  serverCheckout ??= (async () => {
    const top = await deps.git(["rev-parse", "--show-toplevel"], { cwd: deps.serverDir });
    const branch = await deps.git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: deps.serverDir });
    if (top.code !== 0 || branch.code !== 0) return null;
    return { top: top.stdout.trim(), branch: branch.stdout.trim() };
  })();
  return serverCheckout;
}

/** Per merge commit: did it change the server this process runs? Immutable once known. */
const restartBySha = new Map<string, boolean>();
async function mergeNeedsRestart(card: MergeCard): Promise<boolean> {
  if (card.at <= deps.processStart) return false;
  const known = restartBySha.get(card.sha);
  if (known !== undefined) return known;
  const co = await checkout();
  if (!co || co.branch !== card.target) return false;
  const inHead = await deps.git(["merge-base", "--is-ancestor", card.sha, "HEAD"], { cwd: co.top });
  if (inHead.code !== 0) return false;
  const from = card.fastForward ? `${card.sha}~${Math.max(1, card.commits)}` : `${card.sha}^1`;
  let diff = await deps.git(["diff", "--name-only", "--no-renames", from, card.sha], { cwd: co.top });
  if (diff.code !== 0) diff = await deps.git(["show", "--name-only", "--format=", card.sha], { cwd: co.top });
  if (diff.code !== 0) return false;
  const value = diff.stdout.split("\n").some((f) => needsRestart(f.trim()));
  restartBySha.set(card.sha, value);
  return value;
}

/** Whether the merge's commit is on the target's origin branch yet; undefined when unknown. */
async function mergePushed(card: MergeCard, cwd: string): Promise<boolean | undefined> {
  const ref = await deps.git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${card.target}`], { cwd });
  if (ref.code !== 0) return undefined;
  const r = await deps.git(["merge-base", "--is-ancestor", card.sha, ref.stdout.trim()], { cwd });
  return r.code === 0 ? true : r.code === 1 ? false : undefined;
}

async function treeFacts(t: TrackedWorktree): Promise<TreeFacts> {
  const base = { path: t.path, branch: t.branch, tracked: t.status === "merged" ? ("merged" as const) : ("active" as const) };
  const st = await deps.insights.treeStatus(t.path).catch(() => null);
  if (!st || !st.exists || st.error && st.merged === undefined) return { ...base, readable: false };
  // A branch with no commit of its own is never merged: ancestry alone would say it is.
  const own = st.head !== undefined && st.head !== t.base;
  const merged = own && (st.merged === "ancestor" || st.merged === "content");
  return {
    ...base,
    branch: st.branch ?? t.branch,
    readable: true,
    merged,
    ...(st.dirty !== undefined ? { dirty: st.dirty } : {}),
    ...(st.ahead !== undefined ? { ahead: st.ahead } : {}),
    ...(st.subjects ? { tempCommit: tempCommitOf(st.subjects) } : {}),
  };
}

/** A session's readiness now: git, the file's facts and the row. */
export async function computeReadiness(s: SessionSummary, facts: FileFacts): Promise<SessionReadiness | undefined> {
  const own = facts.trees.filter((t) => t.status !== "dropped" && t.session === s.id);
  if (own.length === 0) return undefined;
  const running = s.busy || s.activity?.state === "working" || (s.workers?.working ?? s.live?.workers?.working ?? 0) > 0;
  const reply = facts.lastReply;
  let asks = false;
  if (reply) {
    const signal = deps.asksUser?.(s.id);
    asks = signal && signal.turnId === reply.id ? signal.asks : asksToMerge(reply.text);
  }
  const sf: SessionFacts = { running, openQuestions: s.align?.openQuestions ?? 0, asks, ...(facts.lastCheck ? { lastCheck: facts.lastCheck } : {}) };
  const trees: WorktreeReadiness[] = [];
  for (const t of own) {
    const tf = await treeFacts(t);
    const r = treeReadiness(tf, sf);
    trees.push({ path: t.path, branch: tf.branch, state: r.state, ...(r.why ? { why: r.why } : {}) });
  }
  const cards = facts.merges;
  const newest = cards[cards.length - 1];
  let restartPending = false;
  for (const c of cards) if (await mergeNeedsRestart(c).catch(() => false)) restartPending = true;
  let pushPending = false;
  if (newest) {
    const cwd = own.find((t) => t.path === newest.path)?.path ?? s.cwd;
    pushPending = (await mergePushed(newest, cwd).catch(() => undefined)) === false;
  }
  const followUp = newest ? followUpFor(s.id, newest.id) : undefined;
  const lastReplyAt = reply?.at ?? (Date.parse(s.lastActiveAt) || 0);
  return sessionReadinessOf(trees, { ...(newest ? { lastMerge: { at: newest.at, branch: newest.branch } } : {}), restartPending, pushPending, followUp }, lastReplyAt);
}

/** Ask the follow-up check for every merge card with a reply it hasn't answered. */
async function checkFollowUps(s: SessionSummary, facts: FileFacts, r: SessionReadiness | undefined): Promise<boolean> {
  const f = deps.followUps;
  if (!f) return false;
  let stored = false;
  for (const c of facts.merges) {
    if (!c.reply) continue;
    const input: FollowUpInput = {
      sessionId: s.id,
      cardId: c.id,
      cwd: s.cwd,
      terminal: deps.terminal?.(s) ?? !!s.live,
      card: { branch: c.branch, target: c.target, commits: c.commits, added: c.added, removed: c.removed },
      reply: c.reply,
      routine: { restart_pending: !!r?.restartPending, push_pending: !!r?.pushPending, cleanup: r?.cleanup ?? 0 },
    };
    if (f.skipReason(input) !== null) continue;
    if (await f.check(input)) stored = true;
  }
  return stored;
}

// --- the background read ----------------------------------------------------------------------

interface Cached {
  scan: ReadinessScan | null;
  facts: FileFacts | null;
  value?: SessionReadiness;
  /** What the answer was computed from: the row's state (rowKey). */
  key: string;
  at: number;
}

const cache = new Map<string, Cached>();
const queued = new Map<string, SessionSummary>();
let draining: Promise<void> | null = null;

/** The row's state the answer depends on besides git: a change re-reads at once. */
const rowKey = (s: SessionSummary) =>
  JSON.stringify([s.lastActiveAt, s.busy, s.activity?.state ?? null, s.workers?.working ?? s.live?.workers?.working ?? 0, s.align?.openQuestions ?? 0, s.signals?.turnId ?? null]);

/** Sessions readiness never covers. */
const excluded = (s: SessionSummary) => !!(s.workerSession || s.overseer || s.projectOverseer || s.baton || s.target);

async function refresh(s: SessionSummary): Promise<void> {
  const prev = cache.get(s.path);
  let size: number;
  try {
    size = (await stat(s.path)).size;
  } catch {
    cache.delete(s.path);
    return;
  }
  const { scan, facts } = await readReadinessScan(s.path, size, prev?.scan ?? null);
  const value = facts ? await computeReadiness(s, facts) : undefined;
  cache.set(s.path, { scan, facts, ...(value ? { value } : {}), key: rowKey(s), at: deps.now() });
  if (facts && value && (await checkFollowUps(s, facts, value).catch(() => false))) {
    const again = await computeReadiness(s, facts);
    cache.set(s.path, { scan, facts, ...(again ? { value: again } : {}), key: rowKey(s), at: deps.now() });
  }
}

function drain(): Promise<void> {
  draining ??= (async () => {
    while (queued.size) {
      const [path, s] = queued.entries().next().value as [string, SessionSummary];
      queued.delete(path);
      await refresh(s).catch((err) => console.warn(`[readiness] ${path}: ${(err as Error).message}`));
    }
  })().finally(() => {
    draining = null;
  });
  return draining;
}

/**
 * A row's readiness as last computed; queues a fresh read when the file or the row's state moved,
 * or (for a file that tracks worktrees) the answer is older than READINESS_TTL_MS: git moves on
 * its own. A file that never wrote a `worktrees` entry is searched again only when it changed.
 */
export function readinessOverlay(s: SessionSummary): SessionReadiness | undefined {
  if (excluded(s)) return undefined;
  const hit = cache.get(s.path);
  const moved = !hit || hit.key !== rowKey(s);
  const aged = !!hit?.scan?.found && deps.now() - hit.at >= READINESS_TTL_MS;
  if (moved || aged) {
    queued.set(s.path, s);
    void drain();
  }
  return hit?.value;
}

/** Every listed session's readiness, and the follow-up store kept to listed sessions. */
export function pruneReadiness(listed: readonly SessionSummary[]): void {
  const paths = new Set(listed.map((s) => s.path));
  for (const k of cache.keys()) if (!paths.has(k)) cache.delete(k);
  deps.followUps?.prune(new Set(listed.map((s) => s.id)));
}

/** A worktree's readiness from the session's cached answer (the Session tab's rows). */
export function treeReadinessOf(sessionPath: string, treePath: string): WorktreeReadiness | undefined {
  return cache.get(sessionPath)?.value?.trees.find((t) => t.path === treePath);
}

/** Tests: wait for the background reads, and start over. */
export const readinessIdle = (): Promise<void> => draining ?? Promise.resolve();
export function resetReadiness(): void {
  cache.clear();
  queued.clear();
  restartBySha.clear();
  serverCheckout = null;
  deps = defaultDeps();
}

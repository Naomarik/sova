// Automatic retirement (§chat.worktrees/retirement): the one owner that retires a finished branch and its
// folder, for every project, on one machine, with no button and no chat involved. It reads git and the chats
// afresh at every wake-up and rechecks everything right before each removal; `retire-pending.json` is only a
// report and a debounce. Every doubt holds: a wrong deletion is the worst thing this file can do.
//
// It runs only on the real server (`retirementAllowed`): a hermetic server shares git's list with the real
// repository but sees only its own chats, so every real worktree would look unused to it.
//
// Reads: server/worktree-cleanup.ts (classification, chats, processes), server/nothing-left.ts (the shared
// answer). The one removal step: server/worktree-remove.ts. The merge queue only wakes it and answers "is
// there an open entry".
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { open as openFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonical, isWithin } from "../pi-config/extensions/worktrees/state.ts";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";
import type { HeldRow } from "../shared/protocol";
import { CONTRACT_FILE, parseDefinition } from "../shared/project-contract";
import { openQueueEntry } from "./nothing-left";
import { registeredCopyOf } from "./project-services/checkout-teardown";
import { draftNamesIn } from "./spec-drafts-state";
import { linksOf } from "./project-services/share";
import { agentRoot, stateRoot } from "./state-root";
import { type Gate, retirementAllowed } from "./worktree-retire-gate";

export { type Gate, retirementAllowed };
import { chatInUse, type CutOffKind, QUIET_MS, type LeftoverInput, type LeftoverProof, leftoverProof, deleteProvedFolder, finishCutOff, gitPointer, keepTestChats, lexists, liveRecordPid, longGit, pinRef, pinTip, realOr, removeTree, retireBranch } from "./worktree-remove";
import { type FinishedFacts, type Leftovers, leftovers, leftoversReason, reachableBlobs, rebuildableDir, RECORDING, type TestCopyLeft, unreadableLeftovers } from "./worktree-leftovers";
import { appendLedger, besideGone, markLedger, readLedger, type RemovedWorktree, retiredEntryCovering } from "./removed-worktrees";
import { scratchCopiesIn } from "./merge-queue/scratch";
import { type ChatFacts, type ChatUse, chatUses, classifyRepo, type ClassifiedTree, forgetSummary, parseWorktreeList, pidAlive, type ProcFacts, type RepoTrees, scanProcesses, treeRecords, type TreeRecord } from "./worktree-cleanup";
import { type FirstPassGroups, type PendingFile, pendingFile, readPending, type RepoReport, type WaitingRow, writePending } from "./worktree-retire-view";
import { execGit, type GitRunner } from "./worktrees";

export { QUIET_MS };
/** A worktree with no commits of its own, while a live chat uses it; and a restored branch. */
export const EMPTY_WAIT_MS = 7 * 86_400_000;
/** A folder newer than this always waits: its creator may not have recorded it yet. */
export const NEW_TREE_GRACE_MS = 10 * 60_000;
export const PERIOD_MS = 5 * 60_000;
/** Wake-ups closer together than this share one pass. */
export const PASS_GAP_MS = 60_000;
/** Removals running at once. */
export const CONCURRENCY = 3;

// --- locks -------------------------------------------------------------------------------------

const heldHere = new Set<string>();

/** An exclusive lock by a file holding its owner's pid; one whose owner is gone is taken over. A doubt about the owner keeps the lock held. */
export function takeLock(file: string, alive: (pid: number) => boolean = pidAlive, self = process.pid): boolean {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(self));
      closeSync(fd);
      heldHere.add(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    let owner = NaN;
    try {
      owner = Number(readFileSync(file, "utf8").trim());
    } catch {
      return false;
    }
    // This very process holds it (a pass and an archive at once): no. Our pid and no memory of it: an earlier life's, reused.
    if (owner === self && heldHere.has(file)) return false;
    if (!Number.isInteger(owner) || owner <= 0 || (owner !== self && alive(owner))) return false;
    try {
      rmSync(file);
    } catch {
      return false;
    }
  }
  return false;
}

export function dropLock(file: string, self = process.pid): void {
  heldHere.delete(file);
  try {
    if (Number(readFileSync(file, "utf8").trim()) === self) rmSync(file);
  } catch {
    // already gone
  }
}

const repoLockFile = (commonDir: string): string => join(commonDir, "sova-retire.lock");

/** Who a lock looks taken by, for the Held line. Null: this very process, which is no reason to say anything. */
function lockOwnerWords(file: string, self = process.pid): string | null {
  let owner: number;
  try {
    owner = Number(readFileSync(file, "utf8").trim());
  } catch {
    return "an unreadable lock file";
  }
  if (owner === self) return null;
  return Number.isInteger(owner) && owner > 0 ? `process ${owner}` : "an unreadable lock file";
}

// --- what it needs -----------------------------------------------------------------------------

/** A copy of the project registered with Sova, on this folder. */
export interface CopyFacts {
  id: string;
  /** An active share link: holds the folder. */
  shareLink: boolean;
  /** Made by Sova's own conformance suite: never ours to stop. */
  ownRun: boolean;
}

export interface RetireDeps {
  allowed(): Gate;
  /** Each project's main checkout. */
  repos(): Promise<readonly string[]> | readonly string[];
  git: GitRunner;
  /** Writes other than the removal itself. */
  gitWrite: Git;
  /** `git worktree remove`. */
  gitRemove: Git;
  classify(root: string, only?: readonly string[]): Promise<RepoTrees | null>;
  chats(paths: readonly string[], exclude?: string): Promise<ChatFacts>;
  /** Every tree any chat's records name. */
  records(): Promise<{ records: TreeRecord[]; unreadable: string[] }>;
  processes(): Promise<ProcFacts[]>;
  alive(pid: number): boolean;
  openEntry(main: string, branch: string): { id: string; state: string } | null;
  /** The drafts in a folder not proved landed. */
  draftsUnproved(main: string, folder: string, branch?: string): Promise<string[]>;
  /** A branch, no folder asked about, has nothing left. A doubt is false. */
  branchFinished(main: string, branch: string): Promise<boolean>;
  copies: { of(path: string): CopyFacts | null; teardown(path: string): Promise<unknown> };
  ledger(): readonly RemovedWorktree[];
  appendLedger(entries: readonly RemovedWorktree[]): void;
  markLedger(match: (e: RemovedWorktree) => boolean, patch: Partial<Pick<RemovedWorktree, "restoredAt" | "backAt" | "branchDeleted">>): boolean;
  /** Ends the cached readiness of every session tracking these. */
  removed(paths: readonly string[]): Promise<void>;
  /** The branch a repository lands on, when its project declares one. */
  targetOf?(main: string): Promise<string | null>;
  /** The project's setup, for a folder brought back. Why it failed, or null. */
  setup?(path: string): Promise<string | null>;
  now(): number;
  pendingFile(): string;
  /** After the first pass: post its summary. False or a throw: it wasn't posted, so the next pass asks again with the same summary. */
  firstPassDone?(summary: PassResult): Promise<boolean | void> | boolean | void;
  /** One of the merge queue's own chats made this folder, by who made it: a leftover with no worktree left to classify. Absent or a doubt: not proved. */
  queueMade?(path: string): Promise<boolean> | boolean;
  /** Whether this project deletes branches when cleaning up. Absent: read from its definition at the target's head (`deleteBranchesOn`). A doubt is false. */
  deleteBranches?(main: string): Promise<boolean> | boolean;
  /** `<state root>/retire-first-pass.json`: beside the pending file unless named. */
  firstPassFile?(): string;
  /** `<state root>/retired-test-chats`: beside the pending file unless named. */
  testChatsAside?(): string;
  /** The user's own chats, which a test chat is compared against. Default: this install's `sessions`. */
  realChatsDir?(): string;
  /** The sandbox's rule reads it: a missing root is proved only on Linux. */
  platform?(): NodeJS.Platform;
}

/** `merge.deleteBranches` in a definition's text: true only in a definition that parses and says so. Pure. */
export function definitionDeletesBranches(text: string): boolean {
  try {
    return parseDefinition(text).merge?.deleteBranches === true;
  } catch {
    return false;
  }
}

/**
 * Whether cleanup deletes this repository's landed branches (§chat.worktrees/retirement): the project's definition at the
 * target's head, read right before a removal. Missing or unreadable is off: a project with no definition keeps its branches.
 */
async function deleteBranchesOn(d: RetireDeps, repo: Pick<RepoTrees, "main" | "target">): Promise<boolean> {
  try {
    if (d.deleteBranches) return (await d.deleteBranches(repo.main)) === true;
    if (!repo.target) return false;
    const r = await d.git(["show", `${repo.target.oid}:${CONTRACT_FILE}`], { cwd: repo.main });
    return r.code === 0 && definitionDeletesBranches(r.stdout);
  } catch {
    return false;
  }
}

const besidePending = (d: Pick<RetireDeps, "pendingFile">, name: string): string => join(dirname(d.pendingFile()), name);
const firstPassFileOf = (d: RetireDeps): string => d.firstPassFile?.() ?? besidePending(d, "retire-first-pass.json");
const asideOf = (d: RetireDeps): string => d.testChatsAside?.() ?? besidePending(d, "retired-test-chats");
const sandboxHolds = (d: RetireDeps): boolean => (d.platform?.() ?? process.platform) !== "linux";

// --- the one rule ------------------------------------------------------------------------------

export type Verdict =
  /** `left`: what the one keep rule read, what goes with the folder. Absent for a folder already gone. */
  | { do: "retire"; copy?: CopyFacts; left?: Leftovers }
  | { do: "wait"; why: string }
  | { do: "hold"; why: string; kind: HeldRow["kind"]; session?: ChatUse }
  /** Not this service's: a branch with work, on no branch, or the branch others land on. */
  | { do: "skip" };

export interface JudgeFacts {
  chats: ChatFacts;
  procs: readonly ProcFacts[];
  ledger: readonly RemovedWorktree[];
  /** What a test copy left, for this tree, in the rule's own read. */
  finished: FinishedFacts;
  /** A chat's sandbox on holds it: every platform but Linux. */
  sandboxHolds: boolean;
  /** Branches that are never retired, whatever they read: where others land. */
  protectedBranches: ReadonlySet<string>;
  /** Archive's: at once. The archived chat is out of `chats`, and a fresh folder doesn't wait. */
  atOnce?: boolean;
}

export const NO_DOT_GIT = "Git still lists it, but its folder has no working .git, and no removal of Sova's explains that, so nothing was touched. To keep it, run git worktree repair <path> from the main checkout; to drop it, delete the folder yourself.";

const sessionOfUse = (u: ChatUse): HeldRow["session"] => ({ ...(u.id ? { id: u.id } : { id: "" }), path: u.path, title: u.name });

/**
 * Why one tree does or doesn't retire now: every condition of §chat.worktrees/retirement. What holds is
 * asked before what only waits, so the Held list says what needs someone even while a chat is busy.
 */
export async function judge(d: Pick<RetireDeps, "git" | "copies" | "openEntry" | "alive" | "gitWrite" | "now" | "draftsUnproved">, repo: Pick<RepoTrees, "main">, t: ClassifiedTree, f: JudgeFacts): Promise<Verdict> {
  if (t.branch && f.protectedBranches.has(t.branch)) return { do: "skip" };
  if (!t.branch || !t.head) return { do: "skip" };
  if (t.unknown) return { do: "hold", kind: "other", why: t.why ?? "Sova can't read what this branch has left." };
  if (t.class === "unmerged") {
    if (t.drafts?.length && t.why === "Its spec drafts aren't proved landed.") return { do: "hold", kind: "drafts", why: `${t.drafts.length} spec draft${t.drafts.length === 1 ? "" : "s"} not proved landed` };
    return { do: "skip" };
  }
  // Git calls it prunable and its folder is there: a stop of Sova's own was finished or held by finishIntents, so this one is nobody's Sova knows of.
  if (t.gone && lexists(t.path)) return { do: "hold", kind: "other", why: NO_DOT_GIT };
  if (t.locked) return { do: "hold", kind: "other", why: "Locked." };
  if (t.nested?.length) return { do: "hold", kind: "files", why: `Another worktree is inside it: ${t.nested[0]}.` };
  const now = d.now();
  const mine = f.chats.uses.filter((u) => u.inside.includes(t.path) || u.tracks.includes(t.path));

  // Its files, by the one keep rule. A folder already gone has none.
  let left: Leftovers | undefined;
  if (!t.gone) {
    // The names are listed before the proof is asked: only a draft proved now goes, never one merely not named as unproved.
    const named = draftNamesIn(t.path) ?? [];
    const unproved = named.length ? await d.draftsUnproved(repo.main, t.path, t.branch).catch(() => ["unknown"]) : [];
    if (unproved.length) return { do: "hold", kind: "drafts", why: `${unproved.length} spec draft${unproved.length === 1 ? "" : "s"} not proved landed` };
    left = await leftovers(t.path, d.git, { provedDrafts: named, finished: f.finished }).catch(unreadableLeftovers);
    const why = leftoversReason(left);
    if (why !== null) return { do: "hold", kind: left.unreadable ? "other" : "files", why };
  }

  // A copy of the project on it.
  const copy = d.copies.of(t.path);
  if (copy?.ownRun) return { do: "hold", kind: "process", why: "A conformance run is using it." };
  if (copy?.shareLink) return { do: "hold", kind: "process", why: "Its test copy has an active share link." };
  // A copy on a branch with no commits may be someone trying the main branch: it holds, unless Sova made it, bringing the folder back.
  if (copy && t.class === "empty" && !f.atOnce && !f.ledger.some((e) => e.path === t.path && e.backAt)) return { do: "hold", kind: "process", why: "A test copy is registered on a branch with no commits of its own." };

  // Who may still use it.
  const sandboxed = f.sandboxHolds ? mine.find((u) => u.sandbox) : undefined;
  if (sandboxed) return { do: "hold", kind: "other", why: `Chat ${sandboxed.name} has its sandbox on.`, session: sandboxed };
  if (f.chats.unreadable.length) return { do: "wait", why: "A chat's file couldn't be read." };
  const entry = d.openEntry(repo.main, t.branch);
  if (entry) return { do: "wait", why: `Its queue entry is ${entry.state}.` };
  for (const u of mine) {
    const why = chatInUse(u, now);
    if (why) return { do: "wait", why };
  }
  const restored = [...f.ledger].reverse().find((e) => e.path === t.path && e.branch === t.branch && e.restoredAt);
  if (restored?.restoredAt && now - restored.restoredAt < EMPTY_WAIT_MS && !f.atOnce) return { do: "wait", why: "It was restored, so it waits 7 days." };
  if (t.class === "empty") {
    const live = mine.filter((u) => !u.archived);
    const quiet7 = live.every((u) => now - u.lastActiveAt >= EMPTY_WAIT_MS);
    if (!quiet7 && !f.atOnce) return { do: "wait", why: "It has no commits yet and a chat used it this week." };
  }
  if (!t.gone && !f.atOnce) {
    // A creator hasn't recorded a brand-new folder yet: nobody may look unused because of that.
    let age = 0;
    try {
      const st = statSync(t.path);
      age = now - Math.max(st.mtimeMs, st.birthtimeMs || 0);
    } catch {
      return { do: "wait", why: "Its folder couldn't be read." };
    }
    if (age < NEW_TREE_GRACE_MS) return { do: "wait", why: "It's brand new." };
  }

  // What's running in it; a registered copy's processes are stopped first, then this is asked again.
  if (!t.gone && !copy) {
    const root = canonical(t.path);
    for (const p of f.procs) if (p.unreadable) return { do: "hold", kind: "process", why: p.unreadable };
    for (const p of f.procs) if (p.paths.some((x) => isWithin(x, root))) return { do: "hold", kind: "process", why: `A process is running in it: ${p.command} (${p.pid}).` };
    const pid = liveRecordPid(t.path, d.alive);
    if (pid) return { do: "hold", kind: "process", why: `A live session under its .agent: ${pid}.` };
  }
  return { do: "retire", ...(copy ? { copy } : {}), ...(left ? { left } : {}) };
}

// --- what a test copy left ---------------------------------------------------------------------

/** Decisions per repository, one at a time. */
const turns = new Map<string, Promise<unknown>>();
async function turnIn<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  const before = turns.get(commonDir) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(fn);
  turns.set(commonDir, mine.catch(() => undefined));
  return mine;
}
/** Folders a removal is taking now, per repository: no copy of a recording in one of them outlives it. */
const going = new Map<string, Set<string>>();
const claim = (commonDir: string, path: string): void => void (going.get(commonDir) ?? going.set(commonDir, new Set()).get(commonDir)!).add(path);
const unclaim = (commonDir: string, path: string): void => void going.get(commonDir)?.delete(path);

const MAX_INDEX_ENTRIES = 200_000;
/** Bytes compared at a time. */
const COMPARE_CHUNK = 1 << 20;

/** Whether `candidate` starts with every byte of `of` (`exact`: and ends there). Reads both, a chunk at a time. */
async function sameBytes(of: string, candidate: string, exact: boolean): Promise<boolean> {
  const [a, b] = await Promise.all([stat(of), stat(candidate)]);
  if (exact ? a.size !== b.size : a.size > b.size) return false;
  const [fa, fb] = await Promise.all([openFile(of, "r"), openFile(candidate, "r")]);
  try {
    const ba = Buffer.allocUnsafe(COMPARE_CHUNK);
    const bb = Buffer.allocUnsafe(COMPARE_CHUNK);
    let at = 0;
    while (at < a.size) {
      const want = Math.min(COMPARE_CHUNK, a.size - at);
      const [ra, rb] = await Promise.all([fa.read(ba, 0, want, at), fb.read(bb, 0, want, at)]);
      if (ra.bytesRead !== want || rb.bytesRead !== want || !ba.subarray(0, want).equals(bb.subarray(0, want))) return false;
      at += want;
    }
    return true;
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

/** A chat file's first line (a copy's is the same as its original's): what a test chat's real counterpart is found by. Null: none. */
async function firstLineOf(path: string): Promise<string | null> {
  const f = await openFile(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    const { bytesRead } = await f.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const cut = text.indexOf("\n");
    return cut > 0 ? text.slice(0, cut) : null;
  } finally {
    await f.close();
  }
}

const firstLines = new Map<string, { ino: number; line: string | null }>();

/** Real chats by first line, so a copy is found whatever its name. A listing or read that can't be finished says so: the comparison can't be trusted. */
const chatIndexes = new Map<string, { files: Map<string, string[]>; failed?: string }>();
async function chatIndex(dir: string): Promise<{ files: Map<string, string[]>; failed?: string }> {
  const hit = chatIndexes.get(dir);
  if (hit) return hit;
  const files = new Map<string, string[]>();
  let failed: string | undefined;
  const add = async (p: string): Promise<void> => {
    try {
      const { ino } = await stat(p);
      let known = firstLines.get(p);
      if (known?.ino !== ino) {
        known = { ino, line: await firstLineOf(p) };
        firstLines.set(p, known);
      }
      if (known.line) (files.get(known.line) ?? files.set(known.line, []).get(known.line)!).push(p);
    } catch (err) {
      failed = `A real chat couldn't be read: ${(err as Error).message}`;
    }
  };
  const visit = async (at: string, top: boolean): Promise<void> => {
    let names;
    try {
      names = await readdir(at, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !top) failed = `The real chats couldn't be listed: ${(err as Error).message}`;
      return;
    }
    for (const e of names) {
      const p = join(at, e.name);
      if (e.isDirectory()) await visit(p, false);
      else if (e.isFile() && e.name.endsWith(".jsonl")) await add(p);
    }
  };
  await visit(dir, true);
  const value = { files, ...(failed ? { failed } : {}) };
  chatIndexes.set(dir, value);
  return value;
}

/** A compared test chat stays compared while neither file changes. */
const chatCompared = new Map<string, boolean>();
async function heldByRealChat(dir: string, chat: string): Promise<boolean | string> {
  const index = await chatIndex(dir);
  if (index.failed) return index.failed;
  const line = await firstLineOf(chat);
  if (!line) return false;
  for (const real of index.files.get(line) ?? []) {
    const [a, b] = await Promise.all([stat(chat), stat(real)]);
    const key = `${chat}\0${a.size}:${a.mtimeMs}\0${real}\0${b.size}:${b.mtimeMs}`;
    let same = chatCompared.get(key);
    if (same === undefined) {
      same = await sameBytes(chat, real, false);
      chatCompared.set(key, same);
      if (chatCompared.size > 5000) chatCompared.delete(chatCompared.keys().next().value!);
    }
    if (same) return true;
  }
  return false;
}

/** Recordings in one folder, by size. Walks what a recording could sit in: not `.git`, a package tree or a test copy's chats. */
async function recordingsIn(folder: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  let entries = 0;
  const stack = [folder];
  while (stack.length) {
    const dir = stack.pop()!;
    const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of names) {
      if (++entries > MAX_INDEX_ENTRIES) return out;
      // A copy in anything that goes with its own folder for free doesn't outlive that folder's removal: never count it.
      if (e.name === ".git" || e.name === ".agent" || e.name === "tmp" || rebuildableDir(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && RECORDING.test(e.name)) {
        const size = await stat(p).then((s) => s.size).catch(() => -1);
        if (size >= 0) (out.get(size) ?? out.set(size, []).get(size)!).push(p);
      }
    }
  }
  return out;
}

const recordingIndexes = new Map<string, Map<number, string[]>>();
async function recordingIndexOf(folder: string): Promise<Map<number, string[]>> {
  const hit = recordingIndexes.get(folder);
  if (hit) return hit;
  const index = await recordingsIn(folder);
  recordingIndexes.set(folder, index);
  return index;
}

/** Each pass (and each archive) lists afresh: a chat or a copy made since the last one counts. */
function forgetIndexes(): void {
  chatIndexes.clear();
  recordingIndexes.clear();
}

/**
 * Whether the same bytes outlive this removal: in git, in the main checkout, or in another folder of the repository that
 * isn't going. Counted one removal at a time. A recording that can't be read says so, and that holds it.
 */
async function recordingElsewhere(d: RetireDeps, main: string, path: string, abs: string): Promise<boolean | string> {
  const size = (await stat(abs)).size;
  const hash = await d.git(["hash-object", "--no-filters", "--", abs], { cwd: main });
  if (hash.code !== 0) return `Git couldn't read it: ${hash.stderr.trim().split("\n")[0]}`;
  // Reachable: a blob no ref holds doesn't outlive git's own tidy-up.
  if ((await reachableBlobs(d.git, main)).has(hash.stdout.trim())) return true;
  const list = await d.git(["worktree", "list", "--porcelain"], { cwd: main });
  if (list.code !== 0) return "Git couldn't list its worktrees.";
  const cd = await d.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: main });
  const commonDir = cd.code === 0 ? canonical(cd.stdout.trim()) : "";
  const leaving = going.get(commonDir);
  // The queue's scratch copies go by themselves, so nothing in one outlives this.
  const scratch = new Set(commonDir ? scratchCopiesIn(commonDir).map((c) => canonical(c.path)) : []);
  for (const w of parseWorktreeList(list.stdout)) {
    if (w.bare || w.path === path || leaving?.has(w.path) || scratch.has(canonical(w.path)) || !existsSync(w.path)) continue;
    for (const candidate of (await recordingIndexOf(w.path)).get(size) ?? []) {
      if (await sameBytes(abs, candidate, true).catch(() => false)) return true;
    }
  }
  return false;
}

/** The facts a finished tree's read asks, wired to this repository. */
function finishedFacts(d: RetireDeps, main: string, path: string): FinishedFacts {
  return {
    heldByRealChat: (abs) => heldByRealChat(d.realChatsDir?.() ?? join(agentRoot(), "sessions"), abs),
    recordingElsewhere: (_rel, abs) => recordingElsewhere(d, main, path, abs),
  };
}

// --- one tree ----------------------------------------------------------------------------------

/** A pass's own note that this removal is about to start, and what goes with it. */
type NoteGoing = (entry: RemovedWorktree, left: Leftovers | undefined) => void;

export interface RetiredRowOut {
  path: string;
  branch: string;
  tip: string;
  merged: RemovedWorktree["merged"];
  branchDeleted: boolean;
  /** A delete that stopped part way was finished under proof. */
  finished?: true;
  /** One of the merge queue's own chats made it: the report's group of its own. */
  queueMade?: true;
  /** The project keeps branches, and this one stayed. */
  branchKept?: true;
  /** What went with it, and what moved aside, for the first pass's report. */
  went?: { rebuildable: string[]; testCopy?: TestCopyLeft };
}

/** The answer for one tree after the full step. */
export type TreeOutcome =
  | { state: "retired"; row: RetiredRowOut }
  | { state: "held"; row: HeldRow }
  | { state: "waiting"; row: WaitingRow }
  | { state: "skip" };

const heldRow = (t: { path: string; branch?: string }, v: { why: string; kind: HeldRow["kind"]; session?: ChatUse }): HeldRow => ({ path: t.path, ...(t.branch ? { branch: t.branch } : {}), ...(v.session ? { session: sessionOfUse(v.session) } : {}), reason: v.why, kind: v.kind });
const outcomeOf = (t: ClassifiedTree, v: Exclude<Verdict, { do: "retire" }>): TreeOutcome =>
  v.do === "skip" ? { state: "skip" } : v.do === "wait" ? { state: "waiting", row: { path: t.path, ...(t.branch ? { branch: t.branch } : {}), why: v.why } } : { state: "held", row: heldRow(t, v) };

async function protectedOf(d: Pick<RetireDeps, "git">, repo: RepoTrees): Promise<Set<string>> {
  const out = new Set<string>(["master", "main"]);
  if (repo.mainBranch) out.add(repo.mainBranch);
  if (repo.target) out.add(repo.target.name);
  const head = await d.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repo.main });
  if (head.code === 0 && head.stdout.trim().startsWith("origin/")) out.add(head.stdout.trim().slice(7));
  const here = await d.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo.main });
  if (here.code === 0 && here.stdout.trim()) out.add(here.stdout.trim());
  return out;
}

/**
 * What a leftover's proof is handed, read fresh; a partial delete's, Remove Worktree's and teardown's too. Chats by the
 * rule `judge` uses, so a quiet one (archived or not) doesn't keep a folder for ever: its next message brings it back.
 * Remove Worktree and teardown share it because they were asked to remove this very folder, and the rule still refuses
 * whatever is using it: the only thing they lose is a refusal nothing could ever clear.
 *
 * A proof that holds has its test chats moved aside, and that move failing is a refusal: what follows it is the delete.
 */
async function proofOf(d: RetireDeps, main: string, path: string, branch: string | undefined, exclude?: string, cutOff?: CutOffKind): Promise<LeftoverProof> {
  const [procs, chats] = await Promise.all([d.processes(), d.chats([path], exclude)]);
  if (chats.unreadable.length) return { why: "A chat's file couldn't be read." };
  const entry = branch ? d.openEntry(main, branch) : null;
  if (entry) return { why: `Its queue entry is ${entry.state}.` };
  const input: LeftoverInput = {
    path,
    main,
    recorded: true,
    ...(branch ? { branch } : {}),
    branchFinished: (b) => d.branchFinished(main, b),
    draftsUnproved: (folder) => d.draftsUnproved(main, folder, branch),
    processes: procs,
    chats: chats.uses,
    now: d.now(),
    alive: d.alive,
    git: d.gitWrite,
    finished: finishedFacts(d, main, path),
    sandboxHolds: sandboxHolds(d),
    ...(cutOff ? { cutOff } : {}),
  };
  const proof = await leftoverProof(input);
  if (proof.why !== null) return proof;
  const moved = keepTestChats(asideOf(d), path, proof.left?.testCopy?.keepAside ?? []);
  return moved ? { why: moved } : proof;
}

/**
 * One tree, from the fresh recheck to the ledger: classify, ask the chats and processes, pin, stop its copy,
 * remove, delete the branch. `exclude`/`atOnce` are archive's: the archived chat counts for nothing.
 *
 * Decisions in one repository are taken one at a time and each going folder is claimed under that turn, so two
 * finished folders holding the only two copies of a recording can't each count the other as the copy that stays.
 */
export async function retireTree(d: RetireDeps, root: string, path: string, o: { exclude?: string; atOnce?: boolean; expectHead?: string; going?: NoteGoing } = {}): Promise<TreeOutcome> {
  const repo = await d.classify(root, [path]);
  const t = repo?.trees.find((x) => x.path === path);
  if (!repo || !t) return { state: "skip" };
  if (o.expectHead && t.head !== o.expectHead) return { state: "waiting", row: { path, ...(t.branch ? { branch: t.branch } : {}), why: "Its branch just moved." } };
  const facts = async (): Promise<JudgeFacts> => {
    const [chats, procs, protectedBranches] = await Promise.all([d.chats([path], o.exclude), d.processes(), protectedOf(d, repo)]);
    return { chats, procs, ledger: d.ledger(), finished: finishedFacts(d, repo.main, path), sandboxHolds: sandboxHolds(d), protectedBranches, ...(o.atOnce ? { atOnce: true } : {}) };
  };
  let claimed = false;
  const decideAndClaim = (r: Pick<RepoTrees, "main">, tree: ClassifiedTree): Promise<Verdict> =>
    turnIn(repo.commonDir, async () => {
      const v = await judge(d, r, tree, await facts());
      if (v.do === "retire" && !v.copy) {
        claim(repo.commonDir, path);
        claimed = true;
      }
      return v;
    });
  let v = await decideAndClaim(repo, t);
  if (v.do !== "retire") return outcomeOf(t, v);
  const tip = t.head!;
  const branch = t.branch!;
  try {
    // The pin comes first, whatever happens next.
    if (!(await pinTip(d.gitWrite, repo.main, tip))) return { state: "held", row: heldRow(t, { kind: "other", why: "Its last commit couldn't be pinned." }) };
    if (v.copy) {
      try {
        await d.copies.teardown(path);
      } catch (err) {
        return { state: "held", row: heldRow(t, { kind: "process", why: `Its test copy couldn't be stopped: ${(err as Error).message.split("\n")[0]}` }) };
      }
      // Everything again: the copy's gone, its processes may not be.
      const after = await d.classify(root, [path]);
      const t2 = after?.trees.find((x) => x.path === path);
      if (!after || !t2) return { state: "held", row: heldRow(t, { kind: "other", why: "It left git's list while its test copy stopped." }) };
      if (t2.head !== tip) return { state: "waiting", row: { path, branch, why: "Its branch just moved." } };
      v = await decideAndClaim(after, t2);
      if (v.do !== "retire" || v.copy) return v.do === "retire" ? { state: "held", row: heldRow(t, { kind: "process", why: "Its test copy is still registered." }) } : outcomeOf(t2, v);
    }
    const left = v.left;
    const kept = left?.testCopy?.keepAside ?? [];
    // Moved before the folder goes, and a chat that can't be moved keeps the folder.
    if (kept.length) {
      const moved = keepTestChats(asideOf(d), path, kept);
      if (moved) return { state: "held", row: heldRow(t, { kind: "files", why: moved }) };
    }
    // Settled before anything goes, and recorded with it: a stop in between can't turn a kept branch into a deleted one.
    // The queue's own copies always lose theirs: they aren't anyone's.
    const keepBranch = !t.queueMade && !(await deleteBranchesOn(d, repo));
    const entry = (branchDeleted: boolean, extra: Partial<RemovedWorktree> = {}): RemovedWorktree => ({ v: 1, path, branch, commonDir: repo.commonDir, tip, merged: t.class === "empty" ? "empty" : t.merged ?? "ancestor", branchDeleted, at: d.now(), retired: true, pinned: true, ...(repo.target ? { target: repo.target.name } : {}), ...(t.queueMade ? { queueMade: true as const } : {}), ...(kept.length ? { keptChats: kept.length } : {}), ...(keepBranch ? { branchKept: true as const } : {}), ...extra });
    // Said before the removal: a stop in the middle can't leave a branch that nothing records (finishIntents).
    const intent = entry(false);
    o.going?.(intent, left);
    noteIntent(d, intent);
    // The note above is the intent: a stop this removal sees for itself may finish where the note may.
    const out = await removeTree({ path, main: repo.main, git: d.gitWrite, remove: d.gitRemove, proof: async (cut) => (await proofOf(d, repo.main, path, branch, o.exclude, cut && "intent")).why });
    if (out.state === "refused") {
      dropIntent(d, path);
      return { state: "held", row: heldRow(t, { kind: "other", why: out.reason }) };
    }
    // Still on git's list: no leftover pass will find it, so the note stays for the next pass's finishIntents.
    if (out.state === "held" && out.stillListed) return { state: "held", row: heldRow(t, { kind: "files", why: out.reason }) };
    if (out.state === "held") {
      // Git has forgotten it: the leftover pass finds it again through this entry.
      d.appendLedger([entry(false, { partial: true })]);
      dropIntent(d, path);
      return { state: "held", row: heldRow(t, { kind: "files", why: out.reason }) };
    }
    // In the ledger before the branch goes: a stop in between leaves a record the next pass finishes from.
    const line = entry(false);
    d.appendLedger([line]);
    dropIntent(d, path);
    const del = keepBranch ? { deleted: false } : await retireBranch(d.gitWrite, repo.main, { branch, tip, onMain: t.ancestor });
    if (del.deleted) d.markLedger((x) => x.commonDir === line.commonDir && x.path === line.path && x.at === line.at && x.tip === line.tip, { branchDeleted: true });
    forgetSummary(repo.commonDir);
    await d.removed([path]).catch((err: Error) => console.warn(`[retire] readiness: ${err.message}`));
    return { state: "retired", row: { path, branch, tip, merged: t.class === "empty" ? "empty" : t.merged ?? "ancestor", branchDeleted: del.deleted, ...(keepBranch ? { branchKept: true as const } : {}), ...(out.finished ? { finished: true as const } : {}), ...(t.queueMade ? { queueMade: true as const } : {}), ...(left ? { went: { rebuildable: left.rebuildable, ...(left.testCopy ? { testCopy: left.testCopy } : {}) } } : {}) } };
  } finally {
    if (claimed) unclaim(repo.commonDir, path);
  }
}

// --- leftover folders --------------------------------------------------------------------------

/**
 * Folders left behind with no working branch: found only from chats' worktree records and the ledger,
 * never by looking in a directory. A folder no record names is never even stat'ed. Reads only.
 */
export async function leftoverCandidates(d: Pick<RetireDeps, "git" | "ledger" | "repos">, repo: RepoTrees, records: readonly TreeRecord[]): Promise<LeftoverCandidate[]> {
  const list = await d.git(["worktree", "list", "--porcelain"], { cwd: repo.main });
  if (list.code !== 0) return [];
  const listed = new Set(list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => realOr(l.slice(9))));
  const location = join(realOr(dirname(repo.main)), ".worktrees");
  const out = new Map<string, LeftoverCandidate>();
  let others: OtherRepo[] | null | undefined;
  const readOthers = async (): Promise<OtherRepo[] | null> => (others === undefined ? (others = await otherRepos(d, repo)) : others);
  const consider = (path: string, branch: string | undefined): boolean => {
    if (out.has(path) || !lexists(path)) return false;
    if (listed.has(realOr(path))) return false;
    if (dirname(realOr(path)) !== location) return false;
    return true;
  };
  const newest = new Map<string, string>();
  for (const e of d.ledger()) newest.set(e.path, e.commonDir);
  // The newest entry speaks for a path: a folder another repository has since retired there isn't this one's.
  for (const e of d.ledger()) {
    if (e.commonDir !== repo.commonDir || newest.get(e.path) !== repo.commonDir) continue;
    if (!consider(e.path, e.branch)) continue;
    const whose = await whoseLeftover(d, repo, e.path, undefined, await readOthers());
    // An entry with no last commit never spoke for its branch: a name a record gave it stays no evidence.
    if (whose === "mine") out.set(e.path, { path: e.path, ...(e.branch && e.tip ? { branch: e.branch } : {}) });
  }
  // `.worktrees` is shared by every repository beside it: a record belongs here only if this repository has its base commit.
  for (const r of records) {
    if (!consider(r.path, r.branch)) continue;
    if (newest.has(r.path) && newest.get(r.path) !== repo.commonDir) continue;
    const mine = await d.git(["cat-file", "-e", `${r.base}^{commit}`], { cwd: repo.main });
    if (mine.code !== 0) continue;
    const whose = await whoseLeftover(d, repo, r.path, r.base, await readOthers());
    if (whose === "mine") out.set(r.path, { path: r.path, ...(r.branch ? { branch: r.branch } : {}), base: r.base });
    // Claimed by one repository, so it's in one group, and with no branch: its name may mean something else in either.
    else if (whose === "shared") out.set(r.path, { path: r.path, base: r.base, doubt: SHARED_HISTORY });
  }
  return [...out.values()];
}

export interface LeftoverCandidate {
  path: string;
  branch?: string;
  /** Found by a chat's record, with this base commit. Absent: this repository's own ledger names it. */
  base?: string;
  /** Held, whatever it holds: why. */
  doubt?: string;
}

const SHARED_HISTORY = "Left behind: Another project shares this one's history, so Sova can't tell whose it is.";

interface OtherRepo {
  main: string;
  listed: string[];
}

/** Every other project's worktrees, read now. Null: one that's there couldn't be read, so nothing can be said about any folder. */
async function otherRepos(d: Pick<RetireDeps, "git" | "repos">, repo: Pick<RepoTrees, "main">): Promise<OtherRepo[] | null> {
  try {
    const out = new Map<string, OtherRepo>();
    for (const root of await d.repos()) {
      if (!existsSync(root)) continue;
      const list = await d.git(["worktree", "list", "--porcelain"], { cwd: root });
      if (list.code !== 0) {
        // A project that isn't a git repository registers nothing.
        if (lexists(join(root, ".git"))) return null;
        continue;
      }
      const listed = list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => realOr(l.slice(9)));
      const main = listed[0];
      if (main && main !== realOr(repo.main)) out.set(main, { main, listed });
    }
    return [...out.values()];
  } catch {
    return null;
  }
}

/**
 * Whether a folder not on this repository's list is this repository's leftover. "not mine": another repository registers it, its
 * `.git` says it's another's, or something couldn't be read. "shared": a chat's record names it, it has no `.git`, and another
 * repository has the record's base commit too, so nothing says whose it is; only the first of them answers this, so it's held once.
 */
async function whoseLeftover(d: Pick<RetireDeps, "git">, repo: Pick<RepoTrees, "main" | "commonDir">, path: string, base: string | undefined, others: readonly OtherRepo[] | null): Promise<"mine" | "not mine" | "shared"> {
  const pointer = gitPointer(path, repo.commonDir);
  if (pointer === "elsewhere" || others === null) return "not mine";
  const real = realOr(path);
  if (others.some((o) => o.listed.some((l) => l === real || isWithin(l, real)))) return "not mine";
  if (pointer === "here" || base === undefined) return "mine";
  const sharing: string[] = [];
  for (const o of others) if ((await d.git(["cat-file", "-e", `${base}^{commit}`], { cwd: o.main })).code === 0) sharing.push(o.main);
  if (!sharing.length) return "mine";
  return realOr(repo.main) < [...sharing].sort()[0]! ? "shared" : "not mine";
}

/** Whether a leftover folder is proved one of the queue's own: the ledger says so, or the queue's chats' records do. A doubt is no. */
async function leftoverQueueMade(d: RetireDeps, repo: Pick<RepoTrees, "commonDir">, c: LeftoverCandidate): Promise<boolean> {
  const e = [...d.ledger()].reverse().find((x) => x.commonDir === repo.commonDir && x.path === c.path);
  if (e?.queueMade && (!c.branch || e.branch === c.branch)) return true;
  try {
    return (await d.queueMade?.(c.path)) === true;
  } catch {
    return false;
  }
}

async function retireLeftover(d: RetireDeps, repo: RepoTrees, c: LeftoverCandidate, madeByQueue: boolean, going?: NoteGoing): Promise<TreeOutcome> {
  // Whose it is, read again right before anything goes.
  const whose = await whoseLeftover(d, repo, c.path, c.base, await otherRepos(d, repo));
  if (whose === "not mine") return { state: "skip" };
  if (whose === "shared") return { state: "held", row: heldRow({ path: c.path }, { kind: "other", why: SHARED_HISTORY }) };
  const { why, left } = await turnIn(repo.commonDir, async () => {
    const p = await proofOf(d, repo.main, c.path, c.branch);
    if (p.why === null) claim(repo.commonDir, c.path);
    return p;
  });
  if (why !== null) return { state: "held", row: heldRow(c, { kind: "files", why: `Left behind: ${why}` }) };
  try {
  // Its branch, when it's still there, has nothing left: the proof asked. Pinned before anything goes. A record naming a
  // branch others land on says nothing about that branch: the folder is the leftover.
  // Nor does a record alone, for a folder with no `.git`: the name may be another repository's. That branch isn't pinned or deleted,
  // and with no last commit recorded nothing later treats it as this folder's: Restore refuses, and a chat comes back fresh or is told the name's in use.
  const recordOnly = c.base !== undefined && !madeByQueue && gitPointer(c.path, repo.commonDir) === "none";
  const named = c.branch && !(await protectedOf(d, repo)).has(c.branch) ? c.branch : undefined;
  const branch = recordOnly ? undefined : named;
  let tip = "";
  if (branch) {
    const at = await d.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: repo.main });
    if (at.code === 0) {
      tip = at.stdout.trim();
      if (!(await pinTip(d.gitWrite, repo.main, tip))) return { state: "held", row: heldRow(c, { kind: "other", why: "Left behind: its last commit couldn't be pinned." }) };
    }
  }
  const keptChats = left?.testCopy?.keepAside.length ?? 0;
  const keepBranch = !!tip && !madeByQueue && !(await deleteBranchesOn(d, repo));
  const line: RemovedWorktree = { v: 1, path: c.path, branch: named ?? "", commonDir: repo.commonDir, tip, merged: "leftover", branchDeleted: !tip && !recordOnly, at: d.now(), retired: true, ...(tip ? { pinned: true as const } : {}), ...(keptChats ? { keptChats } : {}), ...(keepBranch ? { branchKept: true as const } : {}), ...(madeByQueue ? { queueMade: true as const } : {}) };
  // A chat in this folder finds it again through the ledger: a stop right after the delete mustn't leave that unsaid (finishIntents).
  going?.(line, left);
  noteIntent(d, line);
  const failed = deleteProvedFolder(c.path);
  if (failed) {
    dropIntent(d, c.path);
    return { state: "held", row: heldRow(c, { kind: "files", why: `Left behind, and deleting it failed: ${failed}.` }) };
  }
  d.appendLedger([line]);
  dropIntent(d, c.path);
  let branchDeleted = line.branchDeleted;
  if (tip && !keepBranch) {
    const del = await retireBranch(d.gitWrite, repo.main, { branch: branch!, tip, onMain: (await d.git(["merge-base", "--is-ancestor", tip, repo.mainBranch ?? "HEAD"], { cwd: repo.main })).code === 0 });
    branchDeleted = del.deleted;
    if (del.deleted) d.markLedger((x) => x.commonDir === line.commonDir && x.path === line.path && x.at === line.at && x.tip === line.tip, { branchDeleted: true });
  }
  const row: RetiredRowOut = { path: c.path, branch: named ?? "", tip, merged: "leftover", branchDeleted, ...(keepBranch ? { branchKept: true as const } : {}), ...(madeByQueue ? { queueMade: true as const } : {}), ...(left ? { went: { rebuildable: left.rebuildable, ...(left.testCopy ? { testCopy: left.testCopy } : {}) } } : {}) };
  forgetSummary(repo.commonDir);
  return { state: "retired", row };
  } finally {
    unclaim(repo.commonDir, c.path);
  }
}

const intentsFile = (d: Pick<RetireDeps, "pendingFile">): string => `${d.pendingFile()}.intents`;
function readIntents(d: Pick<RetireDeps, "pendingFile">): RemovedWorktree[] {
  try {
    const raw = JSON.parse(readFileSync(intentsFile(d), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as RemovedWorktree[]) : [];
  } catch {
    return [];
  }
}
function writeIntents(d: Pick<RetireDeps, "pendingFile">, list: readonly RemovedWorktree[]): void {
  mkdirSync(dirname(intentsFile(d)), { recursive: true });
  const tmp = `${intentsFile(d)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list));
  renameSync(tmp, intentsFile(d));
}
function noteIntent(d: Pick<RetireDeps, "pendingFile">, e: RemovedWorktree): void {
  writeIntents(d, [...readIntents(d).filter((x) => x.path !== e.path), e]);
}
function dropIntent(d: Pick<RetireDeps, "pendingFile">, path: string): void {
  writeIntents(d, readIntents(d).filter((x) => x.path !== path));
}

/** What a stop's finishing did to trees git still listed: nothing else this pass should read them as. */
interface CutOffs {
  finished: RemovedWorktree[];
  held: { entry: RemovedWorktree; row: HeldRow }[];
}

/**
 * A removal a stop cut off, read back by what git and the disk say now. Still listed with `.git` in place, nothing
 * happened and the normal rule decides again; gone, it did happen, and now it's recorded, so the branch can finish;
 * forgotten by git with files left, it's a partial delete for the leftover pass and its proof.
 *
 * Still listed with `.git` gone (or the folder gone), git died inside the delete, and every retry would only hear "validation
 * failed": only the note says what happened. The note must be for this exact path at this very commit and branch; what is
 * left goes under the leftover proof, and one registration is dropped. A note that can't be finished stays for the next pass.
 */
async function finishIntents(d: RetireDeps, repo: RepoTrees): Promise<CutOffs> {
  const out: CutOffs = { finished: [], held: [] };
  for (const e of readIntents(d)) {
    if (e.commonDir !== repo.commonDir) continue;
    const list = await d.git(["worktree", "list", "--porcelain"], { cwd: repo.main });
    if (list.code !== 0) continue;
    const row = parseWorktreeList(list.stdout).find((w) => w.path === e.path);
    if (row && (!lexists(e.path) || !lexists(join(e.path, ".git")))) {
      const held = (kind: HeldRow["kind"], why: string): void => void out.held.push({ entry: e, row: heldRow(e, { kind, why }) });
      if (row.locked) {
        held("other", "A stop cut its removal short, and it is locked now. Unlock it and the next pass finishes it.");
        continue;
      }
      if (row.branch !== e.branch || row.head !== e.tip) {
        held("other", "A stop cut its removal short, and its branch has moved since, so nothing more was done. Look at what is left in the folder, and delete it yourself if nothing there matters.");
        continue;
      }
      if (!(await pinTip(d.gitWrite, repo.main, e.tip))) {
        held("other", "A stop cut its removal short, and its last commit couldn't be pinned.");
        continue;
      }
      const done = await finishCutOff({ path: e.path, main: repo.main, git: d.gitWrite, remove: d.gitRemove, kind: "intent", stopped: "A stop cut its removal short.", proof: async (cut) => (await proofOf(d, repo.main, e.path, e.branch, undefined, cut)).why });
      if (done.state !== "removed") {
        held("files", done.reason);
        continue;
      }
      if (!d.ledger().some((x) => x.path === e.path && x.at === e.at)) d.appendLedger([e]);
      dropIntent(d, e.path);
      forgetSummary(repo.commonDir);
      await d.removed([e.path]).catch((err: Error) => console.warn(`[retire] readiness: ${err.message}`));
      out.finished.push(e);
      continue;
    }
    if (!row && !d.ledger().some((x) => x.path === e.path && x.at === e.at)) d.appendLedger([{ ...e, ...(lexists(e.path) ? { partial: true as const } : {}) }]);
    dropIntent(d, e.path);
  }
  return out;
}

/** What the first pass noted went from a folder, read before any of it did: what a stop or a later read can't say any more. */
function notedWent(pending: PendingFile, path: string, tip: string): RetiredRowOut["went"] | undefined {
  const g = pending.firstPass?.going?.[path];
  if (!g || g.tip !== tip || !g.rebuildable) return undefined;
  return { rebuildable: g.rebuildable, ...(g.testCopy ? { testCopy: g.testCopy as TestCopyLeft } : {}) };
}

/**
 * A retired folder whose branch didn't go with it (git refused, or a stop came in between): tried again at
 * each wake-up, at exactly the recorded commit, and only when no folder has it checked out. A branch
 * that moved, or that restore or a chat brought back, is left alone.
 */
async function finishBranches(d: RetireDeps, repo: RepoTrees): Promise<void> {
  const ledger = d.ledger();
  const protectedBranches = await protectedOf(d, repo);
  for (const e of ledger) {
    if (e.commonDir !== repo.commonDir || !e.retired || e.branchDeleted || !e.tip || !e.branch || e.restoredAt || e.backAt || e.branchKept || protectedBranches.has(e.branch)) continue;
    if (lexists(e.path)) continue;
    // A partial delete whose folder has since gone is finished like any other, unless something newer speaks for this path.
    if (e.partial && [...ledger].reverse().find((x) => x.path === e.path) !== e) continue;
    const at = await d.git(["rev-parse", "--verify", "-q", `refs/heads/${e.branch}^{commit}`], { cwd: repo.main });
    const match = (x: RemovedWorktree): boolean => x.commonDir === e.commonDir && x.path === e.path && x.at === e.at && x.tip === e.tip;
    if (at.code !== 0) {
      d.markLedger(match, { branchDeleted: true });
      continue;
    }
    if (at.stdout.trim() !== e.tip) continue;
    const onMain = repo.mainBranch ? (await d.git(["merge-base", "--is-ancestor", e.tip, repo.mainBranch], { cwd: repo.main })).code === 0 : false;
    const del = await retireBranch(d.gitWrite, repo.main, { branch: e.branch, tip: e.tip, onMain }).catch(() => null);
    if (del?.deleted) d.markLedger(match, { branchDeleted: true });
  }
}

// --- a pass ------------------------------------------------------------------------------------

/** One worktree a pass left alone: on no Held or Waiting list, because it isn't retirement's to hold. */
export interface PlacedRow {
  path: string;
  branch?: string;
}

export interface PassRepo {
  /** The main checkout. */
  repo: string;
  retired: RetiredRowOut[];
  held: HeldRow[];
  waiting: WaitingRow[];
  /** Folders with no branch of their own that went. */
  leftovers: string[];
  /** Worktrees with work of their own, on no branch, or on a branch others land on. The first pass's report. */
  hasWork: PlacedRow[];
  /** The merge queue's own, however they read: never on the lists above but for `retired`. The first pass's report. */
  queueOwn: PlacedRow[];
  /** Its lock looked taken, by this: nothing here was removed, and the Held list says so in one line. */
  lockTaken?: string;
}

export interface PassResult {
  off?: string;
  /** Why this pass read nothing and removed nothing, though the service is on. */
  skipped?: string;
  repos: PassRepo[];
}

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) await fn(items[i]!);
  }));
}

/** What a pass finds in one repository before it changes anything: reads only. The queue's own trees go on neither list. */
export async function judgeRepo(d: RetireDeps, repo: RepoTrees): Promise<{ go: ClassifiedTree[]; held: HeldRow[]; waiting: WaitingRow[]; hasWork: PlacedRow[]; queueOwn: PlacedRow[] }> {
  const candidates = repo.trees.filter((t) => t.class !== "unmerged" || t.unknown || t.drafts?.length);
  const [chats, procs, protectedBranches] = await Promise.all([d.chats(candidates.map((t) => t.path)), d.processes(), protectedOf(d, repo)]);
  const out: Awaited<ReturnType<typeof judgeRepo>> = { go: [], held: [], waiting: [], hasWork: [], queueOwn: [] };
  const placed = (t: ClassifiedTree): PlacedRow => ({ path: t.path, ...(t.branch ? { branch: t.branch } : {}) });
  for (const t of repo.trees) {
    if (!candidates.includes(t)) {
      (t.queueMade ? out.queueOwn : out.hasWork).push(placed(t));
      continue;
    }
    const facts: JudgeFacts = { chats, procs, ledger: d.ledger(), finished: finishedFacts(d, repo.main, t.path), sandboxHolds: sandboxHolds(d), protectedBranches };
    const v = await judge(d, repo, t, facts);
    if (v.do === "retire") out.go.push(t);
    // Every worktree in exactly one group: a queue-made tree held, waiting or skipped is the queue's own.
    else if (t.queueMade) out.queueOwn.push(placed(t));
    else if (v.do === "skip") out.hasWork.push(placed(t));
    else {
      const o = outcomeOf(t, v);
      if (o.state === "held") out.held.push(o.row);
      else if (o.state === "waiting") out.waiting.push(o.row);
    }
  }
  return out;
}

/** One repository, under its lock. */
async function passRepo(d: RetireDeps, root: string, records: readonly TreeRecord[], pending: PendingFile, firstPass: boolean): Promise<PassRepo | null> {
  forgetIndexes();
  const repo = await d.classify(root);
  if (!repo) return null;
  const lock = repoLockFile(repo.commonDir);
  if (!takeLock(lock, d.alive)) {
    const who = lockOwnerWords(lock);
    if (who) {
      // One line on the Held tab; what was held before stays until a pass reads again.
      const was = pending.repos[repo.commonDir];
      pending.repos[repo.commonDir] = { main: repo.main, commonDir: repo.commonDir, held: was?.held ?? [], waiting: was?.waiting ?? [], at: d.now(), lockTaken: who };
      writePending(pending, d.pendingFile());
    }
    return { repo: repo.main, retired: [], held: [], waiting: [], leftovers: [], hasWork: [], queueOwn: [], ...(who ? { lockTaken: who } : {}) };
  }
  try {
    const out: PassRepo = { repo: repo.main, retired: [], held: [], waiting: [], leftovers: [], hasWork: [], queueOwn: [] };
    // First: what a stop left half done. A partial entry the removal itself finished by proof isn't one any more once the folder's gone.
    const cutOffs = await finishIntents(d, repo);
    await finishBranches(d, repo);
    // Read from the ledger after the branches ran: the row says what became of its branch, as an unbroken removal's does.
    const ledgerNow = d.ledger();
    for (const e of cutOffs.finished) {
      const line = [...ledgerNow].reverse().find((x) => x.commonDir === e.commonDir && x.path === e.path && x.at === e.at) ?? e;
      const went = notedWent(pending, e.path, e.tip);
      out.retired.push({ path: e.path, branch: e.branch, tip: e.tip, merged: e.merged, branchDeleted: line.branchDeleted, finished: true, ...(e.branchKept ? { branchKept: true as const } : {}), ...(e.queueMade ? { queueMade: true as const } : {}), ...(went ? { went } : {}) });
    }
    for (const h of cutOffs.held) {
      if (h.entry.queueMade) out.queueOwn.push({ path: h.entry.path, ...(h.entry.branch ? { branch: h.entry.branch } : {}) });
      else out.held.push(h.row);
    }
    // Those are answered: judged again here they would be a second row, and a retry git can only refuse.
    const answered = new Set([...cutOffs.finished.map((e) => e.path), ...cutOffs.held.map((h) => h.entry.path)]);
    const { go, held, waiting, hasWork, queueOwn } = await judgeRepo(d, { ...repo, trees: repo.trees.filter((t) => !answered.has(t.path)) });
    out.held.push(...held);
    out.waiting.push(...waiting);
    out.hasWork.push(...hasWork);
    out.queueOwn.push(...queueOwn);
    // Every last commit pinned and the list recorded before anything goes: the first pass's promise, and cheap every time.
    const pinned = new Map<string, boolean>();
    for (const t of go) pinned.set(t.path, await pinTip(d.gitWrite, repo.main, t.head!));
    if (firstPass) {
      const list = go.map((t) => ({ main: repo.main, path: t.path, branch: t.branch!, tip: t.head!, pinned: !!pinned.get(t.path) }));
      const known = new Set((pending.firstPass?.list ?? []).map((x) => `${x.path}\0${x.tip}`));
      pending.firstPass = { ...pending.firstPass, at: pending.firstPass?.at ?? d.now(), list: [...(pending.firstPass?.list ?? []), ...list.filter((x) => !known.has(`${x.path}\0${x.tip}`))] };
      writePending(pending, d.pendingFile());
      writeFirstPassReport(d, pending);
    }
    const report = (): void => {
      const rep: RepoReport = { main: repo.main, commonDir: repo.commonDir, held: out.held, waiting: out.waiting, at: d.now() };
      pending.repos[repo.commonDir] = rep;
      writePending(pending, d.pendingFile());
    };
    report();
    // Written before each removal starts, so a stop anywhere after it loses neither the row nor what went.
    const going: NoteGoing | undefined = firstPass
      ? (e, left) => {
          // A stop's retry reads a folder that already lost or moved things: what the first attempt noted is what really went.
          const earlier = notedWent(pending, e.path, e.tip);
          const went = earlier ?? (left ? { rebuildable: left.rebuildable, ...(left.testCopy ? { testCopy: left.testCopy } : {}) } : {});
          pending.firstPass = { ...pending.firstPass!, going: { ...pending.firstPass?.going, [e.path]: { main: repo.main, tip: e.tip, at: e.at, ...went } } };
          writePending(pending, d.pendingFile());
        }
      : undefined;
    await pool(go, CONCURRENCY, async (t) => {
      // A failure on one tree holds that tree. The next pass reads everything again.
      const r = await retireTree(d, root, t.path, { expectHead: t.head!, ...(going ? { going } : {}) }).catch((err: Error): TreeOutcome => ({ state: "held", row: heldRow(t, { kind: "other", why: `It failed: ${err.message.split("\n")[0]}` }) }));
      if (r.state === "retired") {
        const went = notedWent(pending, r.row.path, r.row.tip);
        out.retired.push(went ? { ...r.row, went } : r.row);
      } else if (t.queueMade) out.queueOwn.push({ path: t.path, ...(t.branch ? { branch: t.branch } : {}) });
      else if (r.state === "held") out.held.push(r.row);
      else if (r.state === "waiting") out.waiting.push(r.row);
    });
    await finishBranches(d, repo);
    const leftovers = await leftoverCandidates(d, repo, records);
    await pool(leftovers, CONCURRENCY, async (c) => {
      if (c.doubt) {
        out.held.push(heldRow({ path: c.path }, { kind: "other", why: c.doubt }));
        return;
      }
      const own = await leftoverQueueMade(d, repo, c);
      const r = await retireLeftover(d, repo, c, own, going).catch((err: Error): TreeOutcome => ({ state: "held", row: heldRow(c, { kind: "other", why: `It failed: ${err.message.split("\n")[0]}` }) }));
      if (r.state === "retired") {
        out.retired.push(r.row);
        out.leftovers.push(c.path);
      } else if (r.state === "held") (own ? out.queueOwn.push({ path: c.path, ...(c.branch ? { branch: c.branch } : {}) }) : out.held.push(r.row));
    });
    if (firstPass) recoverStopped(d, repo, out, pending);
    report();
    if (firstPass) {
      const groups = groupsOf(out);
      pending.firstPass = { ...pending.firstPass!, repos: { ...pending.firstPass?.repos, [repo.main]: pending.firstPass?.repos?.[repo.main] ?? groups } };
      writePending(pending, d.pendingFile());
      writeFirstPassReport(d, pending);
    }
    return out;
  } finally {
    dropLock(lock);
  }
}

/**
 * What an earlier, stopped first pass removed here, put back into this pass's result, so the report and the summary read as if
 * nothing had stopped it. Only what the ledger says happened counts (the note written before is a report), and anything this pass
 * read for itself speaks for its own folder.
 */
function recoverStopped(d: Pick<RetireDeps, "ledger">, repo: Pick<RepoTrees, "main" | "commonDir">, out: PassRepo, pending: PendingFile): void {
  const read = new Set([...out.retired, ...out.held, ...out.waiting, ...out.hasWork, ...out.queueOwn].map((x) => x.path));
  const ledger = d.ledger();
  for (const [path, g] of Object.entries(pending.firstPass?.going ?? {})) {
    if (g.main !== repo.main || read.has(path)) continue;
    const e = [...ledger].reverse().find((x) => x.commonDir === repo.commonDir && x.path === path && x.retired && x.tip === g.tip && x.at >= g.at);
    if (!e) continue;
    if (e.partial && lexists(path)) {
      if (e.queueMade) out.queueOwn.push({ path, ...(e.branch ? { branch: e.branch } : {}) });
      else out.held.push(heldRow({ path, ...(e.branch ? { branch: e.branch } : {}) }, { kind: "files", why: "Left behind: A stop cut its removal short." }));
      continue;
    }
    out.retired.push({ path, branch: e.branch, tip: e.tip, merged: e.merged, branchDeleted: e.branchDeleted, ...(e.branchKept ? { branchKept: true as const } : {}), ...(e.queueMade ? { queueMade: true as const } : {}), ...(g.rebuildable ? { went: { rebuildable: g.rebuildable, ...(g.testCopy ? { testCopy: g.testCopy as TestCopyLeft } : {}) } } : {}) });
    if (e.merged === "leftover") out.leftovers.push(path);
  }
}

/** One repository's pass as the report's groups: every worktree and leftover folder in exactly one. */
function groupsOf(r: PassRepo): FirstPassGroups {
  const row = (x: RetiredRowOut): FirstPassGroups["retired"][number] => ({ path: x.path, branch: x.branch, tip: x.tip, merged: x.merged, branchDeleted: x.branchDeleted, ...(x.went ?? {}) });
  return {
    retired: r.retired.filter((x) => !x.queueMade).map(row),
    held: r.held.map((x) => ({ path: x.path, ...(x.branch ? { branch: x.branch } : {}), reason: x.reason })),
    waiting: r.waiting.map((x) => ({ path: x.path, ...(x.branch ? { branch: x.branch } : {}), reason: x.why })),
    hasWork: r.hasWork,
    queueOwn: [...r.retired.filter((x) => x.queueMade).map((x) => ({ ...row(x), retired: true as const })), ...r.queueOwn],
  };
}

/** `<state root>/retire-first-pass.json`: the list and every pin before anything goes, then each project's groups. */
function writeFirstPassReport(d: RetireDeps, pending: PendingFile): void {
  const fp = pending.firstPass;
  if (!fp) return;
  const groups: FirstPassGroups = { retired: [], held: [], waiting: [], hasWork: [], queueOwn: [] };
  for (const g of Object.values(fp.repos ?? {})) for (const k of Object.keys(groups) as (keyof FirstPassGroups)[]) (groups[k] as unknown[]).push(...g[k]);
  const file = firstPassFileOf(d);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, at: fp.at, done: !!fp.done, list: fp.list, groups, repos: fp.repos ?? {} }, null, 1)}\n`);
  renameSync(tmp, file);
}

/** One pass over every project. Off, it reads and removes nothing at all. */
export async function retirePass(d: RetireDeps): Promise<PassResult> {
  const gate = d.allowed();
  if (!gate.on) return { off: gate.why, repos: [] };
  const pending = readPending(d.pendingFile());
  // Who uses what, first: nothing goes on a list of chats that can't be read.
  let records: Awaited<ReturnType<RetireDeps["records"]>>;
  try {
    records = await d.records();
  } catch (err) {
    return { skipped: `The chats couldn't be read: ${(err as Error).message}`, repos: [] };
  }
  const firstPass = !pending.firstPass?.done;
  const repos: PassRepo[] = [];
  let failed: string | undefined;
  for (const root of await d.repos()) {
    try {
      const r = await passRepo(d, root, records.records, pending, firstPass);
      if (r) repos.push(r);
      // A repository whose lock looked taken wasn't read: the first pass isn't over for it.
      if (r?.lockTaken) failed ??= `${root}: its lock looks taken (${r.lockTaken})`;
    } catch (err) {
      failed = `${root}: ${(err as Error).message}`;
      console.warn(`[retire] ${failed}`);
    }
  }
  pending.lastPassAt = d.now();
  writePending(pending, d.pendingFile());
  const result: PassResult = { ...(failed ? { skipped: failed } : {}), repos };
  if (firstPass && !failed) {
    // Marked before the post: this pass was the first, whether or not the summary gets through.
    pending.firstPass = { ...pending.firstPass, at: pending.firstPass?.at ?? d.now(), list: pending.firstPass?.list ?? [], done: true, summary: result };
    delete pending.firstPass.going;
    writePending(pending, d.pendingFile());
    writeFirstPassReport(d, pending);
  }
  // Posted only when it was: an Overseer that's busy or won't open gets the first pass's summary at a later pass.
  const owed = pending.firstPass?.done && !pending.firstPass.posted ? pending.firstPass : null;
  if (owed?.summary && d.firstPassDone) {
    const posted = await Promise.resolve(d.firstPassDone(owed.summary)).catch((err: Error) => {
      console.warn(`[retire] the first pass's summary wasn't posted: ${err.message}`);
      return false;
    });
    if (posted !== false) {
      pending.firstPass = { ...pending.firstPass, at: owed.at, list: owed.list, done: true, posted: true };
      delete pending.firstPass.summary;
      writePending(pending, d.pendingFile());
    }
  }
  return result;
}

// --- coming back -------------------------------------------------------------------------------

async function mainOfCommonDir(git: GitRunner, commonDir: string): Promise<string | null> {
  if (!existsSync(commonDir)) return null;
  const r = await git(["worktree", "list", "--porcelain"], { cwd: commonDir });
  if (r.code !== 0) return null;
  const first = r.stdout.split("\n").find((l) => l.startsWith("worktree "));
  return first ? first.slice(9) : null;
}

/** Whether the branch of that name is still the one the setting kept: its recorded last commit is in it. A doubt is no. */
async function onKeptLine(d: RetireDeps, main: string, e: RemovedWorktree): Promise<boolean> {
  return (await d.git(["merge-base", "--is-ancestor", e.tip, `refs/heads/${e.branch}`], { cwd: main })).code === 0;
}

export type RestoreResult = { ok: true; path: string; branch: string } | { ok: false; error: string };

/**
 * Restore (§chat.worktrees/retirement): the branch back at its recorded last commit and its folder at its
 * old place, nothing else. A branch or folder already there refuses it, naming which, with nothing changed.
 * A restored branch then waits 7 days.
 */
export async function restoreRetired(d: RetireDeps, o: { root: string; path: string; branch: string; tip: string }): Promise<RestoreResult> {
  const repo = await d.classify(o.root, []);
  if (!repo) return { ok: false, error: "That project's repository wasn't found." };
  const e = [...d.ledger()].reverse().find((x) => x.commonDir === repo.commonDir && x.path === o.path && x.branch === o.branch && x.tip === o.tip && x.retired);
  if (!e) return { ok: false, error: "Sova has no record of retiring that branch." };
  if (!e.tip) return { ok: false, error: "Sova has no last commit recorded for it." };
  const known = await d.git(["cat-file", "-e", `${e.tip}^{commit}`], { cwd: repo.main });
  if (known.code !== 0) return { ok: false, error: `Its last commit ${e.tip.slice(0, 7)} isn't in this repository any more.` };
  const there = (await d.git(["rev-parse", "--verify", "-q", `refs/heads/${e.branch}`], { cwd: repo.main })).code === 0;
  // A branch the setting kept stands as it is. One deleted that exists again isn't it: only the kept line, moved or not, counts.
  if (there && !(e.branchKept && (await onKeptLine(d, repo.main, e)))) return { ok: false, error: `${e.branch} already exists. Nothing was changed.` };
  if (lexists(e.path)) return { ok: false, error: `${e.path} already exists. Nothing was changed.` };
  const add = await d.gitWrite(there ? ["worktree", "add", "--", e.path, e.branch] : ["worktree", "add", "-b", e.branch, "--", e.path, e.tip], repo.main);
  if (add.code !== 0) return { ok: false, error: (add.stderr || add.stdout).trim().split("\n")[0] || "Git refused." };
  d.markLedger((x) => x === e || (x.commonDir === e.commonDir && x.path === e.path && x.tip === e.tip && x.at === e.at), { restoredAt: d.now() });
  forgetSummary(repo.commonDir);
  await d.removed([e.path]).catch(() => undefined);
  return { ok: true, path: e.path, branch: e.branch };
}

export type BringBackResult =
  | { state: "none" }
  | { state: "back"; path: string; branch: string; target: string; sha: string; line: string }
  /** The chat stays in the home folder, and `line` tells it why. */
  | { state: "failed"; reason: string; line: string };

/** The newest retirement of the worktree `cwd` is in, with nothing having brought it back yet, and its folder gone if the delete stopped part way. Null: nothing recorded, one deleted by hand, or a partial delete still held. */
export function retiredEntryFor(ledger: readonly RemovedWorktree[], cwd: string): RemovedWorktree | null {
  return retiredEntryCovering(ledger, canonical(cwd));
}

const flights = new Map<string, Promise<BringBackResult>>();

/**
 * A message or a worker's start to a chat whose own folder is in a retired worktree brings it back before
 * the turn: the same place, the same branch name, fresh from the newest target, setup run. Reading never
 * calls this. Whatever is in the way leaves the chat in the home folder, told why.
 */
export function bringBack(d: RetireDeps, cwd: string): Promise<BringBackResult> {
  const e = retiredEntryFor(d.ledger(), cwd);
  if (!e) return Promise.resolve({ state: "none" });
  const flying = flights.get(e.path);
  if (flying) return flying;
  const flight = bringBackOf(d, e).finally(() => flights.delete(e.path));
  flights.set(e.path, flight);
  return flight;
}

async function bringBackOf(d: RetireDeps, e: RemovedWorktree): Promise<BringBackResult> {
  const failed = (reason: string): BringBackResult => ({ state: "failed", reason, line: `Your worktree was retired after ${e.branch} landed, and it couldn't be brought back: ${reason} You're in the home folder.` });
  // The folder is back already (another chat's message): nothing more to do, and that chat's entry reads back.
  if (lexists(e.path)) return failed(`The folder ${e.path} is in use.`);
  const main = await mainOfCommonDir(d.git, e.commonDir);
  if (!main) return failed("Its repository is gone.");
  const repo = await d.classify(main, []);
  if (!repo?.target) return failed("Its repository has no branch to start from.");
  const here = (await d.git(["rev-parse", "--verify", "-q", `refs/heads/${e.branch}^{commit}`], { cwd: main }));
  if (here.code === 0 && e.branchKept && (await onKeptLine(d, main, e))) {
    // Kept by the setting: the folder comes back on it as it stands, never moved.
    const add = await d.gitWrite(["worktree", "add", "--", e.path, e.branch], main);
    if (add.code !== 0) return failed(`Git refused: ${(add.stderr || add.stdout).trim().split("\n")[0]}`);
    d.markLedger((x) => x.commonDir === e.commonDir && x.path === e.path && x.at === e.at, { backAt: d.now() });
    forgetSummary(repo.commonDir);
    await d.removed([e.path]).catch(() => undefined);
    const setupFailed = d.setup ? await d.setup(e.path).catch((err: Error) => err.message) : null;
    const sha = here.stdout.trim().slice(0, 7);
    const line = `Your worktree was retired after ${e.branch} landed. It's back at ${e.path}, on ${e.branch} as it was at ${sha}. It may be behind ${repo.target.name}.${setupFailed ? ` Its setup failed: ${setupFailed.split("\n")[0]}` : ""}`;
    return { state: "back", path: e.path, branch: e.branch, target: repo.target.name, sha, line };
  }
  if (here.code === 0) {
    // Still at the commit it retired at, because its delete hasn't finished: that's the stop finishing, not someone else's branch.
    const at = await d.git(["rev-parse", "--verify", "-q", `refs/heads/${e.branch}^{commit}`], { cwd: main });
    const ours = !e.branchDeleted && at.stdout.trim() === e.tip && !(await protectedOf(d, repo)).has(e.branch);
    const del = ours ? await retireBranch(d.gitWrite, main, { branch: e.branch, tip: e.tip, onMain: false }).catch(() => null) : null;
    if (!del?.deleted) return failed(`The branch name ${e.branch} is in use.`);
  }
  const add = await d.gitWrite(["worktree", "add", "-b", e.branch, "--", e.path, repo.target.oid], main);
  if (add.code !== 0) return failed(`Git refused: ${(add.stderr || add.stdout).trim().split("\n")[0]}`);
  const sha = repo.target.oid.slice(0, 7);
  d.markLedger((x) => x.commonDir === e.commonDir && x.path === e.path && x.at === e.at, { backAt: d.now() });
  forgetSummary(repo.commonDir);
  await d.removed([e.path]).catch(() => undefined);
  const setupFailed = d.setup ? await d.setup(e.path).catch((err: Error) => err.message) : null;
  const line = `Your worktree was retired after ${e.branch} landed. It's back at ${e.path}, on ${e.branch}, fresh from ${repo.target.name} at ${sha}.${setupFailed ? ` Its setup failed: ${setupFailed.split("\n")[0]}` : ""}`;
  return { state: "back", path: e.path, branch: e.branch, target: repo.target.name, sha, line };
}

// --- the real wiring ---------------------------------------------------------------------------

let real: RetireDeps | null = null;

/** The real dependencies; each lazily, so a test of the pure rules loads none of this. */
export function realRetireDeps(): RetireDeps {
  if (real) return real;
  real = {
    allowed: () => retirementAllowed(),
    repos: async () => (await import("./projects/spaces")).listProjects().map((p) => p.root),
    git: execGit,
    gitWrite: runGit,
    gitRemove: longGit,
    classify: async (root, only) => classifyRepo(root, { withQueueMade: true, ...(only ? { only } : {}) }),
    chats: async (paths, exclude) => {
      const facts = await chatUses(paths, exclude);
      return facts;
    },
    records: async () => {
      const r = await treeRecords();
      if (!r.records.length && !r.unreadable.length) {
        // Zero chats is what a session folder that can't be listed also looks like (listSessionFiles swallows that).
        const { listSessionFiles } = await import("./sessions-index");
        if (!(await listSessionFiles()).length) throw new Error("no chat session could be listed");
      }
      return r;
    },
    processes: () => scanProcesses(),
    alive: pidAlive,
    openEntry: (main, branch) => openQueueEntry(main, branch),
    draftsUnproved: async (main, folder, branch) => {
      const { branchLeft } = await import("./nothing-left");
      const repo = await classifyRepo(main, { only: [] });
      if (!repo?.target) return ["unknown"];
      const tip = branch ? await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main }) : null;
      const left = await branchLeft({ root: main, folder, ...(branch ? { branch } : {}), head: tip?.code === 0 ? tip.stdout.trim() : repo.target.oid, target: repo.target });
      return left.drafts;
    },
    branchFinished: async (main, branch) => {
      const { branchLeft } = await import("./nothing-left");
      const repo = await classifyRepo(main, { only: [] });
      if (!repo?.target) return false;
      const tip = await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main });
      if (tip.code !== 0) return false;
      const left = await branchLeft({ root: main, branch, head: tip.stdout.trim(), target: repo.target });
      return !left.code.left && left.code.kind !== "unknown";
    },
    copies: {
      of: (path) => registeredCopyOf(path, (id) => linksOf(id, { activeOnly: true }).length),
      teardown: async (path) => (await import("./project-services/checkout-teardown")).teardownCopyOf(path, undefined, { keepWorktree: true }),
    },
    ledger: () => readLedger(),
    appendLedger: (e) => appendLedger(e),
    markLedger: (m, p) => markLedger(m, p),
    removed: async (paths) => (await import("./merge-readiness")).worktreesRemoved(paths),
    targetOf: async (main) => (await import("./merge-queue/wire")).landingTargetOf(main),
    setup: async (path) => {
      return (await import("./project-services/checkout-teardown")).setUpCheckout(path);
    },
    now: Date.now,
    pendingFile,
    firstPassFile: () => join(stateRoot(), "retire-first-pass.json"),
    testChatsAside: () => join(stateRoot(), "retired-test-chats"),
    realChatsDir: () => join(agentRoot(), "sessions"),
    platform: () => process.platform,
    queueMade: async (path) => (await import("./merge-queue/wire")).worktreeQueueMade(path),
  };
  return real;
}

/** Tests: use these instead of the real wiring (archive's, Remove Worktree's proof). */
export function setRealRetireDeps(d: RetireDeps | null): void {
  real = d;
}

/** Whether a removal in this folder's repository would keep the branch (a row's confirm). A repository it can't read: yes. */
export async function keepsBranchAt(path: string, d: RetireDeps = realRetireDeps()): Promise<boolean> {
  const dir = [path, ...besideGone(path)].find((x) => existsSync(x));
  const repo = dir ? await d.classify(dir, []) : null;
  return !repo || !(await deleteBranchesOn(d, repo));
}

/** Why what a partial delete left may not be finished, or null: Remove Worktree's and teardown's proof. */
export async function leftoverProofHere(path: string, main: string, branch?: string, cut?: CutOffKind): Promise<string | null> {
  // No note of this service's stands behind these callers: a cut-off folder has to be inside the worktrees location as well.
  return (await proofOf(realRetireDeps(), main, path, branch, undefined, cut && "listed")).why;
}

/** Archive (§app.overseer/tools): one tree through the same service, at once, the archived chat counting for nothing. */
export async function retireNow(dir: string, path: string, exclude: string | undefined, d: RetireDeps = realRetireDeps()): Promise<TreeOutcome | { state: "kept"; reason: string }> {
  const repo = await d.classify(dir, [path]);
  if (!repo) return { state: "kept", reason: "Its repository wasn't found" };
  if (!repo.trees.some((t) => t.path === path)) return { state: "kept", reason: "No longer in git's worktree list." };
  const lock = repoLockFile(repo.commonDir);
  if (!takeLock(lock, d.alive)) return { state: "kept", reason: "A cleanup of this repository is already running" };
  forgetIndexes();
  try {
    return await retireTree(d, repo.main, path, { ...(exclude ? { exclude } : {}), atOnce: true });
  } finally {
    dropLock(lock);
  }
}

export type RemoveAnswer = { ok: true; path: string; branch: string; branchDeleted: boolean } | { ok: false; error: string };

/**
 * POST /api/worktrees/remove: the Remove on a Worktrees row of an install where retirement is off because it runs on an
 * agent directory of its own (§chat.worktrees/pane). The server decides, whatever a screen shows: anywhere else it
 * removes nothing, and there it goes through the same rule and the one removal step as retirement, at once rather than
 * at the next wake-up. A chat that isn't quiet, a file only there or a running process refuses it, with the reason.
 */
export async function removeFinished(path: string, d: RetireDeps = realRetireDeps(), gate: Gate = d.allowed()): Promise<RemoveAnswer> {
  if (gate.on || gate.offFor !== "install") return { ok: false, error: `Remove is only for an install where automatic cleanup is off. Nothing was removed. ${gate.on ? "Sova retires finished worktrees on its own here." : gate.why}` };
  const dir = [path, ...besideGone(path)].find((x) => existsSync(x));
  const r = dir ? await retireNow(dir, path, undefined, d) : { state: "kept" as const, reason: "Its repository wasn't found" };
  const no = (why: string): RemoveAnswer => ({ ok: false, error: `${why.replace(/\.$/, "")}. Nothing was removed.` });
  switch (r.state) {
    case "retired":
      return { ok: true, path, branch: r.row.branch, branchDeleted: r.row.branchDeleted };
    case "held":
      return no(r.row.reason);
    case "waiting":
      return no(r.row.why);
    case "kept":
      return no(r.reason);
    default:
      return no("It has work to land");
  }
}

// --- the service -------------------------------------------------------------------------------

export interface Retirer {
  wake(reason: string): void;
  stop(): void;
  /** Why it isn't running; absent when it is. */
  off?: string;
}

const machineLockFile = (): string => join(agentRoot(), "sova", "retire.lock");

/**
 * The service. One per machine: it holds a lock next to the state root, and only a server on the real agent
 * dir gets that far. Off, it subscribes to nothing, runs nothing and writes nothing.
 */
export function startWorktreeRetirer(o: { deps?: RetireDeps; startDelayMs?: number; subscribe?: (wake: (reason: string) => void) => (() => void)[]; ready?: () => Promise<boolean> | boolean; lockFile?: string } = {}): Retirer {
  const d = o.deps ?? realRetireDeps();
  const gate = d.allowed();
  if (!gate.on) {
    console.log(`[retire] off: ${gate.why}`);
    return { wake: () => undefined, stop: () => undefined, off: gate.why };
  }
  const lock = o.lockFile ?? machineLockFile();
  if (!takeLock(lock, d.alive)) {
    console.log("[retire] off: another Sova on this machine runs it");
    return { wake: () => undefined, stop: () => undefined, off: "Another Sova on this machine runs it." };
  }
  let stopped = false;
  let running = false;
  let again = false;
  let lastAt = readPending(d.pendingFile()).lastPassAt ?? 0;
  let timer: NodeJS.Timeout | null = null;
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (!(await Promise.resolve(o.ready?.() ?? true).catch(() => false))) return;
    running = true;
    try {
      lastAt = d.now();
      const r = await retirePass(d);
      const n = r.repos.reduce((a, x) => a + x.retired.length, 0);
      if (n) console.log(`[retire] retired ${n} worktree${n === 1 ? "" : "s"}`);
      if (r.skipped) console.warn(`[retire] ${r.skipped}`);
    } catch (err) {
      console.warn(`[retire] pass failed: ${(err as Error).message}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        wake("again");
      }
    }
  };
  const wake = (_reason: string): void => {
    if (stopped || timer) return;
    const wait = Math.max(0, PASS_GAP_MS - (d.now() - lastAt));
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, wait);
    timer.unref?.();
  };
  const offs = o.subscribe?.(wake) ?? [];
  const period = setInterval(() => wake("period"), PERIOD_MS);
  period.unref?.();
  const first = setTimeout(() => void run(), o.startDelayMs ?? PASS_GAP_MS);
  first.unref?.();
  return {
    wake,
    stop() {
      stopped = true;
      clearInterval(period);
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      for (const off of offs) off();
      dropLock(lock);
    },
  };
}

/** Test seam: the file names. */
export const retireFiles = { repoLockFile, pinRef };

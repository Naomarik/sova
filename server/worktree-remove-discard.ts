// Discard Branch… (the Land ▾ menu's page-only action): a branch you won't land goes with everything on it. Its
// folder (only the files whose listing you saw, Remove Anyway's digest), then its branch at exactly the tip you saw,
// with no backup (no refs/sova/retired pin, no removed-worktrees row), then its chat archived. Refused, naming why,
// while it is the main checkout or the branch it lands into, while the queue has an entry for it, while its chat or a
// worker in its folder is working, or once its head moved. The whole act holds the retirer's lock of the repository
// (server/worktree-retire.ts), so a cleanup pass never runs beside it.
//
// The core takes its world as deps (tests stand in a fake git and chats); `realDiscardDeps` wires the server's.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "../pi-config/extensions/worktrees/git.ts";
import type { DiscardBranchPreview, DiscardBranchResult, DiscardBranchStep } from "../shared/merge-queue";
import type { WorktreeRemoveAnyway } from "../shared/protocol";
import { NO_BACKGROUND_CLEANUP } from "./git-no-background";
import { chatInUse, type CutOffKind, liveRecordPid, realOr, removeTree } from "./worktree-remove";
import type { Leftovers } from "./worktree-leftovers";
import type { ChatUse, ProcFacts } from "./worktree-cleanup";

/** The refusals, word for word (the copy the confirm's disabled button shows). */
export const DISCARD_WORDS = {
  main: "That's the main checkout.",
  inQueue: "It's in the merge queue.",
  chatWorking: "Its chat is working.",
  chatTui: "Its chat is open in a TUI.",
  worker: "A worker is running in its folder.",
  moved: "Its branch moved since you looked: look again.",
  noBranch: "There's no such branch any more.",
  noTarget: "The branch it lands into couldn't be read.",
  locked: "A cleanup of this repository is running: try again in a moment.",
  changed: "Its files changed since you looked. Nothing was deleted. Look again.",
} as const;

export const process_words = (p: { command: string; pid: number }): string => `A process is running in its folder: ${p.command} (${p.pid}).`;

/** How many of the branch's commits the preview lists by line; the count is always exact. */
export const COMMITS_SHOWN = 20;

/** The branch's chat, as the owner rule (server/merge-queue/owners.ts) finds it. */
export interface DiscardOwner {
  id: string;
  title: string;
  path: string;
  archived: boolean;
  /** Open in a TUI. */
  tui: boolean;
}

export interface DiscardDeps {
  /** Reads and the branch's delete, in the main checkout. */
  git: Git;
  /** `git worktree remove` (a long time limit). Default: git. */
  remove?: Git;
  /** The branch it lands into, and whether the queue serves the project; null target: unknown. */
  target(root: string): Promise<string | null>;
  /** The queue's standing entry for the branch (queued, checking, approved, waiting…), or null. */
  openEntry(root: string, branch: string): Promise<{ id: string; state: string } | null>;
  /** The branch's chat (folder null: found by the chats' worktree records). */
  owner(root: string, branch: string, folder: string | null): Promise<DiscardOwner | null>;
  /** A turn runs in the chat now. */
  chatBusy(path: string): boolean;
  /** Its workers that are working now. */
  workingSubagents(path: string): number;
  /** The chats with a folder inside `folder` or tracking it. */
  uses(folder: string): Promise<{ uses: ChatUse[]; unreadable: string[] }>;
  processes(): Promise<ProcFacts[]>;
  alive(pid: number): boolean;
  /** What the folder holds that git doesn't (server/worktree-leftovers.ts). */
  leftovers(folder: string): Promise<Leftovers>;
  digestOf(l: Leftovers): string;
  listingOf(l: Leftovers): WorktreeRemoveAnyway;
  draftNames(folder: string): string[];
  /** A partial delete's proof (Remove Worktree's); null: what's left may go. */
  proof?(folder: string, root: string, branch: string, cut?: CutOffKind): Promise<string | null>;
  /** Run `fn` with Remove Anyway's permission for this listing (server/project-worktrees.ts). */
  withAnyway<T>(folder: string, digest: string, fn: () => Promise<T>): Promise<T>;
  /** The retirer's repository lock: its file, taken and dropped. */
  lockFile(root: string): Promise<string | null>;
  takeLock(file: string): boolean;
  dropLock(file: string): void;
  /** POST /api/sessions/archive's own function, a plain archive. */
  archive(path: string): Promise<{ ok: true } | { ok: false; error: string }>;
  close(path: string, message: string): Promise<unknown>;
  now(): number;
}

export interface DiscardRequest {
  root: string;
  branch: string;
  commit: string;
}

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "git failed";

/** git's worktree list: each folder and the branch it has checked out (the first is the main checkout). */
async function worktreeList(git: Git, root: string): Promise<{ path: string; branch: string | null }[]> {
  const r = await git(["worktree", "list", "--porcelain"], root);
  if (r.code !== 0) throw new Error(`Git couldn't list its worktrees: ${firstLine(r.stderr || r.stdout)}`);
  const out: { path: string; branch: string | null }[] = [];
  for (const block of r.stdout.split("\n\n")) {
    const lines = block.split("\n");
    const p = lines.find((l) => l.startsWith("worktree "));
    if (!p) continue;
    const b = lines.find((l) => l.startsWith("branch refs/heads/"));
    out.push({ path: p.slice(9), branch: b ? b.slice("branch refs/heads/".length) : null });
  }
  return out;
}

async function headOf(git: Git, root: string, branch: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], root);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** What the act would take, read now, and the first reason it can't (null: it may). */
interface Reading {
  target: string | null;
  folder: string | null;
  owner: DiscardOwner | null;
  left: Leftovers | null;
  refused: string | null;
}

async function read(req: DiscardRequest, d: DiscardDeps): Promise<Reading> {
  const { root, branch, commit } = req;
  const list = await worktreeList(d.git, root);
  const main = list[0];
  const here = list.find((w) => w.branch === branch) ?? null;
  const target = await d.target(root);
  const base: Reading = { target, folder: null, owner: null, left: null, refused: null };
  const no = (why: string): Reading => ({ ...base, refused: why });
  if (branch === target || (main && main.branch === branch) || (here && main && realOr(here.path) === realOr(main.path))) return no(DISCARD_WORDS.main);
  const folder = here && existsSync(here.path) ? here.path : null;
  const owner = await d.owner(root, branch, folder);
  const left = folder ? await d.leftovers(folder) : null;
  const r: Reading = { ...base, folder, owner, left };
  const why = await refusal(req, d, r);
  return { ...r, refused: why };
}

async function refusal(req: DiscardRequest, d: DiscardDeps, r: Reading): Promise<string | null> {
  const head = await headOf(d.git, req.root, req.branch);
  if (!head) return DISCARD_WORDS.noBranch;
  if (head !== req.commit) return DISCARD_WORDS.moved;
  if (!r.target) return DISCARD_WORDS.noTarget;
  if (await d.openEntry(req.root, req.branch)) return DISCARD_WORDS.inQueue;
  if (r.owner && !r.owner.archived) {
    if (d.chatBusy(r.owner.path)) return DISCARD_WORDS.chatWorking;
    if (r.owner.tui) return DISCARD_WORDS.chatTui;
    if (d.workingSubagents(r.owner.path) > 0) return DISCARD_WORDS.worker;
  }
  if (r.folder) {
    const u = await d.uses(r.folder);
    if (u.unreadable.length) return "A chat's file couldn't be read, so Sova can't tell whether one works in its folder.";
    for (const c of u.uses) {
      if (r.owner && c.path === r.owner.path) continue;
      if (c.archived) continue;
      // Another chat or a worker working there: the one use rule, minus its quiet time (you asked for this now).
      if (chatInUse({ ...c, lastActiveAt: 0 }, d.now())) return DISCARD_WORDS.worker;
    }
    const real = realOr(r.folder);
    const inside = (p: string) => p === real || p.startsWith(`${real}/`) || realOr(p) === real || realOr(p).startsWith(`${real}/`);
    const procs = await d.processes();
    for (const p of procs) if (p.unreadable) return p.unreadable;
    for (const p of procs) if (p.paths.some(inside)) return process_words(p);
    const pid = liveRecordPid(r.folder, d.alive);
    if (pid) return DISCARD_WORDS.worker;
    if (r.left?.unreadable) return r.left.unreadable;
  }
  return null;
}

/** The dry run: what goes, and why it can't now (the confirm's listing). */
export async function previewDiscard(req: DiscardRequest, d: DiscardDeps): Promise<DiscardBranchPreview> {
  const r = await read(req, d);
  const commits = r.target ? await commitsOf(d.git, req.root, r.target, req.commit) : { count: 0, shown: [] };
  return {
    branch: req.branch,
    commit: req.commit,
    target: r.target ?? "",
    commits,
    folder: r.folder,
    files: r.left && !r.left.unreadable ? d.listingOf(r.left) : null,
    drafts: r.folder ? d.draftNames(r.folder) : [],
    chat: r.owner && !r.owner.archived ? { id: r.owner.id, title: r.owner.title, path: r.owner.path } : null,
    digest: r.left && !r.left.unreadable ? d.digestOf(r.left) : "",
    refused: r.refused,
  };
}

async function commitsOf(git: Git, root: string, target: string, commit: string): Promise<DiscardBranchPreview["commits"]> {
  const n = await git(["rev-list", "--count", `refs/heads/${target}..${commit}`], root);
  const log = await git(["log", `--max-count=${COMMITS_SHOWN}`, "--format=%h%x00%s", `refs/heads/${target}..${commit}`], root);
  const shown = log.code === 0 ? log.stdout.split("\n").filter(Boolean).map((l) => ({ sha: l.split("\0")[0] ?? "", subject: l.split("\0")[1] ?? "" })) : [];
  return { count: n.code === 0 ? Number(n.stdout.trim()) || 0 : shown.length, shown };
}

/** A refusal of the confirm: nothing was done. `changed`: the files differ from the listing the user saw. */
export class DiscardRefused extends Error {
  constructor(
    readonly code: "refused" | "changed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The confirm: folder, branch, chat, in that order, under the repository's lock, each step only after the one before
 * it went (a row with no folder or no chat skips that step). Refused (DiscardRefused) before anything is deleted.
 */
export async function discardBranch(req: DiscardRequest, digest: string, d: DiscardDeps): Promise<DiscardBranchResult> {
  const lock = await d.lockFile(req.root);
  if (!lock || !d.takeLock(lock)) throw new DiscardRefused("refused", DISCARD_WORDS.locked);
  try {
    const r = await read(req, d);
    if (r.refused) throw new DiscardRefused("refused", r.refused);
    const now = r.left ? d.digestOf(r.left) : "";
    if (now !== digest) throw new DiscardRefused("changed", DISCARD_WORDS.changed);
    const steps: DiscardBranchStep[] = [];
    const stop = (from: DiscardBranchStep["step"][]): DiscardBranchResult => {
      for (const s of from) steps.push({ step: s, state: "not-run" });
      return { outcome: "partial", steps, message: words(req.branch, steps) };
    };

    // 1. The folder: only the listing the user saw (Remove Anyway's --force), else a plain removal.
    if (!r.folder) steps.push({ step: "folder", state: "skipped", detail: "It has no folder." });
    else {
      const folder = r.folder;
      const forced = !!r.left && hasContent(r.left);
      const out = await d.withAnyway(folder, digest, () =>
        removeTree({ path: folder, main: req.root, git: d.git, ...(d.remove ? { remove: d.remove } : {}), force: forced, ...(d.proof ? { proof: (cut) => d.proof!(folder, req.root, req.branch, cut) } : {}) }),
      );
      if (out.state !== "removed") {
        steps.push({ step: "folder", state: "failed", detail: out.reason });
        return stop(["branch", "chat"]);
      }
      // A worktree of another repository that went with it: dropped from that repository's list by name.
      if (forced) for (const n of r.left!.nested) if (n.kind === "worktree" && n.of && existsSync(n.of)) await d.git(["worktree", "remove", "--", join(folder, n.path)], n.of).catch(() => null);
      steps.push({ step: "folder", state: "done" });
    }

    // 2. The branch, at exactly the tip the user saw: no pin, no backup.
    const ref = `refs/heads/${req.branch}`;
    const still = (await worktreeList(d.git, req.root).catch(() => null))?.some((w) => w.branch === req.branch);
    if (still !== false) {
      steps.push({ step: "branch", state: "failed", detail: still ? "Another folder has this branch checked out." : "Git couldn't list its worktrees." });
      return stop(["chat"]);
    }
    const del = await d.git([...NO_BACKGROUND_CLEANUP, "update-ref", "-d", ref, req.commit], req.root);
    if (del.code !== 0) {
      steps.push({ step: "branch", state: "failed", detail: `Git kept the branch: ${firstLine(del.stderr || del.stdout)}` });
      return stop(["chat"]);
    }
    // `update-ref -d` leaves the branch's config; a later branch of this name mustn't inherit it.
    await d.git([...NO_BACKGROUND_CLEANUP, "config", "--remove-section", `branch.${req.branch}`], req.root).catch(() => undefined);
    steps.push({ step: "branch", state: "done" });

    // 3. The chat: archived as the Archive button does; closed in any case, since its folder is gone.
    if (!r.owner || r.owner.archived) steps.push({ step: "chat", state: "skipped", detail: r.owner ? "It was already archived." : "It has no chat." });
    else {
      const a = await d.archive(r.owner.path).catch((err: Error) => ({ ok: false as const, error: err.message }));
      if (a.ok) steps.push({ step: "chat", state: "done" });
      else {
        if (r.folder) await d.close(r.owner.path, "Its worktree was removed, so it has no folder to work in.").catch(() => undefined);
        steps.push({ step: "chat", state: "failed", detail: a.error });
      }
    }
    const ok = steps.every((s) => s.state === "done" || s.state === "skipped");
    return { outcome: ok ? "discarded" : "partial", steps, message: words(req.branch, steps) };
  } finally {
    d.dropLock(lock);
  }
}

const hasContent = (l: Leftovers): boolean => l.dirty.length > 0 || l.ignored.length > 0 || l.nested.length > 0 || !!l.lastRecordings?.length;

const NAMES: Record<DiscardBranchStep["step"], string> = { folder: "its folder", branch: "its branch", chat: "its chat" };

/** The result in a sentence: what went, and what stayed and why. */
function words(branch: string, steps: readonly DiscardBranchStep[]): string {
  const done = steps.filter((s) => s.state === "done").map((s) => NAMES[s.step]);
  const failed = steps.find((s) => s.state === "failed");
  if (!failed) return done.length ? `Discarded ${branch}: ${list(done)} ${done.length === 1 ? "is" : "are"} gone.` : `Discarded ${branch}.`;
  const kept = steps.filter((s) => s.state === "failed" || s.state === "not-run").map((s) => NAMES[s.step]);
  const gone = done.length ? `${cap(list(done))} ${done.length === 1 ? "is" : "are"} gone; ` : "Nothing was deleted; ";
  return `${gone}${list(kept)} stayed. ${cap(NAMES[failed.step])}: ${failed.detail ?? "it failed"}`;
}
const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// --- the server's wiring ----------------------------------------------------------------------------

/** The live server's deps. Imports are lazy: the module itself stays light for its tests. */
export async function realDiscardDeps(): Promise<DiscardDeps> {
  const [{ runGit }, { canonical }, remove, leftoversMod, cleanup, retire, live, chat, sessions, drafts, pw, wire, nothingLeft] = await Promise.all([
    import("../pi-config/extensions/worktrees/git.ts"),
    import("../pi-config/extensions/worktrees/state.ts"),
    import("./worktree-remove"),
    import("./worktree-leftovers"),
    import("./worktree-cleanup"),
    import("./worktree-retire"),
    import("./live"),
    import("./chat-handle"),
    import("./sessions-index"),
    import("./spec-drafts-state"),
    import("./project-worktrees"),
    import("./merge-queue/wire"),
    import("./nothing-left"),
  ]);
  const ownerRow = async (session: string, archived: boolean): Promise<DiscardOwner | null> => {
    const s = (await sessions.listSessions().catch(() => [])).find((x) => x.id === session);
    if (!s) return null;
    return { id: s.id, title: s.title && s.title !== "Untitled" ? s.title : s.id.slice(0, 8), path: s.path, archived: archived || !!s.archived, tui: !!s.live };
  };
  return {
    git: runGit,
    remove: remove.longGit,
    target: (root) => wire.landingTargetOf(root),
    async openEntry(root, branch) {
      const qs = wire.mergeQueues();
      const target = await wire.landingTargetOf(root);
      if (!qs || !target || !(await wire.queueManages(root, target))) return null;
      // Loaded, so its reading of open entries is registered.
      await qs.get(root);
      return nothingLeft.openQueueEntry(root, branch);
    },
    async owner(_root, branch, folder) {
      if (folder) {
        const o = await wire.worktreeOwnerOf(folder);
        return o ? ownerRow(o.session, !!o.archived) : null;
      }
      // No folder: the chat whose own record created a worktree on this branch.
      const { trackedWorktrees } = await import("./merge-readiness");
      for (const [, trees] of trackedWorktrees().each()) {
        const t = trees.find((x) => x.branch === branch && x.how === "created" && x.status !== "dropped");
        if (t) {
          const o = await wire.worktreeOwnerOf(t.path);
          if (o) return ownerRow(o.session, !!o.archived);
        }
      }
      return null;
    },
    chatBusy: (path) => chat.isSessionBusy(path),
    workingSubagents: (path) => live.workingSubagents(path),
    uses: (folder) => cleanup.chatUses([folder]),
    processes: () => cleanup.scanProcesses(),
    alive: cleanup.pidAlive,
    leftovers: (folder) => leftoversMod.leftovers(folder).catch(leftoversMod.unreadableLeftovers),
    digestOf: leftoversMod.leftoversDigest,
    listingOf: leftoversMod.removeAnywayOf,
    draftNames: (folder) => drafts.draftNamesIn(folder) ?? [],
    proof: (folder, root, branch, cut) => retire.leftoverProofHere(folder, root, branch, cut),
    withAnyway: (folder, digest, fn) => pw.withRemoveAnyway(folder, digest, fn),
    async lockFile(root) {
      const r = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
      return r.code === 0 && r.stdout.trim() ? retire.retireFiles.repoLockFile(canonical(r.stdout.trim())) : null;
    },
    takeLock: (file) => retire.takeLock(file),
    dropLock: (file) => retire.dropLock(file),
    async archive(path) {
      const r = await sessions.archiveSession(path, true);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    close: (path, message) => chat.closeChat(path, message),
    now: () => Date.now(),
  };
}

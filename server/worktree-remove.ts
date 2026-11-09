// The one removal step (§chat.worktrees/cleanup): every way Sova removes one of your worktrees ends
// here. `git worktree remove`, never --force; a delete that stops part way (git dropped the tree from
// its list and files stayed, a writer refilled the folder, or git died with `.git` gone and the tree
// still on its list) is finished only under the proof for a leftover folder, else held with what
// remains named. Then the branch: its last commit pinned first,
// under a private reference, then `git branch -d`, or a delete at exactly the pinned commit.
//
// Node builtins, git by argv and the one keep rule (server/worktree-leftovers.ts). The project services' teardown and
// a project's Remove Worktree import it, so it knows nothing of sessions; what a proof needs is handed in.
//
// Sova's own throwaway copies (conform, deploy, the merge queue's merge and scratch copies) go by their
// own --force --force and are nothing to do with this step.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Git, GitResult } from "../pi-config/extensions/worktrees/git.ts";
import { NO_BACKGROUND_CLEANUP } from "./git-no-background";
import { draftNamesIn } from "./spec-drafts-state";
import { type FinishedFacts, type Leftovers, leftoversOfFolder, leftoversReason } from "./worktree-leftovers";

/** A removal deletes a whole node_modules: well past the tool git's two minutes. Killed at this, it reads as a partial delete. */
const REMOVE_TIMEOUT_MS = 15 * 60_000;

/** Git with a long time limit, for `git worktree remove`. Never throws. */
export const longGit: Git = (args, cwd) =>
  new Promise((done) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: REMOVE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) || (err && code !== 0 ? err.message : "") });
    });
  });

const firstLine = (r: GitResult): string => (r.stderr || r.stdout).trim().split("\n")[0]?.trim() || `exit ${r.code}`;

export const DRAFTS_DIR = ".sova/spec/drafts";

// --- the test chats a finished tree keeps ------------------------------------------------------

/** The hash of a file, read as it is now. */
function hashFile(path: string): string {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/** A place under `dst` for these bytes that overwrites nothing: its own name, else "<name>.2<ext>" and on. Null: they are kept there already. */
function freePlace(dst: string, sum: string): string | null {
  const ext = extname(dst);
  const stem = dst.slice(0, dst.length - ext.length);
  for (let n = 1; ; n++) {
    const at = n === 1 ? dst : `${stem}.${n}${ext}`;
    if (!existsSync(at)) return at;
    if (hashFile(at) === sum) return null;
  }
}

/**
 * Test chats that differ from the real ones move to `<aside>/<folder>/` under their own path (`rels` are under the
 * tree's `.agent`), each read back before its source goes, and an earlier one under the same name stays. Nothing Sova
 * runs deletes that place. Null, or the reason the folder must stay, with what was already moved still kept.
 */
export function keepTestChats(aside: string, tree: string, rels: readonly string[]): string | null {
  for (const rel of rels) {
    const src = join(tree, rel);
    try {
      const sum = hashFile(src);
      const place = freePlace(join(aside, basename(tree), rel.replace(/^\.agent\//, "")), sum);
      if (place) {
        mkdirSync(dirname(place), { recursive: true });
        const tmp = `${place}.${process.pid}.tmp`;
        copyFileSync(src, tmp, constants.COPYFILE_EXCL);
        if (statSync(tmp).size !== statSync(src).size || hashFile(tmp) !== sum) {
          rmSync(tmp, { force: true });
          return `A test chat couldn't be kept aside: ${rel}.`;
        }
        renameSync(tmp, place);
      }
      unlinkSync(src);
    } catch {
      return `A test chat couldn't be kept aside: ${rel}.`;
    }
  }
  return null;
}

/** The sentence for a folder holding what git doesn't. */
const missingWords = (rels: readonly string[]): string => (rels.length === 1 ? `1 file git doesn't have: ${rels[0]}.` : `${rels.length} files git doesn't have: ${rels[0]} and ${rels.length - 1} more.`);

// --- the pin -----------------------------------------------------------------------------------

export const RETIRED_REF_PREFIX = "refs/sova/retired/";
export const pinRef = (tip: string): string => `${RETIRED_REF_PREFIX}${tip}`;

/** Pin `tip` under Sova's private references, so git's own tidy-up can't drop it. True: it's pinned, now or from before. */
export async function pinTip(git: Git, main: string, tip: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(tip)) return false;
  const r = await git(["update-ref", pinRef(tip), tip], main);
  if (r.code !== 0) return false;
  const back = await git(["rev-parse", "--verify", "-q", pinRef(tip)], main);
  return back.code === 0 && back.stdout.trim() === tip;
}

// --- leftover-folder proof ---------------------------------------------------------------------

/** A live process and the paths it holds (its cwd and open files). */
export interface ProcHolder {
  pid: number;
  command: string;
  paths: string[];
  unreadable?: string;
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

// --- who is using it --------------------------------------------------------------------------

/** How long a chat stays quiet before its worktree may go: the landed notice wakes it, and its receipts land in the folder first. */
export const QUIET_MS = 10 * 60_000;

/** What the one use rule asks of a chat. */
export interface ChatInUseFacts {
  name: string;
  /** Its summary couldn't be read: who knows what it's doing. */
  unknown?: boolean;
  running: boolean;
  tui: boolean;
  workers: number;
  lastActiveAt: number;
}

/**
 * Why a chat is using its folder now, or null: running, open in a TUI, holding workers, or active in the last 10
 * minutes. The one rule, for a finished tree and for a folder left behind alike. Having a folder there is no use by
 * itself: a quiet chat's next message brings it back. A sandbox on is asked apart, since on the platforms it matters it holds rather than waits.
 */
export function chatInUse(u: ChatInUseFacts, now: number): string | null {
  if (u.unknown) return `Chat ${u.name} couldn't be read.`;
  if (u.tui) return `Chat ${u.name} is open in a TUI.`;
  if (u.running) return `Chat ${u.name} is running.`;
  if (u.workers > 0) return `Chat ${u.name} has workers.`;
  if (now - u.lastActiveAt < QUIET_MS) return `Chat ${u.name} was active in the last 10 minutes.`;
  return null;
}

/** A chat a proof asks about: its folder, canonical, or the folders it tracks as active. */
export interface LeftoverChat extends ChatInUseFacts {
  cwd: string | null;
  tracks: readonly string[];
  sandbox: boolean;
}

/**
 * How a folder git still lists comes to be asked about: its removal stopped after `.git` went. "listed": the removal
 * running right here saw it happen, so git's listing it is no refusal. "intent": this service also recorded, before
 * starting, a removal of this exact path git had registered, which stands in for being inside the worktrees location.
 */
export type CutOffKind = "listed" | "intent";

export interface LeftoverInput {
  path: string;
  /** The main checkout's folder. */
  main: string;
  /** A chat's worktree record or the ledger names this path (or git had it registered a moment ago, for a partial delete). */
  recorded: boolean;
  /** The branch it was on, when known. */
  branch?: string;
  /** Whether that branch, when it still exists, has nothing left (§chat.worktrees/nothing-left). Asked only when the branch is there. */
  branchFinished: (branch: string) => Promise<boolean>;
  /** Spec drafts in the folder: the names not proved landed. Asked only when it holds a drafts folder. */
  draftsUnproved: (folder: string) => Promise<string[]>;
  processes: readonly ProcHolder[];
  /** The chats with a folder inside it or tracking it. Only one using it now refuses: `chatInUse`, or a sandbox on where that holds. */
  chats: readonly LeftoverChat[];
  now: number;
  alive: (pid: number) => boolean;
  git: Git;
  /** A finished folder: what a test copy left doesn't keep it. Absent: it does. */
  finished?: FinishedFacts;
  /** Whether a chat's sandbox on holds it: macOS and any other platform but Linux. Default false. */
  sandboxHolds?: boolean;
  /** Absent: git listing the folder refuses it, and it must be inside the worktrees location. */
  cutOff?: CutOffKind;
}

/** A live record under the folder's own `.agent/sessions/live` naming a process still alive. */
export function liveRecordPid(tree: string, alive: (pid: number) => boolean): number | null {
  const dir = join(tree, ".agent", "sessions", "live");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), "utf8")) as { session?: { pid?: unknown }; pid?: unknown };
      const pid = typeof rec.session?.pid === "number" ? rec.session.pid : typeof rec.pid === "number" ? rec.pid : Number(/^p(\d+)-/.exec(n)?.[1]);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid;
    } catch {
      // a half-written record: not a live one
    }
  }
  return null;
}

/**
 * A `.git` in a folder git has forgotten: a plain file naming a worktree admin directory that's gone
 * is what a partial delete leaves when it stopped before reaching it, and holds nothing. Anything else
 * (a directory, a live pointer) is a working repository.
 */
export function hasLiveGit(path: string): boolean {
  const at = join(path, ".git");
  let st;
  try {
    st = lstatSync(at);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (!st.isFile() || st.size > 4096) return true;
  try {
    const m = /^gitdir: (.+)\n?$/.exec(readFileSync(at, "utf8"));
    return !m || !/[\\/]worktrees[\\/][^\\/]+$/.test(m[1]!) || existsSync(m[1]!);
  } catch {
    return true;
  }
}

/**
 * Whose a folder's `.git` says it is, live or dead: "none" (it has none), "here" (a worktree pointer into this common dir) or
 * "elsewhere" (a pointer into another repository, a repository of its own, or anything that can't be read). A doubt is "elsewhere".
 */
export function gitPointer(path: string, commonDir: string): "none" | "here" | "elsewhere" {
  const at = join(path, ".git");
  let st;
  try {
    st = lstatSync(at);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "elsewhere";
  }
  if (!st.isFile() || st.size > 4096) return "elsewhere";
  try {
    const m = /^gitdir: (.+)\n?$/.exec(readFileSync(at, "utf8"));
    if (!m) return "elsewhere";
    const admin = resolve(path, m[1]!);
    if (basename(dirname(admin)) !== "worktrees") return "elsewhere";
    return realOr(dirname(dirname(admin))) === realOr(commonDir) ? "here" : "elsewhere";
  } catch {
    return "elsewhere";
  }
}

/** A proof's answer: why it must stay, or null, with what the one keep rule read, for what goes with it. */
export interface LeftoverProof {
  why: string | null;
  left?: Leftovers;
}

/**
 * Why a folder left with no working branch must stay, or null when every proof holds
 * (§chat.worktrees/cleanup). Any doubt is a reason. Reads only.
 */
export async function leftoverProof(i: LeftoverInput): Promise<LeftoverProof> {
  const no = (why: string): LeftoverProof => ({ why });
  if (!i.recorded) return no("No chat's record or ledger entry names it.");
  let st;
  try {
    st = lstatSync(i.path);
  } catch (err) {
    return no(`Couldn't read it: ${(err as NodeJS.ErrnoException).code ?? "error"}.`);
  }
  if (st.isSymbolicLink()) return no("It's a symlink.");
  if (!st.isDirectory()) return no("It isn't a folder.");
  const real = realOr(i.path);
  const location = join(realOr(dirname(i.main)), ".worktrees");
  // The location bounds what a chat's record or a ledger line can point at; those are only text. An intent names a folder this
  // service was already removing, on git's own list of this repository at that moment, under the full rule, wherever a
  // linked worktree lives (§chat.worktrees/cleanup "Which trees"), and everything below is asked as for any other.
  if (i.cutOff !== "intent" && dirname(real) !== location) return no("It isn't directly inside the worktrees location.");
  if (real === realOr(i.main) || within(realOr(i.main), real)) return no("It holds the main checkout.");
  if (hasLiveGit(real)) return no("It holds a .git.");
  const list = await i.git(["worktree", "list", "--porcelain"], i.main);
  if (list.code !== 0) return no(`Git couldn't list its worktrees: ${firstLine(list)}`);
  const listed = list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => realOr(l.slice(9)));
  if (listed.includes(real) && !i.cutOff) return no("Git still lists it.");
  const inside = listed.find((l) => l !== real && within(l, real));
  if (inside) return no(`Another worktree is inside it: ${inside}.`);
  if (i.branch) {
    const ref = await i.git(["rev-parse", "--verify", "-q", `refs/heads/${i.branch}^{commit}`], i.main);
    if (ref.code === 0 && !(await i.branchFinished(i.branch).catch(() => false))) return no(`Its branch ${i.branch} still has something to land.`);
  }
  for (const p of i.processes) if (p.unreadable) return no(p.unreadable);
  for (const p of i.processes) if (p.paths.some((x) => within(x, real) || within(realOr(x), real))) return no(`A running process is inside it: ${p.command} (${p.pid}).`);
  const pid = liveRecordPid(real, i.alive);
  if (pid) return no(`A live session under its .agent: ${pid}.`);
  for (const u of i.chats) {
    if (!u.tracks.length && !(u.cwd && within(u.cwd, real))) continue;
    if (u.sandbox && i.sandboxHolds) return no(`Chat ${u.name} has its sandbox on.`);
    const why = chatInUse(u, i.now);
    if (why) return no(why);
  }
  // The names are listed before the proof is asked, so a draft that appears in between isn't taken for one it proved.
  const named = draftNamesIn(real) ?? [];
  const unproved = existsSync(join(real, ...DRAFTS_DIR.split("/"))) ? await i.draftsUnproved(real).catch(() => ["unknown"]) : [];
  if (unproved.length) return no(`${unproved.length} spec draft${unproved.length === 1 ? "" : "s"} not proved landed.`);
  const run = (args: readonly string[], o: { cwd: string }) => i.git([...args], o.cwd);
  const left = await leftoversOfFolder(real, i.main, run, { provedDrafts: named, ...(i.finished ? { finished: i.finished } : {}) });
  if (left.unreadable) return no(left.unreadable);
  const missing = [...left.dirty, ...left.ignored];
  if (missing.length) return no(missingWords(missing));
  const why = leftoversReason(left);
  return why ? no(why) : { why: null, left };
}

export const leftoverRefusal = async (i: LeftoverInput): Promise<string | null> => (await leftoverProof(i)).why;

/** Delete a proved folder; symlinks inside are deleted, not followed. Null, or why it couldn't. */
export function deleteProvedFolder(path: string): string | null {
  // basename checked again here: a bug upstream can't make this the worktrees location itself.
  if (!basename(path) || basename(path) === ".worktrees") return "That's not a worktree's folder.";
  try {
    rmSync(path, { recursive: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "it couldn't be deleted";
  }
  return existsSync(path) ? "something wrote into it again" : null;
}

// --- removal -----------------------------------------------------------------------------------

export type RemoveOutcome =
  /** The folder is gone and git forgot it. `finished`: a delete that stopped part way was finished under proof. */
  | { state: "removed"; finished?: true }
  /** Git refused and changed nothing: the tree is as it was. */
  | { state: "refused"; reason: string }
  /** Files stayed and the proof didn't hold: the folder stays, with what remains named. `stillListed`: git has it registered yet, so no leftover pass will find it. */
  | { state: "held"; reason: string; remains: string[]; stillListed?: true };

async function registered(git: Git, main: string, path: string): Promise<boolean | null> {
  const r = await git(["worktree", "list", "--porcelain"], main);
  if (r.code !== 0) return null;
  const real = realOr(path);
  return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && (l.slice(9) === path || realOr(l.slice(9)) === real));
}

const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** What remains in a folder, in words. */
function remainsOf(path: string): string[] {
  try {
    return readdirSync(path).sort().slice(0, 5);
  } catch {
    return [];
  }
}
const remainsWords = (r: readonly string[]): string => (r.length ? `Still in it: ${r.join(", ")}.` : "");

/**
 * `git worktree remove -- <path>` from the main checkout, never --force, read back by what's actually
 * there and not by git's exit code alone. `proof` answers why a partial delete may not be finished, or
 * null; absent, a partial delete is always held. `git` reads; `remove` runs the removal.
 */
export async function removeTree(o: { path: string; main: string; git: Git; remove?: Git; force?: boolean; proof?: (cut?: CutOffKind) => Promise<string | null> }): Promise<RemoveOutcome> {
  const remove = o.remove ?? o.git;
  // Whether this call is what took `.git`: one already gone when it started is someone else's doing, and git's refusal stands.
  const hadGit = lexists(join(o.path, ".git"));
  // `force` is Remove Anyway's alone, on the exact listing the user confirmed (§chat.worktrees/leftovers).
  const r = await remove(["worktree", "remove", ...(o.force ? ["--force"] : []), "--", o.path], o.main);
  const listed = await registered(o.git, o.main, o.path);
  const there = lexists(o.path);
  if (listed === null) {
    return there
      ? { state: "held", reason: "Git couldn't say whether it still lists this folder, so nothing more was done.", remains: remainsOf(o.path) }
      : { state: "refused", reason: "Git couldn't say whether it still lists this folder." };
  }
  if (listed && hadGit && !lexists(join(o.path, ".git"))) return finishCutOff({ ...o, kind: "listed", stopped: `Git stopped part way (${firstLine(r)}).` });
  if (listed) return { state: "refused", reason: r.code !== 0 ? `Git refused: ${firstLine(r)}` : "Git still lists it." };
  if (!there) return { state: "removed" };
  // Git forgot it and files stayed: a partial delete, whichever exit code it came with.
  const remains = remainsOf(o.path);
  const why = o.proof ? await o.proof().catch((err: Error) => `The proof couldn't run: ${err.message}`) : "Nothing here can prove what's left is safe to delete.";
  if (why !== null) return { state: "held", reason: `Git stopped part way (${firstLine(r)}). ${why} ${remainsWords(remains)}`.trim(), remains };
  const failed = deleteProvedFolder(o.path);
  if (failed) return { state: "held", reason: `Git stopped part way, and finishing it failed: ${failed}. ${remainsWords(remainsOf(o.path))}`.trim(), remains: remainsOf(o.path) };
  return { state: "removed", finished: true };
}

/**
 * A removal that stopped after `.git` went, with git still listing the folder: what is left goes only under the proof, and then
 * this one registration, by `git worktree remove` of a folder that is gone (never --force, never a prune, which would forget
 * every other worktree whose folder happens to be missing). A folder already gone skips straight to the registration.
 */
export async function finishCutOff(o: { path: string; main: string; git: Git; remove?: Git; proof?: (cut?: CutOffKind) => Promise<string | null>; kind: CutOffKind; stopped: string }): Promise<RemoveOutcome> {
  const remove = o.remove ?? o.git;
  if (lexists(o.path)) {
    const remains = remainsOf(o.path);
    const why = o.proof ? await o.proof(o.kind).catch((err: Error) => `The proof couldn't run: ${err.message}`) : "Nothing here can prove what's left is safe to delete.";
    if (why !== null) return { state: "held", reason: `${o.stopped} ${why} ${remainsWords(remains)}`.trim(), remains, stillListed: true };
    const failed = deleteProvedFolder(o.path);
    if (failed) return { state: "held", reason: `${o.stopped} Finishing it failed: ${failed}. ${remainsWords(remainsOf(o.path))}`.trim(), remains: remainsOf(o.path), stillListed: true };
  }
  const r = await remove(["worktree", "remove", "--", o.path], o.main);
  const listed = await registered(o.git, o.main, o.path);
  if (listed !== false) return { state: "held", reason: `${o.stopped} Its folder is gone, but git still lists it: ${firstLine(r)}`, remains: [], stillListed: true };
  return { state: "removed", finished: true };
}

export type BranchOutcome =
  | { deleted: true; pinned: boolean }
  | { deleted: false; pinned: boolean; why: string };

/**
 * The branch, after its folder (§chat.worktrees/cleanup). Its last commit is pinned first; no pin, no
 * delete. A branch on the main branch goes with `git branch -d`; any other, or one `-d` won't take,
 * only at exactly the commit just pinned, so one that moved in between stays.
 */
export async function retireBranch(git: Git, main: string, o: { branch: string; tip: string; onMain: boolean }): Promise<BranchOutcome> {
  const ref = `refs/heads/${o.branch}`;
  const now = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], main);
  if (now.code !== 0) return { deleted: true, pinned: await pinTip(git, main, o.tip) };
  if (now.stdout.trim() !== o.tip) return { deleted: false, pinned: false, why: `The branch moved to ${now.stdout.trim().slice(0, 7)} in between, so it stays.` };
  const list = await git(["worktree", "list", "--porcelain"], main);
  if (list.code !== 0) return { deleted: false, pinned: false, why: `Git couldn't list its worktrees: ${firstLine(list)}` };
  if (list.stdout.split("\n").includes(`branch ${ref}`)) return { deleted: false, pinned: false, why: "Another folder has this branch checked out." };
  if (!(await pinTip(git, main, o.tip))) return { deleted: false, pinned: false, why: "Its last commit couldn't be pinned, so the branch stays." };
  if (o.onMain) {
    const del = await git([...NO_BACKGROUND_CLEANUP, "branch", "-d", "--", o.branch], main);
    if (del.code === 0) return { deleted: true, pinned: true };
  }
  const del = await git([...NO_BACKGROUND_CLEANUP, "update-ref", "-d", ref, o.tip], main);
  if (del.code !== 0) return { deleted: false, pinned: true, why: `Git kept the branch: ${firstLine(del)}` };
  // `update-ref -d` leaves the branch's config; a later branch of this name mustn't inherit it. Nothing there is worth a failure.
  await git([...NO_BACKGROUND_CLEANUP, "config", "--remove-section", `branch.${o.branch}`], main).catch(() => undefined);
  return { deleted: true, pinned: true };
}

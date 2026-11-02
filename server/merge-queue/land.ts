import { readFileSync } from "node:fs";
import { NO_BACKGROUND_CLEANUP, noBackgroundCleanupEnv } from "../git-no-background";
import { type Git, isAncestor, revParse, statusArgs, worktreesOf } from "./guard";

/**
 * Moving the target, the only place the queue writes the project's repository outside its merge copy.
 *
 * Land: the target fast-forwards to exactly the tested tip, never anything else. Where the target is checked out (the
 * project's main folder, normally), that checkout is fast-forwarded with it (`merge --ff-only`), and only when it has no
 * uncommitted tracked change and no merge in progress: a dirty folder is never forced, the queue pauses and says so.
 * Where no checkout holds the target, the ref moves by compare-and-swap (`update-ref <to> <from>`).
 */

export type LandResult =
  | { kind: "landed" }
  /** The checkout holding the target has uncommitted edits (or the ff was refused there): nothing moved. */
  | { kind: "dirty"; why: string; checkout: string }
  /** The target isn't where the run started: nothing moved by us. */
  | { kind: "moved"; head: string | null };

/** Whether `dir` has tracked uncommitted changes or an operation in progress; the reason, or null when clean. */
export async function dirtyWhy(git: Git, dir: string): Promise<string | null> {
  const st = await git(statusArgs("--porcelain", "--untracked-files=no"), dir);
  if (st.code !== 0) return `git status failed in ${dir}: ${st.stderr.trim().split("\n")[0] ?? ""}`;
  const files = st.stdout.split("\n").filter(Boolean);
  if (files.length) return `${dir} has uncommitted changes (${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 3).map((l) => l.slice(3)).join(", ")}${files.length > 3 ? ", …" : ""})`;
  for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (await revParse(git, dir, ref)) return `${dir} has a ${ref === "MERGE_HEAD" ? "merge" : ref === "REBASE_HEAD" ? "rebase" : ref === "CHERRY_PICK_HEAD" ? "cherry-pick" : "revert"} in progress`;
  }
  return null;
}

/** Where the target is checked out, if anywhere. */
export async function checkoutOf(git: Git, root: string, target: string): Promise<string | null> {
  return (await worktreesOf(git, root)).find((w) => w.branch === target)?.path ?? null;
}

/** The preconditions alone (nothing moves): the target is at `from`, and its checkout (if any) is clean. */
export async function canLand(git: Git, root: string, target: string, from: string): Promise<LandResult | null> {
  const head = await revParse(git, root, `refs/heads/${target}`);
  if (head !== from) return { kind: "moved", head };
  const co = await checkoutOf(git, root, target);
  if (co) {
    const why = await dirtyWhy(git, co);
    if (why) return { kind: "dirty", why, checkout: co };
  }
  return null;
}

/** Fast-forward `target` from `from` to `to`. The caller wrote the landing intent first. */
export async function landTip(git: Git, root: string, target: string, from: string, to: string): Promise<LandResult> {
  const pre = await canLand(git, root, target, from);
  if (pre) return pre;
  if (!(await isAncestor(git, root, from, to))) return { kind: "moved", head: from };
  const co = await checkoutOf(git, root, target);
  if (co) {
    const r = await git([...NO_BACKGROUND_CLEANUP, "merge", "--ff-only", "--no-edit", to], co);
    if (r.code !== 0) {
      const head = await revParse(git, root, `refs/heads/${target}`);
      if (head === to) return { kind: "landed" };
      if (head !== from) return { kind: "moved", head };
      return { kind: "dirty", why: `the fast-forward of ${co} was refused: ${(r.stderr || r.stdout).trim().split("\n").slice(0, 2).join(" ")}`, checkout: co };
    }
  } else {
    const r = await git(["update-ref", "-m", "merge queue: land", `refs/heads/${target}`, to, from], root);
    if (r.code !== 0) return { kind: "moved", head: await revParse(git, root, `refs/heads/${target}`) };
  }
  const head = await revParse(git, root, `refs/heads/${target}`);
  return head === to ? { kind: "landed" } : { kind: "moved", head };
}

/** The first-parent commits `from..to` (what one landing adds to the target's line). */
export async function firstParents(git: Git, root: string, from: string, to: string): Promise<string[]> {
  const r = await git(["rev-list", "--first-parent", `${from}..${to}`], root);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

// ---- push ---------------------------------------------------------------------------------------

export type PushResult = { state: "pushed"; sha: string } | { state: "not-pushed"; why: string; remote?: string } | { state: "no-remote"; why: string };

/**
 * Push the target to origin: fast-forward only (never forced), only when origin's target is an ancestor of the tip
 * and every first-parent commit between them is one the queue landed (an unpublished release commit on master is
 * never pushed by the queue), never while a push hold is on (a release in progress), never when the project says not
 * to push. The leak scan is a check of the run (the project's merge section), so a tip reaching here passed it.
 */
export async function pushTip(
  git: Git,
  root: string,
  target: string,
  tip: string,
  opts: { landed: ReadonlySet<string>; push?: boolean; holdFile?: string },
): Promise<PushResult> {
  if (opts.push === false) return { state: "not-pushed", why: "the project doesn't push from the queue" };
  const remotes = await git(["remote"], root);
  if (!remotes.stdout.split("\n").includes("origin")) return { state: "no-remote", why: "no remote named origin" };
  if (opts.holdFile) {
    let hold: string | null = null;
    try {
      hold = readFileSync(opts.holdFile, "utf8").trim() || "a push hold is on";
    } catch {}
    if (hold) return { state: "not-pushed", why: `held: ${hold.split("\n")[0]}` };
  }
  const ls = await git(["ls-remote", "origin", `refs/heads/${target}`], root, { timeoutMs: 60_000 });
  if (ls.code !== 0) return { state: "not-pushed", why: `origin can't be read: ${ls.stderr.trim().split("\n")[0] ?? ""}` };
  const remote = ls.stdout.split(/\s/)[0] || null;
  if (remote === tip) return { state: "pushed", sha: tip };
  if (remote) {
    if (!(await revParse(git, root, remote))) return { state: "not-pushed", why: `origin's ${target} (${remote.slice(0, 7)}) has commits this repository doesn't`, remote };
    if (!(await isAncestor(git, root, remote, tip))) return { state: "not-pushed", why: `origin's ${target} (${remote.slice(0, 7)}) isn't in ${target}'s history: never forced`, remote };
    const between = await firstParents(git, root, remote, tip);
    const foreign = between.filter((c) => !opts.landed.has(c));
    if (foreign.length) return { state: "not-pushed", why: `${target} has ${foreign.length} commit${foreign.length === 1 ? "" : "s"} the queue didn't land (${foreign[0]!.slice(0, 7)}${foreign.length > 1 ? ", …" : ""}): a release or a hand commit is pushed by its own owner`, remote };
  }
  const r = await git(["push", "--porcelain", "origin", `${tip}:refs/heads/${target}`], root, { timeoutMs: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...noBackgroundCleanupEnv() } });
  if (r.code !== 0) return { state: "not-pushed", why: `origin refused the push: ${(r.stderr || r.stdout).trim().split("\n").filter((l) => !l.startsWith("To ")).slice(0, 2).join(" ")}`, ...(remote ? { remote } : {}) };
  return { state: "pushed", sha: tip };
}

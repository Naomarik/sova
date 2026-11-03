import { readFileSync } from "node:fs";
import { NO_BACKGROUND_CLEANUP, noBackgroundCleanupEnv } from "../git-no-background";
import { countBetween, type Git, isAncestor, revParse, statusArgs, worktreesOf } from "./guard";
import { firstParents, landTip } from "./land";
import { scanPublication } from "./publish-scan";

/**
 * The git half of landing by request (pull request, merge request) or by pushing the branch alone (al_3): the queue's
 * merged result stays in the merge copy, test-only; what goes to origin is the chat's own branch, carrying the spec
 * docs commit, pushed fast-forward only (never forced). Host calls (open, find, view) are server/merge-queue/hosts/;
 * the order of the acts and their records are the queue's (queue.ts).
 */

const firstLine = (s: string): string => s.trim().split("\n").filter((l) => !l.startsWith("To ")).slice(0, 2).join(" ");

/** origin's target fetched now (`refs/remotes/origin/<target>`): request projects test every run against it. */
export async function fetchTarget(git: Git, root: string, target: string): Promise<{ sha: string } | { why: string }> {
  const r = await git([...NO_BACKGROUND_CLEANUP, "fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`], root, { timeoutMs: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.code !== 0) return { why: `origin's ${target} couldn't be fetched: ${firstLine(r.stderr || r.stdout)}` };
  const sha = await revParse(git, root, `refs/remotes/origin/${target}`);
  return sha ? { sha } : { why: `origin has no ${target}` };
}

export type PromoteResult =
  /** No docs to carry: the branch's own commit is what is published. */
  | { kind: "none"; head: string }
  /** The docs commit is on the branch now (in its worktree when it has one). */
  | { kind: "made"; head: string }
  /** Not now: the chat's folder isn't quiet (busy, uncommitted files); try again later. */
  | { kind: "wait"; why: string }
  /** Can't: the branch moved past the approved commit, or the docs don't apply to it. */
  | { kind: "refused"; why: string };

/** The trailer the run's docs commit carries (run.ts landDrafts): a retry finds a docs commit it already made. */
const trailerOf = (runId: string) => `Sova-Spec-Landing: merge-queue ${runId}`;

/**
 * Put the run's docs commit on the chat's own branch (q9 = c): the same change the run made official in the copy
 * (`mergeSha..tip`), applied onto the approved commit, committed with the copy's message and author, then the branch
 * fast-forwarded to it in its worktree (`merge --ff-only`, so the chat's folder has the very commit that is pushed).
 * Only while the worktree is clean and still at the approved commit; the caller checked the owning chat is idle.
 * Idempotent: a branch already one docs commit (this run's trailer) past the approved commit is taken as made.
 */
export async function promoteDocs(git: Git, root: string, o: { branch: string; commit: string; mergeSha: string; tip: string; runId: string; worktree?: string | undefined }): Promise<PromoteResult> {
  const now = await revParse(git, root, `refs/heads/${o.branch}`);
  if (!now) return { kind: "refused", why: `no branch ${o.branch} any more` };
  if (o.tip === o.mergeSha) return now === o.commit || (await isAncestor(git, root, o.commit, now)) ? { kind: "none", head: o.commit } : { kind: "refused", why: `${o.branch} no longer holds the approved commit ${o.commit.slice(0, 7)}` };
  if (now !== o.commit) {
    const parent = await revParse(git, root, `${now}^`);
    const msg = (await git(["log", "-1", "--format=%B", now], root)).stdout;
    if (parent === o.commit && msg.includes(trailerOf(o.runId))) return { kind: "made", head: now };
    return { kind: "refused", why: `${o.branch} moved past the approved commit ${o.commit.slice(0, 7)} (now ${now.slice(0, 7)}): Land Again to include the newer commits` };
  }
  const wt = o.worktree ?? (await worktreesOf(git, root)).find((w) => w.branch === o.branch && w.path !== root)?.path;
  if (wt) {
    const st = await git(statusArgs("--porcelain"), wt);
    if (st.code !== 0) return { kind: "wait", why: `git status failed in ${wt}` };
    const n = st.stdout.split("\n").filter(Boolean).length;
    if (n) return { kind: "wait", why: `${wt} has ${n} uncommitted file${n === 1 ? "" : "s"}: the spec docs commit waits until it is clean` };
    const head = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], wt)).stdout.trim();
    if (head !== o.branch) return { kind: "wait", why: `${wt} isn't on ${o.branch} now` };
  }
  const mt = await git(["merge-tree", "--write-tree", "--no-messages", `--merge-base=${o.mergeSha}`, o.commit, o.tip], root);
  const tree = mt.stdout.split("\n")[0]?.trim() ?? "";
  if (mt.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) return { kind: "refused", why: `the spec docs made in the merge copy don't apply cleanly to ${o.branch} itself${mt.code === 1 ? " (they conflict with it)" : `: ${firstLine(mt.stderr)}`}` };
  const meta = await git(["log", "-1", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce", o.tip], root);
  const [an, ae, ad, cn, ce] = meta.stdout.trim().split("\0");
  const message = (await git(["log", "-1", "--format=%B", o.tip], root)).stdout;
  const env = { ...process.env, ...(an ? { GIT_AUTHOR_NAME: an } : {}), ...(ae ? { GIT_AUTHOR_EMAIL: ae } : {}), ...(ad ? { GIT_AUTHOR_DATE: ad } : {}), ...(cn ? { GIT_COMMITTER_NAME: cn } : {}), ...(ce ? { GIT_COMMITTER_EMAIL: ce } : {}) };
  const c = await git(["commit-tree", tree, "-p", o.commit, "-m", message.replace(/\n+$/, "")], root, { env });
  const docs = c.stdout.trim();
  if (c.code !== 0 || !docs) return { kind: "refused", why: `making the spec docs commit failed: ${firstLine(c.stderr)}` };
  if (wt) {
    const ff = await git([...NO_BACKGROUND_CLEANUP, "merge", "--ff-only", "--no-edit", docs], wt);
    if (ff.code !== 0) {
      const after = await revParse(git, root, `refs/heads/${o.branch}`);
      if (after === docs) return { kind: "made", head: docs };
      return { kind: "wait", why: `the fast-forward of ${wt} was refused: ${firstLine(ff.stderr || ff.stdout)}` };
    }
  } else {
    const u = await git(["update-ref", "-m", "merge queue: spec docs", `refs/heads/${o.branch}`, docs, o.commit], root);
    if (u.code !== 0) return { kind: "wait", why: `${o.branch} moved while its spec docs commit was made` };
  }
  return (await revParse(git, root, `refs/heads/${o.branch}`)) === docs ? { kind: "made", head: docs } : { kind: "wait", why: `${o.branch} moved while its spec docs commit was made` };
}

export type BranchPushResult = { state: "pushed"; sha: string; from: string | null } | { state: "refused"; why: string; hits?: string[] };

/**
 * Push `tip` to origin as `refs/heads/<branch>`: never while a push hold is on, never before the scan passes over
 * everything origin's `base` lacks up to the tip (and `texts`, the request's words), fast-forward only. A branch
 * origin already has must be in the tip's history (Land Again adds on top, never rewrites; q6).
 */
export async function pushBranch(git: Git, root: string, o: { branch: string; tip: string; base: string; namesFile?: string | undefined; holdFile?: string; texts?: { label: string; text: string }[] }): Promise<BranchPushResult> {
  const remotes = await git(["remote"], root);
  if (!remotes.stdout.split("\n").includes("origin")) return { state: "refused", why: "no remote named origin: nothing to publish to" };
  if (o.holdFile) {
    let hold: string | null = null;
    try {
      hold = readFileSync(o.holdFile, "utf8").trim() || "a push hold is on";
    } catch {}
    if (hold) return { state: "refused", why: `held: ${hold.split("\n")[0]}` };
  }
  const ls = await git(["ls-remote", "origin", `refs/heads/${o.branch}`], root, { timeoutMs: 60_000 });
  if (ls.code !== 0) return { state: "refused", why: `origin can't be read: ${firstLine(ls.stderr)}` };
  const remote = ls.stdout.split(/\s/)[0] || null;
  if (remote && remote !== o.tip) {
    if (!(await revParse(git, root, remote))) return { state: "refused", why: `origin's ${o.branch} (${remote.slice(0, 7)}) has commits this repository doesn't: someone pushed to it; never forced` };
    if (!(await isAncestor(git, root, remote, o.tip))) return { state: "refused", why: `origin's ${o.branch} (${remote.slice(0, 7)}) isn't in the tested commit's history: never forced` };
  }
  const scan = await scanPublication(git, { repo: root, range: `${o.base}..${o.tip}`, namesFile: o.namesFile, ...(o.texts ? { texts: o.texts } : {}) });
  if (!scan.ok) return { state: "refused", why: scan.why, hits: scan.hits };
  if (remote === o.tip) return { state: "pushed", sha: o.tip, from: remote };
  const r = await git(["push", "--porcelain", "origin", `${o.tip}:refs/heads/${o.branch}`], root, { timeoutMs: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...noBackgroundCleanupEnv() } });
  if (r.code !== 0) return { state: "refused", why: `origin refused the push: ${firstLine(r.stderr || r.stdout)}` };
  return { state: "pushed", sha: o.tip, from: remote };
}

/** What origin's branch is now (null: none). */
export async function remoteBranch(git: Git, root: string, branch: string): Promise<{ sha: string | null } | { why: string }> {
  const ls = await git(["ls-remote", "origin", `refs/heads/${branch}`], root, { timeoutMs: 60_000 });
  if (ls.code !== 0) return { why: `origin can't be read: ${firstLine(ls.stderr)}` };
  return { sha: ls.stdout.split(/\s/)[0] || null };
}

export type UpdateMainResult =
  | { kind: "current"; head: string }
  | { kind: "updated"; from: string; to: string; parents: string[] }
  | { kind: "refused"; why: string };

/**
 * Update Local Main (q11): the local target fast-forwarded to origin's, as the queue moves it after a landing
 * (land.ts landTip: the main checkout too, only when clean; never forced). Refused, with the reason, when the
 * checkout holding it has uncommitted edits or local main has commits origin lacks; nothing pauses.
 */
export async function updateLocalMain(git: Git, root: string, target: string): Promise<UpdateMainResult> {
  const f = await fetchTarget(git, root, target);
  if ("why" in f) return { kind: "refused", why: f.why };
  const local = await revParse(git, root, `refs/heads/${target}`);
  if (!local) return { kind: "refused", why: `no branch ${target} in ${root}` };
  if (local === f.sha) return { kind: "current", head: local };
  if (!(await isAncestor(git, root, local, f.sha))) {
    const n = await countBetween(git, root, f.sha, local);
    return { kind: "refused", why: `local ${target} has ${n} commit${n === 1 ? "" : "s"} origin's doesn't: it isn't moved (never forced)` };
  }
  const parents = await firstParents(git, root, local, f.sha);
  const r = await landTip(git, root, target, local, f.sha);
  if (r.kind === "landed") return { kind: "updated", from: local, to: f.sha, parents };
  if (r.kind === "dirty") return { kind: "refused", why: `${r.why}: commit or put them away, then Update Local Main again` };
  return { kind: "refused", why: `local ${target} moved meanwhile: try again` };
}

/** How far local main is behind origin's (as last fetched); 0 when level or unknown. */
export async function localBehind(git: Git, root: string, target: string): Promise<number> {
  const local = await revParse(git, root, `refs/heads/${target}`);
  const remote = await revParse(git, root, `refs/remotes/origin/${target}`);
  if (!local || !remote || local === remote) return 0;
  return countBetween(git, root, local, remote);
}

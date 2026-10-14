import type { InstallKind, UpdateCheckResult, UpdateSource, UpdateTarget } from "../../shared/protocol";
import { firstLine, type Git } from "./git";
import { sourceLabel } from "./state";

/**
 * A check: the source's commit from `git ls-remote`, compared with the running
 * commit. Nothing here moves a branch, a tag, HEAD or a working file: objects arrive through a fetch
 * into the private namespace `refs/sova-updates/*`. Sova never moves to older code, so the answer
 * is "available" only when the source is newer.
 */

/** Sova's own repository: the only one updates come from. */
export const OFFICIAL_REPO = "https://github.com/Naomarik/sova.git";

/** The repository checks and upgrades use: Sova's, or the test-only stand-in `SOVA_UPDATES_REPO_URL`. */
export const repoUrlOf = (env: NodeJS.ProcessEnv): string => env.SOVA_UPDATES_REPO_URL?.trim() || OFFICIAL_REPO;

/** The repository's web page, when it is on GitHub ("https://github.com/Naomarik/sova"), else null. */
export function githubWebOf(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** `git ls-remote` output as name → commit, a tag's peeled commit (`^{}`) taking its place. */
export function parseLsRemote(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const [, sha, name] = m as unknown as [string, string, string];
    if (name.endsWith("^{}")) out.set(name.slice(0, -3), sha);
    else if (!out.has(name)) out.set(name, sha);
  }
  return out;
}

/** "v1.2.3" → [1, 2, 3]; anything else (a pre-release, "stable") → null. */
export function parseVersion(tag: string): [number, number, number] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** The numbered releases in `refs`, newest first: [tag, commit]. */
export function releasesOf(refs: Map<string, string>): [string, string][] {
  return [...refs]
    .filter(([name]) => name.startsWith("refs/tags/v") && parseVersion(name.slice(10)))
    .map(([name, sha]): [string, string] => [name.slice(10), sha])
    .sort((a, b) => compareVersions(b[0], a[0]));
}

/** The newest numbered release at `sha`, or null. */
export const releaseAt = (refs: Map<string, string>, sha: string | null): string | null => (sha ? (releasesOf(refs).find(([, s]) => s === sha)?.[0] ?? null) : null);

/** The ref a source follows. */
export const sourceRef = (s: UpdateSource): string => (s.kind === "stable" ? "refs/tags/stable" : s.kind === "master" ? "refs/heads/master" : `refs/heads/${s.branch}`);

/** The refs one check asks for: the source's, and every numbered release with its peeled commit. */
export function lsRemoteArgs(repo: string, s: UpdateSource): string[] {
  const ref = sourceRef(s);
  return ["ls-remote", repo, ref, `${ref}^{}`, "refs/tags/v*"];
}

/** That release's section of CHANGELOG.md ("## v0.3.3 — …" up to the next "## "), trimmed and capped. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version}`) && (l.length === 3 + version.length || /[\s—-]/.test(l[3 + version.length]!)));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const text = lines.slice(start + 1, end).join("\n").trim();
  return text ? (text.length > 6000 ? `${text.slice(0, 6000)}…` : text) : null;
}

export interface Running {
  head: string | null;
  branch: string | null;
  version: string | null;
  baseVersion: string | null;
  pastBase: number | null;
}

/** What the checkout runs: its commit, branch, release and how far past the newest release it is. */
export async function describeRunning(git: Git, refs?: Map<string, string>): Promise<Running> {
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim() || null;
  if (!head) return { head: null, branch: null, version: null, baseVersion: null, pastBase: null };
  const b = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = b.code === 0 ? b.stdout.trim() || null : null;
  let baseVersion: string | null = null;
  let pastBase: number | null = null;
  const d = await git(["describe", "--tags", "--long", "--match", "v[0-9]*", "--exclude", "stable", "HEAD"]);
  const m = d.code === 0 ? /^(v\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/.exec(d.stdout.trim()) : null;
  if (m) {
    baseVersion = m[1]!;
    pastBase = Number(m[2]);
  } else {
    // A shallow installer clone has no numbered tags: the ones a check fetched (refs/sova-updates/tags).
    const base = await newestReleaseIn(git, head);
    if (base) ({ version: baseVersion, past: pastBase } = base);
  }
  const version = releaseAt(refs ?? new Map(), head) ?? (pastBase === 0 ? baseVersion : null);
  return { head, branch, version, baseVersion, pastBase };
}

/** The newest release among the fetched ones (`refs/sova-updates/tags/*`) that `head` contains. */
async function newestReleaseIn(git: Git, head: string): Promise<{ version: string; past: number } | null> {
  const r = await git(["for-each-ref", "--format=%(refname:strip=3) %(objectname)", "refs/sova-updates/tags/"]);
  if (r.code !== 0) return null;
  const tags = r.stdout
    .split("\n")
    .map((l) => l.trim().split(" "))
    .filter((p): p is [string, string] => p.length === 2 && !!parseVersion(p[0]!))
    .sort((a, b) => compareVersions(b[0], a[0]));
  for (const [tag] of tags) {
    if ((await git(["merge-base", "--is-ancestor", `refs/sova-updates/tags/${tag}^{commit}`, head])).code !== 0) continue;
    const n = await git(["rev-list", "--count", `refs/sova-updates/tags/${tag}^{commit}..${head}`]);
    return { version: tag, past: Number(n.stdout.trim()) || 0 };
  }
  return null;
}

export interface CheckInput {
  git: Git;
  repo: string;
  source: UpdateSource;
  kind: InstallKind;
  /** The checkout's commit now. */
  head: string;
  /** The checkout's branch (null: detached), for a developer copy's refusal. */
  branch: string | null;
}

export interface CheckOutcome {
  result: UpdateCheckResult;
  refs: Map<string, string>;
}

/** Fetch `ref` (and every numbered release) from `repo` into refs/sova-updates/*, deepening a shallow clone first. */
export async function fetchPrivate(git: Git, repo: string, ref: string): Promise<void> {
  const shallow = (await git(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
  const r = await git(
    ["-c", "fetch.writeFetchHEAD=false", "fetch", "--quiet", "--no-tags", "--no-auto-gc", ...(shallow ? ["--unshallow"] : []), repo, `+${ref}:refs/sova-updates/target`, "+refs/tags/v*:refs/sova-updates/tags/v*"],
    { timeoutMs: 600_000 },
  );
  if (r.code !== 0) throw new Error(`Couldn't fetch from Sova's repository: ${firstLine(r)}.`);
}

/**
 * Why a developer copy can't follow `source` from the branch it is on, or null when it can: Latest
 * changes needs master checked out, a branch source that branch, Stable master or a detached HEAD.
 * Nothing of the developer's is moved to follow a source it isn't on (runner.ts repeats this rule).
 */
export function branchMismatch(source: UpdateSource, branch: string | null): string | null {
  if (source.kind === "stable") return branch === null || branch === "master" ? null : `You're on ${branch}; switch to master or a release to follow Stable.`;
  const want = source.kind === "master" ? "master" : source.branch;
  if (branch === want) return null;
  return branch ? `You're on ${branch}; switch to ${want} to follow it.` : `Your copy isn't on a branch; switch to ${want} to follow it.`;
}

export async function checkForUpdate(input: CheckInput): Promise<CheckOutcome> {
  const { git, repo, source, head } = input;
  const ls = await git(lsRemoteArgs(repo, source), { timeoutMs: 60_000 });
  if (ls.code !== 0) throw new Error(`Couldn't reach Sova's repository: ${firstLine(ls)}.`);
  const refs = parseLsRemote(ls.stdout);
  const ref = sourceRef(source);
  const sha = refs.get(ref);
  if (!sha) {
    throw new Error(source.kind === "branch" ? `Sova's repository has no branch ${source.branch}.` : source.kind === "stable" ? "Sova's repository has no stable release yet." : "Sova's repository has no master branch.");
  }
  const version = source.kind === "stable" ? releaseAt(refs, sha) : null;
  const label = source.kind === "stable" ? (version ?? "stable") : source.kind === "master" ? "master" : source.branch;
  const name = sourceLabel(source);
  if (sha === head) return { result: { state: "up-to-date" }, refs };
  // A developer copy on another branch than the source's is never offered a move.
  const wrong = input.kind === "developer" ? branchMismatch(source, input.branch) : null;
  if (wrong) return { result: { state: "diverged", target: { sha, label, version, count: null, subject: null, notes: null, notesUrl: null }, message: wrong }, refs };

  await fetchPrivate(git, repo, ref);
  const target: UpdateTarget = { sha, label, version, count: null, subject: null, notes: null, notesUrl: null };
  const subject = await git(["log", "-1", "--format=%s", sha]);
  if (subject.code === 0) target.subject = subject.stdout.trim() || null;
  const web = githubWebOf(repo);
  if (version) {
    const log = await git(["show", `${sha}:CHANGELOG.md`]);
    if (log.code === 0) target.notes = changelogSection(log.stdout, version);
    if (web) target.notesUrl = `${web}/blob/${version}/CHANGELOG.md`;
  } else if (web) {
    target.notesUrl = `${web}/compare/${head.slice(0, 12)}...${sha.slice(0, 12)}`;
  }
  const ahead = { state: "ahead" as const, message: `You're ahead of ${name}; updates resume when ${name} catches up.` };

  // Two numbered releases: the numbers decide, whatever the history says.
  const running = releaseAt(refs, head);
  if (source.kind === "stable" && running && version) {
    if (compareVersions(version, running) <= 0) return { result: ahead, refs };
  }
  const isAncestor = async (a: string, b: string) => (await git(["merge-base", "--is-ancestor", a, b])).code === 0;
  if (await isAncestor(head, sha)) {
    const n = await git(["rev-list", "--count", `${head}..${sha}`]);
    target.count = n.code === 0 ? Number(n.stdout.trim()) : null;
    return { result: { state: "available", target }, refs };
  }
  if (await isAncestor(sha, head)) return { result: ahead, refs };
  if (source.kind === "stable" && version) {
    const base = await newestReleaseIn(git, head);
    if (base && compareVersions(base.version, version) >= 0) return { result: ahead, refs };
  }
  const message =
    input.kind === "installer"
      ? `This copy isn't on ${name}'s history (it was rewritten, or you installed another branch). Upgrading installs ${label} as it is now.`
      : `Your copy's ${input.branch ? `branch ${input.branch}` : "commit"} isn't part of ${name}'s history, so we won't move it.`;
  return { result: { state: "diverged", target, message }, refs };
}

/** Whether a check's result offers an upgrade on a copy of `kind`: an update, or a rewritten source on an installed copy. */
export const offersUpgrade = (r: UpdateCheckResult | undefined, kind: InstallKind): r is Extract<UpdateCheckResult, { target: UpdateTarget }> =>
  !!r && (r.state === "available" || (r.state === "diverged" && kind === "installer"));

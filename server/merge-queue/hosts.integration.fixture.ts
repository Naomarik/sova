import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stand-in `gh` and `glab` programs for tests: never a real host. `standInHosts()` writes both into a bin folder; put
 * it first on PATH (`withStandInPath`) and the server's host adapters (server/merge-queue/hosts/) run them like the real
 * tools. They keep one shared state file (sign-in per host, the requests opened) and log every call (argv + stdin).
 * With `origin` (a local bare repository), a request's head is read from it live, and opening one from a branch
 * origin doesn't have fails as the real tools do. `merge()` merges a request on the stand-in host: into `origin`'s
 * base (a merge commit, or a squash), recording the host's merge commit.
 *
 * Supported: `gh auth status`, `gh pr create|list|view|edit`; `glab auth status`, `glab mr create|list|view|update`,
 * `glab api …/approvals`. Anything else exits 2 naming itself, so a test sees an unexpected call.
 */

export interface StandInRequest {
  host: "github" | "gitlab";
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** GitHub rollup / GitLab pipeline stand-ins: "none" reports no checks at all. */
  checks: "none" | "pending" | "pass" | "fail";
  review: "none" | "approved" | "changes-requested" | "review-required";
  conflicts: boolean;
  mergeCommit: string | null;
  mergedAt: string | null;
  /** Fixed head when there is no origin. */
  headSha?: string;
}

export interface StandInState {
  signedIn: { github: boolean; gitlab: boolean };
  /** Hosts glab is signed in to besides gitlab.com and those named gitlab.* (self-hosted). */
  glabHosts: string[];
  origin: string | null;
  requests: StandInRequest[];
  /** The next call to this program fails with these words (then is cleared). */
  failNext: { cli: "gh" | "glab"; stderr: string; code: number } | null;
  /** Calls hang this long first (a timeout test). */
  delayMs: number;
}

export interface StandInCall {
  cli: "gh" | "glab";
  args: string[];
  stdin: string;
}

const PROGRAM = String.raw`import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const cli = process.argv[2];
const args = process.argv.slice(3);
const stateFile = dir + "/state.json";
let stdin = "";
if (args.includes("-")) { try { stdin = readFileSync(0, "utf8"); } catch {} }
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ cli, args, stdin }) + "\n");
const st = JSON.parse(readFileSync(stateFile, "utf8"));
const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 2));
const out = (s) => process.stdout.write(s);
const die = (msg, code = 1) => { process.stderr.write(msg + "\n"); process.exit(code); };
if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
if (st.failNext && st.failNext.cli === cli) { const f = st.failNext; st.failNext = null; save(); die(f.stderr, f.code); }
const opt = (...names) => { for (const n of names) { const i = args.indexOf(n); if (i >= 0) return args[i + 1]; } return undefined; };
const host = cli === "gh" ? "github" : "gitlab";
const originHead = (branch) => { if (!st.origin) return null; try { return execFileSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch], { cwd: st.origin, encoding: "utf8" }).trim() || null; } catch { return null; } };
const head = (r) => originHead(r.head) ?? r.headSha ?? null;
const mine = () => st.requests.filter((r) => r.host === host);
const find = (n) => mine().find((r) => r.number === Number(n));
const needAuth = () => { if (!st.signedIn[host]) die(cli === "gh" ? "To get started with GitHub CLI, please run:  gh auth login" : "glab: not authenticated. Run glab auth login", cli === "gh" ? 4 : 1); };
if (args[0] === "auth" && args[1] === "status") {
  const h = opt("--hostname") ?? (cli === "gh" ? "github.com" : "gitlab.com");
  if (cli === "gh") { if (!st.signedIn.github || h !== "github.com") die("You are not logged into any GitHub hosts. To log in, run: gh auth login"); out("github.com\n  ✓ Logged in to github.com account standin (keyring)\n  - Token: gho_************************************\n"); process.exit(0); }
  const known = h === "gitlab.com" || /^gitlab\./.test(h) || st.glabHosts.includes(h);
  if (!st.signedIn.gitlab || !known) die(h + "\n  x " + h + ": api call failed: 401 Unauthorized");
  out(h + "\n  ✓ Logged in to " + h + " as standin\n"); process.exit(0);
}
needAuth();
const ghJson = (r) => ({ number: r.number, url: "https://github.com/acme/app/pull/" + r.number, state: r.state.toUpperCase(), isDraft: r.draft, mergedAt: r.mergedAt, mergeCommit: r.mergeCommit ? { oid: r.mergeCommit } : null, mergeable: r.conflicts ? "CONFLICTING" : "MERGEABLE", reviewDecision: { approved: "APPROVED", "changes-requested": "CHANGES_REQUESTED", "review-required": "REVIEW_REQUIRED", none: "" }[r.review], statusCheckRollup: r.checks === "none" ? [] : [{ __typename: "CheckRun", name: "ci", status: r.checks === "pending" ? "IN_PROGRESS" : "COMPLETED", conclusion: r.checks === "pass" ? "SUCCESS" : r.checks === "fail" ? "FAILURE" : "" }], headRefOid: head(r), headRefName: r.head, baseRefName: r.base, title: r.title, body: r.body });
const glJson = (r) => ({ iid: r.number, web_url: "https://gitlab.example.com/team/app/-/merge_requests/" + r.number, state: r.state === "open" ? "opened" : r.state, draft: r.draft, merged_at: r.mergedAt, merge_commit_sha: r.mergeCommit, squash_commit_sha: null, detailed_merge_status: r.conflicts ? "conflict" : r.review === "changes-requested" ? "requested_changes" : r.review === "review-required" ? "not_approved" : "mergeable", has_conflicts: r.conflicts, head_pipeline: r.checks === "none" ? null : { status: { pending: "running", pass: "success", fail: "failed" }[r.checks] }, sha: head(r), source_branch: r.head, target_branch: r.base, title: r.title, description: r.body });
const create = (h, b, title, body) => {
  if (!h || !b || !title) die("missing --head/--base/--title");
  if (st.origin && !originHead(h)) die(cli === "gh" ? "pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between " + b + " and " + h + " (createPullRequest)" : "ERROR: 422 Unprocessable Entity: Source branch '" + h + "' does not exist");
  if (mine().some((r) => r.head === h && r.base === b && r.state === "open")) die(cli === "gh" ? "a pull request for branch \"" + h + "\" into branch \"" + b + "\" already exists" : "Another open merge request already exists for this source branch");
  const number = st.requests.reduce((m, r) => Math.max(m, r.number), 0) + 1;
  const r = { host, number, head: h, base: b, title, body, state: "open", draft: false, checks: "none", review: "none", conflicts: false, mergeCommit: null, mergedAt: null };
  st.requests.push(r); save(); return r;
};
if (cli === "gh" && args[0] === "pr") {
  const sub = args[1];
  if (sub === "create") { const r = create(opt("--head", "-H"), opt("--base", "-B"), opt("--title", "-t"), opt("--body-file", "-F") === "-" ? stdin : (opt("--body", "-b") ?? "")); out("https://github.com/acme/app/pull/" + r.number + "\n"); process.exit(0); }
  if (sub === "view") { const r = find(args[2]); if (!r) die("GraphQL: Could not resolve to a PullRequest with the number of " + args[2] + "."); out(JSON.stringify(ghJson(r))); process.exit(0); }
  if (sub === "list") { const s = opt("--state") ?? "open"; const list = mine().filter((r) => (!opt("--head") || r.head === opt("--head")) && (!opt("--base") || r.base === opt("--base")) && (s === "all" || r.state === s)); out(JSON.stringify(list.map(ghJson))); process.exit(0); }
  if (sub === "edit") { const r = find(args[2]); if (!r) die("no pull requests found"); if (opt("--title") !== undefined) r.title = opt("--title"); if (opt("--body-file") === "-") r.body = stdin; save(); out(r.number + "\n"); process.exit(0); }
}
if (cli === "glab" && args[0] === "mr") {
  const sub = args[1];
  if (sub === "create") { if (!args.includes("--yes")) die("would prompt for confirmation"); const r = create(opt("--source-branch", "-s"), opt("--target-branch", "-b"), opt("--title", "-t"), opt("--description-file") === "-" ? stdin : (opt("--description", "-d") ?? "")); out("\n!" + r.number + " " + r.title + " (" + r.head + ")\n https://gitlab.example.com/team/app/-/merge_requests/" + r.number + "\n\n"); process.exit(0); }
  if (sub === "view") { const r = find(args[2]); if (!r) die("ERROR: 404 Not Found"); out(JSON.stringify(glJson(r))); process.exit(0); }
  if (sub === "list") { const all = args.includes("--all"); const list = mine().filter((r) => (!opt("--source-branch") || r.head === opt("--source-branch")) && (!opt("--target-branch") || r.base === opt("--target-branch")) && (all || r.state === "open")); out(JSON.stringify(list.map(glJson))); process.exit(0); }
  if (sub === "update") { if (!args.includes("--yes")) die("would prompt for confirmation"); const r = find(args[2]); if (!r) die("ERROR: 404 Not Found"); if (opt("--title") !== undefined) r.title = opt("--title"); if (opt("--description-file") === "-") r.body = stdin; save(); out("updated\n"); process.exit(0); }
}
if (cli === "glab" && args[0] === "api") {
  const m = /merge_requests\/(\d+)\/approvals$/.exec(args[args.length - 1]);
  const r = m && find(m[1]);
  if (!r) die("ERROR: 404 Not Found");
  out(JSON.stringify({ approved: r.review === "approved" || r.review === "none", approved_by: r.review === "approved" ? [{ user: { username: "reviewer" } }] : [] })); process.exit(0);
}
die("stand-in " + cli + ": unsupported call: " + args.join(" "), 2);
`;

export interface StandInHosts {
  /** The folder holding `gh` and `glab`: put it first on PATH. */
  bin: string;
  state(): StandInState;
  set(change: Partial<StandInState>): void;
  /** Change one request on the stand-in host (checks finish, a review, closing it). */
  update(host: "github" | "gitlab", number: number, change: Partial<StandInRequest>): void;
  calls(): StandInCall[];
  /** Merge a request on the stand-in host: into `origin`'s base, a merge commit (or a squash); → the host's merge commit. */
  merge(host: "github" | "gitlab", number: number, opts?: { squash?: boolean }): string;
}

export function standInHosts(init: Partial<StandInState> = {}): StandInHosts {
  const bin = mkdtempSync(join(tmpdir(), "sova-standin-hosts-"));
  const stateFile = join(bin, "state.json");
  const write = (s: StandInState) => writeFileSync(stateFile, JSON.stringify(s, null, 2));
  write({ signedIn: { github: true, gitlab: true }, glabHosts: [], origin: null, requests: [], failNext: null, delayMs: 0, ...init });
  writeFileSync(join(bin, "calls.jsonl"), "");
  writeFileSync(join(bin, "standin.mjs"), PROGRAM);
  // The node that runs the tests, by its path: the stand-ins never depend on what else PATH holds.
  for (const cli of ["gh", "glab"]) {
    writeFileSync(join(bin, cli), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$(dirname "$0")/standin.mjs" ${cli} "$@"\n`);
    chmodSync(join(bin, cli), 0o755);
  }
  const state = (): StandInState => JSON.parse(readFileSync(stateFile, "utf8"));
  const self: StandInHosts = {
    bin,
    state,
    set: (change) => write({ ...state(), ...change }),
    update(host, number, change) {
      const s = state();
      const r = s.requests.find((x) => x.host === host && x.number === number);
      if (!r) throw new Error(`no stand-in request ${host} #${number}`);
      Object.assign(r, change);
      write(s);
    },
    calls: () =>
      readFileSync(join(bin, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as StandInCall),
    merge(host, number, opts = {}) {
      const s = state();
      const r = s.requests.find((x) => x.host === host && x.number === number);
      if (!r || r.state !== "open") throw new Error(`stand-in request ${host} #${number} isn't open`);
      if (!s.origin) throw new Error("merge() needs an origin");
      const work = mkdtempSync(join(tmpdir(), "sova-standin-merge-"));
      const git = (...a: string[]) => execFileSync("git", a, { cwd: work, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.invalid", GIT_COMMITTER_NAME: "Host", GIT_COMMITTER_EMAIL: "host@example.invalid" } }).trim();
      git("clone", "--quiet", s.origin, ".");
      git("checkout", "--quiet", r.base);
      if (opts.squash) {
        git("merge", "--squash", "--quiet", `origin/${r.head}`);
        git("commit", "--quiet", "-m", `${r.title} (#${number})`);
      } else git("merge", "--no-ff", "--quiet", "-m", `Merge request #${number}: ${r.title}`, `origin/${r.head}`);
      git("push", "--quiet", "origin", `HEAD:refs/heads/${r.base}`);
      const sha = git("rev-parse", "HEAD");
      r.state = "merged";
      r.mergeCommit = sha;
      r.mergedAt = new Date().toISOString();
      write(s);
      return sha;
    },
  };
  return self;
}

/** Run `fn` with `bin` first on PATH (restored after). The host adapters read PATH when they run a tool. */
export async function withStandInPath<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

/** A bare origin with `main` holding one commit, and a clone to work in. */
export function bareOrigin(): { origin: string; work: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "sova-standin-origin-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(work);
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: work, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "--quiet", "-m", "first");
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "origin", "main");
  if (!existsSync(origin)) throw new Error("no origin");
  return { origin, work, git };
}

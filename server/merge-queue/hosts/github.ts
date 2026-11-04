import { type CliResult, type CliRunner, realCli, sanitizeCliError } from "./run";
import { BODY_MAX, type HostAdapter, type HostFail, type HostRepo, installFirst, type RequestChecks, type RequestFacts, type RequestMergeable, type RequestReview, type RequestState, signInFirst } from "./types";

/** GitHub through `gh`. */

/** The fields Sova asks `gh pr view` / `gh pr list` for. */
export const GH_PR_FIELDS = "number,url,state,isDraft,mergedAt,mergeCommit,mergeable,reviewDecision,statusCheckRollup,headRefOid,headRefName,baseRefName";

const repoArg = (repo: HostRepo) => `${repo.host}/${repo.path}`;

/** A `gh` failure as a HostFail: sign-in trouble reads as the a11 refusal. */
export function ghFail(r: CliResult, repo: HostRepo): HostFail {
  if (r.missing) return { ok: false, code: "no-cli", why: installFirst("github") };
  if (r.timedOut) return { ok: false, code: "timeout", why: "GitHub didn't answer in time" };
  const text = `${r.stderr}\n${r.stdout}`;
  if (/gh auth login|not logged in|authentication required|bad credentials|HTTP 401|token .*(?:invalid|expired)/i.test(text)) return { ok: false, code: "not-signed-in", why: signInFirst("github", repo.host) };
  if (/could not resolve to a (?:pullrequest|repository)|no pull requests? found|HTTP 404|not found/i.test(text)) return { ok: false, code: "not-found", why: sanitizeCliError(r.stderr || r.stdout, "not found on GitHub") };
  return { ok: false, code: "failed", why: sanitizeCliError(r.stderr || r.stdout, `gh exited with ${r.code}`) };
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The checks' summary from `statusCheckRollup`: any failure fails, any still running is pending, none is "not-reported". */
export function ghChecks(rollup: unknown): RequestChecks {
  if (!Array.isArray(rollup) || !rollup.length) return "not-reported";
  let pending = false;
  let counted = 0;
  for (const c of rollup as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") continue;
    // A CheckRun has status + conclusion; a StatusContext has state.
    const status = String(c.status ?? "").toUpperCase();
    const conclusion = String(c.conclusion ?? "").toUpperCase();
    const state = String(c.state ?? "").toUpperCase();
    if (c.__typename === "StatusContext" || (state && !status)) {
      counted++;
      if (state === "FAILURE" || state === "ERROR") return "fail";
      if (state !== "SUCCESS") pending = true;
      continue;
    }
    counted++;
    if (status && status !== "COMPLETED") {
      pending = true;
      continue;
    }
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(conclusion)) return "fail";
    if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) pending = true;
  }
  if (!counted) return "not-reported";
  return pending ? "pending" : "pass";
}

/** `gh pr view --json` → RequestFacts, or null when it isn't one. */
export function ghFacts(j: unknown): RequestFacts | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const number = typeof o.number === "number" && Number.isInteger(o.number) && o.number > 0 ? o.number : null;
  const url = s(o.url);
  if (!number || !url) return null;
  const st = String(o.state ?? "").toUpperCase();
  const state: RequestState = st === "MERGED" ? "merged" : st === "CLOSED" ? "closed" : o.isDraft === true ? "draft" : "open";
  const rd = String(o.reviewDecision ?? "").toUpperCase();
  const review: RequestReview = rd === "APPROVED" ? "approved" : rd === "CHANGES_REQUESTED" ? "changes-requested" : rd === "REVIEW_REQUIRED" ? "review-required" : "none";
  const m = String(o.mergeable ?? "").toUpperCase();
  const mergeable: RequestMergeable = m === "MERGEABLE" ? "mergeable" : m === "CONFLICTING" ? "conflicts" : "unknown";
  const mc = o.mergeCommit && typeof o.mergeCommit === "object" ? s((o.mergeCommit as Record<string, unknown>).oid) : null;
  return {
    number,
    url,
    state,
    checks: ghChecks(o.statusCheckRollup),
    review,
    mergeable,
    headSha: s(o.headRefOid),
    headBranch: s(o.headRefName) ?? "",
    baseBranch: s(o.baseRefName) ?? "",
    mergeCommit: state === "merged" ? mc : null,
    mergedAt: state === "merged" ? s(o.mergedAt) : null,
  };
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function githubAdapter(run: CliRunner = realCli): HostAdapter {
  const view: HostAdapter["view"] = async (repo, number) => {
    const r = await run("gh", ["pr", "view", String(number), "--repo", repoArg(repo), "--json", GH_PR_FIELDS], { timeoutMs: 30_000 });
    if (r.code !== 0) return ghFail(r, repo);
    const request = ghFacts(parse(r.stdout));
    return request ? { ok: true, request } : { ok: false, code: "failed", why: "gh answered with something that isn't a pull request" };
  };
  return {
    kind: "github",
    cli: "gh",
    async auth(repo) {
      const r = await run("gh", ["auth", "status", "--hostname", repo.host], { timeoutMs: 15_000 });
      if (r.code === 0) return { ok: true };
      if (r.missing || r.timedOut) return ghFail(r, repo);
      // `gh auth status` exits 1 for no login and for an expired or invalid one alike.
      return { ok: false, code: "not-signed-in", why: signInFirst("github", repo.host) };
    },
    async find(repo, q) {
      const r = await run("gh", ["pr", "list", "--repo", repoArg(repo), "--head", q.head, "--base", q.base, "--state", q.all ? "all" : "open", "--limit", "20", "--json", GH_PR_FIELDS], { timeoutMs: 30_000 });
      if (r.code !== 0) return ghFail(r, repo);
      const list = parse(r.stdout);
      if (!Array.isArray(list)) return { ok: false, code: "failed", why: "gh answered with something that isn't a list of pull requests" };
      const found = list
        .map(ghFacts)
        .filter((f): f is RequestFacts => !!f && f.headBranch === q.head && (!f.baseBranch || f.baseBranch === q.base))
        .sort((a, b) => b.number - a.number);
      return { ok: true, request: found.find((f) => f.state === "open" || f.state === "draft") ?? (q.all ? (found[0] ?? null) : null) };
    },
    async create(repo, req) {
      const r = await run("gh", ["pr", "create", "--repo", repoArg(repo), "--head", req.head, "--base", req.base, "--title", req.title, "--body-file", "-"], { stdin: req.body.slice(0, BODY_MAX), timeoutMs: 90_000 });
      if (r.code !== 0) return ghFail(r, repo);
      const m = /\/pull\/(\d+)\b/.exec(r.stdout);
      if (!m) return { ok: false, code: "failed", why: "gh didn't say which pull request it opened" };
      return view(repo, Number(m[1]));
    },
    async update(repo, number, change) {
      const args = ["pr", "edit", String(number), "--repo", repoArg(repo)];
      if (change.title !== undefined) args.push("--title", change.title);
      if (change.body !== undefined) args.push("--body-file", "-");
      if (args.length === 5) return { ok: true };
      const r = await run("gh", args, { ...(change.body !== undefined ? { stdin: change.body.slice(0, BODY_MAX) } : {}), timeoutMs: 60_000 });
      return r.code === 0 ? { ok: true } : ghFail(r, repo);
    },
    view,
  };
}

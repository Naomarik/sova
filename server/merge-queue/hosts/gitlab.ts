import { type CliResult, type CliRunner, realCli, sanitizeCliError } from "./run";
import { BODY_MAX, type HostAdapter, type HostFail, type HostRepo, installFirst, type RequestChecks, type RequestFacts, type RequestMergeable, type RequestReview, type RequestState, signInFirst } from "./types";

/** GitLab (gitlab.com or self-hosted) through `glab`. `-R` takes the repo's web URL, so the host is never guessed. */

const bareHost = (repo: HostRepo) => repo.host.replace(/:\d+$/, "");

export function glabFail(r: CliResult, repo: HostRepo): HostFail {
  if (r.missing) return { ok: false, code: "no-cli", why: installFirst("gitlab") };
  if (r.timedOut) return { ok: false, code: "timeout", why: "GitLab didn't answer in time" };
  const text = `${r.stderr}\n${r.stdout}`;
  if (/glab auth login|not authenticated|no token|401 unauthorized|invalid_token|token .*(?:invalid|expired|revoked)/i.test(text)) return { ok: false, code: "not-signed-in", why: signInFirst("gitlab", bareHost(repo)) };
  if (/404|not found/i.test(text)) return { ok: false, code: "not-found", why: sanitizeCliError(r.stderr || r.stdout, "not found on GitLab") };
  return { ok: false, code: "failed", why: sanitizeCliError(r.stderr || r.stdout, `glab exited with ${r.code}`) };
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A pipeline status → the checks' summary. No pipeline (or a skipped one) is "not-reported". */
export function glabChecks(status: unknown): RequestChecks {
  const st = typeof status === "string" ? status.toLowerCase() : "";
  if (!st || st === "skipped") return "not-reported";
  if (st === "success") return "pass";
  if (st === "failed" || st === "canceled" || st === "cancelled") return "fail";
  return "pending"; // created, waiting_for_resource, preparing, pending, running, scheduled, manual
}

/**
 * GitLab's merge request JSON (`glab mr view -F json`) → RequestFacts. `approvals`: the approvals endpoint's answer,
 * when it was read (`{approved, approved_by}`).
 */
export function glabFacts(j: unknown, approvals?: unknown): RequestFacts | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const number = typeof o.iid === "number" && Number.isInteger(o.iid) && o.iid > 0 ? o.iid : null;
  const url = s(o.web_url);
  if (!number || !url) return null;
  const st = String(o.state ?? "").toLowerCase();
  const draft = o.draft === true || o.work_in_progress === true;
  const state: RequestState = st === "merged" ? "merged" : st === "closed" ? "closed" : draft ? "draft" : "open";
  const dms = String(o.detailed_merge_status ?? o.merge_status ?? "").toLowerCase();
  const mergeable: RequestMergeable =
    o.has_conflicts === true || dms === "conflict" || dms === "cannot_be_merged" ? "conflicts" : ["checking", "unchecked", "preparing", "cannot_be_merged_recheck", ""].includes(dms) ? "unknown" : "mergeable";
  const a = approvals && typeof approvals === "object" ? (approvals as Record<string, unknown>) : null;
  const approvedBy = Array.isArray(a?.approved_by) ? a!.approved_by.length : 0;
  const review: RequestReview =
    dms === "requested_changes" ? "changes-requested" : a?.approved === true && approvedBy > 0 ? "approved" : dms === "not_approved" || (a && a.approved === false) ? "review-required" : "none";
  const pipe = (o.head_pipeline ?? o.pipeline) as Record<string, unknown> | null | undefined;
  return {
    number,
    url,
    state,
    checks: glabChecks(pipe && typeof pipe === "object" ? pipe.status : null),
    review,
    mergeable: state === "merged" || state === "closed" ? "unknown" : mergeable,
    headSha: s(o.sha),
    headBranch: s(o.source_branch) ?? "",
    baseBranch: s(o.target_branch) ?? "",
    mergeCommit: state === "merged" ? (s(o.merge_commit_sha) ?? s(o.squash_commit_sha)) : null,
    mergedAt: state === "merged" ? s(o.merged_at) : null,
  };
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function gitlabAdapter(run: CliRunner = realCli): HostAdapter {
  const approvalsOf = async (repo: HostRepo, iid: number): Promise<unknown> => {
    const r = await run("glab", ["api", "--hostname", bareHost(repo), `projects/${encodeURIComponent(repo.path)}/merge_requests/${iid}/approvals`], { timeoutMs: 30_000 });
    return r.code === 0 ? parse(r.stdout) : undefined; // optional: without it, the review reads from the merge status alone
  };
  const view: HostAdapter["view"] = async (repo, number) => {
    const r = await run("glab", ["mr", "view", String(number), "-R", repo.web, "-F", "json"], { timeoutMs: 30_000 });
    if (r.code !== 0) return glabFail(r, repo);
    const j = parse(r.stdout);
    if (!glabFacts(j)) return { ok: false, code: "failed", why: "glab answered with something that isn't a merge request" };
    const st = String((j as { state?: unknown }).state ?? "");
    const request = glabFacts(j, st === "opened" ? await approvalsOf(repo, number) : undefined)!;
    return { ok: true, request };
  };
  return {
    kind: "gitlab",
    cli: "glab",
    async auth(repo) {
      const r = await run("glab", ["auth", "status", "--hostname", bareHost(repo)], { timeoutMs: 15_000 });
      // Older glab versions exit 0 while saying the login failed: the words count too.
      if (r.code === 0 && !/no token|not authenticated|not logged in|401 unauthorized|invalid token/i.test(`${r.stderr}\n${r.stdout}`)) return { ok: true };
      if (r.missing || r.timedOut) return glabFail(r, repo);
      return { ok: false, code: "not-signed-in", why: signInFirst("gitlab", bareHost(repo)) };
    },
    async find(repo, q) {
      const r = await run("glab", ["mr", "list", "-R", repo.web, "--source-branch", q.head, "--target-branch", q.base, ...(q.all ? ["--all"] : []), "--per-page", "20", "-F", "json"], { timeoutMs: 30_000 });
      if (r.code !== 0) return glabFail(r, repo);
      const list = parse(r.stdout);
      if (!Array.isArray(list)) return { ok: false, code: "failed", why: "glab answered with something that isn't a list of merge requests" };
      const found = list
        .map((j) => glabFacts(j))
        .filter((f): f is RequestFacts => !!f && f.headBranch === q.head && f.baseBranch === q.base)
        .sort((a, b) => b.number - a.number);
      const pick = found.find((f) => f.state === "open" || f.state === "draft") ?? (q.all ? (found[0] ?? null) : null);
      if (!pick) return { ok: true, request: null };
      const full = await view(repo, pick.number); // the list omits the pipeline and approvals
      return full.ok ? { ok: true, request: full.request } : full;
    },
    async create(repo, req) {
      const r = await run(
        "glab",
        ["mr", "create", "-R", repo.web, "--source-branch", req.head, "--target-branch", req.base, "--title", req.title, "--description-file", "-", "--yes"],
        { stdin: req.body.slice(0, BODY_MAX), timeoutMs: 90_000 },
      );
      if (r.code !== 0) return glabFail(r, repo);
      const m = /\/merge_requests\/(\d+)\b/.exec(r.stdout) ?? /\/merge_requests\/(\d+)\b/.exec(r.stderr);
      if (!m) return { ok: false, code: "failed", why: "glab didn't say which merge request it opened" };
      return view(repo, Number(m[1]));
    },
    async update(repo, number, change) {
      const args = ["mr", "update", String(number), "-R", repo.web];
      if (change.title !== undefined) args.push("--title", change.title);
      if (change.body !== undefined) args.push("--description-file", "-");
      if (args.length === 5) return { ok: true };
      args.push("--yes");
      const r = await run("glab", args, { ...(change.body !== undefined ? { stdin: change.body.slice(0, BODY_MAX) } : {}), timeoutMs: 60_000 });
      return r.code === 0 ? { ok: true } : glabFail(r, repo);
    },
    view,
  };
}

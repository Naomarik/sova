// Run: pnpm test server/merge-queue/hosts.test.ts
// The host adapters (server/merge-queue/hosts/) in-process, with a recorded fake runner in place of gh / glab: the
// argument arrays each call sends, how each host's JSON reads as RequestFacts (missing checks are "not-reported",
// never "pass"), the sign-in refusal's exact words, sanitized errors, remote detection and the suggestion.
// The same calls against stand-in executables on PATH: hosts.integration.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { adapterFor, type CliResult, type CliRunner, ghChecks, ghFacts, glabChecks, glabFacts, type HostRepo, remoteParts, repoOf, sanitizeCliError, signInFirst, suggestLanding } from "./hosts/index";
import { ghFail } from "./hosts/github";

const GH: HostRepo = { kind: "github", host: "github.com", path: "acme/app", web: "https://github.com/acme/app" };
const GL: HostRepo = { kind: "gitlab", host: "gitlab.example.com", path: "team/sub/app", web: "https://gitlab.example.com/team/sub/app" };

type Call = { cli: string; args: string[]; stdin?: string };
function fake(answer: (c: Call) => Partial<CliResult>): { run: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CliRunner = async (cli, args, opts = {}) => {
    const c = { cli, args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) };
    calls.push(c);
    return { code: 0, stdout: "", stderr: "", ...answer(c) };
  };
  return { run, calls };
}

const ghPr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  mergeCommit: null,
  mergeable: "MERGEABLE",
  reviewDecision: "",
  statusCheckRollup: [],
  headRefOid: "a".repeat(40),
  headRefName: "feat/x",
  baseRefName: "main",
  ...over,
});

const glMr = (over: Record<string, unknown> = {}) => ({
  iid: 12,
  web_url: "https://gitlab.example.com/team/sub/app/-/merge_requests/12",
  state: "opened",
  draft: false,
  merged_at: null,
  merge_commit_sha: null,
  squash_commit_sha: null,
  detailed_merge_status: "mergeable",
  has_conflicts: false,
  head_pipeline: null,
  sha: "b".repeat(40),
  source_branch: "feat/x",
  target_branch: "main",
  ...over,
});

describe("remote detection and the suggestion (a2)", () => {
  test("remote URL forms: https, scp, ssh with a port, credentials dropped, .git dropped", () => {
    assert.deepEqual(remoteParts("https://github.com/acme/app.git"), { host: "github.com", path: "acme/app" });
    assert.deepEqual(remoteParts("git@github.com:acme/app.git"), { host: "github.com", path: "acme/app" });
    assert.deepEqual(remoteParts("ssh://git@gitlab.example.com:2222/team/sub/app.git"), { host: "gitlab.example.com", path: "team/sub/app" });
    assert.deepEqual(remoteParts("https://user:" + "pw-fake-01" + "@gitlab.example.com:8443/team/app"), { host: "gitlab.example.com:8443", path: "team/app" });
    assert.equal(remoteParts("/srv/git/app.git"), null);
    assert.equal(remoteParts("../app"), null);
    assert.equal(remoteParts("https://github.com/acme/../x"), null);
  });

  test("repoOf: github.com is owner/repo only; GitLab hosts by name or as glab knows them", () => {
    assert.deepEqual(repoOf("git@github.com:acme/app.git"), GH);
    assert.equal(repoOf("https://github.com/acme/app/extra"), null, "a GitHub repo is owner/repo");
    assert.equal(repoOf("https://gitlab.com/g/s/r.git")?.kind, "gitlab");
    assert.equal(repoOf("https://gitlab.example.com/team/sub/app.git")?.web, GL.web);
    assert.equal(repoOf("https://code.example.org/team/app.git"), null);
    assert.equal(repoOf("https://code.example.org/team/app.git", ["code.example.org"])?.kind, "gitlab");
  });

  test("suggestLanding: GitHub → PR, GitLab → MR, glab-known host → MR, else local; asks glab only for an unknown host", async () => {
    const none = fake(() => ({ code: 1 }));
    assert.equal((await suggestLanding("git@github.com:acme/app.git", { run: none.run })).how, "github-pr");
    assert.equal((await suggestLanding("https://gitlab.com/g/r.git", { run: none.run })).how, "gitlab-mr");
    assert.equal(none.calls.length, 0, "known hosts need no tool call");
    assert.equal((await suggestLanding(null, { run: none.run })).how, "local");
    assert.equal((await suggestLanding("/srv/git/app.git", { run: none.run })).how, "local");
    const other = await suggestLanding("https://code.example.org/team/app.git", { run: none.run });
    assert.equal(other.how, "local");
    assert.deepEqual(none.calls.at(-1), { cli: "glab", args: ["auth", "status", "--hostname", "code.example.org"] });
    const known = fake((c) => ({ code: c.args.includes("code.example.org") ? 0 : 1 }));
    const s = await suggestLanding("https://code.example.org/team/app.git", { run: known.run });
    assert.equal(s.how, "gitlab-mr");
    assert.equal(s.repo?.web, "https://code.example.org/team/app");
  });

  test("a missing glab never suggests GitLab", async () => {
    const missing = fake(() => ({ code: 127, missing: true }));
    assert.equal((await suggestLanding("https://code.example.org/team/app.git", { run: missing.run })).how, "local");
  });
});

describe("sign-in (a11)", () => {
  test("the exact refusal words", () => {
    assert.equal(signInFirst("github"), "Sign in to GitHub on this computer first (gh auth login)");
    assert.equal(signInFirst("gitlab"), "Sign in to GitLab on this computer first (glab auth login)");
    assert.equal(signInFirst("gitlab", "gitlab.example.com"), "Sign in to GitLab on this computer first (glab auth login --hostname gitlab.example.com)");
  });

  test("auth asks the tool for the repo's host, never for a token", async () => {
    const ok = fake(() => ({ code: 0 }));
    assert.deepEqual(await adapterFor("github", ok.run).auth(GH), { ok: true });
    assert.deepEqual(await adapterFor("gitlab", ok.run).auth(GL), { ok: true });
    assert.deepEqual(ok.calls.map((c) => [c.cli, ...c.args]), [
      ["gh", "auth", "status", "--hostname", "github.com"],
      ["glab", "auth", "status", "--hostname", "gitlab.example.com"],
    ]);
    assert.ok(!ok.calls.some((c) => c.args.some((a) => /token/i.test(a))), "never --show-token");
  });

  test("not signed in (or expired) → the refusal; not installed → its own words", async () => {
    const no = fake(() => ({ code: 1, stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login" }));
    assert.deepEqual(await adapterFor("github", no.run).auth(GH), { ok: false, code: "not-signed-in", why: "Sign in to GitHub on this computer first (gh auth login)" });
    const glNo = fake(() => ({ code: 1, stderr: "x gitlab.example.com: api call failed: 401 Unauthorized" }));
    const r = await adapterFor("gitlab", glNo.run).auth(GL);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.why, "Sign in to GitLab on this computer first (glab auth login --hostname gitlab.example.com)");
    const glOld = fake(() => ({ code: 0, stderr: "x gitlab.com: No token provided" }));
    assert.equal((await adapterFor("gitlab", glOld.run).auth({ ...GL, host: "gitlab.com" })).ok, false, "an older glab's exit 0 with a failed login is not signed in");
    const missing = fake(() => ({ code: 127, missing: true }));
    const m = await adapterFor("gitlab", missing.run).auth(GL);
    assert.equal(!m.ok && m.code, "no-cli");
  });

  test("a create refused for sign-in reads as the refusal", async () => {
    const r = ghFail({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login" }, GH);
    assert.deepEqual(r, { ok: false, code: "not-signed-in", why: signInFirst("github") });
  });
});

describe("GitHub facts", () => {
  test("states, review, mergeability, head", () => {
    assert.equal(ghFacts(ghPr())!.state, "open");
    assert.equal(ghFacts(ghPr({ isDraft: true }))!.state, "draft");
    const merged = ghFacts(ghPr({ state: "MERGED", mergedAt: "2026-11-03T10:00:00Z", mergeCommit: { oid: "c".repeat(40) } }))!;
    assert.equal(merged.state, "merged");
    assert.equal(merged.mergeCommit, "c".repeat(40));
    assert.equal(merged.mergedAt, "2026-11-03T10:00:00Z");
    assert.equal(ghFacts(ghPr({ state: "CLOSED" }))!.state, "closed");
    assert.equal(ghFacts(ghPr({ reviewDecision: "APPROVED" }))!.review, "approved");
    assert.equal(ghFacts(ghPr({ reviewDecision: "CHANGES_REQUESTED" }))!.review, "changes-requested");
    assert.equal(ghFacts(ghPr({ reviewDecision: "REVIEW_REQUIRED" }))!.review, "review-required");
    assert.equal(ghFacts(ghPr())!.review, "none");
    assert.equal(ghFacts(ghPr({ mergeable: "CONFLICTING" }))!.mergeable, "conflicts");
    assert.equal(ghFacts(ghPr({ mergeable: "UNKNOWN" }))!.mergeable, "unknown");
    assert.equal(ghFacts(ghPr())!.headSha, "a".repeat(40));
    assert.equal(ghFacts({ url: "x" }), null);
  });

  test("checks: none reported is not-reported, never pass; any failure fails; anything running is pending", () => {
    assert.equal(ghChecks([]), "not-reported");
    assert.equal(ghChecks(null), "not-reported");
    assert.equal(ghChecks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }]), "pass");
    assert.equal(ghChecks([{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]), "pending");
    assert.equal(ghChecks([{ __typename: "CheckRun", status: "IN_PROGRESS" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]), "fail");
    assert.equal(ghChecks([{ __typename: "StatusContext", state: "PENDING" }]), "pending");
    assert.equal(ghChecks([{ __typename: "StatusContext", state: "ERROR" }]), "fail");
    assert.equal(ghChecks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]), "pass");
  });

  test("create: argument array, the body on stdin, then the request read back", async () => {
    const f = fake((c) => (c.args[1] === "create" ? { stdout: "https://github.com/acme/app/pull/7\n" } : { stdout: JSON.stringify(ghPr()) }));
    const r = await adapterFor("github", f.run).create(GH, { head: "feat/x", base: "main", title: "Add x; rm -rf / $(boom)", body: "Body `with` $(shell) stuff" });
    assert.ok(r.ok);
    assert.equal(r.ok && r.request.number, 7);
    assert.deepEqual(f.calls[0], { cli: "gh", args: ["pr", "create", "--repo", "github.com/acme/app", "--head", "feat/x", "--base", "main", "--title", "Add x; rm -rf / $(boom)", "--body-file", "-"], stdin: "Body `with` $(shell) stuff" });
    assert.deepEqual(f.calls[1]!.args.slice(0, 5), ["pr", "view", "7", "--repo", "github.com/acme/app"]);
  });

  test("find: the open request for head→base only; with all, the newest of any state", async () => {
    const list = [ghPr({ number: 3, state: "CLOSED" }), ghPr({ number: 9, headRefName: "feat/other" }), ghPr({ number: 5 })];
    const f = fake(() => ({ stdout: JSON.stringify(list) }));
    const gh = adapterFor("github", f.run);
    const r = await gh.find(GH, { head: "feat/x", base: "main" });
    assert.equal(r.ok && r.request?.number, 5);
    assert.ok(f.calls[0]!.args.includes("open"));
    const none = fake(() => ({ stdout: JSON.stringify([ghPr({ number: 3, state: "CLOSED" })]) }));
    assert.equal((await adapterFor("github", none.run).find(GH, { head: "feat/x", base: "main" }) as { request: unknown }).request, null);
    const all = await adapterFor("github", none.run).find(GH, { head: "feat/x", base: "main", all: true });
    assert.equal(all.ok && all.request?.state, "closed");
  });

  test("update: only what changes; nothing to change is no call", async () => {
    const f = fake(() => ({}));
    const gh = adapterFor("github", f.run);
    assert.deepEqual(await gh.update(GH, 7, {}), { ok: true });
    assert.equal(f.calls.length, 0);
    await gh.update(GH, 7, { body: "new" });
    assert.deepEqual(f.calls[0], { cli: "gh", args: ["pr", "edit", "7", "--repo", "github.com/acme/app", "--body-file", "-"], stdin: "new" });
  });
});

describe("GitLab facts", () => {
  test("states, pipeline, mergeability, review, merge commit (squash aware)", () => {
    assert.equal(glabFacts(glMr())!.state, "open");
    assert.equal(glabFacts(glMr({ draft: true }))!.state, "draft");
    assert.equal(glabFacts(glMr({ state: "closed" }))!.state, "closed");
    const merged = glabFacts(glMr({ state: "merged", merged_at: "2026-11-03T10:00:00Z", squash_commit_sha: "d".repeat(40) }))!;
    assert.equal(merged.state, "merged");
    assert.equal(merged.mergeCommit, "d".repeat(40));
    assert.equal(glabFacts(glMr({ has_conflicts: true, detailed_merge_status: "conflict" }))!.mergeable, "conflicts");
    assert.equal(glabFacts(glMr({ detailed_merge_status: "checking" }))!.mergeable, "unknown");
    assert.equal(glabFacts(glMr({ detailed_merge_status: "not_approved" }))!.review, "review-required");
    assert.equal(glabFacts(glMr({ detailed_merge_status: "requested_changes" }))!.review, "changes-requested");
    assert.equal(glabFacts(glMr(), { approved: true, approved_by: [{ user: { username: "r" } }] })!.review, "approved");
    assert.equal(glabFacts(glMr())!.review, "none");
    assert.equal(glabFacts(glMr())!.headSha, "b".repeat(40));
  });

  test("pipeline: none or skipped is not-reported, never pass", () => {
    assert.equal(glabChecks(null), "not-reported");
    assert.equal(glabChecks("skipped"), "not-reported");
    assert.equal(glabChecks("success"), "pass");
    assert.equal(glabChecks("failed"), "fail");
    assert.equal(glabChecks("canceled"), "fail");
    assert.equal(glabChecks("running"), "pending");
    assert.equal(glabChecks("manual"), "pending");
    assert.equal(glabFacts(glMr({ head_pipeline: { status: "running" } }))!.checks, "pending");
  });

  test("create: -R is the web URL, the description on stdin, no prompt; then view and approvals", async () => {
    const f = fake((c) =>
      c.args[1] === "create" ? { stdout: "Creating merge request for feat/x into main in team/sub/app\n\n!12 Add x (feat/x)\n https://gitlab.example.com/team/sub/app/-/merge_requests/12\n" } : c.args[0] === "api" ? { stdout: JSON.stringify({ approved: false, approved_by: [] }) } : { stdout: JSON.stringify(glMr()) },
    );
    const r = await adapterFor("gitlab", f.run).create(GL, { head: "feat/x", base: "main", title: "Add x", body: "Body" });
    assert.ok(r.ok);
    assert.equal(r.ok && r.request.number, 12);
    assert.deepEqual(f.calls[0], { cli: "glab", args: ["mr", "create", "-R", GL.web, "--source-branch", "feat/x", "--target-branch", "main", "--title", "Add x", "--description-file", "-", "--yes"], stdin: "Body" });
    assert.deepEqual(f.calls[1]!.args, ["mr", "view", "12", "-R", GL.web, "-F", "json"]);
    assert.deepEqual(f.calls[2]!.args, ["api", "--hostname", "gitlab.example.com", "projects/team%2Fsub%2Fapp/merge_requests/12/approvals"]);
    assert.equal(r.ok && r.request.review, "review-required");
  });

  test("a failing approvals call leaves the review to the merge status", async () => {
    const f = fake((c) => (c.args[0] === "api" ? { code: 1, stderr: "403" } : { stdout: JSON.stringify(glMr()) }));
    const r = await adapterFor("gitlab", f.run).view(GL, 12);
    assert.equal(r.ok && r.request.review, "none");
  });
});

describe("errors are sanitized", () => {
  test("ANSI, token lines, secrets and URL credentials never pass", () => {
    const tok = "glpat-" + "FAKEfake0123456789abcd";
    const ghTok = "ghp_" + "FAKE0123456789abcdefFAKE0123";
    const raw = `\x1b[31merror:\x1b[0m push to https://oauth2:${tok}@gitlab.example.com/x failed\n  - Token: ${ghTok}\nsecond line ${ghTok}\nthird\nfourth`;
    const out = sanitizeCliError(raw);
    assert.ok(!out.includes(tok) && !out.includes(ghTok), out);
    assert.ok(!out.includes("\x1b"), out);
    assert.ok(!/fourth/.test(out), "three lines at most");
    assert.match(out, /error: push to https:\/\/gitlab\.example\.com\/x failed/);
    assert.ok(sanitizeCliError("x".repeat(1000)).length <= 300);
    assert.equal(sanitizeCliError("\n\n", "fallback"), "fallback");
  });

  test("a host failure carries sanitized words", async () => {
    const tok = "glpat-" + "FAKEfake0123456789abcd";
    const f = fake(() => ({ code: 1, stderr: `\x1b[1mERROR:\x1b[0m something broke with ${tok}` }));
    const r = await adapterFor("gitlab", f.run).view(GL, 1);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && !r.why.includes(tok) && !r.why.includes("\x1b"), !r.ok ? r.why : "");
  });
});

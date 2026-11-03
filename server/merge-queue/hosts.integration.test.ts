// Run: pnpm test:int server/merge-queue/hosts.integration.test.ts
// The host adapters (server/merge-queue/hosts/) running real programs: stand-in `gh` and `glab` first on PATH
// (hosts.integration.fixture.ts) over a local bare origin, never a real host. Sign-in refusals, opening a request
// only from a pushed branch, finding it again before any second create (a17), reading the host's checks, review and
// merge (squash included), a missing tool, a timeout; and the request folder's real check scripts (the shipped example
// kit's included) with no host sign-in in their environment.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { bareOrigin, standInHosts, withStandInPath } from "./hosts.integration.fixture";
import { adapterFor, draftRequest, type HostRepo, loadRequestKit, realCli, type RequestKit, signInFirst, suggestLanding } from "./hosts/index";

const GH: HostRepo = { kind: "github", host: "github.com", path: "acme/app", web: "https://github.com/acme/app" };
const GL: HostRepo = { kind: "gitlab", host: "gitlab.example.com", path: "team/app", web: "https://gitlab.example.com/team/app" };

describe("GitHub through a stand-in gh", () => {
  test("sign-in, open only from a pushed branch, find before create, checks, review, merge", async () => {
    const o = bareOrigin();
    const host = standInHosts({ origin: o.origin });
    await withStandInPath(host.bin, async () => {
      const gh = adapterFor("github");
      assert.deepEqual(await gh.auth(GH), { ok: true });

      const notPushed = await gh.create(GH, { head: "feat/x", base: "main", title: "Add x", body: "B" });
      assert.equal(!notPushed.ok && notPushed.code, "failed", "a branch origin doesn't have opens nothing");

      o.git("checkout", "--quiet", "-b", "feat/x");
      writeFileSync(join(o.work, "x.txt"), "x\n");
      o.git("add", "x.txt");
      o.git("commit", "--quiet", "-m", "x");
      o.git("push", "--quiet", "origin", "feat/x");
      const tip = o.git("rev-parse", "HEAD");

      assert.deepEqual(await gh.find(GH, { head: "feat/x", base: "main" }), { ok: true, request: null });
      const made = await gh.create(GH, { head: "feat/x", base: "main", title: "Add x", body: "Body with `ticks` and $(not a shell)" });
      assert.ok(made.ok, JSON.stringify(made));
      const pr = made.ok ? made.request : null!;
      assert.equal(pr.number, 1);
      assert.equal(pr.state, "open");
      assert.equal(pr.checks, "not-reported", "no checks reported is never Passed");
      assert.equal(pr.headSha, tip);
      assert.equal(host.state().requests[0]!.body, "Body with `ticks` and $(not a shell)", "the body went through stdin as is");

      // a17: after an unknown outcome the caller looks first, and finds the one already open.
      const again = await gh.find(GH, { head: "feat/x", base: "main" });
      assert.equal(again.ok && again.request?.number, 1);
      const second = await gh.create(GH, { head: "feat/x", base: "main", title: "Add x", body: "B" });
      assert.equal(second.ok, false, "the host refuses a second open request for the same branch");

      assert.deepEqual(await gh.update(GH, 1, { body: "New body" }), { ok: true });
      assert.equal(host.state().requests[0]!.body, "New body");

      host.update("github", 1, { checks: "pending" });
      assert.equal(((await gh.view(GH, 1)) as { request: { checks: string } }).request.checks, "pending");
      host.update("github", 1, { checks: "fail" });
      assert.equal(((await gh.view(GH, 1)) as { request: { checks: string } }).request.checks, "fail");
      host.update("github", 1, { checks: "pass", review: "approved" });
      const ready = await gh.view(GH, 1);
      assert.equal(ready.ok && ready.request.checks, "pass");
      assert.equal(ready.ok && ready.request.review, "approved");

      // New commits on the branch: the request's head follows origin.
      writeFileSync(join(o.work, "y.txt"), "y\n");
      o.git("add", "y.txt");
      o.git("commit", "--quiet", "-m", "y");
      o.git("push", "--quiet", "origin", "feat/x");
      const tip2 = o.git("rev-parse", "HEAD");
      assert.equal(((await gh.view(GH, 1)) as { request: { headSha: string } }).request.headSha, tip2);

      const mergeCommit = host.merge("github", 1, { squash: true });
      const merged = await gh.view(GH, 1);
      assert.equal(merged.ok && merged.request.state, "merged");
      assert.equal(merged.ok && merged.request.mergeCommit, mergeCommit, "merged is the host's word, with its squash commit");
      assert.equal(o.git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0], mergeCommit);
      assert.deepEqual(await gh.find(GH, { head: "feat/x", base: "main" }), { ok: true, request: null }, "a merged request isn't open");
      const any = await gh.find(GH, { head: "feat/x", base: "main", all: true });
      assert.equal(any.ok && any.request?.state, "merged");
    });
    const calls = host.calls();
    assert.ok(calls.every((c) => c.cli === "gh"));
    assert.ok(!calls.some((c) => c.args.includes("--show-token")));
  });

  test("not signed in: the exact refusal, for auth and for any call", async () => {
    const host = standInHosts({ signedIn: { github: false, gitlab: false } });
    await withStandInPath(host.bin, async () => {
      const gh = adapterFor("github");
      assert.deepEqual(await gh.auth(GH), { ok: false, code: "not-signed-in", why: "Sign in to GitHub on this computer first (gh auth login)" });
      const v = await gh.view(GH, 1);
      assert.deepEqual(v, { ok: false, code: "not-signed-in", why: signInFirst("github") });
    });
  });
});

describe("GitLab through a stand-in glab", () => {
  test("self-hosted: suggested from origin, open, follow, merge", async () => {
    const o = bareOrigin();
    const host = standInHosts({ origin: o.origin, glabHosts: ["code.example.org"] });
    await withStandInPath(host.bin, async () => {
      assert.equal((await suggestLanding("https://code.example.org/team/app.git")).how, "gitlab-mr", "a host glab is signed in to");
      assert.equal((await suggestLanding("https://other.example.org/team/app.git")).how, "local");
      assert.equal((await suggestLanding("git@github.com:acme/app.git")).how, "github-pr");

      const gl = adapterFor("gitlab");
      assert.deepEqual(await gl.auth(GL), { ok: true });
      o.git("checkout", "--quiet", "-b", "feat/y");
      writeFileSync(join(o.work, "y.txt"), "y\n");
      o.git("add", "y.txt");
      o.git("commit", "--quiet", "-m", "y");
      o.git("push", "--quiet", "origin", "feat/y");
      const made = await gl.create(GL, { head: "feat/y", base: "main", title: "Add y", body: "Body" });
      assert.ok(made.ok, JSON.stringify(made));
      const mr = made.ok ? made.request : null!;
      assert.equal(mr.number, 1);
      assert.equal(mr.checks, "not-reported");
      assert.equal(mr.review, "none");
      assert.equal(mr.headSha, o.git("rev-parse", "HEAD"));
      host.update("gitlab", 1, { checks: "pending", review: "review-required" });
      const waiting = await gl.view(GL, 1);
      assert.equal(waiting.ok && waiting.request.checks, "pending");
      assert.equal(waiting.ok && waiting.request.review, "review-required");
      host.update("gitlab", 1, { checks: "pass", review: "approved" });
      const ok = await gl.view(GL, 1);
      assert.equal(ok.ok && ok.request.review, "approved");
      host.update("gitlab", 1, { conflicts: true });
      assert.equal(((await gl.view(GL, 1)) as { request: { mergeable: string } }).request.mergeable, "conflicts");
      host.update("gitlab", 1, { conflicts: false });
      const found = await gl.find(GL, { head: "feat/y", base: "main" });
      assert.equal(found.ok && found.request?.number, 1);
      assert.deepEqual(await gl.update(GL, 1, { title: "Add y, better" }), { ok: true });
      assert.equal(host.state().requests[0]!.title, "Add y, better");
      const sha = host.merge("gitlab", 1);
      const merged = await gl.view(GL, 1);
      assert.equal(merged.ok && merged.request.state, "merged");
      assert.equal(merged.ok && merged.request.mergeCommit, sha);
    });
    const creates = host.calls().filter((c) => c.args[1] === "create");
    assert.ok(creates.every((c) => c.args.includes("--yes")), "never waits on a prompt");
  });

  test("not signed in: GitLab's refusal names a self-hosted host", async () => {
    const host = standInHosts({ signedIn: { github: true, gitlab: false } });
    await withStandInPath(host.bin, async () => {
      assert.deepEqual(await adapterFor("gitlab").auth(GL), { ok: false, code: "not-signed-in", why: "Sign in to GitLab on this computer first (glab auth login --hostname gitlab.example.com)" });
      assert.deepEqual(await adapterFor("gitlab").auth({ ...GL, host: "gitlab.com" }), { ok: false, code: "not-signed-in", why: "Sign in to GitLab on this computer first (glab auth login)" });
    });
  });

  test("a host failure is sanitized: no ANSI, no token", async () => {
    const host = standInHosts();
    const tok = "glpat-" + "FAKEfake0123456789abcd";
    host.set({ failNext: { cli: "glab", stderr: `\x1b[31mERROR\x1b[0m: 500 at https://oauth2:${tok}@gitlab.example.com/api`, code: 1 } });
    await withStandInPath(host.bin, async () => {
      const r = await adapterFor("gitlab").view(GL, 1);
      assert.equal(r.ok, false);
      assert.ok(!r.ok && !r.why.includes(tok) && !r.why.includes("\x1b"), !r.ok ? r.why : "");
    });
  });
});

describe("the tools themselves", () => {
  test("a tool that isn't installed says so", async () => {
    const empty = scratchRoot("no-tools");
    const prev = process.env.PATH;
    process.env.PATH = empty;
    try {
      const r = await adapterFor("github").auth(GH);
      assert.deepEqual(r, { ok: false, code: "no-cli", why: "GitHub's command-line tool (gh) isn't installed on this computer" });
      const g = await adapterFor("gitlab").view(GL, 1);
      assert.equal(!g.ok && g.code, "no-cli");
    } finally {
      process.env.PATH = prev;
    }
  });

  test("a tool that hangs is killed at its timeout", async () => {
    const host = standInHosts({ delayMs: 30_000 });
    await withStandInPath(host.bin, async () => {
      const started = Date.now();
      const r = await realCli("gh", ["pr", "view", "1"], { timeoutMs: 400 });
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - started < 10_000);
    });
  });
});

describe("the request folder's real checks", () => {
  test("the example kit: a failing check sends the text back with its reason; the rewrite passes", async () => {
    const root = scratchRoot("request-kit-int");
    cpSync(join(import.meta.dirname, "..", "..", ".sova", "playbooks", "request"), join(root, ".sova", "playbooks", "request"), { recursive: true });
    const kit = loadRequestKit(root, ".sova/playbooks/request", "github") as RequestKit;
    assert.ok(!("error" in kit), JSON.stringify(kit));
    assert.equal(kit.checks.length, 1);
    const reasons: string[] = [];
    const out = await draftRequest({
      kit,
      input: { host: "github", branch: "feat/x", base: "main", chatTitle: "Show the host's checks", checksPassed: ["unit"] },
      draft: async (_brief, rejection) => {
        if (rejection) reasons.push(rejection.failed.why ?? "");
        return rejection ? { title: "Merge queue: show the host's checks", body: "## Why\nx\n\n## What changes\n- y\n\n## Checks\n- unit: passed\n" } : { title: "show the host's checks.", body: "no sections" };
      },
    });
    assert.ok(out.ok, JSON.stringify(out));
    assert.deepEqual(reasons, ["the title ends with a period; drop it"]);
    assert.deepEqual(out.ok && out.checks, [{ name: "Sova", ok: true }, { name: "check.mjs", ok: true }]);
  });

  test("a check sees no host sign-in, and one that hangs refuses the text (fail closed)", async () => {
    const root = scratchRoot("request-kit-env");
    mkdirSync(join(root, "kit", "scripts"), { recursive: true });
    writeFileSync(join(root, "kit", "PLAYBOOK.md"), "# x\n");
    writeFileSync(
      join(root, "kit", "scripts", "check-env.mjs"),
      `const bad = ["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "GLAB_CONFIG_DIR"].filter((k) => process.env[k]);
if (bad.length || process.env.HOME === ${JSON.stringify(process.env.HOME ?? "")}) { console.error("sees " + (bad.join(",") || "the real HOME")); process.exit(1); }
`,
    );
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "fake-gh-01";
    try {
      const kit = loadRequestKit(root, "kit", "github") as RequestKit;
      const out = await draftRequest({ kit, input: { host: "github", branch: "b", base: "main", chatTitle: "T" }, draft: async () => ({ title: "T", body: "B" }) });
      assert.ok(out.ok, JSON.stringify(out));
    } finally {
      prev === undefined ? delete process.env.GH_TOKEN : (process.env.GH_TOKEN = prev);
    }
    writeFileSync(join(root, "kit", "scripts", "check-hang.mjs"), "setInterval(() => {}, 1000);\n");
    const kit = loadRequestKit(root, "kit", "github") as RequestKit;
    const out = await draftRequest({ kit, input: { host: "github", branch: "b", base: "main", chatTitle: "T" }, draft: async () => ({ title: "T", body: "B" }), timeoutMs: 500 });
    assert.equal(!out.ok && out.why, "The request folder's check check-hang.mjs ran past 1 s");
  });
});

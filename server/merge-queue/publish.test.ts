import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { isAncestor, realGit } from "./guard";
import { fetchTarget, localBehind, promoteDocs, pushBranch, updateLocalMain } from "./publish";
import { NAMES_NOT_SET_UP, scanPublication } from "./publish-scan";
import { approvalHow, effectiveHow, landHowSetting, readOverride, writeOverride } from "./strategy";
import type { HostAdapter, HostRepo } from "./hosts/types";
import { git } from "./testing/repo";

/** A project with a bare origin, its main checkout on main, and feat/x in a worktree beside it with one commit. */
function fixture() {
  const dir = scratchRoot("mq-publish-");
  const origin = join(dir, "origin.git");
  const root = join(dir, "demo");
  git(dir, ["init", "--bare", "-b", "main", origin]);
  git(dir, ["clone", "-q", origin, root]);
  git(root, ["checkout", "-q", "-b", "main"], { allowFail: true });
  writeFileSync(join(root, "a.txt"), "a\n");
  mkdirSync(join(root, ".sova", "spec", "claims"), { recursive: true });
  writeFileSync(join(root, ".sova", "spec", "claims", "x.md"), "# x\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "first"]);
  git(root, ["push", "-q", "origin", "main"]);
  const wt = join(dir, ".worktrees", "demo-x");
  git(root, ["worktree", "add", "-q", "-b", "feat/x", wt, "main"]);
  writeFileSync(join(wt, "b.txt"), "b\n");
  git(wt, ["add", "b.txt"]);
  git(wt, ["commit", "-q", "-m", "feat: b"]);
  const names = join(dir, "names.json");
  writeFileSync(names, JSON.stringify({ v: 1, privateNames: ["acme-corp"] }));
  const head = (ref: string, cwd = root) => git(cwd, ["rev-parse", ref]);
  return { dir, origin, root, wt, names, head, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What a run leaves in the copy: main merged with the branch commit (test-only), then one docs commit on top. */
function runResult(f: ReturnType<typeof fixture>, runId: string, base = f.head("main")) {
  const commit = f.head("feat/x");
  const tmp = join(f.dir, "copy");
  git(f.root, ["worktree", "add", "-q", "--detach", tmp, base]);
  git(tmp, ["merge", "-q", "--no-ff", "--no-edit", commit]);
  const mergeSha = git(tmp, ["rev-parse", "HEAD"]);
  writeFileSync(join(tmp, ".sova", "spec", "claims", "x.md"), "# x\n\nThe branch's promise.\n");
  git(tmp, ["add", "-A"]);
  git(tmp, ["commit", "-q", "-m", "Spec: land x", "-m", `Sova-Spec-Landing: merge-queue ${runId}`]);
  const tip = git(tmp, ["rev-parse", "HEAD"]);
  git(f.root, ["worktree", "remove", "--force", tmp]);
  return { commit, mergeSha, tip };
}

describe("promoteDocs (q9 = c: the docs commit on the chat's own branch, in its folder)", () => {
  test("the run's docs commit lands on the approved commit in the worktree; a retry finds it; the merge stays out", async () => {
    const f = fixture();
    try {
      const r = runResult(f, "mr_1");
      const p = await promoteDocs(realGit, f.root, { branch: "feat/x", ...r, runId: "mr_1" });
      assert.equal(p.kind, "made");
      const head = f.head("HEAD", f.wt);
      assert.equal(p.kind === "made" && p.head, head, "the chat's folder is on the very commit");
      assert.equal(f.head(`${head}^`), r.commit, "its one parent is the approved commit");
      assert.equal(git(f.root, ["rev-list", "--count", `${r.commit}..${head}`]), "1");
      assert.equal(await isAncestor(realGit, f.root, r.mergeSha, head), false, "the test-only merge is not published");
      assert.equal(git(f.root, ["rev-list", "--parents", "-1", head]).split(" ").length, 2, "one parent");
      assert.match(readFileSync(join(f.wt, ".sova", "spec", "claims", "x.md"), "utf8"), /The branch's promise/);
      assert.equal(git(f.wt, ["status", "--porcelain"]), "");
      const again = await promoteDocs(realGit, f.root, { branch: "feat/x", ...r, runId: "mr_1" });
      assert.deepEqual(again, { kind: "made", head });
    } finally {
      f.done();
    }
  });

  test("waits on uncommitted files; refuses a branch that moved past the approved commit; no docs: the commit itself", async () => {
    const f = fixture();
    try {
      const r = runResult(f, "mr_2");
      writeFileSync(join(f.wt, "scratch.txt"), "wip\n");
      const w = await promoteDocs(realGit, f.root, { branch: "feat/x", ...r, runId: "mr_2" });
      assert.equal(w.kind, "wait");
      assert.match(w.kind === "wait" ? w.why : "", /1 uncommitted file/);
      assert.equal(f.head("feat/x"), r.commit, "nothing moved");
      rmSync(join(f.wt, "scratch.txt"));
      assert.deepEqual(await promoteDocs(realGit, f.root, { branch: "feat/x", ...r, tip: r.mergeSha, runId: "mr_2" }), { kind: "none", head: r.commit });
      writeFileSync(join(f.wt, "c.txt"), "c\n");
      git(f.wt, ["add", "c.txt"]);
      git(f.wt, ["commit", "-q", "-m", "more"]);
      const m = await promoteDocs(realGit, f.root, { branch: "feat/x", ...r, runId: "mr_2" });
      assert.equal(m.kind, "refused");
      assert.match(m.kind === "refused" ? m.why : "", /moved past the approved commit/);
    } finally {
      f.done();
    }
  });
});

describe("pushBranch: fast-forward only, scanned first, never forced", () => {
  test("first push, then Land Again's push adds on top: the second published head descends from the first on origin", async () => {
    const f = fixture();
    try {
      const base = f.head("main");
      const first = f.head("feat/x");
      const p1 = await pushBranch(realGit, f.root, { branch: "feat/x", tip: first, base, namesFile: f.names });
      assert.deepEqual(p1, { state: "pushed", sha: first, from: null });
      writeFileSync(join(f.wt, "c.txt"), "c\n");
      git(f.wt, ["add", "c.txt"]);
      git(f.wt, ["commit", "-q", "-m", "more"]);
      const second = f.head("feat/x");
      const p2 = await pushBranch(realGit, f.root, { branch: "feat/x", tip: second, base, namesFile: f.names });
      assert.deepEqual(p2, { state: "pushed", sha: second, from: first });
      assert.equal(git(f.origin, ["rev-parse", "refs/heads/feat/x"]), second);
      git(f.origin, ["merge-base", "--is-ancestor", first, second]);
      // Someone pushed to the branch on the host: never overwritten.
      const other = join(f.dir, "other");
      git(f.dir, ["clone", "-q", "-b", "feat/x", f.origin, other]);
      writeFileSync(join(other, "d.txt"), "d\n");
      git(other, ["add", "d.txt"]);
      git(other, ["commit", "-q", "-m", "on the host"]);
      git(other, ["push", "-q", "origin", "feat/x"]);
      const hostHead = git(other, ["rev-parse", "HEAD"]);
      const p3 = await pushBranch(realGit, f.root, { branch: "feat/x", tip: second, base, namesFile: f.names });
      assert.equal(p3.state, "refused");
      assert.match(p3.state === "refused" ? p3.why : "", /never forced/);
      assert.equal(git(f.origin, ["rev-parse", "refs/heads/feat/x"]), hostHead);
    } finally {
      f.done();
    }
  });

  test("refused before anything leaves: no private names set up, a private name in a commit or the request's text, a secret, a hold", async () => {
    const f = fixture();
    try {
      const base = f.head("main");
      const tip = f.head("feat/x");
      const none = await pushBranch(realGit, f.root, { branch: "feat/x", tip, base, namesFile: join(f.dir, "missing.json") });
      assert.equal(none.state, "refused");
      assert.match(none.state === "refused" ? none.why : "", new RegExp(NAMES_NOT_SET_UP));
      const text = await pushBranch(realGit, f.root, { branch: "feat/x", tip, base, namesFile: f.names, texts: [{ label: "title", text: "For ACME-Corp" }] });
      assert.equal(text.state, "refused");
      assert.deepEqual(text.state === "refused" && text.hits, ["title line 1 · private name #1"]);
      writeFileSync(join(f.dir, "hold"), "release in progress\n");
      const held = await pushBranch(realGit, f.root, { branch: "feat/x", tip, base, namesFile: f.names, holdFile: join(f.dir, "hold") });
      assert.match(held.state === "refused" ? held.why : "", /^held: release in progress/);
      const token = `github_pat_${"A1b2".repeat(15)}`;
      writeFileSync(join(f.wt, "conf.txt"), `token ${token}\n`);
      git(f.wt, ["add", "conf.txt"]);
      git(f.wt, ["commit", "-q", "-m", "conf"]);
      const secret = await pushBranch(realGit, f.root, { branch: "feat/x", tip: f.head("feat/x"), base, namesFile: f.names });
      assert.equal(secret.state, "refused");
      const hits = secret.state === "refused" ? (secret.hits ?? []) : [];
      assert.ok(hits.some((h) => /conf\.txt:1 · looks like a GitHub fine-grained token/.test(h)), hits.join("\n"));
      assert.ok(!JSON.stringify(secret).includes(token), "the matched text is never repeated");
      assert.equal(git(f.origin, ["branch", "--list", "feat/x"]), "", "nothing reached origin");
    } finally {
      f.done();
    }
  });

  test("the scan masks a private name in a file's name and fails closed on a range it can't read", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.wt, "acme-corp-notes.txt"), "plain\n");
      git(f.wt, ["add", "-A"]);
      git(f.wt, ["commit", "-q", "-m", "notes"]);
      const s = await scanPublication(realGit, { repo: f.root, range: `${f.head("main")}..${f.head("feat/x")}`, namesFile: f.names });
      assert.equal(s.ok, false);
      assert.ok(!JSON.stringify(s).toLowerCase().includes("acme-corp"), JSON.stringify(s));
      const bad = await scanPublication(realGit, { repo: f.root, range: "nope..also-nope", namesFile: f.names });
      assert.equal(bad.ok, false);
      assert.match(!bad.ok ? bad.why : "", /couldn't list/);
    } finally {
      f.done();
    }
  });
});

describe("Update Local Main (q11): the queue's own fast-forward, refused with a reason on a dirty folder", () => {
  test("behind after a host merge; dirty: refused, nothing moved; clean: fast-forwarded with the host's first parents", async () => {
    const f = fixture();
    try {
      const before = f.head("main");
      const other = join(f.dir, "host");
      git(f.dir, ["clone", "-q", "-b", "main", f.origin, other]);
      writeFileSync(join(other, "h.txt"), "h\n");
      git(other, ["add", "h.txt"]);
      git(other, ["commit", "-q", "-m", "merged on the host"]);
      git(other, ["push", "-q", "origin", "main"]);
      const hostMain = git(other, ["rev-parse", "HEAD"]);
      const fetched = await fetchTarget(realGit, f.root, "main");
      assert.deepEqual(fetched, { sha: hostMain });
      assert.equal(await localBehind(realGit, f.root, "main"), 1);
      writeFileSync(join(f.root, "a.txt"), "edited\n");
      const dirty = await updateLocalMain(realGit, f.root, "main");
      assert.equal(dirty.kind, "refused");
      assert.match(dirty.kind === "refused" ? dirty.why : "", /uncommitted changes/);
      assert.equal(f.head("main"), before);
      git(f.root, ["checkout", "--", "a.txt"]);
      const up = await updateLocalMain(realGit, f.root, "main");
      assert.deepEqual(up, { kind: "updated", from: before, to: hostMain, parents: [hostMain] });
      assert.equal(f.head("HEAD"), hostMain, "the main folder moved with it");
      assert.deepEqual(await updateLocalMain(realGit, f.root, "main"), { kind: "current", head: hostMain });
    } finally {
      f.done();
    }
  });
});

describe("How it lands: this computer ?? the project's file ?? local", () => {
  test("default local; the project's key; this computer's override wins and clears; a typed via wins on one approval", () => {
    const dir = scratchRoot("mq-strategy-");
    try {
      assert.deepEqual(effectiveHow(undefined, dir), { effective: "local", from: "default" });
      assert.deepEqual(effectiveHow("bogus", dir), { effective: "local", from: "default" });
      assert.deepEqual(effectiveHow("gitlab-mr", dir), { effective: "gitlab-mr", from: "project", project: "gitlab-mr" });
      writeOverride(dir, "github-pr", "2026-01-01T00:00:00.000Z");
      assert.deepEqual(readOverride(dir), { how: "github-pr", at: "2026-01-01T00:00:00.000Z" });
      assert.deepEqual(effectiveHow("local", dir), { effective: "github-pr", from: "computer", project: "local", computer: "github-pr" });
      writeOverride(dir, null);
      assert.equal(existsSync(join(dir, "strategy.json")), false);
      assert.equal(effectiveHow(undefined, dir).effective, "local");
      assert.equal(approvalHow({}), "local");
      assert.equal(approvalHow({ how: "push-branch" }), "push-branch");
      assert.equal(approvalHow({ how: "local", via: "gitlab-mr" }), "gitlab-mr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("landHowSetting: the settings row's facts", () => {
  test("suggestion from origin; sign-in asked only for a request strategy, on origin's own host", async () => {
    const dir = scratchRoot("mq-strategy-row-");
    try {
      const repo: HostRepo = { kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" };
      let asked = 0;
      const signedIn = { ok: false as const, code: "not-signed-in" as const, why: "Sign in to GitHub on this computer first (gh auth login)" };
      const hosts = { suggest: async () => ({ how: "github-pr" as const, why: "origin is on GitHub", repo }), adapterFor: () => ({ auth: async () => (asked++, signedIn) }) as unknown as HostAdapter };
      assert.deepEqual(await landHowSetting({ dir, root: dir, projectHow: undefined, hosts }), { effective: "local", from: "default", suggested: { how: "github-pr", why: "origin is on GitHub" } });
      assert.equal(asked, 0);
      writeOverride(dir, "github-pr");
      const row = await landHowSetting({ dir, root: dir, projectHow: "local", hosts });
      assert.deepEqual(row.signIn, { ok: false, why: signedIn.why });
      assert.equal(row.from, "computer");
      writeOverride(dir, "gitlab-mr");
      assert.match((await landHowSetting({ dir, root: dir, projectHow: undefined, hosts })).signIn?.why ?? "", /origin isn't on GitLab/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

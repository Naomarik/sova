import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { realGit } from "./guard";
import type { HostAdapter, HostRepo, RequestFacts } from "./hosts/types";
import { type Hosting, pollRequest, publishEntry, publishSettings, reconcilePublish } from "./strategy-run";
import { git } from "./testing/repo";

/** An in-process stand-in host: one open request per head branch, merges on demand by pushing to the bare origin. */
function fakeHost(origin: string, opts: { signedIn?: boolean; createFails?: "before" | "after" } = {}) {
  const requests: (RequestFacts & { title: string; body: string })[] = [];
  const calls: string[] = [];
  const repo: HostRepo = { kind: "github", host: "github.com", path: "o/r", web: "https://github.com/o/r" };
  const head = (b: string) => git(origin, ["rev-parse", `refs/heads/${b}`], { allowFail: true }) || null;
  const adapter: HostAdapter = {
    kind: "github",
    cli: "gh",
    auth: async () => (calls.push("auth"), opts.signedIn === false ? { ok: false, code: "not-signed-in", why: "Sign in to GitHub on this computer first (gh auth login)" } : { ok: true }),
    find: async (_r, q) => {
      calls.push(`find ${q.head}`);
      const r = requests.find((x) => x.headBranch === q.head && x.baseBranch === q.base && (x.state === "open" || x.state === "draft"));
      return { ok: true, request: r ? { ...r, headSha: head(q.head) } : null };
    },
    create: async (_r, c) => {
      calls.push(`create ${c.head}`);
      if (!head(c.head)) return { ok: false, code: "failed", why: "head branch not on the host" };
      if (opts.createFails === "before") return { ok: false, code: "timeout", why: "timed out" };
      const r = { number: requests.length + 1, url: `https://github.com/o/r/pull/${requests.length + 1}`, state: "open" as const, checks: "pending" as const, review: "none" as const, mergeable: "unknown" as const, headSha: head(c.head), headBranch: c.head, baseBranch: c.base, mergeCommit: null, mergedAt: null, title: c.title, body: c.body };
      requests.push(r);
      if (opts.createFails === "after") return { ok: false, code: "timeout", why: "timed out" };
      return { ok: true, request: r };
    },
    update: async () => ({ ok: true }),
    view: async (_r, n) => {
      calls.push(`view ${n}`);
      const r = requests.find((x) => x.number === n);
      return r ? { ok: true, request: { ...r, headSha: head(r.headBranch) } } : { ok: false, code: "not-found", why: "no such request" };
    },
  };
  return { hosting: { adapter, repo } as Hosting, requests, calls };
}

function fixture() {
  const dir = scratchRoot("mq-strategy-run-");
  const origin = join(dir, "origin.git");
  const root = join(dir, "demo");
  git(dir, ["init", "--bare", "-b", "main", origin]);
  git(dir, ["clone", "-q", origin, root]);
  git(root, ["checkout", "-q", "-b", "main"], { allowFail: true });
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "project.json"), '{\n  "version": 1\n}\n');
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

const text = { title: "feat: b", body: "Adds b.\n\nOpened by Sova" };

describe("publishEntry: the chat's branch pushed, then the request found or opened", () => {
  test("opens one request; Land Again pushes on top and finds the same one; a lost create answer is found, never doubled", async () => {
    const f = fixture();
    try {
      const h = fakeHost(f.origin, { createFails: "after" });
      const ctx = { git: realGit, root: f.root, target: "main", namesFile: f.names, host: h.hosting };
      const base = f.head("main");
      const c1 = f.head("feat/x");
      const steps: string[] = [];
      const first = await publishEntry(ctx, { how: "github-pr", branch: "feat/x", commit: c1, mergeSha: c1, tip: c1, runId: "mr_1", worktree: f.wt, base, text }, (s, head) => steps.push(`${s} ${head.slice(0, 7)}`));
      assert.equal(first.kind, "requested");
      assert.equal(first.kind === "requested" && first.request.number, 1);
      assert.deepEqual(steps, [`push ${c1.slice(0, 7)}`, `create ${c1.slice(0, 7)}`], "each step announced before it is done");
      assert.equal(h.requests.length, 1, "the create whose answer was lost is found, not repeated");
      writeFileSync(join(f.wt, "c.txt"), "c\n");
      git(f.wt, ["add", "c.txt"]);
      git(f.wt, ["commit", "-q", "-m", "more"]);
      const c2 = f.head("feat/x");
      const again = await publishEntry(ctx, { how: "github-pr", branch: "feat/x", commit: c2, mergeSha: c2, tip: c2, runId: "mr_2", worktree: f.wt, base, text, number: 1 }, () => {});
      assert.equal(again.kind === "requested" && again.opened, false);
      assert.equal(h.requests.length, 1);
      git(f.origin, ["merge-base", "--is-ancestor", c1, git(f.origin, ["rev-parse", "refs/heads/feat/x"])]);
    } finally {
      f.done();
    }
  });

  test("refusals say whose: not signed in (setup, nothing pushed); a private name in the text (text); push branch only stops at the push", async () => {
    const f = fixture();
    try {
      const base = f.head("main");
      const c = f.head("feat/x");
      const o = { how: "github-pr" as const, branch: "feat/x", commit: c, mergeSha: c, tip: c, runId: "mr_1", worktree: f.wt, base };
      const out = fakeHost(f.origin, { signedIn: false });
      const r1 = await publishEntry({ git: realGit, root: f.root, target: "main", namesFile: f.names, host: out.hosting }, { ...o, text }, () => {});
      assert.deepEqual(r1, { kind: "refused", why: "Sign in to GitHub on this computer first (gh auth login)", blame: "setup" });
      assert.equal(git(f.origin, ["branch", "--list", "feat/x"]), "");
      const h = fakeHost(f.origin);
      const r2 = await publishEntry({ git: realGit, root: f.root, target: "main", namesFile: f.names, host: h.hosting }, { ...o, text: { title: "For ACME-corp", body: text.body } }, () => {});
      assert.equal(r2.kind === "refused" && r2.blame, "text");
      assert.equal(git(f.origin, ["branch", "--list", "feat/x"]), "");
      const r3 = await publishEntry({ git: realGit, root: f.root, target: "main", namesFile: f.names, host: null }, { ...o, how: "push-branch" }, () => {});
      assert.deepEqual(r3, { kind: "pushed", head: c });
      assert.equal(h.requests.length, 0);
      const r4 = await publishEntry({ git: realGit, root: f.root, target: "main", namesFile: f.names, host: null }, { ...o, text }, () => {});
      assert.equal(r4.kind === "refused" && r4.blame, "setup");
      assert.match(r4.kind === "refused" ? r4.why : "", /origin isn't on GitHub/);
    } finally {
      f.done();
    }
  });

  test("after a stop between the push and the create: the host is asked, and the request opened once", async () => {
    const f = fixture();
    try {
      const h = fakeHost(f.origin);
      const ctx = { git: realGit, root: f.root, target: "main", namesFile: f.names, host: h.hosting };
      const c = f.head("feat/x");
      git(f.root, ["push", "-q", "origin", `${c}:refs/heads/feat/x`]);
      const r = await reconcilePublish(ctx, { how: "github-pr", branch: "feat/x", head: c, text });
      assert.equal(r.kind, "requested");
      const again = await reconcilePublish(ctx, { how: "github-pr", branch: "feat/x", head: c, text });
      assert.equal(again.kind === "requested" && again.opened, false);
      assert.equal(h.requests.length, 1);
      const gone = await reconcilePublish(ctx, { how: "github-pr", branch: "feat/x", head: f.head("main"), text });
      assert.equal(gone.kind, "refused");
    } finally {
      f.done();
    }
  });
});

describe("the docs commit waits for the owning chat to be idle", () => {
  test("busy: wait, nothing written or pushed; idle: made and published", async () => {
    const f = fixture();
    try {
      const h = fakeHost(f.origin);
      const ctx = { git: realGit, root: f.root, target: "main", namesFile: f.names, host: h.hosting };
      const base = f.head("main");
      const c = f.head("feat/x");
      const tmp = join(f.dir, "copy");
      git(f.root, ["worktree", "add", "-q", "--detach", tmp, base]);
      git(tmp, ["merge", "-q", "--no-ff", "--no-edit", c]);
      const mergeSha = git(tmp, ["rev-parse", "HEAD"]);
      writeFileSync(join(tmp, "spec.md"), "promise\n");
      git(tmp, ["add", "-A"]);
      git(tmp, ["commit", "-q", "-m", "Spec: land x", "-m", "Sova-Spec-Landing: merge-queue mr_9"]);
      const tip = git(tmp, ["rev-parse", "HEAD"]);
      let idle = false;
      const o = { how: "github-pr" as const, branch: "feat/x", commit: c, mergeSha, tip, runId: "mr_9", worktree: f.wt, base, text, chatIdle: async () => idle };
      const busy = await publishEntry(ctx, o, () => {});
      assert.equal(busy.kind, "wait");
      assert.match(busy.kind === "wait" ? busy.why : "", /busy/);
      assert.equal(f.head("feat/x"), c, "nothing written into the chat's folder");
      assert.equal(git(f.origin, ["branch", "--list", "feat/x"]), "");
      idle = true;
      const done = await publishEntry(ctx, o, () => {});
      assert.equal(done.kind, "requested");
      assert.equal(f.head(`${f.head("HEAD", f.wt)}^`), c);
      assert.equal(readFileSync(join(f.wt, "spec.md"), "utf8"), "promise\n");
    } finally {
      f.done();
    }
  });
});

describe("pollRequest: the host's word", () => {
  test("open, then merged on the host: the host's commit and origin's first parents, local main untouched", async () => {
    const f = fixture();
    try {
      const h = fakeHost(f.origin);
      const ctx = { git: realGit, root: f.root, target: "main", namesFile: f.names, host: h.hosting };
      const c = f.head("feat/x");
      const base = f.head("main");
      await publishEntry(ctx, { how: "github-pr", branch: "feat/x", commit: c, mergeSha: c, tip: c, runId: "mr_1", worktree: f.wt, base, text }, () => {});
      assert.equal((await pollRequest(ctx, { number: 1, from: base })).kind, "open");
      // The host squash-merges it into main.
      const other = join(f.dir, "host");
      git(f.dir, ["clone", "-q", "-b", "main", f.origin, other]);
      git(other, ["merge", "-q", "--squash", `origin/feat/x`]);
      git(other, ["commit", "-q", "-m", "feat: b (#1)"]);
      git(other, ["push", "-q", "origin", "main"]);
      const squash = git(other, ["rev-parse", "HEAD"]);
      Object.assign(h.requests[0]!, { state: "merged", mergeCommit: squash, mergedAt: "2026-11-03T12:00:00Z" });
      const m = await pollRequest(ctx, { number: 1, from: base });
      assert.deepEqual(m.kind === "merged" && { sha: m.sha, parents: m.parents }, { sha: squash, parents: [squash] });
      assert.equal(f.head("main"), base, "local main isn't moved by a poll");
      assert.equal(f.head("refs/remotes/origin/main"), squash);
    } finally {
      f.done();
    }
  });
});

describe("publishSettings (q7): a settings save on a request project is its own request", () => {
  test("one commit on origin's main, on a sova/settings-… branch, scanned and pushed; local main never moves", async () => {
    const f = fixture();
    try {
      const h = fakeHost(f.origin);
      const ctx = { git: realGit, root: f.root, target: "main", namesFile: f.names, host: h.hosting };
      const before = f.head("main");
      const r = await publishSettings(ctx, { how: "github-pr", file: "project.json", textAt: async (b) => `${git(f.root, ["show", `${b}:project.json`]).replace("1\n}", '1,\n  "merge": { "push": false }\n}')}\n`, message: "Merge queue settings: push off", body: "Turns push off.\n\nOpened by Sova", at: new Date("2026-11-03T09:05:00Z"), scratch: join(f.dir, "scratch") });
      assert.equal(r.state, "requested");
      assert.equal(r.state === "requested" && r.branch, "sova/settings-20261103-0905");
      const tip = git(f.origin, ["rev-parse", "refs/heads/sova/settings-20261103-0905"]);
      assert.equal(git(f.origin, ["rev-parse", `${tip}^`]), before);
      assert.match(git(f.origin, ["show", `${tip}:project.json`]), /"push": false/);
      assert.equal(f.head("main"), before);
      assert.equal(h.requests[0]!.title, "Merge queue settings: push off");
      const p = await publishSettings({ ...ctx, host: null }, { how: "push-branch", file: "project.json", textAt: async () => "{}\n", message: "Merge queue settings: x", body: "x", at: new Date("2026-11-03T09:06:00Z"), scratch: join(f.dir, "scratch") });
      assert.equal(p.state, "pushed");
      assert.equal(readFileSync(join(f.root, "project.json"), "utf8"), '{\n  "version": 1\n}\n');
    } finally {
      f.done();
    }
  });
});

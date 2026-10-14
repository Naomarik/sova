import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { changelogSection, checkForUpdate, compareVersions, describeRunning, githubWebOf, offersUpgrade, OFFICIAL_REPO, parseLsRemote, repoUrlOf } from "./check";
import { gitIn } from "./git";
import { makeRepos, type Repos } from "./testing";

/**
 * Checks against a stand-in repository: real local git,
 * no network. The origin's history:
 *
 *   c1 v0.1.0 ── c2 v0.2.0 (stable) ── c3 ── c4 (master)
 *                                              └─ c5 "feat: thing" (feat/x)
 */
type Commits = Record<"c1" | "c2" | "c3" | "c4" | "c5", string>;

function world(): Repos & { c: Commits } {
  const r = makeRepos();
  const c = {} as Commits;
  c.c1 = r.commit(r.origin, "first");
  r.tag(r.origin, "v0.1.0");
  writeFileSync(join(r.origin, "CHANGELOG.md"), "# Changelog\n\n## v0.2.0 — 2026-10-14\n\nThe second release.\n\n- **A thing.** It works.\n\n## v0.1.0 — 2026-10-01\n\nThe first.\n");
  r.git(r.origin, "add", "CHANGELOG.md");
  c.c2 = r.commit(r.origin, "release v0.2.0");
  r.tag(r.origin, "v0.2.0");
  r.tag(r.origin, "stable");
  c.c3 = r.commit(r.origin, "three");
  c.c4 = r.commit(r.origin, "four");
  r.git(r.origin, "checkout", "--quiet", "-b", "feat/x");
  c.c5 = r.commit(r.origin, "feat: thing");
  r.git(r.origin, "checkout", "--quiet", "master");
  return { ...r, c };
}

const run = async (r: Repos, dir: string, source: Parameters<typeof checkForUpdate>[0]["source"], kind: "installer" | "developer" = "developer") => {
  const git = gitIn(dir);
  const now = await describeRunning(git);
  return (await checkForUpdate({ git, repo: r.url, source, kind, head: now.head!, branch: now.branch })).result;
};

test("an installed copy at an older release (a shallow clone) is offered the newer Stable, with its release notes", async () => {
  const r = world();
  const copy = r.clone("installed", { ref: "v0.1.0", depth: 1 });
  const result = await run(r, copy, { kind: "stable" }, "installer");
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  assert.equal(result.target.sha, r.c.c2);
  assert.equal(result.target.label, "v0.2.0");
  assert.equal(result.target.version, "v0.2.0");
  assert.equal(result.target.count, 1);
  assert.match(result.target.notes ?? "", /The second release\.\n\n- \*\*A thing\.\*\* It works\./);
  assert.doesNotMatch(result.target.notes ?? "", /The first/, "only that release's section");
  // Nothing moved: no branch, no tag, no HEAD.
  assert.equal(r.git(copy, "rev-parse", "HEAD"), r.c.c1);
  assert.equal(r.git(copy, "tag", "--list", "v0.2.0"), "", "no tag of the repository's was written");
  assert.equal(r.git(copy, "rev-parse", "refs/sova-updates/target^{commit}"), r.c.c2, "the target sits in the private namespace");
  // After the check the copy can say what it runs, even shallow-cloned.
  const now = await describeRunning(gitIn(copy));
  assert.equal(now.baseVersion, "v0.1.0");
  assert.equal(now.pastBase, 0);
});

test("never older code: a copy on master past Stable is ahead of it, with no offer", async () => {
  const r = world();
  const copy = r.clone("dev");
  const result = await run(r, copy, { kind: "stable" });
  assert.deepEqual(result, { state: "ahead", message: "You're ahead of Stable; updates resume when Stable catches up." });
  assert.equal(offersUpgrade(result, "installer"), false);
});

test("two releases: the numbers decide, so a Stable moved back to an older release is never offered", async () => {
  const r = world();
  const copy = r.clone("at-v020", { ref: "v0.2.0" });
  r.tag(r.origin, "stable", r.c.c1); // a rollback of stable to v0.1.0
  const result = await run(r, copy, { kind: "stable" }, "installer");
  assert.equal(result.state, "ahead");
});

test("Stable diverged from a copy that already holds a newer release is ahead, not an offer", async () => {
  const r = world();
  // v0.3.0 on master (c3), then a v0.2.1 hotfix off v0.2.0 that stable points at; the copy runs c4,
  // past v0.3.0 and no release itself, so only its history can say it holds the newer release.
  r.tag(r.origin, "v0.3.0", r.c.c3);
  r.git(r.origin, "checkout", "--quiet", "-b", "hotfix", r.c.c2);
  const fix = r.commit(r.origin, "hotfix", "fix.txt");
  r.tag(r.origin, "v0.2.1");
  r.tag(r.origin, "stable");
  r.git(r.origin, "checkout", "--quiet", "master");
  const copy = r.clone("past-v030");
  const result = await run(r, copy, { kind: "stable" }, "installer");
  assert.equal(result.state, "ahead", `stable is at ${fix}`);
});

test("master and a branch: newer commits are counted and the newest subject named; the same commit is up to date", async () => {
  const r = world();
  const copy = r.clone("dev");
  assert.deepEqual(await run(r, copy, { kind: "master" }), { state: "up-to-date" });
  r.commit(r.origin, "six: the newest");
  const m = await run(r, copy, { kind: "master" });
  assert.equal(m.state, "available");
  if (m.state === "available") {
    assert.equal(m.target.label, "master");
    assert.equal(m.target.count, 1);
    assert.equal(m.target.subject, "six: the newest");
  }
  const b = await run(r, copy, { kind: "branch", branch: "feat/x" });
  assert.equal(b.state, "available");
  if (b.state === "available") {
    assert.equal(b.target.label, "feat/x");
    assert.equal(b.target.sha, r.c.c5);
    assert.equal(b.target.subject, "feat: thing");
  }
});

test("a rewritten source: an installed copy is offered it as it is now, a developer copy is refused", async () => {
  const r = world();
  const copy = r.clone("dev");
  r.git(r.origin, "reset", "--quiet", "--hard", r.c.c3);
  r.commit(r.origin, "rewritten four");
  const dev = await run(r, copy, { kind: "master" }, "developer");
  assert.equal(dev.state, "diverged");
  if (dev.state === "diverged") assert.equal(dev.message, "Your copy's branch master isn't part of master's history, so we won't move it.");
  assert.equal(offersUpgrade(dev, "developer"), false);
  const inst = await run(r, copy, { kind: "master" }, "installer");
  assert.equal(inst.state, "diverged");
  if (inst.state === "diverged") assert.match(inst.message, /Upgrading installs master as it is now\./);
  assert.equal(offersUpgrade(inst, "installer"), true);
});

test("a branch the repository doesn't have, and a repository that can't be reached, are failed checks that say so", async () => {
  const r = world();
  const copy = r.clone("dev");
  await assert.rejects(run(r, copy, { kind: "branch", branch: "nope" }), /Sova's repository has no branch nope\./);
  const git = gitIn(copy);
  await assert.rejects(checkForUpdate({ git, repo: join(r.root, "missing.git"), source: { kind: "stable" }, kind: "developer", head: r.c.c4, branch: "master" }), /^Error: Couldn't reach Sova's repository: /);
});

test("the running copy: release, branch and how far past the newest release", async () => {
  const r = world();
  const copy = r.clone("dev");
  const now = await describeRunning(gitIn(copy));
  assert.deepEqual(now, { head: r.c.c4, branch: "master", version: null, baseVersion: "v0.2.0", pastBase: 2 });
  const tagged = r.clone("tagged", { ref: "v0.2.0" });
  const t = await describeRunning(gitIn(tagged));
  assert.equal(t.version, "v0.2.0");
  assert.equal(t.branch, null, "detached at the tag");
});

test("helpers: ls-remote peeling, versions, changelog sections, the repository's web page and its override", () => {
  const refs = parseLsRemote(`${"a".repeat(40)}\trefs/tags/stable\n${"b".repeat(40)}\trefs/tags/stable^{}\n${"c".repeat(40)}\trefs/heads/master\n`);
  assert.equal(refs.get("refs/tags/stable"), "b".repeat(40), "a tag is its peeled commit");
  assert.equal(refs.get("refs/heads/master"), "c".repeat(40));
  assert.ok(compareVersions("v0.10.0", "v0.9.9") > 0);
  assert.equal(compareVersions("v1.2.3", "v1.2.3"), 0);
  assert.equal(changelogSection("## v0.3.2 — x\n\nA.\n\n## v0.3.10 — y\n\nB.\n", "v0.3.1"), null, "v0.3.1 is not v0.3.10 or v0.3.2");
  assert.equal(changelogSection("## v0.3.10 — y\n\nB.\n## v0.3.1 — z\n\nC.\n", "v0.3.1"), "C.");
  assert.equal(githubWebOf(OFFICIAL_REPO), "https://github.com/Naomarik/sova");
  assert.equal(githubWebOf("git@github.com:Naomarik/sova.git"), "https://github.com/Naomarik/sova");
  assert.equal(githubWebOf("file:///tmp/x"), null);
  assert.equal(repoUrlOf({}), OFFICIAL_REPO);
  assert.equal(repoUrlOf({ SOVA_UPDATES_REPO_URL: "file:///srv/standin.git" }), "file:///srv/standin.git");
});

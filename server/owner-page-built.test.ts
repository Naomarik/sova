// Run: pnpm exec tsx --test server/owner-page-built.test.ts. The owner page's "What's been built"
// (§app.owner-page/content) reads a build's merged state from git, as the project page does: a
// branch merged once and given new commits since is in progress, not finished, whatever
// the build's chart recorded. A throwaway PI_CODING_AGENT_DIR, workspace and git repo in the OS temp
// dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { OwnerHome } from "../shared/owner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-built-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const orgs = await import("./orgs");
const owner = await import("./owner");
const { ownerView } = await import("./owner-page");
const { seedBuild } = await import("./org-test-fixtures");

const repo = join(root, "repo");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", "a.txt");
git("commit", "-q", "-m", "a");
const base = git("rev-parse", "HEAD");
// sova/again: merged into main, then a new commit; sova/done: merged and left alone.
for (const b of ["again", "done"]) {
  git("checkout", "-q", "-b", `sova/${b}`, base);
  writeFileSync(join(repo, `${b}.txt`), "1\n");
  git("add", `${b}.txt`);
  git("commit", "-q", "-m", b);
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `merge ${b}`, `sova/${b}`);
}
git("checkout", "-q", "sova/again");
writeFileSync(join(repo, "again.txt"), "2\n");
git("commit", "-q", "-am", "again 2");
git("checkout", "-q", "main");

const org = await orgs.createOrg({ name: "Builds Co", dir: join(root, "ws") });
const p = await orgs.addProject(org.id, { name: "Shop", root: repo });
const kim = await orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach" });
owner.setOwner(org.id, kim.id);
const tree = (b: string) => ({ path: join(root, `gone-${b}`), branch: `sova/${b}`, base, target: "main" });
for (const b of ["again", "done"]) await seedBuild(org.id, p.id, { sessionId: `c-${b}`, kind: "coding", createdAt: "2026-09-22T00:00:00.000Z", worktree: tree(b), merged: { commit: "def", at: "2026-09-23T00:00:00.000Z" } });

test("a merged branch with new commits is in progress, not finished; git decides over the record", async () => {
  const home = (await ownerView(org.id)) as OwnerHome;
  const shop = home.projects.find((x) => x.name === "Shop")!;
  assert.deepEqual([shop.finished, shop.inProgress], [1, 1]);
});

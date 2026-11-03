// The mechanical sanity check of a conflict resolution, on real git repositories (git is fine in the unit tier).
import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../test-scratch";
import { conflictRegions, conflictsBetween, hunksInside, hunksOf, sanityCheck } from "./conflicts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function repo() {
  const root = join(scratchRoot("mq-conf-"), "r");
  mkdirSync(root);
  const git = (...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8", env: ENV }).trim();
  const put = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), t);
      git("add", f);
    }
  };
  git("init", "-q", "-b", "master");
  put({ "list.txt": "alpha\nbravo\ncharlie\n", "other.txt": "one\ntwo\n", "app.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" });
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feat");
  put({ "list.txt": "alpha\nbravo\ncharlie\ndelta\n" });
  git("commit", "-qm", "feat: delta");
  const commit = git("rev-parse", "HEAD");
  git("checkout", "-q", "master");
  put({ "list.txt": "alpha\nbravo\ncharlie\necho\n" });
  git("commit", "-qm", "master: echo");
  const base = git("rev-parse", "HEAD");
  /** A resolution on a side branch: merge feat into master's head, resolve with `files`, commit. */
  const resolve = (files: Record<string, string>, extra: () => void = () => {}) => {
    git("checkout", "-q", "--detach", base);
    try {
      git("merge", "--no-ff", "--no-edit", commit);
    } catch {
      /* the conflict */
    }
    put(files);
    extra();
    git("commit", "-qm", "resolve", "--no-edit");
    const sha = git("rev-parse", "HEAD");
    git("checkout", "-q", "master");
    return sha;
  };
  return { root, git, put, base, commit, resolve };
}

describe("conflict regions and hunks", () => {
  test("regions are the marker lines and what's between them", () => {
    expect(conflictRegions("a\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\nb\n<<<<<<< o\n=======\n>>>>>>> t\n")).toEqual([[2, 6], [8, 10]]);
  });
  test("a hunk inside a region passes; touching a line outside fails; an insertion must sit strictly inside", () => {
    const regions: [number, number][] = [[3, 7]];
    expect(hunksInside(hunksOf("@@ -3,5 +3,2 @@\n"), regions)).toBe(true);
    expect(hunksInside(hunksOf("@@ -2,3 +2,1 @@\n"), regions)).toBe(false);
    expect(hunksInside(hunksOf("@@ -5 +5 @@\n"), regions)).toBe(true);
    expect(hunksInside(hunksOf("@@ -4,0 +5,1 @@\n"), regions)).toBe(true);
    expect(hunksInside(hunksOf("@@ -7,0 +8,1 @@\n"), regions)).toBe(false);
    expect(hunksInside(hunksOf("@@ -9 +9 @@\n"), regions)).toBe(false);
  });
});

describe("sanityCheck", () => {
  test("conflictsBetween names the conflicted files and writes nothing", () => {
    const r = repo();
    const c = conflictsBetween(r.root, r.base, r.commit);
    return c.then((x) => {
      expect("files" in x && x.files).toEqual(["list.txt"]);
      expect(r.git("status", "--porcelain")).toBe("");
    });
  });

  test("keeping both sides inside the conflict passes", async () => {
    const r = repo();
    const res = r.resolve({ "list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n" });
    expect(await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: res })).toEqual({ ok: true, files: ["list.txt"] });
  });

  test("an edit outside the conflict region, or in a file that didn't conflict, is refused", async () => {
    const r = repo();
    const outside = r.resolve({ "list.txt": "ALPHA\nbravo\ncharlie\necho\ndelta\n" });
    expect(await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: outside })).toMatchObject({ ok: false, why: "it changes list.txt outside its conflict regions" });
    const other = r.resolve({ "list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n", "other.txt": "one\nTWO\n" });
    expect(await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: other })).toMatchObject({ ok: false, why: "it changes other.txt, which didn't conflict" });
  });

  test("adds, deletes, mode changes and leftover markers are refused", async () => {
    const r = repo();
    const added = r.resolve({ "list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n", "new.txt": "x\n" });
    expect((await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: added })).why).toMatch(/adds new\.txt/);
    const deleted = r.resolve({ "list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n" }, () => r.git("rm", "-q", "other.txt"));
    expect((await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: deleted })).why).toMatch(/deletes other\.txt/);
    const mode = r.resolve({ "list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n" }, () => {
      chmodSync(join(r.root, "list.txt"), 0o755);
      r.git("add", "list.txt");
    });
    expect((await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: mode })).why).toMatch(/mode of list\.txt/);
    const markers = r.resolve({ "list.txt": "alpha\nbravo\ncharlie\n<<<<<<< HEAD\necho\n=======\ndelta\n>>>>>>> feat\n" });
    expect((await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: markers })).why).toMatch(/still holds conflict markers/);
  });

  test("the wrong parents are refused: not the approved commit, not on the target, not a merge", async () => {
    const r = repo();
    const good = r.resolve({ "list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n" });
    expect((await sanityCheck(r.root, { base: r.base, commit: r.base, resolution: good })).why).toMatch(/not the approved commit/);
    expect((await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: r.commit })).why).toMatch(/1 parent/);
    // First parent off the target: a merge made on the branch side.
    r.git("checkout", "-q", "--detach", r.commit);
    r.git("commit", "-q", "--allow-empty", "-m", "side");
    const side = r.git("rev-parse", "HEAD");
    try {
      r.git("merge", "--no-ff", "--no-edit", r.base);
    } catch {
      /* conflict */
    }
    r.put({ "list.txt": "alpha\nbravo\ncharlie\necho\ndelta\n" });
    r.git("commit", "-qm", "wrong way", "--no-edit");
    const wrong = r.git("rev-parse", "HEAD");
    r.git("checkout", "-q", "master");
    expect((await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: wrong })).ok).toBe(false);
    expect(side).toBeTruthy();
    expect((await sanityCheck(r.root, { base: r.base, commit: r.commit, resolution: "f".repeat(40) })).why).toMatch(/isn't a commit/);
  });
});

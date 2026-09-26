// Run: pnpm exec tsx --test server/worktrees.test.ts
// A session's tracked worktrees in the insight (§chat.worktrees/pane) and its merge cards in the
// transcript (§chat.worktrees/merge-card). Uses a throwaway PI_CODING_AGENT_DIR and git repo in the
// OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-worktrees-test-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); // before the modules below compute their paths
const sessionsDir = join(root, "agent", "sessions", "--tmp-worktrees-test--");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

const { normalizeEntry } = await import("./transcript");
const { getSessionInsight } = await import("./insights");
const { describeWorktrees } = await import("./worktrees-state");
const { canonicalPath } = await import("./paths");

after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
  const main = join(root, "repo");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  git(main, "config", "user.email", "t@example.invalid");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-q", "-m", "a");
  const worktree = (name: string) => {
    const path = join(root, `repo-${name}`);
    git(main, "worktree", "add", "-q", "-b", `feat/${name}`, path);
    return { path, base: git(main, "rev-parse", "HEAD") };
  };
  return { main, worktree };
}

const tree = (over: Record<string, unknown>) => ({ branch: "feat/x", base: "0", status: "active", session: "sess-own", how: "created", at: 1, ...over });

describe("merge card", () => {
  const details = { version: 1, path: "/w/repo-x", branch: "feat/x", target: "master", sha: "abc1234def", commits: 5, added: 120, removed: 30, fastForward: false, how: "tool" };
  const content = "Merged feat/x into master at abc1234, 5 commits, +120 −30";

  test("a worktree-merge message is its own row kind with the details; the text is the model's line", () => {
    const [row] = normalizeEntry({ type: "custom_message", id: "m1", customType: "worktree-merge", display: true, content, details });
    assert.equal(row?.kind, "worktree-merge");
    assert.equal(row?.text, content);
    const { version: _v, ...info } = details;
    assert.deepEqual(row?.worktreeMerge, info);
  });

  test("unreadable details fall back to the plain row; display:false renders nothing", () => {
    const [row] = normalizeEntry({ type: "custom_message", id: "m2", customType: "worktree-merge", display: true, content, details: { ...details, commits: "5" } });
    assert.equal(row?.kind, "info");
    assert.equal(row?.worktreeMerge, undefined);
    assert.deepEqual(normalizeEntry({ type: "custom_message", id: "m3", customType: "worktree-merge", display: false, content, details }), []);
    // The `worktrees` state entry itself is invisible, like the other extension state.
    assert.deepEqual(normalizeEntry({ type: "custom", id: "w1", customType: "worktrees", data: { version: 1, trees: [] } }), []);
  });
});

describe("insight: the session's worktrees", () => {
  const r = repo();
  const own = r.worktree("own");
  const other = r.worktree("other");
  const inherited = r.worktree("inherited");
  // feat/other is merged into master outside this session's record.
  writeFileSync(join(other.path, "o.txt"), "o\n");
  git(other.path, "add", "o.txt");
  git(other.path, "commit", "-q", "-m", "o");
  git(r.main, "merge", "-q", "--no-edit", "feat/other");

  function session(id: string, entries: unknown[]): string {
    const path = join(sessionsDir, `2026-09-27T00-00-00-000Z_${id}.jsonl`);
    const header = { type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd: r.main };
    writeFileSync(path, [header, ...entries].map((e, i) => JSON.stringify(i === 0 ? e : { id: `e${i}`, parentId: i === 1 ? null : `e${i - 1}`, ...(e as object) })).join("\n") + "\n");
    return canonicalPath(path);
  }

  test("the newest entry on the branch, annotated: exists, .agent, merged elsewhere, shared", async () => {
    mkdirSync(join(own.path, ".agent"));
    const set = (trees: unknown[]) => ({ type: "custom", customType: "worktrees", data: { version: 1, trees } });
    const path = session("sess-own", [
      set([tree({ path: own.path, branch: "feat/own", base: own.base })]),
      set([
        tree({ path: own.path, branch: "feat/own", base: own.base }),
        tree({ path: other.path, branch: "feat/other", base: other.base, baseBranch: "master" }),
        tree({ path: inherited.path, branch: "feat/inherited", base: inherited.base, session: "sess-parent", how: "attached" }),
        tree({ path: join(root, "gone"), branch: "feat/gone", status: "merged", merge: { target: "master", sha: "fff0000", at: 2, how: "detected" } }),
        tree({ path: join(root, "dropped"), branch: "feat/dropped", status: "dropped" }),
      ]),
    ]);
    const rows = (await getSessionInsight(path)).worktrees ?? [];
    assert.deepEqual(rows.map((w) => [w.branch, w.status, w.exists, w.hasAgentDir, w.sharedWith ?? null, w.mergedInto?.target ?? null]), [
      ["feat/own", "active", true, true, null, null],
      ["feat/other", "active", true, false, null, "master"],
      ["feat/inherited", "active", true, false, "sess-parent", null],
      ["feat/gone", "merged", false, false, null, null],
      ["feat/dropped", "dropped", false, false, null, null],
    ]);
    assert.equal(rows[1]!.mergedInto?.sha, git(r.main, "rev-parse", "master"));
    assert.deepEqual(rows[3]!.merge, { target: "master", sha: "fff0000", how: "detected", at: 2 });
  });

  test("a session that never tracked a worktree has no field", async () => {
    const path = session("sess-none", [{ type: "custom", customType: "sandbox", data: { version: 1, on: false, level: "workspace-write" } }]);
    assert.equal((await getSessionInsight(path)).worktrees, undefined);
  });

  test("running workers count only live processes whose cwd is inside the worktree", async () => {
    const rows = await describeWorktrees(
      { version: 1, trees: [tree({ path: own.path, branch: "feat/own", base: own.base }) as never] },
      "sess-own",
      [
        { status: "running", cwd: join(own.path, ".") },
        { status: "waiting", cwd: own.path },
        { status: "done", cwd: own.path },
        { status: "restored", cwd: own.path },
        { status: "running", cwd: `${own.path}-evil` },
        { status: "running", cwd: r.main },
        { status: "running" },
      ],
    );
    assert.equal(rows?.[0]?.runningWorkers, 2);
  });
});

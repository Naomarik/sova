// Run: npx tsx --test server/archive-worktrees.test.ts (or pnpm test). `sova_archive` with
// `worktrees: "remove"` (§app.overseer/tools) over a real git repository in the OS temp dir, and a
// throwaway PI_CODING_AGENT_DIR (the audit log); ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";

const agentDir = mkdtempSync(join(tmpdir(), "sova-archive-wt-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const top = realpathSync(mkdtempSync(join(tmpdir(), "sova-archive-wt-")));
process.on("exit", () => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(top, { recursive: true, force: true });
});

const { archiveWorktrees } = await import("./archive-worktrees");
const { overseerTools, TurnLimits } = await import("./overseer-tools");
const { DEFAULT_CAPS } = await import("./overseer-store");

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(top, "repo");
const wt = (name: string) => join(top, `wt-${name}`);
const branchExists = (b: string) => git(repo, "branch", "--list", b) !== "";

/** A tree as the worktrees extension records it in the session's `worktrees` entry. */
const tree = (name: string, session: string, base: string) => ({ path: wt(name), branch: `feat/${name}`, base, baseBranch: "master", status: "active", session, how: "created", at: 1 });
const entryOf = (trees: unknown[]) => [{ type: "custom", customType: "worktrees", data: { version: 1, trees } }];

let base = "";
before(() => {
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  base = git(repo, "rev-parse", "HEAD");
  for (const name of ["merged", "open", "dirty", "theirs"]) {
    git(repo, "worktree", "add", "-q", "-b", `feat/${name}`, wt(name), base);
    writeFileSync(join(wt(name), `${name}.txt`), `${name}\n`);
    git(wt(name), "add", `${name}.txt`);
    git(wt(name), "commit", "-q", "-m", name);
  }
  git(repo, "merge", "-q", "--no-edit", "feat/merged");
  // Uncommitted work: an untracked file counts.
  writeFileSync(join(wt("dirty"), "scratch.txt"), "wip\n");
});

after(() => rmSync(top, { recursive: true, force: true }));

describe("sova_archive with worktrees: remove", () => {
  /** Two sessions: s1 owns merged + open and inherited theirs; s2 owns dirty. */
  function harness() {
    const sessions: Record<string, SessionSummary> = {
      s1: { id: "s1", path: "/s/s1.jsonl", title: "One", cwd: repo } as SessionSummary,
      s2: { id: "s2", path: "/s/s2.jsonl", title: "Two", cwd: repo } as SessionSummary,
    };
    const branches: Record<string, unknown[]> = {
      "/s/s1.jsonl": entryOf([tree("merged", "s1", base), tree("open", "s1", base), tree("theirs", "s0", base)]),
      "/s/s2.jsonl": entryOf([tree("dirty", "s2", base)]),
    };
    const archived: string[] = [];
    const host = {
      request: async (_path: string, init?: RequestInit) => {
        archived.push(JSON.parse(String(init?.body)).path);
        return Response.json({ ok: true });
      },
      overseerId: () => "ov",
      confirmed: () => null,
      caps: () => DEFAULT_CAPS,
      session: async (ref: string) => sessions[ref] ?? null,
      attended: () => true,
      worktrees: archiveWorktrees(async (path) => branches[path] ?? []),
    } as unknown as OverseerToolHost;
    const tool = overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_archive")!;
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params, undefined, undefined, undefined as never).then(
        (r) => (r.content[0] as { text: string }).text,
        (e: Error) => `ERROR: ${e.message}`,
      );
    return { call, archived };
  }

  test("a session with uncommitted changes in a worktree is refused whole: not archived, nothing removed", async () => {
    const h = harness();
    const out = await h.call({ sessions: ["s2"], worktrees: "remove" });
    assert.match(out, /^ERROR: Nothing was archived:\n- s2: refused — uncommitted changes in its worktree .*wt-dirty \(1 file, e\.g\. scratch\.txt\)\. Nothing of it was archived or removed/);
    assert.deepEqual(h.archived, []);
    assert.ok(existsSync(wt("dirty")));
    assert.ok(branchExists("feat/dirty"));
  });

  test("a clean session is archived, then its own worktrees removed; a branch is deleted only when merged; an inherited one is left", async () => {
    const h = harness();
    const out = await h.call({ sessions: ["s1", "s2"], worktrees: "remove" });
    assert.deepEqual(h.archived, ["/s/s1.jsonl"], "s2 is still refused, s1 goes");
    assert.match(out, /- \[One\]\(sova:\/\/s\/s1\): archived\n {2}- worktree .*wt-merged: removed; branch feat\/merged deleted \(merged\)\n {2}- worktree .*wt-open: removed; branch feat\/open kept \(not merged, its commits stay\)\n {2}- worktree .*wt-theirs \(feat\/theirs\): left, it belongs to session s0/);
    assert.match(out, /- s2: refused — uncommitted changes/);
    assert.ok(!existsSync(wt("merged")) && !existsSync(wt("open")), "both own worktrees are gone");
    assert.ok(!branchExists("feat/merged"), "merged branch deleted");
    assert.ok(branchExists("feat/open"), "unmerged branch keeps its commits");
    assert.ok(existsSync(wt("theirs")) && existsSync(wt("dirty")), "inherited and other sessions' trees untouched");
  });

  test("without worktrees nothing is removed; remove refuses with unarchive and any other value", async () => {
    const h = harness();
    assert.match(await h.call({ sessions: ["s2"] }), /archived/);
    assert.ok(existsSync(wt("dirty")));
    assert.match(await h.call({ sessions: ["s2"], archived: false, worktrees: "remove" }), /^ERROR: worktrees: "remove" goes only with archiving/);
    assert.match(await h.call({ sessions: ["s2"], worktrees: "delete" }), /^ERROR: worktrees takes only "remove"/);
  });
});

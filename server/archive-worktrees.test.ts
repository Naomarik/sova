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
const { configureCleanup } = await import("./worktree-cleanup");
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
  for (const name of ["merged", "open", "dirty", "theirs", "watched", "home"]) {
    git(repo, "worktree", "add", "-q", "-b", `feat/${name}`, wt(name), base);
    writeFileSync(join(wt(name), `${name}.txt`), `${name}\n`);
    git(wt(name), "add", `${name}.txt`);
    git(wt(name), "commit", "-q", "-m", name);
  }
  git(repo, "merge", "-q", "--no-edit", "feat/merged");
  git(repo, "merge", "-q", "--no-edit", "feat/watched");
  git(repo, "merge", "-q", "--no-edit", "feat/home");
  mkdirSync(join(wt("home"), "sub"));
  // Uncommitted work: an untracked file counts.
  writeFileSync(join(wt("dirty"), "scratch.txt"), "wip\n");
});

after(() => rmSync(top, { recursive: true, force: true }));

describe("sova_archive with worktrees: remove", () => {
  /** s1 owns merged + open and inherited theirs; s2 owns dirty; s3 owns watched, which s4 (sandbox
      on) tracks too; s5 owns home and runs inside it. Session files are real: the service reads them. */
  function harness() {
    const dir = join(top, "sessions");
    mkdirSync(dir, { recursive: true });
    const sessions: Record<string, SessionSummary> = {};
    const branches: Record<string, unknown[]> = {};
    const add = (id: string, title: string, cwd: string, entries: unknown[]) => {
      const path = join(dir, `${id}.jsonl`);
      writeFileSync(path, [{ type: "session", version: 3, id, timestamp: "", cwd }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
      sessions[id] = { id, path, title, cwd, busy: false, live: null } as unknown as SessionSummary;
      branches[path] = entries;
    };
    add("s1", "One", repo, entryOf([tree("merged", "s1", base), tree("open", "s1", base), tree("theirs", "s0", base)]));
    add("s2", "Two", repo, entryOf([tree("dirty", "s2", base)]));
    add("s3", "Three", repo, entryOf([tree("watched", "s3", base)]));
    add("s4", "Four", repo, [...entryOf([tree("watched", "s4", base)]), { type: "custom", customType: "sandbox", data: { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "full" } }]);
    add("s5", "Five", join(wt("home"), "sub"), entryOf([tree("home", "s5", base)]));
    configureCleanup({ summary: async (p) => Object.values(sessions).find((x) => x.path === p) ?? null, sessionFiles: async () => Object.values(sessions).map((x) => x.path), readBranch: async (p) => branches[p] ?? [], processes: async () => [], ledger: () => {} });
    const archived: string[] = [];
    const host = {
      request: async (_path: string, init?: RequestInit) => {
        archived.push(JSON.parse(String(init?.body)).path.split("/").pop());
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

  test("a clean session is archived, then its own worktrees go through the cleanup's checks: merged removed, unmerged kept, inherited left", async () => {
    const h = harness();
    const out = await h.call({ sessions: ["s1", "s2"], worktrees: "remove" });
    assert.deepEqual(h.archived, ["s1.jsonl"], "s2 is still refused, s1 goes");
    assert.match(out, /- \[One\]\(sova:\/\/s\/s1\): archived\n {2}- worktree .*wt-merged: removed; branch feat\/merged deleted \(merged\)\n {2}- worktree .*wt-open \(feat\/open\): kept, not merged into master\n {2}- worktree .*wt-theirs \(feat\/theirs\): left, it belongs to session s0/);
    assert.match(out, /- s2: refused — uncommitted changes/);
    assert.ok(!existsSync(wt("merged")), "the merged worktree is gone");
    assert.ok(existsSync(wt("open")), "an unmerged worktree is kept, as the Clean Up Merged button keeps it");
    assert.ok(!branchExists("feat/merged"), "merged branch deleted");
    assert.ok(branchExists("feat/open"), "unmerged branch keeps its commits");
    assert.ok(existsSync(wt("theirs")) && existsSync(wt("dirty")), "inherited and other sessions' trees untouched");
  });

  test("the service's session checks apply, except to the archived session itself", async () => {
    const h = harness();
    const out = await h.call({ sessions: ["s3", "s5"], worktrees: "remove" });
    assert.deepEqual(h.archived, ["s3.jsonl", "s5.jsonl"]);
    // Another session with its sandbox on tracks it: kept, with the service's reason.
    assert.match(out, /worktree .*wt-watched \(feat\/watched\): kept, session “Four” tracks it and has its sandbox on/);
    assert.ok(existsSync(wt("watched")) && branchExists("feat/watched"));
    // The archived session's own folder is inside its tree: that alone doesn't keep it.
    assert.match(out, /worktree .*wt-home: removed; branch feat\/home deleted \(merged\)/);
    assert.ok(!existsSync(wt("home")));
  });

  test("without worktrees nothing is removed; remove refuses with unarchive and any other value", async () => {
    const h = harness();
    assert.match(await h.call({ sessions: ["s2"] }), /archived/);
    assert.ok(existsSync(wt("dirty")));
    assert.match(await h.call({ sessions: ["s2"], archived: false, worktrees: "remove" }), /^ERROR: worktrees: "remove" goes only with archiving/);
    assert.match(await h.call({ sessions: ["s2"], worktrees: "delete" }), /^ERROR: worktrees takes only "remove"/);
  });
});

describe("a worktree's running copy is torn down first (§app.overseer/tools)", () => {
  test("its copy goes before the worktree; a copy that can't be torn down keeps the worktree, saying why", async () => {
    for (const name of ["copy-ok", "copy-fail"]) git(repo, "worktree", "add", "-q", "-b", `feat/${name}`, wt(name), base);
    const torn: string[] = [];
    const w = archiveWorktrees(
      async () => entryOf([tree("copy-ok", "s9", base), tree("copy-fail", "s9", base)]),
      undefined,
      async (path) => {
        if (path === wt("copy-fail")) throw new Error("Its running copy could not be torn down: busy: another verb is running on this instance");
        assert.ok(existsSync(path), "torn down while its worktree is still there");
        torn.push(path);
      },
    );
    const lines = await w.remove(await w.plan({ id: "s9", path: "/s/s9.jsonl" }));
    assert.deepEqual(torn, [wt("copy-ok")]);
    assert.match(lines[0]!, /wt-copy-ok: removed/);
    assert.equal(lines[1], `  - worktree ${wt("copy-fail")} (feat/copy-fail): kept, its running copy could not be torn down: busy: another verb is running on this instance`);
    assert.ok(!existsSync(wt("copy-ok")) && existsSync(wt("copy-fail")));
  });
});

describe("the cleanup's checks come before the teardown (§app.overseer/tools)", () => {
  test("a worktree the service keeps (unmerged) keeps its running copy: nothing is torn down", async () => {
    git(repo, "worktree", "add", "-q", "-b", "feat/copy-keep", wt("copy-keep"), base);
    writeFileSync(join(wt("copy-keep"), "k.txt"), "k\n");
    git(wt("copy-keep"), "add", "k.txt");
    git(wt("copy-keep"), "commit", "-q", "-m", "keep");
    const torn: string[] = [];
    const w = archiveWorktrees(async () => entryOf([tree("copy-keep", "s8", base)]), undefined, async (path) => { torn.push(path); });
    const lines = await w.remove(await w.plan({ id: "s8", path: "/s/s8.jsonl" }));
    assert.deepEqual(torn, [], "an unmerged worktree's copy is left running");
    assert.equal(lines[0], `  - worktree ${wt("copy-keep")} (feat/copy-keep): kept, not merged into master`);
    assert.ok(existsSync(wt("copy-keep")));
  });
});

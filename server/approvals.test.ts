// Run: pnpm test -- server/approvals.test.ts. Its folders and agent dir are in the runner's throwaway home.
//
// The approval list's store side: the file (version 2, and version 1 read and migrated), the keys (a checkout's
// relative path shared by the main checkout and its worktrees, the absolute path outside them), the scan of a
// folder (the project's, its folders', those above it and the user's own), the fingerprints and the changed mark,
// the one write and what it drops, and the Sova-wide setting.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

// The runner gives this file a throwaway home of its own (Bun reads HOME only at its start): the folders go inside it.
const home = realpathSync(homedir());
const base = realpathSync(mkdtempSync(join(home, "approvals-")));
const agent = join(base, "agent");
mkdirSync(join(agent, "sova"), { recursive: true });
const prev = { agent: process.env.PI_CODING_AGENT_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.CLAUDE_CONFIG_DIR;
after(() => {
  for (const [k, v] of [["PI_CODING_AGENT_DIR", prev.agent], ["CLAUDE_CONFIG_DIR", prev.claude]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
  rmSync(join(home, "AGENTS.md"), { force: true });
});

const store = await import("./project-skills-store");
const A = await import("./approvals");
const setting = await import("./context-approval-setting");
const { parseContextChanges, parseSkillChanges, skillsRowState } = await import("./projects/skills");

const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const skill = (dir: string, name: string) => put(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`);

beforeEach(() => {
  rmSync(store.projectSkillsPath(), { force: true });
  rmSync(setting.contextApprovalPath(), { force: true });
});

// ---- the file ------------------------------------------------------------------------------------

describe("the file", () => {
  test("decisions by folder and key, saved at once; waiting clears one; a folder with none left drops out", () => {
    store.setDecisions("p:p1", "skills", { ".agents/skills/pdf/SKILL.md": { state: "disallowed", name: "pdf" } });
    store.setDecisions("p:p1", "context", { "AGENTS.md": { state: "approved", sha256: "a".repeat(64) } });
    const f = store.folderDecisions("p:p1");
    assert.deepEqual(f.skills, { ".agents/skills/pdf/SKILL.md": { state: "disallowed", name: "pdf" } });
    assert.deepEqual(f.context, { "AGENTS.md": { state: "approved", sha256: "a".repeat(64) } });
    assert.equal(JSON.parse(readFileSync(store.projectSkillsPath(), "utf8")).version, 2);
    store.setDecisions("p:p1", "skills", { ".agents/skills/pdf/SKILL.md": "waiting" });
    store.setDecisions("p:p1", "context", { "AGENTS.md": "waiting" });
    assert.deepEqual(store.readApprovalStore().folders, {});
  });

  test("it reads strictly: a bad folder key, item key, state or fingerprint is never a decision", () => {
    put(store.projectSkillsPath(), JSON.stringify({
      version: 2,
      folders: {
        "x:1": { context: { "AGENTS.md": { state: "approved" } } },
        "d:relative": { context: { "AGENTS.md": { state: "approved" } } },
        "p:ok": { context: { "../out/AGENTS.md": { state: "approved" }, "a//b": { state: "approved" }, "AGENTS.md": { state: "off" }, "sub/AGENTS.md": { state: "approved", sha256: "nothex" } }, skills: { "/abs/SKILL.md": "disallowed" } },
      },
    }));
    assert.deepEqual(store.readApprovalStore().folders, { "p:ok": { context: { "sub/AGENTS.md": { state: "approved" } }, skills: { "/abs/SKILL.md": { state: "disallowed" } } } });
    writeFileSync(store.projectSkillsPath(), "not json");
    assert.deepEqual(store.readApprovalStore().folders, {});
  });

  test("version 1 is read: its Disallowed skills wait under the project by name; its Approved ones are dropped", () => {
    put(store.projectSkillsPath(), JSON.stringify({ version: 1, projects: { p1: { skills: { pdf: "disallowed", docx: "approved", bad: "off" } }, "bad key!": { skills: { a: "disallowed" } } } }));
    // Its Approved meant nothing while Waiting was on, and anyone could set it: never carried into an approval.
    assert.deepEqual(store.readApprovalStore().folders, { "p:p1": { context: {}, skills: {}, legacySkills: { pdf: "disallowed" } } });
    assert.deepEqual(store.projectSkillDecisions("p1"), { pdf: "disallowed" });
  });
});

// ---- keys and the lookup --------------------------------------------------------------------------

describe("keys", () => {
  const l = (over: Partial<import("./approvals").ApprovalLookup> = {}): import("./approvals").ApprovalLookup => ({
    folder: { key: "p:p1", kind: "project", projectId: "p1", name: "P", root: "/w/main" },
    asking: false,
    checkouts: ["/w/main", "/w/.worktrees/x", "/w/main/.worktrees/nested"],
    context: {},
    skills: {},
    ...over,
  });

  test("a file in the main checkout and the same file in a worktree share one key; a nested worktree's is its own checkout's", () => {
    assert.equal(A.itemKey(l(), "/w/main/AGENTS.md"), "AGENTS.md");
    assert.equal(A.itemKey(l(), "/w/.worktrees/x/AGENTS.md"), "AGENTS.md");
    assert.equal(A.itemKey(l(), "/w/main/.worktrees/nested/sub/AGENTS.md"), "sub/AGENTS.md");
    assert.equal(A.itemKey(l(), "/w/.worktrees/x/.agents/skills/a/SKILL.md"), ".agents/skills/a/SKILL.md");
  });

  test("outside every checkout the key is the path itself (above the project, the user's own)", () => {
    assert.equal(A.itemKey(l(), "/w/AGENTS.md"), "/w/AGENTS.md");
    assert.equal(A.itemKey(l(), "/home/u/.pi/agent/skills/a/SKILL.md"), "/home/u/.pi/agent/skills/a/SKILL.md");
  });

  test("a state by key: no decision is waiting; on by the list: approved always, waiting only without asking, disallowed never", () => {
    const x = l({ context: { "AGENTS.md": { state: "approved", sha256: "1".repeat(64) }, "sub/AGENTS.md": { state: "disallowed" } } });
    assert.equal(A.itemState(x, "context", "/w/.worktrees/x/AGENTS.md"), "approved");
    assert.equal(A.itemState(x, "context", "/w/main/sub/AGENTS.md"), "disallowed");
    assert.equal(A.itemState(x, "context", "/w/main/other/AGENTS.md"), "waiting");
    assert.equal(A.itemState(x, "skill", "/w/main/AGENTS.md"), "waiting", "a skill's decisions are their own");
    for (const [asking, want] of [[false, [true, false, true]], [true, [true, false, false]]] as const) {
      const y = { ...x, asking };
      assert.deepEqual(["/w/main/AGENTS.md", "/w/main/sub/AGENTS.md", "/w/main/other/AGENTS.md"].map((p) => A.onByList(y, "context", p)), want, `asking ${asking}`);
    }
    assert.equal(A.itemChanged(x, "context", "/w/main/AGENTS.md", "1".repeat(64)), false);
    assert.equal(A.itemChanged(x, "context", "/w/main/AGENTS.md", "2".repeat(64)), true);
    assert.equal(A.itemChanged(x, "context", "/w/main/sub/AGENTS.md", "2".repeat(64)), false, "only an approved one changes");
  });

  test("where an item comes from", () => {
    const p = { checkout: "/w/main", agentDir: "/h/.pi/agent", home: "/h", claudeDirs: ["/h/.claude"] };
    assert.equal(A.groupOf("context", "/w/main/AGENTS.md", p), "project");
    assert.equal(A.groupOf("context", "/w/main/sub/AGENTS.md", p), "subfolder");
    assert.equal(A.groupOf("context", "/w/AGENTS.md", p), "above");
    assert.equal(A.groupOf("context", "/h/AGENTS.md", p), "user");
    assert.equal(A.groupOf("context", "/h/.pi/agent/AGENTS.md", p), "user");
    assert.equal(A.groupOf("skill", "/w/main/.agents/skills/a/SKILL.md", p), "project");
    assert.equal(A.groupOf("skill", "/w/main/.claude/skills/a/SKILL.md", p), "claude");
    assert.equal(A.groupOf("skill", "/w/main/svc/.agents/skills/a/SKILL.md", p), "subfolder");
    assert.equal(A.groupOf("skill", "/h/.pi/agent/skills/a/SKILL.md", p), "user");
    assert.equal(A.groupOf("skill", "/h/.claude/skills/a/SKILL.md", p), "claude");
  });
});

// ---- a folder's scan, view and write --------------------------------------------------------------

/** An ad hoc folder (no project) in the home folder: a repository, a folder above it, the user's own. */
function world(name: string) {
  const above = join(base, name);
  const repo = join(above, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  put(join(home, "AGENTS.md"), "# home\n");
  put(join(agent, "AGENTS.md"), "# mine\n");
  put(join(above, "AGENTS.md"), "# above\n");
  put(join(repo, "AGENTS.md"), "# repo\n");
  put(join(repo, "svc", "AGENTS.md"), "# svc\n");
  skill(join(repo, ".agents", "skills"), "tidy");
  skill(join(repo, "svc", ".agents", "skills"), "deploy");
  skill(join(agent, "skills"), "tidy");
  return { above, repo, deps: { checkouts: async (root: string) => ({ dirs: [realpathSync(root)], complete: true }) } };
}

describe("a folder's lists", () => {
  test("an ad hoc folder is the repository holding the chat's folder; every file and skill a chat there could load is listed, by place", async () => {
    const w = world("adhoc");
    assert.equal(A.folderForCwd(join(w.repo, "svc")).key, `d:${w.repo}`);
    const v = await A.folderApprovalsView(join(w.repo, "svc"), w.deps);
    assert.equal(v.folder.kind, "folder");
    assert.equal(v.complete, true);
    const files = Object.fromEntries(v.files.map((f) => [f.key, f.source.kind]));
    assert.equal(files["AGENTS.md"], "project");
    assert.equal(files["svc/AGENTS.md"], "subfolder");
    assert.equal(files[join(w.above, "AGENTS.md")], "above");
    assert.equal(files[join(home, "AGENTS.md")], "user");
    assert.equal(files[join(agent, "AGENTS.md")], "user");
    // The user's tidy is a row of its own beside the project's: told by place, not name.
    const tidy = v.skills.filter((s) => s.name === "tidy").map((s) => [s.key, s.source.kind]).sort();
    assert.deepEqual(tidy, [[".agents/skills/tidy/SKILL.md", "project"], [join(agent, "skills", "tidy", "SKILL.md"), "user"]]);
    assert.ok(v.skills.some((s) => s.key === "svc/.agents/skills/deploy/SKILL.md" && s.source.kind === "subfolder"));
    assert.equal(v.counts.waiting, v.files.length + v.skills.length);
  });

  test("approving keeps the file's fingerprint; changed content is marked, still approved, and Re-approve clears the mark", async () => {
    const w = world("hash");
    const f = A.folderForCwd(w.repo);
    await A.writeFolderApprovals(f, { context: { "AGENTS.md": "approved" }, skills: { tidy: "disallowed" } }, w.deps);
    let v = await A.folderApprovalsView(f, w.deps);
    const row = () => v.files.find((x) => x.key === "AGENTS.md")!;
    assert.equal(row().state, "approved");
    assert.equal(row().changed, undefined);
    assert.equal(v.skills.find((s) => s.key === ".agents/skills/tidy/SKILL.md")?.state, "disallowed", "a bare name is the first skill of that name");
    assert.equal(v.skills.find((s) => s.key.startsWith(agent))?.state, "waiting", "the user's tidy keeps its own state");
    writeFileSync(join(w.repo, "AGENTS.md"), "# repo, edited\n");
    v = await A.folderApprovalsView(f, w.deps);
    assert.equal(row().state, "approved");
    assert.equal(row().changed, true);
    assert.equal(v.counts.changed, 1);
    const re = await A.writeFolderApprovals(f, { context: { "AGENTS.md": "approved" }, skills: {} }, w.deps);
    assert.deepEqual(re.changed.map((c) => [c.key, c.from, c.to]), [["AGENTS.md", "approved", "approved"]], "a Re-approve is a write");
    v = await A.folderApprovalsView(f, w.deps);
    assert.equal(row().changed, undefined);
  });

  test("a skill's fingerprint is its whole folder: an edited script or an added file marks it changed; a symlink is its target, never followed", async () => {
    const w = world("folder-fp");
    const sk = join(w.repo, ".agents", "skills", "tidy");
    put(join(sk, "scripts", "run.sh"), "echo one\n");
    const f = A.folderForCwd(w.repo);
    const key = ".agents/skills/tidy/SKILL.md";
    await A.writeFolderApprovals(f, { context: {}, skills: { [key]: "approved" } }, w.deps);
    const row = async () => (await A.folderApprovalsView(f, w.deps)).skills.find((s) => s.key === key)!;
    assert.equal((await row()).changed, undefined);
    writeFileSync(join(sk, "scripts", "run.sh"), "echo two\n");
    assert.equal((await row()).changed, true, "an edited script");
    await A.writeFolderApprovals(f, { context: {}, skills: { [key]: "approved" } }, w.deps);
    assert.equal((await row()).changed, undefined, "Re-approve takes the folder as it is");
    put(join(sk, "notes.txt"), "new\n");
    assert.equal((await row()).changed, true, "an added file");
    await A.writeFolderApprovals(f, { context: {}, skills: { [key]: "approved" } }, w.deps);
    // A link to a file: the file's content counts, read through the link.
    put(join(base, "outside.txt"), "outside\n");
    symlinkSync(join(base, "outside.txt"), join(sk, "out"));
    assert.equal((await row()).changed, true, "an added link");
    await A.writeFolderApprovals(f, { context: {}, skills: { [key]: "approved" } }, w.deps);
    assert.equal((await row()).fingerprintPartial, undefined, "a file link is covered");
    writeFileSync(join(base, "outside.txt"), "outside, edited\n");
    assert.equal((await row()).changed, true, "editing a linked file's target marks the skill changed");
    // An edit that keeps the size and puts the times back is still seen (ctime is the kernel's).
    await A.writeFolderApprovals(f, { context: {}, skills: { [key]: "approved" } }, w.deps);
    const script = join(sk, "scripts", "run.sh");
    const { atime, mtime } = statSync(script);
    writeFileSync(script, "echo six\n");
    utimesSync(script, atime, mtime);
    assert.equal((await row()).changed, true, "same size, times reset");
  });

  test("a SKILL.md that is a link: its target's text is the skill's; a link to a folder or a dangling one marks the row partial", async () => {
    const w = world("linked-skill");
    const shared = join(base, "shared-skill.md");
    put(shared, "---\nname: shared\ndescription: Shared.\n---\nOne.\n");
    mkdirSync(join(w.repo, ".agents", "skills", "shared"), { recursive: true });
    symlinkSync(shared, join(w.repo, ".agents", "skills", "shared", "SKILL.md"));
    const f = A.folderForCwd(w.repo);
    const key = ".agents/skills/shared/SKILL.md";
    await A.writeFolderApprovals(f, { context: {}, skills: { [key]: "approved" } }, w.deps);
    const row = async () => (await A.folderApprovalsView(f, w.deps)).skills.find((s) => s.key === key)!;
    assert.deepEqual([(await row()).changed, (await row()).fingerprintPartial], [undefined, undefined]);
    writeFileSync(shared, "---\nname: shared\ndescription: Shared.\n---\nTwo: rewritten.\n");
    assert.equal((await row()).changed, true, "the linked SKILL.md's text changed");
    mkdirSync(join(base, "elsewhere"), { recursive: true });
    symlinkSync(join(base, "elsewhere"), join(w.repo, ".agents", "skills", "shared", "lib"));
    assert.equal((await row()).fingerprintPartial, true, "a link to a folder can't be covered");
    rmSync(join(w.repo, ".agents", "skills", "shared", "lib"));
    symlinkSync(join(base, "nowhere"), join(w.repo, ".agents", "skills", "shared", "gone"));
    assert.equal((await row()).fingerprintPartial, true, "a dangling link can't be covered");
  });

  test("an unchanged rescan reads no file; past the cap the fingerprint is the listing, marked partial", async () => {
    const FP = await import("./skill-fingerprint");
    const w = world("fp-cache");
    const skillFile = join(w.repo, ".agents", "skills", "tidy", "SKILL.md");
    put(join(dirname(skillFile), "a.txt"), "a\n");
    FP.forgetFingerprintsForTest();
    const first = FP.skillFolderFingerprint(skillFile);
    const reads = FP.fingerprintIo.reads;
    assert.deepEqual(FP.skillFolderFingerprint(skillFile), first);
    assert.equal(FP.fingerprintIo.reads, reads, "nothing read the second time");
    writeFileSync(join(dirname(skillFile), "a.txt"), "a, edited\n");
    assert.notEqual(FP.skillFolderFingerprint(skillFile).sha256, first.sha256);
    assert.equal(FP.fingerprintIo.reads, reads + 1, "only the changed file read");
    // Past the cap: a listing fingerprint, partial, and it reads no contents.
    const before = FP.fingerprintIo.reads;
    const big = FP.skillFolderFingerprint(skillFile, { maxFiles: 1 });
    assert.equal(big.partial, true);
    assert.equal(FP.fingerprintIo.reads, before);
    assert.equal(FP.skillFolderFingerprint(skillFile, { maxBytes: 4 }).partial, true);
    put(join(dirname(skillFile), "b.txt"), "b\n");
    assert.notEqual(FP.skillFolderFingerprint(skillFile, { maxFiles: 1 }).sha256, big.sha256, "an added file moves the listing too");
    assert.equal(FP.skillFolderFingerprint(skillFile).partial, undefined, "under the cap: whole");
    if (process.getuid?.() !== 0) {
      mkdirSync(join(dirname(skillFile), "locked"), { recursive: true });
      chmodSync(join(dirname(skillFile), "locked"), 0o000);
      try {
        assert.equal(FP.skillFolderFingerprint(skillFile).partial, true, "an unreadable folder isn't covered");
      } finally {
        chmodSync(join(dirname(skillFile), "locked"), 0o755);
        rmSync(join(dirname(skillFile), "locked"), { recursive: true, force: true });
      }
    }
    // The real cap, on the wire: a skill folder past FINGERPRINT_MAX_FILES files is marked on its row.
    const huge = join(w.repo, ".agents", "skills", "huge");
    skill(join(w.repo, ".agents", "skills"), "huge");
    mkdirSync(join(huge, "data"), { recursive: true });
    for (let i = 0; i < FP.FINGERPRINT_MAX_FILES; i++) writeFileSync(join(huge, "data", `${i}.txt`), "x");
    const v = await A.folderApprovalsView(A.folderForCwd(w.repo), w.deps);
    assert.equal(v.skills.find((x) => x.name === "huge")?.fingerprintPartial, true);
    assert.equal(v.skills.find((x) => x.name === "tidy" && x.key.startsWith(".agents"))?.fingerprintPartial, undefined);
  });

  test("the main checkout and its worktree share one decision; a file only the worktree has is listed and decided too", async () => {
    const w = world("trees");
    const wt = join(w.above, "wt");
    put(join(wt, "AGENTS.md"), "# wt\n");
    put(join(wt, "only", "AGENTS.md"), "# only\n");
    const deps = { checkouts: async () => ({ dirs: [w.repo, wt], complete: true }) };
    const f = A.folderForCwd(w.repo);
    const v = await A.folderApprovalsView(f, deps);
    assert.equal(v.files.filter((x) => x.key === "AGENTS.md").length, 1);
    assert.equal(v.files.find((x) => x.key === "AGENTS.md")?.path, join(w.repo, "AGENTS.md"), "the main checkout's copy is the row's");
    assert.ok(v.files.some((x) => x.key === "only/AGENTS.md"));
    await A.writeFolderApprovals(f, { context: { "AGENTS.md": "disallowed" }, skills: {} }, deps);
    const l = await A.approvalLookupForCwd(w.repo, deps);
    assert.equal(A.itemState(l, "context", join(wt, "AGENTS.md")), "disallowed");
    assert.equal(A.itemState(l, "context", join(w.repo, "AGENTS.md")), "disallowed");
  });

  test("with real git: a worktree's checkout is found, and its copy of a file shares the main checkout's key", async () => {
    const main = join(base, "git-main");
    mkdirSync(main, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", main, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    put(join(main, "AGENTS.md"), "# main\n");
    git("add", "AGENTS.md");
    git("commit", "-q", "-m", "one");
    const wt = join(base, "git-wt");
    git("worktree", "add", "-q", "-b", "feat", wt);
    put(join(wt, "AGENTS.md"), "# the branch's own words\n");
    const v = await A.folderApprovalsView(A.folderForCwd(wt));
    assert.equal(v.complete, true);
    assert.equal(v.folder.key, `d:${main}`, "a worktree of a folder is that folder");
    assert.deepEqual(v.files.filter((f) => f.key === "AGENTS.md").map((f) => f.path), [join(main, "AGENTS.md")]);
    await A.writeFolderApprovals(A.folderForCwd(main), { context: { "AGENTS.md": "approved" }, skills: {} });
    const l = await A.approvalLookupForCwd(wt);
    assert.equal(A.itemState(l, "context", join(wt, "AGENTS.md")), "approved");
    assert.equal(A.itemChanged(l, "context", join(wt, "AGENTS.md"), A.fileSha256(readFileSync(join(wt, "AGENTS.md")))), true, "the worktree's differing copy reads as changed");
  });

  test("an item gone drops off after a complete scan only; an unknown one is a 404 unless the scan was partial", async () => {
    const w = world("prune");
    const f = A.folderForCwd(w.repo);
    await A.writeFolderApprovals(f, { context: { "svc/AGENTS.md": "disallowed" }, skills: {} }, w.deps);
    rmSync(join(w.repo, "svc", "AGENTS.md"));
    await A.folderApprovalsView(f, { ...w.deps, checkouts: async () => ({ dirs: [w.repo], complete: false }) });
    assert.ok(store.folderDecisions(f.key).context["svc/AGENTS.md"], "a partial scan keeps it");
    await A.folderApprovalsView(f, w.deps);
    assert.equal(store.folderDecisions(f.key).context["svc/AGENTS.md"], undefined);
    await assert.rejects(A.writeFolderApprovals(f, { context: { "nope/AGENTS.md": "disallowed" }, skills: {} }, w.deps), /Nothing named "nope\/AGENTS.md"/);
    await A.writeFolderApprovals(f, { context: { "nope/AGENTS.md": "waiting" }, skills: {} }, w.deps);
    // A partial scan takes a decision on an item it didn't see, but never an approval: there is nothing to fingerprint.
    const partial = { ...w.deps, checkouts: async () => ({ dirs: [w.repo], complete: false }) };
    await A.writeFolderApprovals(f, { context: { "unseen/AGENTS.md": "disallowed" }, skills: {} }, partial);
    await assert.rejects(A.writeFolderApprovals(f, { context: { "unseen/AGENTS.md": "approved" }, skills: {} }, partial), /can't be approved: it wasn't found/);
    assert.equal(store.folderDecisions(f.key).context["unseen/AGENTS.md"]?.state, "disallowed");
  });

  test("a Disallowed by name (version 1) goes to the first skill of that name at the next scan; asking on, nothing is approved by it", async () => {
    const w = world("legacy");
    const key = `d:${w.repo}`;
    put(store.projectSkillsPath(), JSON.stringify({ version: 2, folders: { [key]: { context: {}, skills: {}, legacySkills: { tidy: "disallowed", deploy: "approved", gone: "disallowed" } } } }));
    setting.setAllowWithoutAsking(false);
    const l = await A.approvalLookupForCwd(w.repo, w.deps);
    assert.deepEqual(l.skills[".agents/skills/tidy/SKILL.md"], { state: "disallowed", name: "tidy" });
    assert.equal(A.itemState(l, "skill", join(w.repo, "svc", ".agents", "skills", "deploy", "SKILL.md")), "waiting");
    assert.equal(A.onByList(l, "skill", join(w.repo, "svc", ".agents", "skills", "deploy", "SKILL.md")), false);
    assert.equal(A.itemState(l, "skill", join(agent, "skills", "tidy", "SKILL.md")), "waiting", "the other tidy is its own");
    assert.equal(store.folderDecisions(key).legacySkills, undefined, "a name no skill has goes after a complete scan");
  });

  test("an approval with no fingerprint matches nothing: it reads as changed, still approved", async () => {
    const w = world("nohash");
    const key = `d:${w.repo}`;
    store.setDecisions(key, "context", { "AGENTS.md": { state: "approved" } });
    const v = await A.folderApprovalsView(A.folderForCwd(w.repo), w.deps);
    assert.deepEqual([v.files.find((f) => f.key === "AGENTS.md")?.state, v.files.find((f) => f.key === "AGENTS.md")?.changed], ["approved", true]);
    assert.equal(A.itemChanged(await A.approvalLookupForCwd(w.repo, w.deps), "context", join(w.repo, "AGENTS.md"), "0".repeat(64)), true);
  });

  test("who must be the page: an approval, a Re-approve, or a disallowed item turned back on; a disallow or a clear of a waiting one is anyone's", () => {
    store.setDecisions("p:need", "context", { "A.md": { state: "disallowed" }, "B.md": { state: "approved" } });
    const need = (context: Record<string, import("../shared/approvals").ApprovalState>) => A.changesNeedPage("p:need", { context, skills: {} });
    assert.equal(need({ "C.md": "approved" }), true);
    assert.equal(need({ "B.md": "approved" }), true);
    assert.equal(need({ "A.md": "waiting" }), true);
    assert.equal(need({ "B.md": "disallowed", "C.md": "disallowed" }), false);
    assert.equal(need({ "C.md": "waiting", "B.md": "waiting" }), false);
  });
});

// ---- bodies, the row, the setting -----------------------------------------------------------------

test("a PUT body is strict: one or more keys (a skill also by name), each approved, disallowed or waiting", () => {
  assert.deepEqual(parseSkillChanges({ skills: { tidy: "approved", ".agents/skills/x/SKILL.md": "waiting" } }), { tidy: "approved", ".agents/skills/x/SKILL.md": "waiting" });
  assert.deepEqual(parseContextChanges({ files: { "AGENTS.md": "disallowed", "/abs/AGENTS.md": "approved" } }), { "AGENTS.md": "disallowed", "/abs/AGENTS.md": "approved" });
  for (const bad of [null, {}, { skills: {} }, { skills: [] }, { skills: { a: "off" } }, { skills: { "": "approved" } }]) assert.throws(() => parseSkillChanges(bad), /Expected/);
  for (const bad of [{ files: {} }, { files: { "../x/AGENTS.md": "approved" } }, { files: { "a\nb": "approved" } }]) assert.throws(() => parseContextChanges(bad), /Expected/);
});

test("the All settings row: waiting counts only while asking; changed ones are named", () => {
  const c = (approved: number, disallowed: number, waiting: number, changed = 0) => ({ approved, disallowed, waiting, changed });
  assert.equal(skillsRowState(c(0, 0, 4)), "No preference");
  assert.equal(skillsRowState(c(0, 0, 4), true), "4 waiting");
  assert.equal(skillsRowState(c(1, 2, 1)), "2 disallowed");
  assert.equal(skillsRowState(c(1, 2, 1), true), "2 disallowed · 1 waiting");
  assert.equal(skillsRowState(c(3, 0, 0)), "3 approved");
  assert.equal(skillsRowState(c(3, 0, 0, 1)), "1 changed");
});

test("the Sova-wide setting: no file is the default (allow); a file that can't be read or understood keeps asking on", () => {
  assert.equal(setting.allowWithoutAsking(), true, "missing file: the default");
  assert.equal(setting.askingFirst(), false);
  setting.setAllowWithoutAsking(false);
  assert.equal(setting.askingFirst(), true);
  setting.setAllowWithoutAsking(true);
  assert.equal(setting.askingFirst(), false);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    for (const bad of ["{", "garbage", "null", "[]", "{}", '{"allowWithoutAsking":"yes"}']) {
      writeFileSync(setting.contextApprovalPath(), bad);
      assert.equal(setting.askingFirst(), true, bad);
    }
    // Unreadable, not missing: a folder where the file should be.
    rmSync(setting.contextApprovalPath(), { force: true });
    mkdirSync(setting.contextApprovalPath());
    assert.equal(setting.askingFirst(), true, "unreadable");
    rmSync(setting.contextApprovalPath(), { recursive: true, force: true });
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => /not JSON/.test(w)) && warnings.some((w) => /unreadable/.test(w)), warnings.join("\n"));
  assert.equal(setting.askingFirst(), false, "removed again: the default");
});

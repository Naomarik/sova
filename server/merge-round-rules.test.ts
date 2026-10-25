// The merge round's driver (.sova/playbooks/merge-round/scripts/round.mjs) carries its own copies of
// two readiness rules, since a playbook script imports nothing from Sova. These must stay equal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsRestart, tempCommitOf } from "./merge-readiness";

interface RoundRules {
  needsRestart: (file: string) => boolean;
  tempCommitOf: (subjects: readonly string[]) => string | undefined;
}
// A computed specifier: the driver is plain JS with no types, and must not run as a CLI on import.
const ROUND = new URL("../.sova/playbooks/merge-round/scripts/round.mjs", import.meta.url).href;

test("round.mjs's needsRestart matches merge-readiness over every enumerated path", async () => {
  const round = (await import(ROUND)) as RoundRules;
  const dirs = ["server", "shared", "pi-config", "pi-config/extensions/mode", "src", "src/lib", ".sova/spec", "scripts", "docs", ""];
  const names = ["index.ts", "a.test.ts", "a.test.mjs", "a.test.tsx", "a.test.cjs", "README.md", "notes.MD", "a.tsx", "a.json", "package.json", "pnpm-lock.yaml", "x.mjs"];
  let n = 0;
  for (const d of dirs) for (const f of names) {
    const path = d ? `${d}/${f}` : f;
    assert.equal(round.needsRestart(path), needsRestart(path), path);
    n++;
  }
  for (const odd of ["serverx/a.ts", "server", "Server/a.ts", "pi-config", " package.json", "package.json/x"]) assert.equal(round.needsRestart(odd), needsRestart(odd), odd);
  assert.ok(n > 100);
});

test("round.mjs's tempCommitOf matches merge-readiness over every enumerated subject", async () => {
  const round = (await import(ROUND)) as RoundRules;
  const heads = ["TEMP", "temp", "Temp:", "WIP", "wip:", "WIP-", "fixup!", "squash!", "amend!", "Fixup!", "fixup", "squash", "amend", "temporary", "wipe", "template", "feat:", "", "  WIP"];
  const tails = ["", " x", ": x", "! x", "\tx"];
  for (const h of heads) for (const t of tails) {
    const s = `${h}${t}`;
    assert.equal(round.tempCommitOf([s]), tempCommitOf([s]), JSON.stringify(s));
    assert.equal(round.tempCommitOf(["ok", s, "WIP last"]), tempCommitOf(["ok", s, "WIP last"]), JSON.stringify(s));
  }
  assert.equal(round.tempCommitOf([]), tempCommitOf([]));
});

// The go-ahead carry-over (§chat.merge-round/driver): a Land It recorded by landing.ts counts, through the driver's
// own walk, across clean master merges only, for every kind of commit, in a real repository.
interface RoundCarry {
  cleanMergeParent: (run: (args: string[]) => Promise<{ code: number; stdout: string }>, merge: string, target: string) => Promise<string | undefined>;
  landingAnswerAt: (landing: { goAheads: unknown[]; notYet: unknown[] }, branch: string, head: string, parentOf: (sha: string) => Promise<string | undefined>) => Promise<{ kind: string; at?: string } | null>;
  CARRY_MAX: number;
}

test("round.mjs carries landing.ts's go-ahead over clean master merges only: not evil, resolved, octopus or other-branch merges", async () => {
  const round = (await import(ROUND)) as RoundCarry;
  const landing = await import("../pi-config/extensions/worktrees/landing.ts");
  const { runGit } = await import("../pi-config/extensions/worktrees/git.ts");
  const { execFileSync } = await import("node:child_process");
  const { rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { scratchRoot } = await import("./test-scratch");
  const dir = scratchRoot("sova-carry-");
  const repo = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "rerere.enabled=false", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" } }).trim();
  const tryGit = (...args: string[]) => {
    try {
      git(...args);
    } catch {
      // a conflict: resolved by hand below
    }
  };
  const commit = (name: string, text: string) => {
    writeFileSync(join(repo, name), text);
    git("add", "-A");
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  };
  try {
    execFileSync("git", ["init", "-q", "-b", "master", repo]);
    commit("a.txt", "one\ntwo\n");
    git("checkout", "-q", "-b", "feat");
    const P = commit("b.txt", "feature\n");
    const cases: Record<string, string> = { plain: P };
    git("checkout", "-q", "master");
    commit("c.txt", "master\n");
    git("checkout", "-q", "-b", "other", "master~1");
    commit("o.txt", "other\n");
    git("checkout", "-q", "feat");
    git("merge", "--no-edit", "-q", "master");
    cases.clean = git("rev-parse", "HEAD");
    git("reset", "-q", "--hard", P);
    git("merge", "--no-edit", "--no-commit", "-q", "master");
    writeFileSync(join(repo, "b.txt"), "edited in the merge\n");
    git("add", "-A");
    git("commit", "-q", "--no-edit");
    cases.evil = git("rev-parse", "HEAD");
    git("reset", "-q", "--hard", P);
    git("merge", "--no-edit", "-q", "master", "other");
    cases.octopus = git("rev-parse", "HEAD");
    git("reset", "-q", "--hard", P);
    git("merge", "--no-edit", "-q", "other");
    cases.otherBranch = git("rev-parse", "HEAD");
    git("reset", "-q", "--hard", P);
    commit("a.txt", "one\nTWO feat\n");
    git("checkout", "-q", "master");
    commit("a.txt", "one\nTWO master\n");
    git("checkout", "-q", "feat");
    tryGit("merge", "--no-edit", "-q", "master");
    writeFileSync(join(repo, "a.txt"), "one\nTWO both\n");
    git("add", "-A");
    git("commit", "-q", "--no-edit");
    cases.resolved = git("rev-parse", "HEAD");
    const run = (args: string[]) => runGit(args, repo);
    const file = join(dir, "landing.json");
    landing.recordGoAhead({ branch: "feat", commit: P, at: "2026-10-24T00:00:00Z", by: "land-it" }, file);
    const parsed = landing.readLanding(file);
    assert.equal(round.CARRY_MAX, 20);
    const answers: Record<string, boolean> = {};
    const parents: Record<string, boolean> = {};
    for (const [name, sha] of Object.entries(cases)) {
      parents[name] = (await round.cleanMergeParent(run, sha, "master")) === P;
      answers[name] = (await round.landingAnswerAt(parsed, "feat", sha, (s) => round.cleanMergeParent(run, s, "master")))?.kind === "go-ahead";
    }
    assert.deepEqual(parents, { plain: false, clean: true, evil: false, octopus: false, otherBranch: false, resolved: false });
    assert.deepEqual(answers, { plain: true, clean: true, evil: false, octopus: false, otherBranch: false, resolved: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The newest answer at one commit (§chat.worktrees/landing-answers): the driver's copy matches landing.ts's, Not Yet
// a tie or an unreadable time; and the driver's walk stops at the first commit with an answer.
interface RoundAnswer {
  landingAnswer: (landing: { goAheads: unknown[]; notYet: unknown[] }, branch: string, head: string) => { kind: string } | null;
  landingAnswerAt: RoundCarry["landingAnswerAt"];
}

test("round.mjs's newest-answer rule matches landing.ts's answerAt over every pairing of times", async () => {
  const round = (await import(ROUND)) as RoundAnswer;
  const landing = await import("../pi-config/extensions/worktrees/landing.ts");
  const sha = "a".repeat(40);
  const times = [undefined, "2026-10-24T00:00:00Z", "2026-10-24T00:05:00Z", "x"];
  for (const go of times) for (const no of times) {
    const data = {
      v: 1 as const,
      goAheads: go === undefined ? [] : [{ branch: "b", commit: sha, at: go, by: "land-it" as const }],
      notYet: no === undefined ? [] : [{ branch: "b", commit: sha, at: no }],
    };
    const ours = landing.answerAt(data, "b", sha)?.kind ?? null;
    assert.equal(round.landingAnswer(data, "b", sha)?.kind ?? null, ours, `go ${go} / not yet ${no}`);
  }
});

test("round.mjs stops the carry at a later Not Yet recorded by landing.ts: A pressed, Not Yet at B, C holds", async () => {
  const round = (await import(ROUND)) as RoundAnswer & RoundCarry;
  const landing = await import("../pi-config/extensions/worktrees/landing.ts");
  const { runGit } = await import("../pi-config/extensions/worktrees/git.ts");
  const { execFileSync } = await import("node:child_process");
  const { rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { scratchRoot } = await import("./test-scratch");
  const dir = scratchRoot("sova-notyet-");
  const repo = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" } }).trim();
  const commit = (name: string) => {
    writeFileSync(join(repo, name), `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", name);
  };
  const cleanMerge = (name: string) => {
    git("checkout", "-q", "master");
    commit(name);
    git("checkout", "-q", "feat");
    git("merge", "--no-edit", "-q", "master");
    return git("rev-parse", "HEAD");
  };
  try {
    execFileSync("git", ["init", "-q", "-b", "master", repo]);
    commit("base.txt");
    git("checkout", "-q", "-b", "feat");
    commit("feat.txt");
    const A = git("rev-parse", "HEAD");
    const B = cleanMerge("m1.txt");
    const C = cleanMerge("m2.txt");
    const run = (args: string[]) => runGit(args, repo);
    const parentOf = (s: string) => round.cleanMergeParent(run, s, "master");
    const file = join(dir, "landing.json");
    const both = async (label: string, want: Record<string, boolean>) => {
      const parsed = landing.readLanding(file);
      for (const [name, sha] of Object.entries({ A, B, C })) {
        const kind = (await round.landingAnswerAt(parsed, "feat", sha, parentOf))?.kind ?? null;
        assert.equal(kind, want[name] ? "go-ahead" : "not-yet", `${label}: ${name}`);
      }
    };
    landing.recordGoAhead({ branch: "feat", commit: A, at: "2026-10-24T00:00:00Z", by: "land-it" }, file);
    await both("Land It at A", { A: true, B: true, C: true });
    landing.recordNotYet({ branch: "feat", commit: B, at: "2026-10-24T00:05:00Z" }, file);
    await both("then Not Yet at B", { A: true, B: false, C: false });
    landing.recordGoAhead({ branch: "feat", commit: B, at: "2026-10-24T00:10:00Z", by: "land-it" }, file);
    await both("then Land It at B", { A: true, B: true, C: true });
    rmSync(file);
    landing.recordGoAhead({ branch: "feat", commit: A, at: "2026-10-24T00:00:00Z", by: "land-it" }, file);
    landing.recordNotYet({ branch: "feat", commit: A, at: "2026-10-24T00:05:00Z" }, file);
    await both("Not Yet at A after its Land It", { A: false, B: false, C: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

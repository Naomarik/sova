// al_6 landing 2, check (4), BRIEF a4/a5 against the REAL cutover: a branch cut before the cutover promotes one new
// claim, then merges this branch's head (the real converted spec and tools). Each scratch repo holds the real trees:
// its first commit is `git archive` of the branch's base commit (so the merge base is that real tree), the branch
// promotes with the tools in its own tree, and "master" is `git archive HEAD`. Git's three-way merge reads only
// those three trees, so it merges exactly what the real branch would.
// Cases: the branch cut at the pre-landing master (landing 1's tools; found in history, convert/lib.mjs) with its helper configured as USAGE.md says (a clone-relative
// path, so the branch's own copy runs); the same branch with no helper; the same branch with a clone whose helper
// points at the pre-al_6 tools; and a branch cut at the real pre-al_6 commit, running its own old helper.
// Every case: Git stops, or the next check exits non-zero with layout-mixed; the check names the one command
// (merge-manifest --write); that command finishes in format 2 with the branch's claim and every record of HEAD.
// Fails until the cutover commit is on HEAD's history.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { put, read, editRecords, recordsOnDisk, layoutOnDisk, codes, messages } from "./layout/lib.mjs";
import { SPEC, TOOLS, REPO, requireBases, preAl6, recordsAt, archiveInto, scratch, noGit, showAt, canon } from "./convert/lib.mjs";

const CLAIM = "§zz/precut-branch";
const CLAIM_MD = "# §zz/precut-branch — Pre-cutover branch\n\nThe branch's one new note, promoted before it merged the converted master.\n";
const CLAIM_REC = { kind: "note", authority: "accepted", requires: [] };

/** A process env with HOME outside the repo (nothing of the user's git config, no GIT_* leaks). */
function cleanEnv(home) {
  mkdirSync(home, { recursive: true });
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== "SPEC_TEST_LAYOUT")), HOME: home, XDG_CONFIG_HOME: home, TZ: "UTC" };
}
function repo(name) {
  const root = scratch(name), home = scratch(`${name}-home`);
  const env = cleanEnv(home);
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", root, ...a], { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  const ok = (...a) => { const r = git(...a); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}${r.stdout}`); return r.stdout.trim(); };
  const tool = (script, args) => {
    const r = spawnSync(process.execPath, [join(root, TOOLS, script), ...args, "--root", root, "--json"], { encoding: "utf8", env, cwd: root, maxBuffer: 256 * 1024 * 1024 });
    let j; try { j = JSON.parse(r.stdout); } catch { assert.fail(`${script} ${args.join(" ")}: ${r.stdout.slice(0, 600)}${r.stderr.slice(0, 600)}`); }
    return { status: r.status, j };
  };
  return { root, env, git, ok, core: (a) => tool("sova-spec.mjs", a), draft: (a) => tool("sova-spec-draft.mjs", a) };
}
/** Replace the whole worktree with `git archive rev` and commit it. */
function commitTree(R, rev, msg) {
  R.ok("rm", "-rq", "--ignore-unmatch", ".");
  for (const n of spawnSync("ls", ["-A", R.root], { encoding: "utf8" }).stdout.split("\n").filter((n) => n && n !== ".git")) rmSync(join(R.root, n), { recursive: true, force: true });
  archiveInto(rev, R.root);
  R.ok("add", "-A"); R.ok("commit", "-qm", msg);
}
/** USAGE.md's driver lines at a commit, as written there (node + the clone-relative path). */
function driverLines(rev) {
  const usage = showAt(rev, `${SPEC}/USAGE.md`) ?? "";
  const lines = [...usage.matchAll(/git config (merge\.sova-spec-(?:manifest|claims)\.driver) \\\n\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.equal(lines.length, 2, `${rev.slice(0, 12)}: USAGE.md gives both driver lines`);
  for (const [, cmd] of lines) assert.match(cmd, /^node pi-config\/extensions\/spec\/core\/sova-spec-draft\.mjs /, "a clone-relative path: each branch runs its own copy");
  return lines;
}
/** Promote the branch's one new claim with the tools in its own tree, as a chat would, and commit it. */
function promoteBranchClaim(R) {
  const n = R.draft(["new", "precut", "--write"]);
  assert.equal(n.status, 0, JSON.stringify(n.j).slice(0, 600));
  const D = `${SPEC}/drafts/precut/spec`;
  put(R.root, `${D}/claims/zz/precut-branch.md`, CLAIM_MD);
  editRecords(R.root, D, (r) => { r[CLAIM] = CLAIM_REC; });
  const e = R.draft(["evidence", "precut", "--id", CLAIM, "--by", "t", "--verification", "read", "--doc-only", "--write"]);
  assert.equal(e.status, 0, JSON.stringify(e.j).slice(0, 600));
  const p = R.draft(["promote", "precut", "--id", CLAIM, "--write"]);
  assert.equal(p.status, 0, JSON.stringify(p.j).slice(0, 800));
  assert.equal(layoutOnDisk(R.root), 1, "the branch's spec is format 1");
  R.ok("add", "--", SPEC); R.ok("commit", "-qm", "branch: promote one new claim");
}

function scenario(name, { from, driver, al6 }) {
  const R = repo(name);
  R.ok("init", "-q");
  archiveInto(from, R.root);
  R.ok("add", "-A"); R.ok("commit", "-qm", `base ${from.slice(0, 12)}`);
  if (driver === "usage") for (const [key, cmd] of driverLines(from)) R.ok("config", key, cmd.replace(/^node /, `"${process.execPath}" `));
  if (driver === "pre-al6-copy") {
    // a clone whose helper is a copy of the pre-al_6 tools (configured by absolute path, as an older clone might)
    const old = scratch(`${name}-oldtools`);
    archiveInto(al6, old, [TOOLS]);
    for (const [key, cmd] of driverLines(al6)) R.ok("config", key, cmd.replace(/^node pi-config\/extensions\/spec\/core\/sova-spec-draft\.mjs/, `"${process.execPath}" ${join(old, TOOLS, "sova-spec-draft.mjs")}`));
  }
  R.ok("checkout", "-qb", "old");
  promoteBranchClaim(R);
  R.ok("checkout", "-q", "main");
  commitTree(R, REPO_HEAD(), "master: the converted spec (this branch's head)");
  assert.equal(layoutOnDisk(R.root), 2, "master is format 2");
  R.ok("checkout", "-q", "old");
  return R;
}
const REPO_HEAD = () => spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

// [name, base ("pre": the pre-landing master, "al6": the pre-al_6 commit), driver, a helper ran]
const CASES = [
  ["cut at the pre-landing master, landing 1's helper configured per USAGE.md", "pre", "usage", true],
  ["cut at the pre-landing master, no helper configured (Git's line merge)", "pre", "none", false],
  ["cut at the pre-landing master, a clone whose helper is the pre-al_6 copy", "pre", "pre-al6-copy", true],
  ["cut at the pre-al_6 commit, its own old helper configured per its USAGE.md", "al6", "usage", true],
];

describe("a pre-cutover branch merging the converted head is refused, never quietly merged", { skip: noGit }, () => {
  for (const [name, at, driver, helper] of CASES) test(name, (t) => {
    const { cutover, pre } = requireBases();
    const al6 = preAl6(cutover);
    const opts = { from: at === "pre" ? pre : al6, driver, al6 };
    t.diagnostic(`branch base ${opts.from.slice(0, 12)}; pre-al_6 tools ${al6.slice(0, 12)}; cutover ${cutover.slice(0, 12)}`);
    const head = REPO_HEAD();
    const want = recordsAt(head).records;
    const R = scenario(name.replace(/\W+/g, "-").slice(0, 40), opts);
    const merge = R.git("merge", "main", "-m", "merge main");
    const chk = R.core(["check"]);
    const cs = codes(chk.j), mixed = cs.includes("layout-mixed");
    t.diagnostic(`merge exit ${merge.status}; check exit ${chk.status}: ${[...new Set(cs)].join(", ")}`);
    // BRIEF a5: the merge or the next check exits non-zero with the mixed-layout error
    assert.ok(merge.status !== 0 || (chk.status !== 0 && mixed), `merge ${merge.status}: ${merge.stdout}${merge.stderr}\ncheck ${chk.status}: ${JSON.stringify(cs)}`);
    // BRIEF a4: with a helper the cut-down manifest.json makes the helper stop with a clash; without one, Git's line
    // merge conflicts (master dropped the records block). Either way Git itself stops: no quiet merge commit.
    assert.notEqual(merge.status, 0, `Git must stop, not commit the merge: ${merge.stdout}${merge.stderr}`);
    assert.ok(R.ok("diff", "--name-only", "--diff-filter=U").split("\n").includes(`${SPEC}/manifest.json`), "manifest.json is left unmerged");
    assert.notEqual(chk.status, 0, `the half-merged spec must not check clean: ${JSON.stringify(cs)}`);
    if (helper) assert.ok(mixed, `with a helper, the manifest is left as the branch had it beside the record files: layout-mixed, got ${JSON.stringify(cs)}`);
    const msg = messages(chk.j) + JSON.stringify(chk.j.findings ?? []);
    assert.match(msg, /merge-manifest --root \S+ --write/, `the check names the one command: ${msg.slice(0, 600)}`);
    if (!helper) assert.ok(cs.includes("manifest-unreadable") || mixed, `no helper: Git's conflict markers make manifest.json unreadable (or mixed), got ${JSON.stringify(cs)}`);
    // the one command finishes it, in master's layout
    const fin = R.draft(["merge-manifest", "--write"]);
    assert.equal(fin.status, 0, JSON.stringify(fin.j).slice(0, 800));
    assert.equal(layoutOnDisk(R.root), 2, "format 2, the default branch's layout");
    const got = recordsOnDisk(R.root).records;
    assert.equal(canon(got[CLAIM]), canon(CLAIM_REC), "the branch's claim is kept");
    const lost = Object.keys(want).filter((id) => !(id in got)), changed = Object.keys(want).filter((id) => id in got && canon(got[id]) !== canon(want[id]));
    if (at === "pre") {
      assert.deepEqual([lost, changed], [[], []], "every record of the head, as the head has it");
      assert.deepEqual(Object.keys(got).filter((id) => !(id in want)), [CLAIM], "and nothing else");
    } else {
      // an older base: the head's records win wherever only master changed them; nothing of the head is lost
      assert.deepEqual(lost, [], "no record of the head is lost");
      assert.deepEqual(changed, [], "every head record as the head has it (the branch changed no other record)");
    }
    assert.equal(read(R.root, `${SPEC}/claims/zz/precut-branch.md`), CLAIM_MD);
    const after = R.core(["check"]);
    const headCheck = spawnSync(process.execPath, [join(REPO, TOOLS, "sova-spec.mjs"), "check", "--root", REPO, "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    assert.ok(after.status <= Math.max(1, headCheck.status), `check after the finish: ${after.status} (${JSON.stringify([...new Set(codes(after.j))])})`);
    R.ok("add", "-A");
    assert.equal(R.ok("diff", "--name-only", "--diff-filter=U"), "", "nothing left unmerged");
    R.ok("commit", "-qm", "finish the merge");
    assert.equal(R.core(["records"]).j.layout, 2);
  });
});

// Run: node --test .sova/playbooks/merge-round/tests/spec-landing.test.mjs
// Docs made official at landing (al_4; BRIEF a5, a7, a14, a15), driven through the merge round's driver against a
// throwaway repository with the REAL spec tools of this tree (SOVA_ROUND_SPEC_CORE → pi-config/extensions/spec/core):
// a draft's state is read back with the draft tool itself, never from the driver's own words. pnpm is a fake that
// logs, per call, the head it ran at and whether the branch's claim was official in the tree it ran in.
// Nothing here reads or writes ~/.pi or the live tree: HOME is the throwaway root.
//
// Each landing case is paired with the case that differs in one fact, so a driver that never makes docs official
// (today's master) fails the pair instead of passing the "nothing was written" half by doing nothing.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROUND = fileURLToPath(new URL("../scripts/round.mjs", import.meta.url));
const CORE = fileURLToPath(new URL("../../../../pi-config/extensions/spec/core/", import.meta.url));
const DRAFT_TOOL = join(CORE, "sova-spec-draft.mjs");
const OWNER = "0199aaaa-owner";
const ME = "0199bbbb-captain";
/** The trailer the round's docs entry carries (plan al_4: "Sova-Spec-Landing: <round session id>"). */
const TRAILER = "Sova-Spec-Landing";

const root = mkdtempSync(join(tmpdir(), "round-landing-test-"));
const bare = join(root, "origin.git");
const main = join(root, "main");
const agent = join(root, "agent");
const bin = join(root, "bin");
const pnpmLog = join(root, "pnpm.log");
const sova = join(agent, "sova");
const stateFile = join(sova, "playbooks", "merge-round", "state.json");
const boardFile = join(sova, "merge-board.json");
const landingFile = join(sova, "landing.json");
const SETTINGS = { privateNames: [root, basename(root)], kinds: { [root]: "home", [basename(root)]: "home" }, restartUnit: "sova-runtime.service" };

const gitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
const cleanEnv = () => {
  const env = { ...process.env, ...gitEnv };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) delete env[k];
  for (const k of ["SPEC_AGREE_SOURCE", "SPEC_AGREE_GIVEN", "NODE_TEST_CONTEXT"]) delete env[k];
  return env;
};
const baseEnv = () => ({ ...cleanEnv(), PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: agent, PI_SESSION_ID: ME, SOVA_ROUND_PNPM: join(bin, "pnpm"), SOVA_ROUND_SPEC_CORE: CORE, SOVA_ROUND_HEALTH_URL: "http://127.0.0.1:9/api/health", FAKE_PNPM_LOG: pnpmLog, FAKE_PNPM_MODE: "pass", CLAUDE_CONFIG_DIR: join(root, "claude-login") });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (cwd, ...args) => spawnSync("git", args, { cwd, env: cleanEnv(), stdio: "ignore" }).status === 0;
const put = (cwd, rel, text) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), text); };
const commit = (cwd, files, subject) => {
  for (const [rel, text] of Object.entries(files)) put(cwd, rel, text);
  git(cwd, "add", "--", ...Object.keys(files));
  git(cwd, "commit", "-q", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
};
const wt = (name) => join(root, `wt-${name.replace(/\//g, "-")}`);
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const head = (branch) => git(main, "rev-parse", `refs/heads/${branch}`);

/** The draft tool of this tree, in `cwd` → its JSON answer (the process status must equal its exit). */
function draftTool(cwd, ...args) {
  const r = spawnSync(process.execPath, [DRAFT_TOOL, ...args, "--root", cwd, "--json"], { cwd, env: { ...cleanEnv(), HOME: root }, encoding: "utf8" });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`draft tool ${args[0]}: no JSON (status ${r.status}):\n${r.stdout}\n${r.stderr}`); }
  return { ...j, status: r.status };
}
/** One draft's reading by the draft tool: its pending ids, and whether it reads promoted. */
const draftReading = (cwd, name) => {
  const d = draftTool(cwd, "drafts").drafts.find((x) => x.name === name);
  assert.ok(d, `the draft tool lists no draft ${name} in ${cwd}`);
  return { pending: [...d.pending, ...d.conflict], state: d.state };
};

/** Runs round.mjs asynchronously. */
function run(args, { env = {}, cwd = main } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ROUND, ...args], { cwd, env: { ...baseEnv(), ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
    child.stdin.end("");
  });
}
const state = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { branches: {} });
const pnpmCalls = () => (existsSync(pnpmLog) ? readFileSync(pnpmLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Sova's merge board, every row Ready to land at its head with an idle owner (server/merge-board.ts's shape). */
const writeBoard = (branches) => {
  const iso = new Date().toISOString();
  mkdirSync(dirname(boardFile), { recursive: true });
  writeFileSync(boardFile, JSON.stringify({ v: 1, at: iso, read: 10, pending: 0, rows: branches.map((b) => ({ path: wt(b), branch: b, repo: join(main, ".git"), state: "waiting-approval", reason: "Waiting for your OK · reason", landing: { state: "ready", commit: head(b) }, readAt: iso, owner: { id: OWNER, title: `Chat of ${OWNER}`, status: "idle", profile: null, lastActiveAt: iso } })) }));
};
/** The user's Land It on the Landing card, as Sova's server records it (landing.ts recordGoAhead's file shape). */
/** With the drafts as they are at the press (BRIEF a14: `drafts: {hash, names}`), as Sova's Land It click records it. */
const pressLandIt = (branch, commit, extra = {}) => {
  const d = existsSync(landingFile) ? JSON.parse(readFileSync(landingFile, "utf8")) : { v: 1, goAheads: [], notYet: [] };
  const hash = draftsHashOf(wt(branch));
  const drafts = hash ? { drafts: { hash, names: draftNamesOf(wt(branch)) } } : {};
  d.goAheads.push({ branch, commit, session: OWNER, at: new Date().toISOString(), by: "land-it", ...drafts, ...extra });
  mkdirSync(dirname(landingFile), { recursive: true });
  writeFileSync(landingFile, JSON.stringify(d));
};
const group = async (branch) => JSON.parse((await run(["status", "--json"])).out).branches.find((b) => b.branch === branch)?.group;

/** Commits in `range` whose message carries the round's docs-entry trailer. */
const docsEntries = (range) => git(main, "log", "--format=%H", `--grep=^${TRAILER}:`, range).split("\n").filter(Boolean);
/** Paths a commit changes against its first parent. */
const changedBy = (sha) => git(main, "diff", "--name-only", `${sha}^1`, sha).split("\n").filter(Boolean);
const isSpecPath = (p) => p.startsWith(".sova/spec/");
/** The official spec in a worktree's files, as git sees them against a rev: no difference at all → "". */
const specDiff = (cwd, rev) => git(cwd, "diff", "--name-only", rev, "--", ".sova/spec");

// ---------------------------------------------------------------- the project: a small spec, one claim
const MANIFEST = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2) + "\n";
const BASE_CLAIMS = {
  "§a/top": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/top.txt"] },
};
const TOP = "# §a/top\n\nThe top does X.\n";

/**
 * A branch cut from master with one code commit (lib/<slug>.txt) and, for each entry of `drafts`, a spec draft
 * that adds §b/<id> mapping that file, its prose written, and the chat's own verification note recorded
 * (`evidence --note`: no binding, BRIEF a7) unless `note: false`. `edit(spec)` may change the draft's spec dir
 * further. Drafts are gitignored: the worktree stays clean.
 */
const SUFFIX = ["", "-two", "-three"]; // § names take letters and hyphens only
function makeBranch(name, { drafts = [{}], from = "master" } = {}) {
  const slug = name.replace(/^feat\//, "").replace(/[^a-z0-9-]/g, "-");
  git(main, "worktree", "add", "-q", "-b", name, wt(name), from);
  const code = `lib/${slug}.txt`;
  const P = commit(wt(name), { [code]: `${slug} v1\n` }, `${slug}: the feature`);
  const ids = [];
  drafts.forEach((d, i) => {
    const draft = d.name ?? `${slug}${SUFFIX[i]}`;
    const id = d.id ?? `§b/${slug}${SUFFIX[i]}`;
    assert.equal(draftTool(wt(name), "new", draft, "--write").exit, 0, `new ${draft}`);
    const spec = join(wt(name), ".sova/spec/drafts", draft, "spec");
    const m = JSON.parse(readFileSync(join(spec, "manifest.json"), "utf8"));
    if (!d.edit) {
      m.claims[id] = { kind: "behavior", authority: "accepted", requires: [], code: [code] };
      writeFileSync(join(spec, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
      put(spec, `claims/${id.slice(1)}.md`, `# ${id}\n\nThe ${slug} feature does its one thing.\n`);
    } else d.edit(spec, m);
    if (d.note !== false) {
      const ev = draftTool(wt(name), "evidence", draft, "--id", d.noteId ?? id, "--by", OWNER, "--verification", `ran ${slug} by hand: it does its one thing`, "--note", "--write");
      assert.equal(ev.exit, 0, `evidence --note (BRIEF a7: the chat's own verification note, no binding): ${JSON.stringify(ev)}`);
    }
    ids.push({ draft, id });
  });
  assert.equal(git(wt(name), "status", "--porcelain", "--untracked-files=all"), "", "drafts are gitignored: the worktree is clean");
  return { P, code, ids, tree: wt(name) };
}

before(() => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(agent, "sessions", "live"), { recursive: true });
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(join(sova, "merge-round.json"), JSON.stringify(SETTINGS));
  writeFileSync(join(root, "gitconfig"), "[user]\n\tname = Round Test\n\temail = round@test.invalid\n[init]\n\tdefaultBranch = master\n[commit]\n\tgpgsign = false\n");
  // pnpm: logs each call with the head it ran at and whether any §b claim was official in its tree.
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
let head = null;
try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
let official = false;
try { official = fs.readdirSync(".sova/spec/claims/b").some((f) => f.endsWith(".md")); } catch {}
fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ args, cwd: fs.realpathSync(process.cwd()), head, official }) + "\\n");
const mode = process.env.FAKE_PNPM_MODE || "pass";
if (mode === "build-fail" && args[0] === "run" && args[1] === "build") { console.log("build: error TS0000: broken"); process.exit(1); }
if (mode === "typecheck-fail" && args[0] === "run" && args[1] === "typecheck") { console.log("error TS0000"); process.exit(1); }
if (mode === "test-fail" && args[0] === "test") { console.log("✖ server/new-fail.test.ts (3ms)"); process.exit(1); }
if (args[0] === "exec") process.exit(mode === "test-fail" ? 1 : 0);
process.exit(0);
`);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\necho 0\n");
  for (const f of ["pnpm", "systemctl"]) chmodSync(join(bin, f), 0o755);

  execFileSync("git", ["init", "-q", "--bare", "-b", "master", bare], { env: cleanEnv() });
  execFileSync("git", ["init", "-q", "-b", "master", main], { env: cleanEnv() });
  // .sova/spec/.gitignore as Sova's: drafts are local only.
  commit(main, {
    ".sova/spec/.gitignore": "/drafts/\n/reviews/\n",
    ".sova/spec/manifest.json": MANIFEST(BASE_CLAIMS),
    ".sova/spec/claims/a/top.md": TOP,
    "lib/top.txt": "top v1\n",
  }, "base: a spec with one claim");
  git(main, "remote", "add", "origin", bare);
  git(main, "push", "-q", "origin", "master");
  git(main, "fetch", "-q", "origin");
  // The base spec reads clean to the real tools, so any hold below is the landing's, not the fixture's.
  const chk = spawnSync(process.execPath, [join(CORE, "sova-spec.mjs"), "check", "--root", main, "--json"], { env: { ...cleanEnv(), HOME: root }, encoding: "utf8" });
  assert.ok(chk.status <= 1, `the fixture spec checks clean: ${chk.stdout}`);
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Fresh round state, board and answers per test, and master pushed to origin as it is. */
function reset(branches) {
  for (const f of [stateFile, landingFile, pnpmLog]) rmSync(f, { force: true });
  writeBoard(branches);
  git(main, "push", "-q", "-f", "origin", "master");
  git(main, "fetch", "-q", "origin");
}

// ---------------------------------------------------------------- (1) a5: checks first; a failure writes no docs
test("a5: after Land It a failing build hands the branch back unchanged with its drafts still pending; the same branch with a passing build gets its docs", async () => {
  const b = "feat/buildfail";
  const { P, ids, tree } = makeBranch(b);
  reset([b]);
  pressLandIt(b, P);
  assert.equal(await group(b), "check", "Land It at P: the round checks it");

  const failed = await run(["check", b], { env: { FAKE_PNPM_MODE: "build-fail" } });
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /^build: FAILED/m);
  assert.equal(head(b), P, "the branch head is exactly what the user pressed Land It at");
  assert.deepEqual(docsEntries(`master..${b}`), [], "no docs entry");
  assert.equal(git(tree, "status", "--porcelain", "--untracked-files=all"), "", "nothing left in the worktree");
  assert.equal(specDiff(tree, "refs/heads/master"), "", "the official spec in the worktree is master's");
  assert.ok(!existsSync(join(tree, `.sova/spec/claims/${ids[0].id.slice(1)}.md`)), "the claim is not official");
  assert.deepEqual(draftReading(tree, ids[0].draft).pending, [ids[0].id], "the draft tool still reads the record pending");
  const receipts = JSON.parse(readFileSync(join(tree, ".sova/spec/drafts", ids[0].draft, "draft.json"), "utf8")).promotions ?? [];
  assert.deepEqual(receipts, [], "no promotion receipt was written into the draft");
  assert.equal(state().branches[b]?.specLanding, undefined, "no docs entry recorded");

  // The control: one fact differs (the build passes), and the docs become official in one entry on top of P.
  rmSync(pnpmLog, { force: true });
  const passed = await run(["check", b]);
  assert.equal(passed.code, 0, passed.out);
  const D = head(b);
  assert.notEqual(D, P, "the docs entry moved the head");
  assert.equal(git(main, "rev-parse", `${D}^1`), P, "the docs entry sits directly on the checked head");
  assert.equal(git(main, "rev-list", "--count", `${P}..${D}`), "1", "exactly one new commit");
  assert.deepEqual(docsEntries(`master..${b}`), [D], "it carries the trailer");
  assert.ok(changedBy(D).every(isSpecPath), `the docs entry touches only spec paths: ${changedBy(D)}`);
  assert.ok(changedBy(D).includes(`.sova/spec/claims/${ids[0].id.slice(1)}.md`), "and makes the claim official");
  assert.deepEqual(draftReading(tree, ids[0].draft).pending, [], "the draft tool reads it landed");
  // a5: every check ran FIRST, at P, before any docs were official in the tree.
  const calls = pnpmCalls().filter((c) => c.cwd === realpathSync(tree));
  assert.ok(calls.some((c) => c.args[0] === "run" && c.args[1] === "build"), "the build ran");
  assert.deepEqual([...new Set(calls.map((c) => c.head))], [P], "every check ran at P, none at the docs entry");
  assert.ok(calls.every((c) => !c.official), "no check ran with the docs already official");
  const rec = state().branches[b];
  assert.equal(rec?.specLanding?.sha, D, "the round recorded its docs entry");
  assert.equal(rec?.specLanding?.parent, P);
  const land = await run(["land", b]);
  assert.equal(land.code, 0, land.out);
  assert.match(land.out, new RegExp(`^landable at ${D.slice(0, 7)} `, "m"), "it lands at the docs entry, code and docs together");
});

test("a5: a failing test or typecheck after Land It writes no docs either; once they pass, the docs land", async () => {
  for (const mode of ["test-fail", "typecheck-fail"]) {
    const b = `feat/${mode}`;
    const { P, ids, tree } = makeBranch(b);
    reset([b]);
    pressLandIt(b, P);
    const r = await run(["check", b], { env: { FAKE_PNPM_MODE: mode } });
    assert.equal(r.code, 1, r.out);
    assert.equal(head(b), P, mode);
    assert.deepEqual(docsEntries(`master..${b}`), [], mode);
    assert.deepEqual(draftReading(tree, ids[0].draft).pending, [ids[0].id], mode);
    const ok = await run(["check", b]);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(docsEntries(`master..${b}`).length, 1, `${mode}: the control lands its docs`);
  }
});

// ---------------------------------------------------------------- (2) a14: Land It covers the drafts as pressed
test("a14: a draft changed after Land It holds the branch, naming that draft only, and writes nothing; put back as pressed, the same press lands it", async () => {
  const b = "feat/edited";
  const { P, ids, tree } = makeBranch(b, { drafts: [{ name: "kept" }, { name: "rewritten" }] });
  reset([b]);
  const pressed = draftsHashOf(tree);
  pressLandIt(b, P); // records {hash, names} of the drafts as they are now
  assert.equal(JSON.parse(readFileSync(landingFile, "utf8")).goAheads.at(-1).drafts.hash, pressed);

  // The second draft's prose changes after the press: no commit, so the head is still P.
  const changed = ids[1];
  const md = join(tree, ".sova/spec/drafts", changed.draft, "spec/claims", `${changed.id.slice(1)}.md`);
  const was = readFileSync(md, "utf8");
  writeFileSync(md, was.replace("does its one thing", "does two things now"));
  assert.notEqual(draftsHashOf(tree), pressed, "the fixture really changed the drafts' bytes");
  assert.equal(head(b), P);
  const held = await run(["check", b]);
  assert.equal(held.code, 1, held.out);
  const needs = state().branches[b]?.check?.needs ?? [];
  const need = needs.find((n) => n.startsWith("docs changed since Land It: "));
  assert.ok(need, `the need says the docs changed since Land It: ${JSON.stringify(needs)}`);
  assert.ok(need.includes("rewritten"), need);
  assert.deepEqual(need.slice("docs changed since Land It: ".length).split(", "), ["rewritten"], `only the changed draft is named: ${need}`);
  assert.ok(held.out.includes(need), "the round prints it");
  assert.equal(head(b), P, "held: nothing committed");
  assert.deepEqual(docsEntries(`master..${b}`), []);
  assert.equal(specDiff(tree, "refs/heads/master"), "");
  assert.deepEqual(draftReading(tree, changed.draft).pending, [changed.id]);
  assert.notEqual(await group(b), "land", "a held branch doesn't land on the old press");

  // Put the prose back byte for byte: the same press covers it again and the docs land.
  writeFileSync(md, was);
  assert.equal(draftsHashOf(tree), pressed);
  const ok = await run(["check", b]);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(docsEntries(`master..${b}`).length, 1);
});

test("a14: the drafts hash: the core's land, round.mjs and this test's own reading of the definition agree, and it moves with any byte under a draft's spec/, never with draft.json", async () => {
  const b = "feat/hashed";
  const { P, ids, tree } = makeBranch(b, { drafts: [{ name: "one" }, { name: "two" }] });
  const mine = draftsHashOf(tree);
  assert.match(mine, /^[0-9a-f]{64}$/);
  const preview = draftTool(tree, "land", "--commit", P, "--by", "land-it", "--verification", "hash test");
  assert.equal(preview.exit, 0, JSON.stringify(preview));
  assert.equal(preview.written, false);
  assert.equal(preview.draftsHash, mine, "the core's land reads the same hash");
  const round = await import(ROUND);
  assert.equal(typeof round.draftsHashOf, "function", "round.mjs exports draftsHashOf");
  const roundHash = (t) => round.draftsHashOf(t)?.hash ?? null;
  assert.deepEqual(round.draftsHashOf(tree), { hash: mine, names: ["one", "two"] }, "round.mjs reads the same hash and names");
  // draft.json (evidence, notes) is not in it.
  const ev = draftTool(tree, "evidence", ids[0].draft, "--id", ids[0].id, "--by", OWNER, "--verification", "again", "--note", "--write");
  assert.equal(ev.exit, 0, JSON.stringify(ev));
  assert.equal(draftsHashOf(tree), mine);
  assert.equal(roundHash(tree), mine);
  // One byte in a draft's spec/ moves it; so does a draft's name.
  const md = join(tree, ".sova/spec/drafts/two/spec/claims", `${ids[1].id.slice(1)}.md`);
  writeFileSync(md, readFileSync(md, "utf8") + " ");
  assert.notEqual(roundHash(tree), mine);
  assert.equal(roundHash(tree), draftsHashOf(tree));
  assert.equal(round.draftsHashOf(main), null, "a tree with no drafts: null");
});

// ---------------------------------------------------------------- (3) a15: the carry walk
test("a15: Land It carries across the round's own recorded docs entry, and never across a hand-made spec-only commit, trailer or not", async () => {
  const b = "feat/carrydocs";
  const { P, tree } = makeBranch(b);
  const h = makeBranch("feat/handmade");
  reset([b, "feat/handmade"]);
  pressLandIt(b, P);
  const c = await run(["check", b]);
  assert.equal(c.code, 0, c.out);
  const D = head(b);
  assert.deepEqual(docsEntries(`master..${b}`), [D]);
  const recorded = (JSON.parse(readFileSync(landingFile, "utf8")).docsEntries ?? []).filter((e) => e.branch === b);
  assert.deepEqual(recorded.map((e) => [e.sha, e.parent]), [[D, P]], "landing.json records the round's own entry and its parent");
  assert.equal(await group(b), "land", "the press at P counts at the docs entry D");
  const land = await run(["land", b]);
  assert.equal(land.code, 0, land.out);
  assert.match(land.out, new RegExp(`^The user's Land It at ${P.slice(0, 7)}\\.$`, "m"));

  // A chat's own spec-only commit, its message copied from the round's entry, trailer included: not the recorded sha.
  pressLandIt("feat/handmade", h.P);
  assert.equal(await group("feat/handmade"), "check", "the control: the press counts at its own head");
  const msg = git(main, "log", "-1", "--format=%B", D);
  put(h.tree, ".sova/spec/claims/a/top.md", TOP + "\nPromoted by hand.\n");
  git(h.tree, "add", "--", ".sova/spec/claims/a/top.md");
  git(h.tree, "commit", "-q", "-m", msg);
  const H = head("feat/handmade");
  assert.ok(changedBy(H).every(isSpecPath), "spec paths only, as the round's entry");
  assert.deepEqual(docsEntries(`master..feat/handmade`), [H], "it carries the same trailer");
  writeBoard([b, "feat/handmade"]); // Ready to land at H on the board: only the carry decides
  const g = await group("feat/handmade");
  assert.ok(g !== "check" && g !== "land", `a hand-made spec commit needs a new press (group ${g})`);
  const line = (await run(["status"])).out.split("\n").find((l) => l.startsWith("feat/handmade:")) ?? "";
  assert.doesNotMatch(line, /go-ahead \(Land It\)/, line);

  // The round's own entry, rewritten after it was recorded (amended, same trailer), isn't the recorded sha either.
  git(tree, "commit", "-q", "--amend", "-m", `${msg}\n\nAmended by hand.`);
  assert.notEqual(head(b), D);
  assert.equal(docsEntries(`master..${b}`).length, 1, "still one commit with the trailer");
  writeBoard([b, "feat/handmade"]);
  const ga = await group(b);
  assert.ok(ga !== "check" && ga !== "land", `an amended docs entry needs a new press (group ${ga})`);
});

// ---------------------------------------------------------------- (4) a7: a record needs the chat's verification note
test("a7: a record without the chat's verification note holds the branch and nothing is written; with the note it lands", async () => {
  const b = "feat/nonote";
  const { P, ids, tree } = makeBranch(b, { drafts: [{}, { note: false }] });
  reset([b]);
  pressLandIt(b, P);
  const r = await run(["check", b]);
  assert.equal(r.code, 1, r.out);
  const need = (state().branches[b]?.check?.needs ?? []).find((n) => n.startsWith("docs don't fit:"));
  assert.ok(need?.includes(ids[1].id), `the need names the record with no verification note: ${need}`);
  assert.ok(!need.includes(ids[0].id), `and not the noted one: ${need}`);
  assert.match(r.out, /verif/i, "the round says what it lacks");
  assert.equal(head(b), P);
  assert.deepEqual(docsEntries(`master..${b}`), [], "all or nothing: the noted draft doesn't land alone");
  assert.deepEqual(draftReading(tree, ids[0].draft).pending, [ids[0].id]);
  assert.deepEqual(draftReading(tree, ids[1].draft).pending, [ids[1].id]);

  const ev = draftTool(tree, "evidence", ids[1].draft, "--id", ids[1].id, "--by", OWNER, "--verification", "checked it by hand", "--note", "--write");
  assert.equal(ev.exit, 0, JSON.stringify(ev));
  const ok = await run(["check", b]);
  assert.equal(ok.code, 0, ok.out);
  const D = head(b);
  assert.deepEqual(docsEntries(`master..${b}`), [D]);
  // a7: the landing adds the landed commit, who pressed Land It and the checks that passed, beside the chat's note.
  for (const { draft, id } of ids) {
    const evidence = JSON.parse(readFileSync(join(tree, ".sova/spec/drafts", draft, "draft.json"), "utf8")).evidence;
    const mine = evidence.filter((e) => e.ids.some((x) => x.id === id));
    assert.ok(mine.some((e) => e.mode === "note"), `${id}: the chat's own note is kept`);
    const landing = mine.at(-1);
    assert.equal(landing.mode, "commit", `${id}: the landing binds it at the checked head`);
    assert.equal(landing.landing, true);
    assert.equal(landing.commit, P, `${id}: at the landed commit`);
    assert.match(landing.verification, /Land It/, "who gave the go-ahead");
    assert.match(landing.verification, /\bbuild\b/, "the checks that passed");
    assert.doesNotMatch(landing.verification, /FAILED|test:int/, "only the checks that passed (test:int was skipped here)");
  }
  const body = git(main, "log", "-1", "--format=%B", D);
  assert.ok(body.includes(P.slice(0, 7)), `the entry names the landed commit:\n${body}`);
});

test("a7: the draft tool's land refuses a record with no verification note, writing nothing", () => {
  const b = "feat/landnote";
  const { P, ids, tree } = makeBranch(b, { drafts: [{ note: false }] });
  const before = specDiff(tree, "HEAD");
  const r = draftTool(tree, "land", "--commit", P, "--by", "land-it", "--verification", "round test", "--write");
  assert.equal(r.exit, 1, JSON.stringify(r));
  assert.equal(r.status, 1);
  const f = (r.findings ?? []).find((x) => x.id === ids[0].id);
  assert.ok(f, `a finding names ${ids[0].id}: ${JSON.stringify(r.findings)}`);
  assert.equal(f.draft, ids[0].draft);
  assert.equal(f.code, "verification-missing");
  assert.equal(specDiff(tree, "HEAD"), before, "nothing written");
  assert.ok(!existsSync(join(tree, ".sova/spec/drafts/.land")), "no landing snapshot left");
  assert.deepEqual(draftReading(tree, ids[0].draft).pending, [ids[0].id]);
});

// ---------------------------------------------------------------- (5) q1: a clash with docs landed meanwhile
test("q1: docs that landed on master meanwhile clash with the branch's draft: held, sent back with the clashing record, nothing written; a branch whose draft doesn't touch it lands", async () => {
  const b = "feat/clash";
  const other = "feat/noclash";
  // Both drafts rewrite §a/top's prose; feat/noclash adds only its own claim.
  const rewrite = (text) => (spec) => put(spec, "claims/a/top.md", `# §a/top\n\n${text}\n`);
  const { ids, tree } = makeBranch(b, { drafts: [{ id: "§a/top", noteId: "§a/top", edit: rewrite("The top does X, and Y on the branch.") }] });
  const ok = makeBranch(other);
  // Meanwhile another landing makes §a/top say something else on master.
  const masterBefore = git(main, "rev-parse", "master");
  commit(main, { ".sova/spec/claims/a/top.md": "# §a/top\n\nThe top does X, and Z since another landing.\n" }, `docs landed: §a/top\n\n${TRAILER}: another-round`);
  reset([b, other]);
  pressLandIt(b, head(b));
  pressLandIt(other, ok.P);
  await group(b); // the round reads the board: the owner is known
  try {
    const r = await run(["check", b]);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes("§a/top"), `the clashing record is named:\n${r.out}`);
    assert.ok(r.out.includes(`session_send to ${OWNER}`), `sent back to its chat:\n${r.out}`);
    assert.ok(r.out.includes(ids[0].draft), "the hand-back names the draft to fix");
    assert.deepEqual(docsEntries(`master..${b}`), [], "no docs entry");
    assert.equal(specDiff(tree, "refs/heads/master"), "", "the spec in the worktree is master's, nothing of the draft");
    assert.equal(git(tree, "status", "--porcelain", "--untracked-files=all"), "");
    for (const left of [".sova/spec/.txn", ".sova/spec/drafts/.land", ".sova/spec/drafts/.lock"]) assert.ok(!existsSync(join(tree, left)), `no ${left} left`);
    assert.notDeepEqual(draftReading(tree, ids[0].draft).pending, [], "the draft still waits");
    const rec = state().branches[b];
    assert.equal(rec?.check?.ok, false);
    assert.ok(rec.check.needs.some((n) => n.startsWith("docs don't fit:") && n.includes("§a/top")), `the need names it: ${rec.check.needs}`);
    assert.equal(rec?.specLanding, undefined);
    assert.notEqual(await group(b), "land");

    // The control: master moved the same way, the other branch's docs fit, and it lands.
    const c = await run(["check", other]);
    assert.equal(c.code, 0, c.out);
    assert.equal(docsEntries(`master..${other}`).length, 1);
  } finally {
    git(main, "update-ref", "refs/heads/master", masterBefore);
    git(main, "reset", "-q", "--hard", masterBefore);
  }
});

// ---------------------------------------------------------------- (6) q2: one docs entry per landing
test("q2: one automatic docs entry per landing, two drafts and a master merge included; checking again adds none; the landing merge brings code and docs together", async () => {
  const b = "feat/twodrafts";
  const { P, code, ids, tree } = makeBranch(b, { drafts: [{}, {}] });
  // Master moves on, so the check merges it in first.
  const masterBefore = git(main, "rev-parse", "master");
  commit(main, { "lib/elsewhere.txt": "elsewhere\n" }, "master: unrelated work");
  reset([b]);
  pressLandIt(b, P);
  try {
    const c = await run(["check", b]);
    assert.equal(c.code, 0, c.out);
    const entries = docsEntries(`master..${b}`);
    assert.equal(entries.length, 1, `one docs entry for two drafts: ${entries}`);
    const [D] = entries;
    assert.equal(D, head(b), "the entry is the head the round lands");
    for (const { id } of ids) assert.ok(changedBy(D).includes(`.sova/spec/claims/${id.slice(1)}.md`), `${id} is in the one entry`);
    assert.ok(changedBy(D).every(isSpecPath));
    assert.ok(gitOk(main, "merge-base", "--is-ancestor", "refs/heads/master", D), "master was merged in before the entry");

    const again = await run(["check", b]);
    assert.equal(again.code, 0, again.out);
    assert.equal(head(b), D, "checking again makes no second entry");
    assert.equal(docsEntries(`master..${b}`).length, 1);

    // What the worktree tool's merge does where master is checked out: one merge, code and docs in it.
    const m0 = git(main, "rev-parse", "master");
    git(main, "merge", "--no-edit", "-q", b);
    const landedFiles = git(main, "diff", "--name-only", m0, "master").split("\n");
    assert.ok(landedFiles.includes(code), "the code landed");
    for (const { id } of ids) assert.ok(landedFiles.includes(`.sova/spec/claims/${id.slice(1)}.md`), `${id} landed in the same merge`);
    assert.deepEqual(docsEntries(`${m0}..master`), [D], "one docs entry in what landed");
    const chk = spawnSync(process.execPath, [join(CORE, "sova-spec.mjs"), "check", "--root", main, "--json"], { env: { ...cleanEnv(), HOME: root }, encoding: "utf8" });
    assert.ok(chk.status <= 1, `the landed spec checks: ${chk.stdout}`);
  } finally {
    git(main, "update-ref", "refs/heads/master", masterBefore);
    git(main, "reset", "-q", "--hard", masterBefore);
  }
});

test("q2: Merge Without Specs… lands no docs entry and leaves the drafts pending", async () => {
  const b = "feat/without";
  const { P, ids, tree } = makeBranch(b);
  reset([b]);
  pressLandIt(b, P, { withoutSpecs: true });
  const c = await run(["check", b]);
  assert.equal(c.code, 0, c.out);
  assert.equal(head(b), P);
  assert.deepEqual(docsEntries(`master..${b}`), []);
  assert.deepEqual(draftReading(tree, ids[0].draft).pending, [ids[0].id]);
  // The control: a later plain Land It at the same head lands the docs.
  await new Promise((done) => setTimeout(done, 5));
  pressLandIt(b, P);
  const plain = await run(["check", b]);
  assert.equal(plain.code, 0, plain.out);
  assert.equal(docsEntries(`master..${b}`).length, 1, "a plain Land It lands them");
});

// ---------------------------------------------------------------- the drafts hash, read from its definition
/** Draft names under a worktree's drafts dir (dot-dirs skipped), code-point sorted. */
function draftNamesOf(tree) {
  const dir = join(tree, ".sova/spec/drafts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort(byCodePoint);
}
/**
 * The drafts hash as al_4's design defines it, written here a second time on purpose: sha256 hex over the sorted lines
 * `<draft name>/<path under spec/> <sha256 hex of the bytes>`, one per file under every draft's spec/, joined by "\n";
 * null with no draft. A test comparing the tools with this can't pass by the tools agreeing with themselves.
 */
function draftsHashOf(tree) {
  const names = draftNamesOf(tree);
  if (!names.length) return null;
  const lines = [];
  for (const name of names) {
    const spec = join(tree, ".sova/spec/drafts", name, "spec");
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else lines.push(`${name}/${r} ${createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex")}`);
      }
    };
    if (existsSync(spec)) walk(spec, "");
  }
  return createHash("sha256").update(lines.sort(byCodePoint).join("\n")).digest("hex");
}

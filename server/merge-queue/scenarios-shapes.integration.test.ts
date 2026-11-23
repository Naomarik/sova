import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { resolution, settled, setup, STATE } from "./testing/scenario-kit";
import { Fixture, git } from "./testing/repo";
import { type HarnessOptions, type QueueHarness, startHarness } from "./testing/harness";
import type { MergeEntry } from "../../shared/merge-queue";

/**
 * The merge queue on projects of other shapes (team brief, step 8): each sample project driven through a real landing,
 * a failure the branch caused and a conflict the stand-in merge thread resolves, on the real queue and the real run
 * (testing/harness.ts), in a throwaway repository: a Python project whose runner writes JUnit XML, a multi-package
 * repository with a check per package folder (TAP and JUnit) and a folder rule, one with a submodule, one with Git LFS
 * files, one with no remote, one whose remote refuses pushes to its main branch, one whose remote isn't named origin,
 * a simple project (one typecheck and a push), and that simple project landing each branch as one commit.
 */

/** A branch's files: text (null deletes), or `gitlink(sha)` to point a submodule at a commit. */
type Files = Record<string, string | null>;

/** A Fixture prepared by `prep` (a submodule, LFS) before the queue starts on it: the queue starts on what it sees. */
const mine: { fx: Fixture; h?: QueueHarness }[] = [];
after(async () => {
  for (const m of mine) {
    await m.h?.stop().catch(() => {});
    m.fx.dispose();
  }
});
async function setupWith(fo: ConstructorParameters<typeof Fixture>[0], ho: HarnessOptions, prep: (fx: Fixture) => void): Promise<{ fx: Fixture; h: QueueHarness }> {
  const fx = new Fixture(fo);
  const slot: { fx: Fixture; h?: QueueHarness } = { fx };
  mine.push(slot);
  prep(fx);
  slot.h = await startHarness(fx, STATE, ho);
  return { fx, h: slot.h };
}

/** `feat/<name>` in its own worktree with one commit of `files`, a gitlink value setting a submodule's commit. */
function branchOf(fx: Fixture, name: string, files: Files): { branch: string; checkout: string; commit: string } {
  if (!Object.values(files).some((v) => v?.startsWith(GITLINK))) return fx.branch(name, files);
  const branch = `feat/${name}`;
  const checkout = fx.worktreeOf(name);
  git(fx.project, ["worktree", "add", "-q", "-b", branch, checkout, fx.target]);
  for (const [rel, v] of Object.entries(files)) {
    if (v?.startsWith(GITLINK)) git(checkout, ["update-index", "--cacheinfo", `160000,${v.slice(GITLINK.length)},${rel}`]);
    else if (v === null) git(checkout, ["rm", "-q", rel]);
    else {
      writeFileSync(join(checkout, rel), v);
      git(checkout, ["add", rel]);
    }
  }
  git(checkout, ["commit", "-q", "-m", `${name}: change`]);
  return { branch, checkout, commit: git(checkout, ["rev-parse", "HEAD"]) };
}

/** A definition with one placeholder service (the parser wants one) and `merge`. */
const def = (merge: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, slots: { cap: 4 }, services: { svc: { cmd: ["node", "svc.mjs"], start: "on-demand", ports: { tcp: { base: 39_100 } }, ready: { tcp: "tcp", timeout: 10 } } }, ...extra, merge: { target: "main", ...merge } }, null, 2) + "\n";
const IGNORE = ".setup-done\n.sova/spec/drafts/\nnode_modules/\n.agent/\n__pycache__/\nreports/\n";

/**
 * The three cases every shape goes through, in order, each settled as the queue promises: a change lands (pushed as
 * `push` says); a change the branch broke goes back to its chat, the target unmoved; two branches editing one file:
 * the second conflicts, the thread resolves it keeping both, and it lands. → the entries, for more asserts.
 */
async function prove(fx: Fixture, h: QueueHarness, o: { ok: Files; red: Files; redWhy: RegExp; conflict: { file: string; a: string; b: string }; push: "pushed" | "no-remote" | "not-pushed" }): Promise<{ ok: MergeEntry; red: MergeEntry; conflict: MergeEntry }> {
  const ok = branchOf(fx, "ok", o.ok);
  const e1 = await h.add({ branch: ok.branch });
  const l1 = await waitSaying(h, e1.id);
  assert.equal(l1.state, "landed", `landing: ${l1.state}: ${l1.reason}`);
  assert.equal(fx.head("main"), l1.landed!.sha, "main moved to the tested commit");
  assert.equal(l1.landed!.pushed, o.push, `push: ${l1.landed!.pushed} ${l1.landed!.pushWhy ?? ""}`);

  const before = fx.head("main");
  const red = branchOf(fx, "red", o.red);
  const e2 = await h.add({ branch: red.branch });
  const l2 = await waitSaying(h, e2.id);
  assert.equal(l2.state, "with-chat", `failure: ${l2.state}: ${l2.reason}`);
  assert.match(l2.reason ?? "", o.redWhy);
  assert.equal(fx.head("main"), before, "main unmoved by the red branch");

  const a = fx.branch("ca", { [o.conflict.file]: o.conflict.a });
  const b = fx.branch("cb", { [o.conflict.file]: o.conflict.b });
  const ea = await h.add({ branch: a.branch });
  await h.pause("b waits for a to land");
  const eb = await h.add({ branch: b.branch });
  const la = await waitSaying(h, ea.id);
  assert.equal(la.state, "landed", `conflict's first: ${la.state}: ${la.reason}`);
  await h.resume();
  const lb = await waitSaying(h, eb.id);
  assert.equal(lb.state, "landed", `conflict resolved: ${lb.state}: ${lb.reason}`);
  assert.equal(fx.fileAt(fx.head("main"), o.conflict.file), both(o.conflict));
  return { ok: l1, red: l2, conflict: lb };
}

/** The entry once settled; a wait that runs out says where it stood (state, reason, the run's steps). */
async function waitSaying(h: QueueHarness, id: string): Promise<MergeEntry> {
  return h.waitEntry(id, settled, 25_000).catch(async (err) => {
    const e = await h.entry(id);
    throw new Error(`${err}: ${e.state} ${e.reason ?? ""} ${e.run ? JSON.stringify(h.run(e.run).steps.map((s) => [s.id, s.result, s.detail])) : ""}`);
  });
}

/** What the stand-in thread keeps of two conflicting edits: a's lines, then b's last line. */
const both = (c: { a: string; b: string }) => `${c.a}${c.b.split("\n").filter(Boolean).pop()}\n`;
/** The stand-in merge thread: every conflict resolved as `both` (a no-behaviour-change judgement). */
const thread = (c: { file: string; a: string; b: string }) => ({
  conflict: async (h: QueueHarness, e: MergeEntry) => {
    const commit = resolution(h.fx, e.commit, c.file, both(c));
    await h.resolve(e.id, { verdict: "no-behaviour-change", files: [c.file], ours: "main adds a line", theirs: "the branch adds a line", proposal: "keep both", commit });
  },
});
const LINES = (x: string) => `one\ntwo\n${x}\n`;
const CONFLICT = (file: string) => ({ file, a: LINES("three-a"), b: LINES("three-b") });

/** The checks a step ran, by id, in the entry's last run. */
const stepsOf = (h: QueueHarness, e: MergeEntry) => h.run(e.run!).steps;

// ---------------------------------------------------------------- the sample projects

const PY_RUNNER = `import sys, os, glob, importlib.util
from xml.sax.saxutils import quoteattr
args = sys.argv[1:]
names, files, i = [], [], 0
while i < len(args):
    if args[i] == "-k":
        names.append(args[i + 1]); i += 2
    else:
        files.append(args[i]); i += 1
sys.path.insert(0, os.getcwd())
cases = []
for f in (files or sorted(glob.glob("tests/test_*.py"))):
    mod = f[:-3].replace("/", ".")
    spec = importlib.util.spec_from_file_location(mod, f)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    for n in sorted(dir(m)):
        if not n.startswith("test_") or (names and n not in names):
            continue
        try:
            getattr(m, n)()
            cases.append((mod, n, None))
        except Exception as e:
            cases.append((mod, n, repr(e)))
os.makedirs("reports", exist_ok=True)
with open("reports/junit.xml", "w") as out:
    out.write('<testsuites><testsuite name="py">')
    for cls, n, err in cases:
        out.write("<testcase classname=%s name=%s>" % (quoteattr(cls), quoteattr(n)))
        if err:
            out.write("<failure message=%s/>" % quoteattr(err))
        out.write("</testcase>")
    out.write("</testsuite></testsuites>")
bad = [c for c in cases if c[2]]
print("ran %s: %d passed, %d failed" % (" ".join(args) or "all", len(cases) - len(bad), len(bad)))
sys.exit(1 if bad else 0)
`;

/** A tiny node "typecheck": fails naming the file when a .ts file under src/ holds "TYPE ERROR". */
const TYPECHECK = `import { readdirSync, readFileSync } from "node:fs";
const bad = readdirSync("src").filter((f) => f.endsWith(".ts") && readFileSync("src/" + f, "utf8").includes("TYPE ERROR"));
for (const f of bad) console.error("src/" + f + "(1,1): error TS2322: TYPE ERROR");
process.exit(bad.length ? 2 : 0);
`;
const SIMPLE = { "src/app.ts": "export const x = 1;\n", "typecheck.mjs": TYPECHECK, ".gitignore": IGNORE };
const SIMPLE_DEF = (merge: Record<string, unknown> = {}) => def({ checks: [{ id: "typecheck", label: "Typecheck", run: ["node", "typecheck.mjs"] }], ...merge });

describe("sample projects", () => {
  test("a Python project whose runner writes JUnit XML in its own folder: lands, a broken test is the branch's by name, a conflict resolves", async () => {
    if (spawnSync("python3", ["--version"]).status !== 0) return void console.log("skipped: no python3 here");
    const files = {
      ".gitignore": IGNORE,
      ".sova/project.json": def({ checks: [{ id: "pytest", label: "Python tests", run: ["python3", "run_tests.py"], cwd: "py", env: { PYTHONDONTWRITEBYTECODE: "1" }, report: { junit: "reports/junit.xml" }, rerun: true, rerunTest: ["-k", "${test}"] }] }),
      "py/calc.py": "def add(a, b):\n    return a + b\n",
      "py/run_tests.py": PY_RUNNER,
      "py/tests/test_calc.py": "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n\ndef test_zero():\n    assert add(0, 0) == 0\n",
    };
    const c = CONFLICT("py/NOTES.txt");
    const { fx, h } = await setup({ target: "main", files }, { thread: thread(c) });
    const r = await prove(fx, h, { ok: { "py/README.md": "calc\n" }, red: { "py/calc.py": "def add(a, b):\n    return a - b\n" }, redWhy: /test_calc|test_add/, conflict: c, push: "pushed" });
    // The failure was read from the JUnit report: the failing test and its file, from the repository's root.
    const st = stepsOf(h, r.red).find((s) => s.id === "check:pytest")!;
    assert.equal(st.result, "failed");
    assert.deepEqual(st.counts, { passed: 1, failed: 1, skipped: 0 });
    assert.ok(st.failures?.some((f) => f.file === "py/tests/test_calc.py" && /test_add/.test(f.name ?? "")), JSON.stringify(st.failures));
    assert.match(h.log(r.red.run!, st.id), /\[in py\/\]/, "the log says the folder it ran in");
  });

  test("a multi-package repository: each package's check in its folder (TAP, JUnit), a folder rule adds the web check only when web changes", async () => {
    const TAP = `const bad = (await import("node:fs")).readFileSync("lib.mjs", "utf8").includes("BROKEN");
console.log("TAP version 13\\n" + (bad ? "not ok 1 - test/lib.test.mjs" : "ok 1 - test/lib.test.mjs") + "\\n1..1");
process.exit(bad ? 1 : 0);
`;
    const JUNIT = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const bad = readFileSync("page.html", "utf8").includes("BROKEN");
mkdirSync("reports", { recursive: true });
writeFileSync("reports/web.xml", '<testsuite file="test/page.test.js"><testcase name="renders"' + (bad ? '><failure message="no title"/></testcase>' : "/>") + "</testsuite>");
process.exit(bad ? 1 : 0);
`;
    const files = {
      ".gitignore": IGNORE,
      ".sova/project.json": def({
        checks: [
          { id: "api", label: "API tests", run: ["node", "run.mjs"], cwd: "packages/api", rerun: true },
          { id: "web", label: "Web tests", run: ["node", "run.mjs"], cwd: "packages/web", report: { junit: "reports" }, optional: true },
        ],
        rules: [{ paths: ["packages/web/**"], check: "web", why: "the web package changed" }],
      }),
      "packages/api/run.mjs": TAP,
      "packages/api/lib.mjs": "export const ok = 1;\n",
      "packages/api/test/lib.test.mjs": "// stands in for the package's tests\n",
      "packages/web/run.mjs": JUNIT,
      "packages/web/page.html": "<title>web</title>\n",
    };
    const c = CONFLICT("packages/api/NOTES.txt");
    const { fx, h } = await setup({ target: "main", files }, { thread: thread(c) });
    const r = await prove(fx, h, { ok: { "packages/web/page.html": "<title>web 2</title>\n" }, red: { "packages/api/lib.mjs": "export const ok = 'BROKEN';\n" }, redWhy: /packages\/api\/test\/lib\.test\.mjs/, conflict: c, push: "pushed" });
    const ok = stepsOf(h, r.ok).map((s) => s.id);
    assert.ok(ok.includes("check:web"), `web changed: its check ran (${ok.join(", ")})`);
    const red = stepsOf(h, r.red);
    assert.ok(!red.some((s) => s.id === "check:web"), "only api changed: no web check");
    assert.ok(red.find((s) => s.id === "check:api")?.failures?.some((f) => f.file === "packages/api/test/lib.test.mjs"), "TAP named the failing file from the root");
  });

  test("a project with a submodule: the merge copy checks it out at the merged tree's commit each run; a bump lands, a bad bump is the branch's", async () => {
    const c = CONFLICT("NOTES.txt");
    const { fx, h, lib } = await withSubmodule(thread(c));
    const good = libCommit(lib, "value 2\n");
    const bad = libCommit(lib, "fail\n");
    const r = await prove(fx, h, { ok: { lib: gitlink(good) }, red: { lib: gitlink(bad) }, redWhy: /exit 1|Lib check|lib/i, conflict: c, push: "pushed" });
    const steps = stepsOf(h, r.ok);
    assert.equal(steps.find((s) => s.id === "submodules")?.result, "passed", JSON.stringify(steps.map((s) => [s.id, s.result])));
    assert.match(h.log(r.ok.run!, "check:lib"), /lib says: value 2/, "the check read the submodule at the bumped commit");
    // The main checkout's submodule follows each landing (never left behind as an uncommitted change).
    assert.equal(readFileSync(join(fx.project, "lib", "value.txt"), "utf8"), "value 2\n");
    assert.equal(git(fx.project, ["status", "--porcelain", "--untracked-files=no"]), "");
  });

  test("a project with Git LFS files: fetched and checked in full each run; a file still a pointer stops the run as the machine's, never the branch's", async () => {
    if (spawnSync("git", ["lfs", "version"]).status !== 0) return void console.log("skipped: no git-lfs here");
    const files = {
      ".gitignore": IGNORE,
      ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      ".sova/project.json": def({ checks: [{ id: "data", label: "Data check", run: ["node", "check-data.mjs"] }] }),
      "check-data.mjs": `const t = (await import("node:fs")).readFileSync("data.bin", "utf8");\nif (t.startsWith("version https://git-lfs")) { console.error("data.bin is a pointer"); process.exit(3); }\nconsole.log("data: " + t.trim()); process.exit(t.includes("bad") ? 1 : 0);\n`,
    };
    const c = CONFLICT("NOTES.txt");
    const { fx, h } = await setupWith({ target: "main", files }, { thread: thread(c) }, (fx) => {
      git(fx.project, ["lfs", "install", "--local", "--skip-repo"]);
      writeFileSync(join(fx.project, "data.bin"), "seed data\n");
      git(fx.project, ["add", "data.bin"]);
      git(fx.project, ["commit", "-q", "-m", "data"]);
      assert.match(git(fx.project, ["show", "HEAD:data.bin"]), /^version https:\/\/git-lfs/, "the control: stored as an LFS pointer");
      git(fx.project, ["push", "-q", "origin", "main"]);
    });
    const r = await prove(fx, h, { ok: { "data.bin": "more data\n" }, red: { "data.bin": "bad data\n" }, redWhy: /Data check|exit 1/, conflict: c, push: "pushed" });
    assert.equal(stepsOf(h, r.ok).find((s) => s.id === "lfs")?.result, "passed");
    assert.match(h.log(r.ok.run!, "check:data"), /data: more data/, "the check read the file in full, never its pointer");
    // An object nowhere to be fetched (a pointer whose file was never stored anywhere): the file stays a pointer, and
    // the run says so as the machine's.
    const gone = fx.branch("gone", { "README.md": "gone\n" });
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"ab".repeat(32)}\nsize 12\n`;
    writeFileSync(join(fx.root, "pointer.txt"), pointer);
    writeFileSync(join(gone.checkout, "data.bin"), pointer);
    const blob = git(gone.checkout, ["hash-object", "-w", "--no-filters", join(fx.root, "pointer.txt")]);
    git(gone.checkout, ["update-index", "--cacheinfo", `100644,${blob},data.bin`]);
    git(gone.checkout, ["commit", "-q", "-m", "gone: a file nowhere to fetch"]);
    const e = await h.add({ branch: gone.branch });
    const s = await h.waitEntry(e.id, (x) => !!x.run && h.run(x.run).steps.some((st) => st.id === "lfs" && st.result === "failed"), 25_000);
    assert.notEqual(s.state, "with-chat", `never the branch's: ${s.state}: ${s.reason}`);
    assert.notEqual(s.state, "landed");
    assert.match(s.reason ?? "", /LFS files couldn't be fetched|still a pointer/);
    assert.ok(!h.notices.some((n) => n.branch === gone.branch && n.kind === "needs-fix"), "its chat is never told to fix it");
  });

  test("a project with no remote: lands locally and never pushes", async () => {
    const c = CONFLICT("NOTES.txt");
    const { fx, h } = await setup({ target: "main", remote: false, files: { ...SIMPLE, ".sova/project.json": SIMPLE_DEF() } }, { thread: thread(c) });
    const r = await prove(fx, h, { ok: { "src/app.ts": "export const x = 2;\n" }, red: { "src/app.ts": "export const x: number = 'TYPE ERROR';\n" }, redWhy: /Typecheck/, conflict: c, push: "no-remote" });
    assert.match(r.ok.landed?.pushWhy ?? "", /no remote named origin/);
  });

  test("a project whose remote refuses pushes to main (a protected branch): lands locally, the push is held with the remote's refusal", async () => {
    const c = CONFLICT("NOTES.txt");
    const { fx, h } = await setup({ target: "main", files: { ...SIMPLE, ".sova/project.json": SIMPLE_DEF() } }, { thread: thread(c) });
    const hook = join(fx.origin, "hooks", "pre-receive");
    mkdirSync(join(fx.origin, "hooks"), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = await prove(fx, h, { ok: { "src/app.ts": "export const x = 2;\n" }, red: { "src/app.ts": "export const x: number = 'TYPE ERROR';\n" }, redWhy: /Typecheck/, conflict: c, push: "not-pushed" });
    assert.match(r.ok.landed?.pushWhy ?? "", /refused the push.*Protected branch/);
  });

  test("a project whose remote isn't named origin (merge.remote): fetched from and pushed to by its name", async () => {
    const c = CONFLICT("NOTES.txt");
    const { fx, h } = await setupWith({ target: "main", files: { ...SIMPLE, ".sova/project.json": SIMPLE_DEF({ remote: "upstream" }) } }, { thread: thread(c) }, (fx) => git(fx.project, ["remote", "rename", "origin", "upstream"]));
    const r = await prove(fx, h, { ok: { "src/app.ts": "export const x = 2;\n" }, red: { "src/app.ts": "export const x: number = 'TYPE ERROR';\n" }, redWhy: /Typecheck/, conflict: c, push: "pushed" });
    assert.equal(fx.originHead(), r.conflict.landed!.sha, "upstream has the last landing");
    assert.equal(git(fx.project, ["remote"]), "upstream", "no origin was made");
  });

  test("a simple project (a typecheck and a push): lands and pushes, a type error is the branch's, a conflict resolves", async () => {
    const c = CONFLICT("NOTES.txt");
    const { fx, h } = await setup({ target: "main", files: { ...SIMPLE, ".sova/project.json": SIMPLE_DEF() } }, { thread: thread(c) });
    const base = fx.head("main");
    const r = await prove(fx, h, { ok: { "src/app.ts": "export const x = 2;\n" }, red: { "src/app.ts": "export const x: number = 'TYPE ERROR';\n" }, redWhy: /Typecheck/, conflict: c, push: "pushed" });
    assert.equal(fx.originHead(), r.conflict.landed!.sha);
    assert.equal(Number(git(fx.project, ["rev-list", "--count", "--merges", "--first-parent", `${base}..main`])), 3, "each landing a merge commit (the default), the resolution one too");
  });

  test("one commit per branch (merge.squash): each landing is one commit holding the branch's tree, the conflict's resolution too; the pinned commit stays recorded", async () => {
    const c = CONFLICT("NOTES.txt");
    const { fx, h } = await setup({ target: "main", files: { ...SIMPLE, ".sova/project.json": SIMPLE_DEF({ squash: true }) } }, { thread: thread(c) });
    const base = fx.head("main");
    const r = await prove(fx, h, { ok: { "src/app.ts": "export const x = 2;\n" }, red: { "src/app.ts": "export const x: number = 'TYPE ERROR';\n" }, redWhy: /Typecheck/, conflict: c, push: "pushed" });
    const firstParents = fx.firstParentSince(base, "main");
    assert.equal(Number(git(fx.project, ["rev-list", "--count", "--merges", `${base}..main`])), 0, "no merge commit");
    assert.equal(firstParents.length, 3, "three landings, one commit each");
    assert.equal(git(fx.project, ["rev-parse", `${firstParents[0]}^`]), base, "the first one sits on main's head");
    assert.equal(git(fx.project, ["log", "-1", "--format=%s", firstParents[0]!]), "ok: change", "one subject: the branch's own");
    assert.match(git(fx.project, ["log", "-1", "--format=%b", firstParents[0]!]), /Landed from feat\/ok onto main as one commit/);
    assert.equal(fx.tree(firstParents[0]!), git(fx.project, ["rev-parse", `${r.ok.commit}^{tree}`]), "the branch's tree, exactly");
    assert.ok(!fx.isAncestor(r.ok.commit, "main") && r.ok.landed?.oneCommit, "the pinned commit isn't on main, and the landing says so");
    assert.equal(r.conflict.landed!.sha, fx.head("main"));
    assert.equal(r.conflict.landed?.oneCommit, true);
    assert.ok(stepsOf(h, r.ok).find((s) => s.id === "merge")?.detail?.includes("one commit"));
  });
});

// ---------------------------------------------------------------- helpers

/** A library repository (its own bare origin) added to the project as the submodule `lib`, with a check reading it. */
async function withSubmodule(t: ReturnType<typeof thread>): Promise<{ fx: Fixture; h: QueueHarness; lib: string }> {
  const files = {
    ".gitignore": IGNORE,
    ".sova/project.json": def({ checks: [{ id: "lib", label: "Lib check", run: ["node", "check-lib.mjs"] }] }),
    "check-lib.mjs": `const t = (await import("node:fs")).readFileSync("lib/value.txt", "utf8").trim();\nconsole.log("lib says: " + t);\nprocess.exit(t === "fail" ? 1 : 0);\n`,
  };
  let lib = "";
  const { fx, h } = await setupWith({ target: "main", files }, { thread: t }, (fx) => {
    lib = join(fx.root, "lib-work");
    const libOrigin = join(fx.root, "lib.git");
    mkdirSync(lib, { recursive: true });
    git(lib, ["init", "-q", "-b", "main"]);
    writeFileSync(join(lib, "value.txt"), "value 1\n");
    git(lib, ["add", "-A"]);
    git(lib, ["commit", "-q", "-m", "lib: one"]);
    git(fx.root, ["init", "-q", "--bare", "-b", "main", libOrigin]);
    git(lib, ["remote", "add", "origin", libOrigin]);
    git(lib, ["push", "-q", "origin", "main"]);
    // A local path submodule: git refuses the file transport for submodules unless allowed, and a submodule's clone reads
    // only the user's own config: set in the throwaway home the runner gives this process (never a real one).
    assert.match(process.env.HOME ?? "", /sova-test-home-/, "the runner's throwaway home");
    git(fx.root, ["config", "--global", "protocol.file.allow", "always"]);
    git(fx.project, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", libOrigin, "lib"]);
    git(fx.project, ["commit", "-q", "-m", "add lib"]);
    git(fx.project, ["push", "-q", "origin", "main"]);
  });
  return { fx, h, lib };
}

/** A new commit in the library, pushed to its origin; → its sha. */
function libCommit(lib: string, value: string): string {
  writeFileSync(join(lib, "value.txt"), value);
  git(lib, ["commit", "-qam", `lib: ${value.trim()}`]);
  git(lib, ["push", "-q", "origin", "main"]);
  return git(lib, ["rev-parse", "HEAD"]);
}

const GITLINK = "\u0000gitlink:";
/** A branch file value that points a submodule at `sha` (branchOf). */
const gitlink = (sha: string) => `${GITLINK}${sha}`;
void existsSync;

// The merge checks as the queue runs them: a process in the tree it checks, its inputs in SOVA_MERGE_*,
// its report in SOVA_OUT. Each with nothing to do exits 0 and says why; each that runs reports counts.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../../server/test-scratch.ts";
import { copyFromRepo, importClosure, REPO, RUNNER_FILES } from "../runner-copy.test.helper.ts";

const HERE = import.meta.dirname;
const script = (name: string) => join(HERE, `${name}.mjs`);

function repo() {
  const root = scratchRoot("mc-int-");
  const tree = join(root, "tree");
  mkdirSync(tree);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: tree, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  writeFileSync(join(tree, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  return { root, tree, git, base };
}

/** This process's environment without what makes a check run as the queue's own (SOVA_VERB=merge and SOVA_MERGE_*, set
 *  when these tests run as a merge check themselves; SOVA_MERGE_PICKED=1 when the merge thread picked it): a case that
 *  wants one sets it. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SOVA_VERB;
  for (const k of Object.keys(env)) if (k.startsWith("SOVA_MERGE_")) delete env[k];
  return env;
}

function runCheck(name: string, tree: string, root: string, changed: string[], base: string, extra: Record<string, string> = {}) {
  const list = join(root, `changed-${name}.txt`);
  writeFileSync(list, changed.join("\n"));
  const out = join(root, `out-${name}-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(process.execPath, [script(name)], { cwd: tree, encoding: "utf8", env: { ...cleanEnv(), SOVA_MERGE_BASE: base, SOVA_MERGE_CHANGED: list, SOVA_OUT: out, ...extra } });
  let report: Record<string, unknown> | null = null;
  try { report = JSON.parse(readFileSync(out, "utf8")); } catch { /* none */ }
  return { code: r.status, out: `${r.stdout}${r.stderr}`, report };
}

describe("merge checks", () => {
  test("each check with nothing to do exits 0 and reports why it skipped", () => {
    const { root, tree, base } = repo();
    const cases: [string, RegExp][] = [
      ["ext-suites", /no change to a pi-config extension/],
      ["spec-replay", /no change to the spec core/],
      ["statecharts", /no change to the statecharts/],
      ["spec", /no \.sova\/spec in this tree/],
      ["leak-scan", /no origin\/master: nothing would be published/],
      ["e2e", /no walkthrough selected/],
    ];
    for (const [name, why] of cases) {
      const r = runCheck(name, tree, root, ["server/x.ts"], base);
      expect(r.code, `${name}: ${r.out}`).toBe(0);
      expect(r.report?.passed).toBe(0);
      expect(r.report?.failed).toBe(0);
      expect(String(r.report?.skipped)).toMatch(why);
    }
  });

  test("e2e runs only walkthroughs under scripts/e2e of this tree: anything else selected fails, nothing built", () => {
    const { root, tree, base } = repo();
    const list = join(root, "c.txt");
    writeFileSync(list, "a.txt");
    const out = join(root, "e2e-out.json");
    const r = spawnSync(process.execPath, [script("e2e"), "../evil.mjs", "scripts/e2e/missing.mjs"], { cwd: tree, encoding: "utf8", env: { ...cleanEnv(), SOVA_MERGE_BASE: base, SOVA_MERGE_CHANGED: list, SOVA_OUT: out } });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("pnpm run build");
    const rep = JSON.parse(readFileSync(out, "utf8"));
    expect(rep.failed).toBe(2);
    expect(rep.failures.map((f: { name: string }) => f.name)).toEqual(["../evil.mjs", "scripts/e2e/missing.mjs"]);
  });

  test("a triggered check whose tree lacks its runner skips, naming what is missing", () => {
    const { root, tree, base } = repo();
    expect(runCheck("spec-replay", tree, root, ["pi-config/extensions/spec/core/a.mjs"], base).report?.skipped).toMatch(/no tests\/replay\/replay\.test\.mjs/);
    expect(runCheck("statecharts", tree, root, ["statecharts/src/a.cljs"], base).report?.skipped).toMatch(/no scripts\/build-statecharts\.mjs/);
  });

  test("ext-suites runs each changed extension's README line and fails on a failing command", () => {
    const { root, tree, base } = repo();
    const ext = join(tree, "pi-config", "extensions");
    mkdirSync(join(ext, "good"), { recursive: true });
    mkdirSync(join(ext, "bad"), { recursive: true });
    writeFileSync(join(ext, "good", "t.mjs"), "console.log('good ran')\n");
    writeFileSync(join(ext, "bad", "t.mjs"), "process.exit(3)\n");
    writeFileSync(join(tree, "pi-config", "README.md"), "# pi-config\n\n## Tests\n\n```sh\ncd extensions/good && node t.mjs\ncd extensions/bad && node t.mjs\n```\n");
    const ok = runCheck("ext-suites", tree, root, ["pi-config/extensions/good/x.ts"], base);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("good ran");
    expect(ok.report).toMatchObject({ passed: 1, failed: 0 });
    const bad = runCheck("ext-suites", tree, root, ["pi-config/extensions/good/x.ts", "pi-config/extensions/bad/x.ts"], base);
    expect(bad.code).toBe(1);
    expect(bad.report).toMatchObject({ passed: 1, failed: 1 });
    expect((bad.report?.failures as { name: string; message: string }[])[0]).toMatchObject({ name: "pi-config bad: node t.mjs", message: "exit 3" });
    const none = runCheck("ext-suites", tree, root, ["pi-config/extensions/other/x.ts"], base);
    expect(none.code).toBe(0);
    expect(none.report?.skipped).toMatch(/no Tests line for other/);
  });

  test("leak-scan against origin: a clean range passes, a planted name fails without printing it, no names file fails closed", () => {
    const { root, tree, git, base } = repo();
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", "master");
    git("fetch", "-q", "origin");
    const names = join(root, "names.json");
    const TERM = "Quokka-Tower-9";
    writeFileSync(names, JSON.stringify({ privateNames: [TERM] }, null, 1));
    writeFileSync(join(tree, "b.txt"), "plain\n");
    git("add", "b.txt");
    git("commit", "-qm", "clean");
    const clean = runCheck("leak-scan", tree, root, ["b.txt"], base, { SOVA_LEAK_NAMES: names });
    expect(clean.code, clean.out).toBe(0);
    expect(clean.report).toMatchObject({ passed: 1, failed: 0 });
    writeFileSync(join(tree, "c.txt"), `hello ${TERM}\n`);
    git("add", "c.txt");
    git("commit", "-qm", "leaky");
    const hit = runCheck("leak-scan", tree, root, ["c.txt"], base, { SOVA_LEAK_NAMES: names });
    expect(hit.code).toBe(1);
    expect(hit.out.toLowerCase()).not.toContain(TERM.toLowerCase());
    expect(JSON.stringify(hit.report).toLowerCase()).not.toContain(TERM.toLowerCase());
    expect(hit.report?.failed).toBe(1);
    const closed = runCheck("leak-scan", tree, root, ["c.txt"], base, { SOVA_LEAK_NAMES: join(root, "missing.json") });
    expect(closed.code).toBe(2);
    expect(closed.report?.failed).toBe(1);
    // As the queue's check, a project with no names yet is scanned for secrets only, and says the push is held.
    const asCheck = runCheck("leak-scan", tree, root, ["c.txt"], base, { SOVA_LEAK_NAMES: join(root, "missing.json"), SOVA_VERB: "merge" });
    expect(asCheck.code).toBe(0);
    expect(String((asCheck.report?.notes as string[])[0])).toMatch(/private names not set up yet.*push is held/);
    // An empty list is an answer: the project has no private names; secrets only, nothing held.
    const emptyNames = join(root, "empty.json");
    writeFileSync(emptyNames, JSON.stringify({ privateNames: [] }));
    const empty = runCheck("leak-scan", tree, root, ["c.txt"], base, { SOVA_LEAK_NAMES: emptyNames, SOVA_VERB: "merge" });
    expect(empty.code).toBe(0);
    expect(empty.report?.notes).toEqual([]);
    writeFileSync(join(tree, "d.txt"), `key = "sk-${"a".repeat(40)}"\n`);
    git("add", "d.txt");
    git("commit", "-qm", "secret");
    const secret = runCheck("leak-scan", tree, root, ["d.txt"], base, { SOVA_LEAK_NAMES: join(root, "missing.json"), SOVA_VERB: "merge" });
    expect(secret.code).toBe(1);
  });

  test("spec: a tree with a spec is checked by the spec tools; missing tools fail rather than pass", () => {
    const { root, tree, base } = repo();
    mkdirSync(join(tree, ".sova", "spec", "claims"), { recursive: true });
    const r = runCheck("spec", tree, root, ["a.txt"], base, { SOVA_SPEC_CORE: join(root, "no-core") });
    expect(r.code).toBe(1);
    expect(String((r.report?.failures as { message: string }[])[0].message)).toMatch(/spec tools aren't at/);
  });

  test("every optional check Sova declares, run bare as a trial runs it (no selection) on a branch with nothing for it, exits 0 and says why it skipped", () => {
    // A trial picks every optional check with no selection (queue.ts optionalPicks). Each of Sova's runs here in a tree
    // holding its own scripts (each file its command names, with their imports) and the test runner, at the target's
    // tip: the branch changes nothing, every tracked file reads as changed and the check as picked, as a trial says.
    // A new optional check that fails without a selection fails this test by name.
    const def = JSON.parse(readFileSync(join(REPO, ".sova/project.json"), "utf8"));
    const optional = (def.merge.checks as { id: string; run: string[]; optional?: boolean }[]).filter((c) => c.optional);
    expect(optional.map((c) => c.id)).toContain("integration-group");
    const root = scratchRoot("mc-bare-");
    const tree = join(root, "tree");
    const isFile = (a: string) => !a.startsWith("-") && !!statSync(join(REPO, a), { throwIfNoEntry: false })?.isFile();
    copyFromRepo(tree, [...new Set([...RUNNER_FILES, ".sova/project.json", ...importClosure(optional.flatMap((c) => c.run.filter(isFile)))])]);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: tree, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "master");
    git("add", "-A");
    git("commit", "-qm", "target");
    const tip = git("rev-parse", "HEAD");
    const list = join(root, "changed.txt");
    writeFileSync(list, `${git("ls-tree", "-r", "--name-only", "HEAD")}\n`);
    for (const c of optional) {
      expect(c.run.join(" "), `${c.id} takes no template a bare run can't fill`).not.toContain("${");
      const out = join(root, `out-${c.id}.json`);
      const env = { ...cleanEnv(), SOVA_VERB: "merge", SOVA_MERGE_BASE: tip, SOVA_MERGE_TIP: tip, SOVA_MERGE_TARGET: "master", SOVA_MERGE_CHANGED: list, SOVA_MERGE_PICKED: "1", SOVA_OUT: out };
      delete env.SOVA_TEST_FILE;
      const r = spawnSync(c.run[0], c.run.slice(1), { cwd: tree, encoding: "utf8", env, timeout: 120_000 });
      let report: Record<string, unknown> | null = null;
      try { report = JSON.parse(readFileSync(out, "utf8")); } catch { /* none */ }
      expect(r.status, `${c.id} run bare: ${r.stdout}${r.stderr}`).toBe(0);
      expect(report?.passed, c.id).toBe(0);
      expect(report?.failed, c.id).toBe(0);
      expect(typeof report?.skipped === "string" && report.skipped.length > 0, `${c.id} says why it skipped: ${JSON.stringify(report)}`).toBe(true);
    }
  });
});

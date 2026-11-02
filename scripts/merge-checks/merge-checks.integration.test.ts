// The merge checks as the queue runs them: a process in the tree it checks, its inputs in SOVA_MERGE_*,
// its report in SOVA_OUT. Each with nothing to do exits 0 and says why; each that runs reports counts.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../../server/test-scratch.ts";

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

function runCheck(name: string, tree: string, root: string, changed: string[], base: string, extra: Record<string, string> = {}) {
  const list = join(root, `changed-${name}.txt`);
  writeFileSync(list, changed.join("\n"));
  const out = join(root, `out-${name}-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(process.execPath, [script(name)], { cwd: tree, encoding: "utf8", env: { ...process.env, SOVA_MERGE_BASE: base, SOVA_MERGE_CHANGED: list, SOVA_OUT: out, ...extra } });
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
    ];
    for (const [name, why] of cases) {
      const r = runCheck(name, tree, root, ["server/x.ts"], base);
      expect(r.code, `${name}: ${r.out}`).toBe(0);
      expect(r.report?.passed).toBe(0);
      expect(r.report?.failed).toBe(0);
      expect(String(r.report?.skipped)).toMatch(why);
    }
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
  });

  test("spec: a tree with a spec is checked by the spec tools; missing tools fail rather than pass", () => {
    const { root, tree, base } = repo();
    mkdirSync(join(tree, ".sova", "spec"), { recursive: true });
    writeFileSync(join(tree, ".sova", "spec", "manifest.json"), "{}\n");
    const r = runCheck("spec", tree, root, ["a.txt"], base, { SOVA_SPEC_CORE: join(root, "no-core") });
    expect(r.code).toBe(1);
    expect(String((r.report?.failures as { message: string }[])[0].message)).toMatch(/spec tools aren't at/);
  });
});

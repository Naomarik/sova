// Run: pnpm test:int scripts/test-cache-checked.integration.test.ts. scripts/checked.mjs, the output-free check
// wrapper (the type check): in a throwaway repository holding a copy of it, a passing command runs once per
// identical code, then prints one line (and with --report writes SOVA_OUT `skipped`); --fresh, an edit, a
// failure and a run from inside a test all run it again.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../server/test-scratch";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test("checked.mjs reuses a pass on identical code only", () => {
  const root = scratchRoot("checked-");
  const side = scratchRoot("checked-side-");
  roots.push(root, side);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "feat/x");
  mkdirSync(join(root, "scripts"));
  for (const f of ["checked.mjs", "test-cache.mjs"]) copyFileSync(join(import.meta.dirname, f), join(root, "scripts", f));
  const layout = "pi-config/extensions/spec/core/layout.mjs";
  mkdirSync(join(root, layout, ".."), { recursive: true });
  copyFileSync(join(import.meta.dirname, "..", layout), join(root, layout));
  mkdirSync(join(root, "node_modules/.pnpm"), { recursive: true });
  writeFileSync(join(root, "node_modules/.modules.yaml"), '{"layoutVersion": 5}\n');
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "a.ts"), "1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");

  const counter = join(side, "runs");
  const out = join(side, "out.json");
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.SOVA_TEST_HOME;
  delete env.SOVA_TEST_RUNNER_PID;
  delete env.SOVA_FRESH;
  const runs = () => (existsSync(counter) ? readFileSync(counter, "utf8").length : 0);
  const check = (opts: { fail?: boolean; extra?: string[]; env?: Record<string, string> } = {}) => {
    rmSync(out, { force: true });
    const script = `require("fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.exit(${opts.fail ? 1 : 0})`;
    const r = spawnSync(process.execPath, [join(root, "scripts/checked.mjs"), "--report", ...(opts.extra ?? []), "--", process.execPath, "-e", script], {
      cwd: root,
      env: { ...env, SOVA_OUT: out, ...opts.env },
      encoding: "utf8",
    });
    return { code: r.status, stdout: r.stdout, out: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
  };

  let r = check();
  assert.equal(r.code, 0);
  assert.equal(runs(), 1);
  assert.equal(r.out, null, "a real run writes no report");

  r = check();
  assert.equal(r.code, 0);
  assert.equal(runs(), 1, "identical code: not run again");
  assert.match(r.stdout, /already passed on identical code at \d\d:\d\d \(feat\/x's chat\) and wasn't run again \(--fresh runs it\)/);
  assert.match(r.out.skipped, /^already passed on identical code at \d\d:\d\d \(feat\/x's chat\)$/);

  check({ extra: ["--fresh"] });
  assert.equal(runs(), 2, "--fresh runs it");
  check({ env: { SOVA_FRESH: "1" } });
  assert.equal(runs(), 3, "SOVA_FRESH=1 runs it");
  check({ env: { SOVA_TEST_HOME: "/nowhere" } });
  assert.equal(runs(), 4, "from inside a test: runs it");

  writeFileSync(join(root, "a.ts"), "2\n");
  assert.equal(check({ fail: true }).code, 1, "the exit code passes through");
  assert.equal(runs(), 5);
  assert.equal(check({ fail: true }).code, 1);
  assert.equal(runs(), 6, "a failure is never reused");
  check();
  check();
  assert.equal(runs(), 7, "the edited tree passed once, then is reused");

  writeFileSync(join(root, "a.ts"), "1\n");
  check();
  assert.equal(runs(), 7, "back to the first tree: its pass still stands");

  const store = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  assert.ok(existsSync(join(store, "sova-test-results", "v1")), "the store is in the git common dir");
});

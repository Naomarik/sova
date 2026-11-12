// End-to-end guards for test-result reuse: the real runner (scripts/run-tests.mjs, copied with its
// relative imports and preloads into a throwaway git repository of its own by runner-copy.test.helper.ts, so its
// store is that repository's and never this checkout's), run twice over probe test files. Each probe appends its
// name to a log outside the repository when it runs, so "ran" and "reused" are counted from what
// actually executed, never from the runner's own words.
import { after, describe, test } from "node:test";
import { expect } from "../server/merge-queue/testing/expect";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { scratchRoot } from "../server/test-scratch";
import { git, runnerProjects } from "./runner-copy.test.helper";

const base = scratchRoot("sova-tc-e2e-");
after(() => rmSync(base, { recursive: true, force: true }));

const project = runnerProjects(base);
const TO = { timeout: 240_000 };
const show = (r: { code: number | null; out: string }) => `exit ${r.code}\n${r.out.slice(-4000)}`;

describe("a second run on an unchanged tree runs nothing that already passed", () => {
  test("three passing files: the second run runs 0 of them, says so, and reports them as passed", TO, () => {
    const p = project();
    for (const f of ["server/a.test.ts", "server/b.test.ts", "server/c.test.ts"]) p.probe(f);
    p.commit();
    const r1 = p.run();
    expect(r1.code, show(r1)).toBe(0);
    expect(r1.ran).toEqual(["server/a.test.ts", "server/b.test.ts", "server/c.test.ts"]);
    expect(p.batches().length > 0).toBe(true);
    const r2 = p.run();
    expect(r2.code, show(r2)).toBe(0);
    expect(r2.ran, show(r2)).toEqual([]);
    expect(r2.out).toMatch(/already passed on identical code/);
    expect(r2.out).toMatch(/--fresh/);
    expect(r2.report?.reused?.files, JSON.stringify(r2.report)).toBe(3);
    expect(r2.report?.failed ?? 0).toBe(0);
    expect(r2.report?.passed >= 3).toBe(true);
  });

  test("uncommitted work counts: a pass before committing stands after the commit", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.commit();
    p.put("src/x.ts", "export const x = 1;\n");
    p.probe("server/b.test.ts");
    const r1 = p.run();
    expect(r1.code, show(r1)).toBe(0);
    p.commit("now committed");
    const r2 = p.run();
    expect(r2.ran, show(r2)).toEqual([]);
  });

  test("an edit anywhere in the tree runs everything again; a spec claim or manifest edit runs nothing", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.put(".sova/spec/claims/app/x.md", "# §app/x\n\nX.\n");
    p.put(".sova/spec/manifest.json", "{}\n");
    p.put(".sova/spec/README.md", "readme\n");
    p.commit();
    expect(p.run().code).toBe(0);
    p.put(".sova/spec/claims/app/x.md", "# §app/x\n\nX, landed.\n");
    p.put(".sova/spec/claims/app/y.md", "# §app/y\n\nY.\n");
    p.put(".sova/spec/manifest.json", "{\"x\":1}\n");
    const r2 = p.run();
    expect(r2.ran, show(r2)).toEqual([]);
    p.put(".sova/spec/README.md", "readme, edited\n");
    const r3 = p.run();
    expect(r3.ran, show(r3)).toEqual(["server/a.test.ts"]);
  });

  test("a chmod alone and an untracked newline-named file both make a miss, never a crash", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.put("tool.sh", "#!/bin/sh\n");
    p.commit();
    expect(p.run().code).toBe(0);
    chmodSync(join(p.root, "tool.sh"), 0o755);
    const r2 = p.run();
    expect(r2.ran, show(r2)).toEqual(["server/a.test.ts"]);
    p.put("we\nird.txt", "x\n");
    const r3 = p.run();
    expect(r3.code, show(r3)).toBe(0);
    expect(r3.ran, show(r3)).toEqual(["server/a.test.ts"]);
    const r4 = p.run();
    expect(r4.ran, show(r4)).toEqual([]);
  });

  test("per-run settings (width, slice, shared tmp) don't stop reuse; a setting tests read does", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.commit();
    expect(p.run().code).toBe(0);
    const r2 = p.run([], { TEST_BUN_JOBS: "1", SOVA_TEST_SHARED_TMP: base, SOVA_CHAT_SLICE: undefined });
    expect(r2.ran, show(r2)).toEqual([]);
    const r3 = p.run([], { SOVA_GOLDEN_MODE: "record" });
    expect(r3.ran, show(r3)).toEqual(["server/a.test.ts"]);
  });

  test("a bun:test file is remembered too (bun runs no exit handler for it, so the tier guard's record must not wait for exit)", TO, () => {
    const p = project();
    p.probe("server/b.test.ts", "", "", "bun:test");
    p.commit();
    expect(p.run().code).toBe(0);
    const r2 = p.run();
    expect(r2.ran, show(r2)).toEqual([]);
  });

  test("--conditions=browser files are remembered under their own pass and reused too", TO, () => {
    const p = project();
    p.probe("src/lib/a.browser.test.ts");
    p.probe("src/lib/b.test.ts");
    p.commit();
    const r1 = p.run(["src/lib/a.browser.test.ts", "src/lib/b.test.ts"]);
    expect(r1.code, show(r1)).toBe(0);
    const r2 = p.run(["src/lib/a.browser.test.ts", "src/lib/b.test.ts"]);
    expect(r2.ran, show(r2)).toEqual([]);
  });
});

describe("only a clean, full pass is ever reused (a19)", () => {
  test("a failing file, a file with a skip and a file whose every test skipped all run again", TO, () => {
    const p = project();
    p.probe("server/ok.test.ts");
    p.probe("server/fail.test.ts", "  assert.equal(1, 2);");
    p.put("server/skip.test.ts", `import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(p.marks)}, "server/skip.test.ts\\n");\ntest("p", () => {});\ntest("s", { skip: true }, () => {});\n`);
    p.put("server/allskip.test.ts", `import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(p.marks)}, "server/allskip.test.ts\\n");\ntest("s", { skip: true }, () => {});\n`);
    p.commit();
    const r1 = p.run();
    expect(r1.code).toBe(1);
    const r2 = p.run();
    expect(r2.code).toBe(1);
    expect(r2.ran, show(r2)).toEqual(["server/allskip.test.ts", "server/fail.test.ts", "server/skip.test.ts"]);
  });

  test("a narrowed run never stands in for a full one: a name filter, another time limit, the guard only reporting", TO, () => {
    for (const [args, env] of [[["--", "--test-name-pattern=probe"], {}], [["--", "--timeout=1000"], {}], [[], { SOVA_TEST_GUARD: "report" }], [[], { TEST_FILE_LIMIT_MS: "100000" }]] as [string[], Record<string, string>][]) {
      const p = project();
      p.probe("server/a.test.ts");
      p.commit();
      const r1 = p.run(args, env);
      expect(r1.code, show(r1)).toBe(0);
      const r2 = p.run();
      expect({ args, env, ran: r2.ran }).toEqual({ args, env, ran: ["server/a.test.ts"] });
    }
  });

  test("a unit file the tier guard faults, in report mode, is never recorded", TO, () => {
    const p = project();
    p.probe("server/spawns.test.ts", `  execFileSync(process.execPath, ["--version"]);`, `import { execFileSync } from "node:child_process";`);
    p.commit();
    const r1 = p.run([], { SOVA_TEST_GUARD: "report" });
    expect(r1.code, show(r1)).toBe(0);
    const r2 = p.run([], { SOVA_TEST_GUARD: "report" });
    expect(r2.ran, show(r2)).toEqual(["server/spawns.test.ts"]);
  });

  test("a file killed at its time limit is never recorded", TO, () => {
    const p = project();
    p.probe("server/slow.test.ts", "  await new Promise((r) => setTimeout(r, 4000));");
    p.commit();
    const r1 = p.run([], { TEST_FILE_LIMIT_MS: "1500" });
    expect(r1.code).not.toBe(0);
    const r2 = p.run([], { TEST_FILE_LIMIT_MS: "1500" });
    expect(r2.ran, show(r2)).toEqual(["server/slow.test.ts"]);
  });
});

describe("runs that never reuse or save (a16, a17) and fresh runs (--fresh, SOVA_FRESH)", () => {
  test("a run started from inside a test saves nothing and reuses nothing; the same passing probe runs both times", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.commit();
    const inside = { SOVA_TEST_HOME: join(base, "outer-home"), SOVA_TEST_RUNNER_PID: String(process.pid) };
    const r1 = p.run([], inside);
    expect(r1.code, show(r1)).toBe(0);
    expect(p.batches()).toEqual([]);
    const r2 = p.run([], inside);
    expect(r2.ran).toEqual(["server/a.test.ts"]);
    expect(p.batches()).toEqual([]);
  });

  test("a run that names a file outside the project saves nothing", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.commit();
    const outside = join(base, `outside-${basename(p.root)}.test.ts`);
    writeFileSync(outside, `import { test } from "node:test";\ntest("o", () => {});\n`);
    const r1 = p.run(["server/a.test.ts", outside]);
    expect(r1.code, show(r1)).toBe(0);
    expect(p.batches()).toEqual([]);
  });

  test("--runtime node neither reads nor writes the store", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.commit();
    expect(p.run().code).toBe(0);
    const before = p.batches();
    p.run(["--runtime", "node"]); // no tsx here: it may fail; it must not touch the store
    expect(p.batches()).toEqual(before);
  });

  test("--fresh and SOVA_FRESH=1 run everything, and still record their passes", TO, () => {
    const p = project();
    p.probe("server/a.test.ts");
    p.probe("server/b.test.ts");
    p.commit();
    expect(p.run().code).toBe(0);
    const r2 = p.run(["--fresh"]);
    expect(r2.ran, show(r2)).toEqual(["server/a.test.ts", "server/b.test.ts"]);
    const r3 = p.run([], { SOVA_FRESH: "1" });
    expect(r3.ran, show(r3)).toEqual(["server/a.test.ts", "server/b.test.ts"]);
    // Only the fresh runs' records now: a plain run still reuses them.
    const common = git(p.root, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    const first = p.batches().sort()[0];
    rmSync(join(common, first));
    const r4 = p.run();
    expect(r4.ran, show(r4)).toEqual([]);
  });
});

describe("tests that read the project's own git history always run (a22)", () => {
  test("git log or show on the project: never reused; git init of a temp folder, git --version, rev-parse HEAD: reused", TO, () => {
    const p = project();
    p.probe("server/history.test.ts", `  execFileSync("git", ["log", "-1", "--format=%H"]);`, `import { execFileSync } from "node:child_process";`);
    // From another folder, pointed at the project with -C.
    p.probe("server/show.test.ts", `  execFileSync("git", ["-C", process.cwd(), "show", "HEAD:package.json"], { cwd: tmpdir() });`, `import { execFileSync } from "node:child_process";\nimport { tmpdir } from "node:os";`);
    p.probe(
      "server/fixture.test.ts",
      `  const d = mkdtempSync(join(tmpdir(), "g-"));\n  execFileSync("git", ["init", "-q", d]);\n  execFileSync("git", ["--version"]);\n  execFileSync("git", ["rev-parse", "HEAD"]);`,
      `import { execFileSync } from "node:child_process";\nimport { mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";`,
    );
    p.commit();
    const r1 = p.run();
    expect(r1.code, show(r1)).toBe(0);
    const r2 = p.run();
    expect(r2.ran, show(r2)).toEqual(["server/history.test.ts", "server/show.test.ts"]);
  });
});

describe("an edit made while tests run keeps nothing it could have reached", () => {
  test("a file running across the edit is dropped; a file that finished before it is kept", TO, () => {
    const p = project();
    const go = join(p.flags, "go");
    const started = join(p.flags, "started");
    p.probe("server/a-quick.test.ts");
    p.probe(
      "server/b-long.test.ts",
      `  writeFileSync(${JSON.stringify(started)}, "1");\n  for (let i = 0; i < 600 && !existsSync(${JSON.stringify(go)}); i++) await new Promise((r) => setTimeout(r, 100));`,
      `import { writeFileSync } from "node:fs";`,
    );
    p.put("src/x.ts", "export const x = 1;\n");
    p.commit();
    // Ordered by the recorded times: b-long first, a-quick right after at width 1, so a-quick ends before the edit.
    p.put(".cache/test-durations.json", JSON.stringify({ v: 1, files: { "server/b-long.test.ts": { ms: 9000, at: "" }, "server/a-quick.test.ts": { ms: 10, at: "" } } }));
    const runner = Bun.spawn(["node", join(p.root, "scripts/run-tests.mjs")], {
      cwd: p.root,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !["SOVA_TEST_HOME", "SOVA_TEST_RUNNER_PID", "SOVA_TEST_FILE", "SOVA_TEST_GUARD_DIR", "SOVA_RUNTIME"].includes(k))), SOVA_BUN: process.execPath, TEST_BUN_JOBS: "2" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return (async () => {
      for (let i = 0; i < 300 && !(existsSync(started) && readFileSync(p.marks, "utf8").includes("a-quick")); i++) await Bun.sleep(100);
      // a-quick has ended (it logs at load, ends within ms); a run vouches for a file once a sample of the tree after its
      // end matches the start, and the runner samples every 5 s: wait past the next sample before editing.
      await Bun.sleep(6500);
      p.put("src/x.ts", "export const x = 2;\n"); // the edit, while b-long runs
      await Bun.sleep(11_000); // two of the runner's 5 s samples see it
      p.put("src/x.ts", "export const x = 1;\n"); // and back, so the run ends on the tree it started on
      await Bun.sleep(1000);
      writeFileSync(go, "1");
      const code = await runner.exited;
      const out = (await new Response(runner.stdout).text()) + (await new Response(runner.stderr).text());
      expect(code, out).toBe(0);
      const r2 = p.run(); // go stays: a rerun of b-long passes at once
      expect(r2.ran, show(r2)).toEqual(["server/b-long.test.ts"]);
    })();
  });
});

describe("the random re-check (a23)", () => {
  test("a re-checked file that fails: every file reused from the same source runs fresh in that run, and the contradicted records are gone", TO, () => {
    const p = project();
    const broken = join(p.flags, "broken");
    const files = Array.from({ length: 12 }, (_, i) => `server/f${String(i).padStart(2, "0")}.test.ts`);
    // Each fails once the flag (outside the tree, so outside the fingerprint) exists: whichever is sampled fails.
    for (const f of files) p.probe(f, `  assert.equal(existsSync(${JSON.stringify(broken)}), false);`);
    p.commit();
    expect(p.run().code).toBe(0);
    writeFileSync(broken, "1");
    const r2 = p.run([], { SOVA_REUSE_SAMPLE: "0.05" });
    expect(r2.code, show(r2)).toBe(1);
    expect(r2.ran, show(r2)).toEqual(files); // the sampled one, then the rest of its source, fresh
    expect(r2.out).toMatch(/re-?check/i);
    rmSync(broken);
    const r3 = p.run();
    expect(r3.ran, show(r3)).toEqual(files); // nothing of the contradicted run is reused any more
  });

  test("the re-check picks other files on another run of the same tree", TO, () => {
    const p = project();
    const files = Array.from({ length: 40 }, (_, i) => `server/g${String(i).padStart(2, "0")}.test.ts`);
    for (const f of files) p.probe(f);
    p.commit();
    expect(p.run().code).toBe(0);
    const picks = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = p.run([], { SOVA_REUSE_SAMPLE: "0.05" });
      expect(r.code, show(r)).toBe(0);
      expect(r.ran.length >= 1, show(r)).toBe(true);
      expect(r.ran.length).toBeLessThan(files.length);
      for (const f of r.ran) picks.add(f);
    }
    expect(picks.size > 2).toBe(true);
  });
});

describe("what tests see", () => {
  test("no credential reaches a test, whatever the shell has", TO, () => {
    const p = project();
    const names = ["GH_TOKEN", "ANTHROPIC_API_KEY", "MISE_GITHUB_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SOVA_TOKEN", "NPM_TOKEN"];
    p.probe("server/env.test.ts", `  assert.deepEqual(${JSON.stringify(names)}.filter((k) => process.env[k] !== undefined), []);`);
    p.commit();
    const r = p.run([], Object.fromEntries(names.map((k) => [k, "fake-value-01"])));
    expect(r.code, show(r)).toBe(0);
  });
});

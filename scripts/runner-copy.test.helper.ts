// The real test runner (scripts/run-tests.mjs) copied, with its relative imports and preloads, into a throwaway git
// repository of its own: a run there selects, runs and remembers within that repository, never this checkout. Shared
// by the runner's end-to-end tests (reuse, the merge queue's group selection) and the merge-check tests that run
// Sova's own check commands in such a copy.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveImport } from "./test-changed.mjs";

export const REPO = resolve(import.meta.dirname, "..");

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`](\.{1,2}\/[^"'`$]+)["'`]/g;
/** `start` (root-relative files of this checkout) with every file they import by relative path, file to file. */
export function importClosure(start: readonly string[]): string[] {
  const seen = new Set(start);
  const todo = [...start];
  while (todo.length) {
    const f = todo.pop()!;
    for (const m of readFileSync(join(REPO, f), "utf8").matchAll(IMPORT_RE)) {
      if (!m[1]) continue;
      const g = resolveImport(REPO, f, m[1]);
      if (g && !seen.has(g)) {
        seen.add(g);
        todo.push(g);
      }
    }
  }
  return [...seen];
}
/** The runner, its preloads and the stand-in claude, with every file they import by relative path. */
export const RUNNER_FILES = importClosure(["scripts/run-tests.mjs", "scripts/test-tier-guard.mjs", "pi-config/extensions/claude-code/tests/hermetic-env.mjs", "scripts/fake-claude.mjs", "shared/retire-lab.json" /* scripts/test-groups.mjs reads it, which no import shows */]);

/** Copy root-relative files of this checkout into `root`, as they are on disk. */
export function copyFromRepo(root: string, files: readonly string[]): void {
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    copyFileSync(join(REPO, f), join(root, f));
  }
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface RunnerProject {
  root: string;
  marks: string;
  flags: string;
  put(rel: string, text: string): void;
  /** A test file on node:test (as Sova's are), or bun:test when `lib` says so. */
  probe(rel: string, body?: string, head?: string, lib?: "node:test" | "bun:test"): void;
  commit(msg?: string): void;
  run(args?: string[], env?: Record<string, string | undefined>): { code: number | null; out: string; report: Record<string, any> | null; ran: string[] };
  batches(): string[];
}

/** A maker of throwaway projects under `base`: the runner's files, pnpm's install record (keyed as the installed
 *  packages), probes; each on its own `master`. */
export function runnerProjects(base: string): () => RunnerProject {
  let n = 0;
  return () => {
    const root = join(base, `p${++n}`);
    const marks = join(base, `p${n}.marks`);
    const flags = join(base, `p${n}.flags`);
    mkdirSync(root, { recursive: true });
    mkdirSync(flags, { recursive: true });
    writeFileSync(marks, "");
    copyFromRepo(root, RUNNER_FILES);
    for (const f of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      if (existsSync(join(REPO, f))) copyFileSync(join(REPO, f), join(root, f));
      else writeFileSync(join(root, f), "stand-in\n");
    }
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.cache/\n");
    writeFileSync(join(root, "package.json"), "{\"name\":\"probe\",\"private\":true,\"type\":\"module\"}\n");
    git(root, "init", "-q", "-b", "master");
    const p: RunnerProject = {
      root,
      marks,
      flags,
      put(rel, text) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      },
      /** A test file that logs its own run, then runs `body` inside one test (`head` at module level). */
      probe(rel, body = "", head = "", lib = "node:test") {
        p.put(
          rel,
          `import { test } from "${lib}";\nimport assert from "node:assert/strict";\nimport { appendFileSync, existsSync } from "node:fs";\n${head}\nappendFileSync(${JSON.stringify(marks)}, ${JSON.stringify(rel)} + "\\n");\ntest("probe", async () => {\n${body}\n  assert.equal(1, 1);\n});\n`,
        );
      },
      commit(msg = "c") {
        git(root, "add", "-A");
        git(root, "commit", "-q", "--allow-empty", "-m", msg);
      },
      run(args = [], env = {}) {
        const before = readFileSync(marks, "utf8").split("\n").filter(Boolean).length;
        const out = join(base, `out-${n}-${Math.random().toString(36).slice(2)}.json`);
        const e: Record<string, string | undefined> = { ...process.env, SOVA_BUN: process.execPath, SOVA_OUT: out, TEST_BUN_JOBS: "4", TEST_INT_JOBS: "2", ...env };
        // This file runs inside a test run; the inner run is a run of its own project, as from a shell.
        if (!("SOVA_TEST_HOME" in env)) delete e.SOVA_TEST_HOME;
        if (!("SOVA_TEST_RUNNER_PID" in env)) delete e.SOVA_TEST_RUNNER_PID;
        // The outer run's reuse switches (the merge queue sets one, test-env.mjs passes it on) would change what the
        // inner run reuses; a test that wants one says so.
        if (!("SOVA_REUSE_SAMPLE" in env)) delete e.SOVA_REUSE_SAMPLE;
        if (!("SOVA_FRESH" in env)) delete e.SOVA_FRESH;
        // The outer run's merge-queue inputs (when these tests run as a merge check) are never the inner run's.
        for (const k of Object.keys(e)) if (k.startsWith("SOVA_MERGE_") && !(k in env)) delete e[k];
        delete e.SOVA_TEST_FILE;
        delete e.SOVA_TEST_GUARD_DIR;
        delete e.SOVA_RUNTIME;
        for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
        const r = spawnSync("node", [join(root, "scripts/run-tests.mjs"), ...args], { cwd: root, env: e as NodeJS.ProcessEnv, encoding: "utf8", timeout: 240_000 });
        let report: Record<string, any> | null = null;
        try {
          report = JSON.parse(readFileSync(out, "utf8"));
        } catch {
          /* none written */
        }
        const ran = readFileSync(marks, "utf8").split("\n").filter(Boolean).slice(before).sort();
        return { code: r.status, out: `${r.stdout}\n${r.stderr}`, report, ran };
      },
      batches() {
        const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
        return globSync("sova-test-results/**/*.json", { cwd: common });
      },
    };
    return p;
  };
}

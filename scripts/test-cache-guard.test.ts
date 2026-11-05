// Guard tests for test-result reuse (scripts/test-cache.mjs): the ways a reused pass could stand in for
// a run on different inputs. Each case builds a throwaway git repository and asks whether the tree
// fingerprint T, the context C or the store tell the two states apart. Unit tier: git only, in-process.
// The end-to-end guards (the real runner, twice) are in test-cache-guard.integration.test.ts.
import { after, describe, test } from "node:test";
import { expect } from "../server/merge-queue/testing/expect";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../server/test-scratch";
import {
  contextHash,
  createTreeWatch,
  CREDENTIAL_ENV,
  dropRuns,
  isExcluded,
  keyedEnv,
  lookup,
  record,
  sample,
  SPEC_EXCLUDED,
  storeDir,
  treeFingerprint,
} from "./test-cache.mjs";

const base = scratchRoot("sova-tc-guard-");
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** A committed repository: a source file, a test, a spec with one claim and its manifest, docs. */
function repo(): string {
  const root = join(base, `r${++n}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "master");
  put(root, "src/a.ts", "export const a = 1;\n");
  put(root, "src/a.test.ts", "test('a', () => {});\n");
  put(root, "run.sh", "#!/bin/sh\necho hi\n");
  put(root, ".sova/spec/claims/app/x.md", "# §app/x\n\nX does one thing.\n");
  put(root, ".sova/spec/claims/app/x.json", "{}\n");
  put(root, ".sova/spec/manifest.json", "{\"formatVersion\":2}\n");
  put(root, ".sova/spec/README.md", "spec readme\n");
  put(root, ".gitignore", "ignored/\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}
const T = (root: string) => treeFingerprint(root).hash as string;
const TO = { timeout: 60_000 };

describe("tree fingerprint T: a change a test could see moves it", () => {
  test("stable when nothing changed, including a touch that only moves mtimes", TO, () => {
    const r = repo();
    const t0 = T(r);
    expect(T(r)).toBe(t0);
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(r, "src/a.ts"), future, future);
    expect(T(r)).toBe(t0);
  });

  test("an uncommitted edit moves it; reverting it restores it; committing it changes nothing", TO, () => {
    const r = repo();
    const t0 = T(r);
    put(r, "src/a.ts", "export const a = 2;\n");
    const t1 = T(r);
    expect(t1).not.toBe(t0);
    git(r, "commit", "-qam", "edit");
    expect(T(r)).toBe(t1); // committed or not, the same files fingerprint alike
    put(r, "src/a.ts", "export const a = 1;\n");
    expect(T(r)).toBe(t0);
  });

  test("a new untracked file moves it, and so does its content changing", TO, () => {
    const r = repo();
    const t0 = T(r);
    put(r, "src/new.ts", "1\n");
    const t1 = T(r);
    expect(t1).not.toBe(t0);
    put(r, "src/new.ts", "2\n");
    expect(T(r)).not.toBe(t1);
  });

  test("a chmod alone moves it (the index mode is not the file's)", TO, () => {
    const r = repo();
    const t0 = T(r);
    chmodSync(join(r, "run.sh"), 0o755);
    expect(T(r)).not.toBe(t0);
  });

  test("a file `git rm --cached` but kept on disk still counts: editing it or deleting it moves T", TO, () => {
    const r = repo();
    git(r, "rm", "-q", "--cached", "src/a.ts");
    const kept = T(r);
    put(r, "src/a.ts", "export const a = 3;\n");
    expect(T(r)).not.toBe(kept);
    unlinkSync(join(r, "src/a.ts"));
    const gone = T(r);
    expect(gone).not.toBe(kept);
  });

  test("a tracked file deleted on disk moves it", TO, () => {
    const r = repo();
    const t0 = T(r);
    unlinkSync(join(r, "src/a.ts"));
    expect(T(r)).not.toBe(t0);
  });

  test("a staged edit then a further unstaged edit: T follows the disk, not the index", TO, () => {
    const r = repo();
    put(r, "src/a.ts", "export const a = 5;\n");
    git(r, "add", "src/a.ts");
    const staged = T(r);
    put(r, "src/a.ts", "export const a = 6;\n");
    expect(T(r)).not.toBe(staged);
  });

  test("an untracked file named with a newline: no crash, no shorter list, its content counts", TO, () => {
    const r = repo();
    const t0 = T(r);
    const odd = "we\nird.ts";
    put(r, odd, "1\n");
    const t1 = T(r);
    expect(t1).not.toBe(t0);
    put(r, odd, "2\n");
    expect(T(r)).not.toBe(t1);
    // A sibling whose name is the newline name's first line is a different file.
    put(r, "we", "x\n");
    expect(T(r)).not.toBe(t1);
  });

  test("names with spaces, quotes and non-ASCII are hashed from their own content", TO, () => {
    const r = repo();
    for (const name of ["a b.ts", "q\"uote.ts", "é ü.ts", "tab\there.ts"]) {
      put(r, name, "1\n");
      const t1 = T(r);
      put(r, name, "2\n");
      expect(T(r)).not.toBe(t1);
      git(r, "add", "-A");
      git(r, "commit", "-qm", name);
      put(r, name, "3\n");
      expect(T(r)).not.toBe(t1);
    }
  });

  test("a symlink's target counts", TO, () => {
    const r = repo();
    symlinkSync("src/a.ts", join(r, "link"));
    const t1 = T(r);
    unlinkSync(join(r, "link"));
    symlinkSync("src/a.test.ts", join(r, "link"));
    expect(T(r)).not.toBe(t1);
  });

  test("a tracked file hidden from git status (assume-unchanged, skip-worktree) still counts by its content on disk", TO, () => {
    const seen = ["--assume-unchanged", "--skip-worktree"].map((flag) => {
      const r = repo();
      const t0 = T(r);
      git(r, "update-index", flag, "src/a.ts");
      put(r, "src/a.ts", "export const a = 9;\n");
      return { flag, moved: T(r) !== t0 };
    });
    expect(seen).toEqual([{ flag: "--assume-unchanged", moved: true }, { flag: "--skip-worktree", moved: true }]);
  });

  test("the same tree in a linked worktree fingerprints alike (the merge copy is one)", TO, () => {
    const r = repo();
    put(r, "src/dirty.ts", "uncommitted\n");
    const here = T(r);
    git(r, "add", "-A");
    git(r, "commit", "-qm", "dirty");
    const wt = join(base, `wt${n}`);
    git(r, "worktree", "add", "-q", "--detach", wt);
    expect(T(wt)).toBe(here);
    expect(storeDir(wt)).toBe(storeDir(r));
  });
});

describe("spec exclusion: exactly what landing writes, nothing more", () => {
  test("the exclusion is the claims folder and the manifest, nothing else", TO, () => {
    expect([...SPEC_EXCLUDED].sort()).toEqual([".sova/spec/claims/", ".sova/spec/manifest.json"]);
  });

  test("claims and the manifest edited, added or deleted: T unmoved", TO, () => {
    const r = repo();
    const t0 = T(r);
    put(r, ".sova/spec/claims/app/x.md", "# §app/x\n\nX now does two things.\n");
    put(r, ".sova/spec/claims/app/new.md", "# §app/new\n\nNew.\n");
    put(r, ".sova/spec/claims/app/new.json", "{}\n");
    put(r, ".sova/spec/manifest.json", "{\"formatVersion\":2,\"x\":1}\n");
    unlinkSync(join(r, ".sova/spec/claims/app/x.json"));
    expect(T(r)).toBe(t0);
    git(r, "add", "-A");
    git(r, "commit", "-qm", "Spec: land x");
    expect(T(r)).toBe(t0); // a landing's docs commit
  });

  test("every other spec path, and look-alikes of the excluded ones, move T", TO, () => {
    for (const rel of [".sova/spec/README.md", ".sova/spec/USAGE.md", ".sova/spec/claims.md", ".sova/spec/manifest.json.bak", ".sova/spec/drafts/d/spec/manifest.json", "sub/.sova/spec/claims/a.md", ".sova/spec/claimsx/a.md", ".sova/project.json"]) {
      const r = repo();
      const t0 = T(r);
      put(r, rel, "changed\n");
      expect({ rel, moved: T(r) !== t0 }).toEqual({ rel, moved: true });
    }
  });

  test("isExcluded agrees with T on the boundary", TO, () => {
    expect(isExcluded(".sova/spec/claims/app/x.md")).toBe(true);
    expect(isExcluded(".sova/spec/manifest.json")).toBe(true);
    expect(isExcluded(".sova/spec/README.md")).toBe(false);
    expect(isExcluded("x/.sova/spec/manifest.json")).toBe(false);
    expect(isExcluded(".sova/spec/claims")).toBe(false); // a file of that name is not the folder
  });

  test("a gitignored file is outside T (a known blind spot, kept on purpose)", TO, () => {
    const r = repo();
    const t0 = T(r);
    put(r, "ignored/x", "1\n");
    expect(T(r)).toBe(t0);
  });
});

describe("context C: only run-stable settings count", () => {
  const tools = { bun: "1+a", node: "v1", git: "g", python: "p", platform: "linux", arch: "x64" };
  const env = { LANG: "C.UTF-8", SOVA_PRICES_FETCH: "off" };
  const C = (e: Record<string, string>, extra: Partial<Parameters<typeof contextHash>[0]> = {}) => contextHash({ tier: "unit", env: e, tools, packages: "p", ...extra });

  test("per-run values never change the key (a key that changes every run reuses nothing)", TO, () => {
    const c0 = C(env);
    for (const [k, v] of Object.entries({
      HOME: "/tmp/h1", TMPDIR: "/tmp/t1", TMP: "/tmp/t1", TEMP: "/tmp/t1", PATH: "/x:/y", SOVA_CHAT_SLICE: "sova_test_1_ab.slice",
      SOVA_TEST_HOME: "/tmp/r", SOVA_TEST_RUNNER_PID: "123", SOVA_TEST_GUARD_DIR: "/tmp/g", SOVA_FRESH: "1", SOVA_REUSE_SAMPLE: "0.05",
      TEST_BUN_JOBS: "3", TEST_INT_JOBS: "2", SOVA_TEST_SHARED_TMP: "/tmp/s", XDG_RUNTIME_DIR: "/run/user/1000", GIT_CEILING_DIRECTORIES: "/tmp", SOVA_OUT: "/tmp/o.json",
    })) expect({ k, same: C({ ...env, [k]: v }) === c0 }).toEqual({ k, same: true });
  });

  test("credentials never reach the key", TO, () => {
    const c0 = C(env);
    for (const k of ["GH_TOKEN", "ANTHROPIC_API_KEY", "MISE_GITHUB_TOKEN", "DEPLOY_TOKEN", "SOVA_TOKEN", "MK_SHARE_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SOVA_PASSWORD"]) {
      expect({ k, credential: CREDENTIAL_ENV.test(k) }).toEqual({ k, credential: true });
      expect({ k, same: C({ ...env, [k]: "x" }) === c0 }).toEqual({ k, same: true });
      expect(Object.keys(keyedEnv({ ...env, [k]: "x" }))).not.toContain(k);
    }
  });

  test("a setting that changes what tests do changes the key", TO, () => {
    const c0 = C(env);
    for (const [k, v] of Object.entries({ SOVA_GOLDEN_MODE: "record", SOVA_TEST_GUARD: "report", TEST_FILE_LIMIT_MS: "1000", LANG: "de_DE.UTF-8", SLOW: "1" }))
      expect({ k, moved: C({ ...env, [k]: v }) !== c0 }).toEqual({ k, moved: true });
    expect(C(env, { flags: ["--timeout=1000"] })).not.toBe(c0);
    expect(C(env, { flags: ["-t", "one name"] })).not.toBe(c0);
    expect(C(env, { pass: "browser" })).not.toBe(c0);
    expect(C(env, { tier: "integration" })).not.toBe(c0);
    expect(C(env, { packages: "q" })).not.toBe(c0);
    expect(C(env, { tools: { ...tools, bun: "1+b" } })).not.toBe(c0);
    expect(C(env, { facts: { systemd: false } })).not.toBe(C(env, { facts: { systemd: true } }));
  });
});

describe("the store: only clean passes are kept, and a contradicted one goes", () => {
  const fresh = () => {
    const r = repo();
    return { store: storeDir(r) as string, tree: T(r) };
  };

  test("a failure, a skip, a file with no passing test or a missing count is never recorded", TO, () => {
    const { store, tree } = fresh();
    const w = record({
      store, context: "c1", tree, runId: "r1", by: { branch: "b", worktree: "w" },
      files: {
        "fail.test.ts": { pass: 3, skip: 0, fail: 1, ms: 1 },
        "skip.test.ts": { pass: 3, skip: 1, ms: 1 },
        "allskip.test.ts": { pass: 0, skip: 4, ms: 1 },
        "empty.test.ts": { pass: 0, skip: 0, ms: 1 },
        "ok.test.ts": { pass: 2, skip: 0, ms: 1 },
      },
    });
    expect(w).toBeTruthy();
    const { hits, misses } = lookup({ store, context: "c1", tree, files: ["fail.test.ts", "skip.test.ts", "allskip.test.ts", "empty.test.ts", "ok.test.ts"] });
    expect([...hits.keys()]).toEqual(["ok.test.ts"]);
    expect([...misses.keys()].sort()).toEqual(["allskip.test.ts", "empty.test.ts", "fail.test.ts", "skip.test.ts"]);
  });

  test("a record is found only under its own context and tree, and says why not otherwise", TO, () => {
    const { store, tree } = fresh();
    record({ store, context: "c1", tree, runId: "r1", by: null, files: { "a.test.ts": { pass: 1, skip: 0, ms: 1 } } });
    expect(lookup({ store, context: "c1", tree, files: ["a.test.ts"] }).hits.has("a.test.ts")).toBe(true);
    expect(lookup({ store, context: "c2", tree, files: ["a.test.ts"] }).misses.get("a.test.ts")).toBe("settings differ");
    expect(lookup({ store, context: "c1", tree: "other", files: ["a.test.ts"] }).misses.get("a.test.ts")).toBe("code changed");
    expect(lookup({ store, context: "c1", tree, files: ["b.test.ts"] }).misses.get("b.test.ts")).toBe("not passed before");
  });

  test("a contradicted source run's records are gone for good (a failed re-check heals the store)", TO, () => {
    const { store, tree } = fresh();
    record({ store, context: "c1", tree, runId: "r1", by: null, files: { "a.test.ts": { pass: 1, skip: 0, ms: 1 }, "b.test.ts": { pass: 1, skip: 0, ms: 1 } } });
    record({ store, context: "c1", tree, runId: "r2", by: null, files: { "b.test.ts": { pass: 1, skip: 0, ms: 1 } } });
    const hit = lookup({ store, context: "c1", tree, files: ["a.test.ts", "b.test.ts"] }).hits;
    expect(hit.get("b.test.ts")!.sources.sort()).toEqual(["r1", "r2"]);
    dropRuns({ store, runIds: hit.get("b.test.ts")!.sources });
    const after = lookup({ store, context: "c1", tree, files: ["a.test.ts", "b.test.ts"] });
    expect(after.hits.size).toBe(0);
  });

  test("a torn or foreign batch reads as no record", TO, () => {
    const { store, tree } = fresh();
    const p = record({ store, context: "c1", tree, runId: "r1", by: null, files: { "a.test.ts": { pass: 1, skip: 0, ms: 1 } } }) as string;
    writeFileSync(p, "{\"v\":1,\"files\":");
    expect(lookup({ store, context: "c1", tree, files: ["a.test.ts"] }).hits.size).toBe(0);
    writeFileSync(p, JSON.stringify({ v: 1, files: { "a.test.ts": { pass: 1, skip: 2 } } }));
    expect(lookup({ store, context: "c1", tree, files: ["a.test.ts"] }).hits.size).toBe(0);
  });
});

describe("the random re-check", () => {
  const items = Array.from({ length: 980 }, (_, i) => `f${i}.test.ts`);
  test("about 1 in 20, at least one, seeded by the run (another run picks other files)", TO, () => {
    const a = sample(items, { seed: "run-a", fraction: 0.05 });
    expect(a.length).toBe(49);
    expect(sample(items, { seed: "run-a", fraction: 0.05 })).toEqual(a);
    const b = sample(items, { seed: "run-b", fraction: 0.05 });
    expect(JSON.stringify(b) !== JSON.stringify(a)).toBe(true);
    expect(sample(["only.test.ts"], { seed: "x", fraction: 0.05 })).toEqual(["only.test.ts"]);
    expect(sample(items.slice(0, 3), { seed: "x", fraction: 0.05 }).length).toBe(1);
  });
});

describe("mid-run edits: a file keeps its pass only if no edit could have reached it", () => {
  const tick = () => {
    const t = Date.now();
    while (Date.now() <= t) { /* the next millisecond */ }
  };
  test("no edit: kept; an edit inside the window: dropped, even with no sample inside the window", TO, () => {
    let cur = "A";
    const w = createTreeWatch("/nowhere", { intervalMs: 0, fingerprint: () => cur });
    tick();
    const s1 = Date.now();
    tick();
    const e1 = Date.now();
    tick();
    w.sample(); // a sample between the two files
    tick();
    const s2 = Date.now();
    tick();
    cur = "B"; // an edit while file 2 runs, no sample until after it ends
    tick();
    const e2 = Date.now();
    tick();
    w.stop();
    expect(w.cleanBetween(s1, e1)).toBe(true);
    expect(w.cleanBetween(s2, e2)).toBe(false);
  });

  test("an edit made while the closing sample is still hashing does not let it vouch for a file that ended after the edit", TO, () => {
    // A sample reads the tree over some milliseconds (~20 ms on Sova). Content read before an edit, stamped
    // after the file ended, would say the file's window was clean.
    let cur = "A";
    let during: (() => void) | null = null;
    let s = 0;
    let e = 0;
    const w = createTreeWatch("/nowhere", {
      intervalMs: 0,
      fingerprint: () => {
        const seen = cur; // the tree as read when hashing started
        during?.();
        return seen;
      },
    });
    tick();
    s = Date.now();
    tick();
    during = () => {
      cur = "B"; // the edit lands mid-hash...
      tick();
      e = Date.now(); // ...and the file ends before the hash is done
      tick();
    };
    w.stop();
    expect(w.cleanBetween(s, e)).toBe(false);
  });
});

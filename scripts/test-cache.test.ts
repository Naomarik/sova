// Run: pnpm test scripts/test-cache.test.ts. The test-results store's core (scripts/test-cache.mjs): the tree
// fingerprint T, the context C, the store (record, union lookup, miss reasons, dropping contradicted
// batches, prune) and the seeded re-check sample.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "../server/test-scratch";
import {
  contextHash,
  createTreeWatch,
  dropRuns,
  fingerprintEntries,
  isExcluded,
  keyedEnv,
  lookup,
  newRunId,
  packagesHash,
  prune,
  record,
  reuseRefusal,
  sample,
  storeDir,
  treeFingerprint,
} from "./test-cache.mjs";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo() {
  const root = scratchRoot("test-cache-");
  roots.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".sova/spec/claims/app"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, ".sova/spec/claims/app/x.md"), "# x\n");
  writeFileSync(join(root, ".sova/spec/manifest.json"), "{}\n");
  writeFileSync(join(root, ".sova/spec/README.md"), "docs\n");
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const T = () => treeFingerprint(root).hash;
  return { root, git, T };
}

describe("the tree fingerprint", () => {
  test("is stable, and an edit, a new untracked file, a mode change or a deletion moves it; undoing restores it", () => {
    const { root, T } = repo();
    const t0 = T();
    assert.equal(T(), t0, "same tree, same fingerprint");
    writeFileSync(join(root, "src/a.ts"), "export const a = 9;\n");
    const edited = T();
    assert.notEqual(edited, t0, "an uncommitted edit");
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    assert.equal(T(), t0, "content back: fingerprint back");
    writeFileSync(join(root, "src/new.ts"), "x\n");
    assert.notEqual(T(), t0, "an untracked file");
    rmSync(join(root, "src/new.ts"));
    chmodSync(join(root, "src/b.ts"), 0o755);
    assert.notEqual(T(), t0, "a worktree mode change");
    chmodSync(join(root, "src/b.ts"), 0o644);
    assert.equal(T(), t0);
    rmSync(join(root, "src/b.ts"));
    assert.notEqual(T(), t0, "a deleted file");
  });

  test("committing an edit changes nothing: an uncommitted file and the same file committed fingerprint alike", () => {
    const { root, git, T } = repo();
    writeFileSync(join(root, "src/a.ts"), "export const a = 3;\n");
    writeFileSync(join(root, "src/c.ts"), "c\n");
    const dirty = T();
    git("add", "-A");
    assert.equal(T(), dirty, "staged");
    git("commit", "-q", "-m", "c");
    assert.equal(T(), dirty, "committed");
  });

  test("a file `git rm --cached` but still on disk still counts, and its content still moves T", () => {
    const { root, git, T } = repo();
    const t0 = T();
    git("rm", "-q", "--cached", "src/a.ts");
    assert.ok(fingerprintEntries(root).has("src/a.ts"), "listed (as untracked)");
    assert.equal(T(), t0, "same files on disk: same fingerprint");
    writeFileSync(join(root, "src/a.ts"), "changed\n");
    assert.notEqual(T(), t0);
  });

  test("spec claims, the manifest and .merge_file_* leftovers are left out; other spec files and ignored files as git says", () => {
    const { root, T } = repo();
    const t0 = T();
    writeFileSync(join(root, ".sova/spec/claims/app/x.md"), "# changed\n");
    writeFileSync(join(root, ".sova/spec/claims/app/new.md"), "# new\n");
    writeFileSync(join(root, ".sova/spec/manifest.json"), '{"v":2}\n');
    writeFileSync(join(root, "src/.merge_file_aB12cd"), "leftover\n");
    writeFileSync(join(root, ".merge_file_x"), "leftover\n");
    mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored/big.bin"), "ignored\n");
    assert.equal(T(), t0);
    writeFileSync(join(root, ".sova/spec/README.md"), "other docs\n");
    assert.notEqual(T(), t0, "a spec file landing doesn't write still counts");
    assert.ok(isExcluded(".sova/spec/claims/a/b.json"));
    assert.ok(!isExcluded(".sova/spec/claims.md"));
    assert.ok(!isExcluded(".sova/spec/manifest.json.bak"));
  });

  test("newline and space in file names, and symlinks, are hashed", () => {
    const { root, T } = repo();
    const t0 = T();
    writeFileSync(join(root, "src/odd\nname .ts"), "1\n");
    const t1 = T();
    assert.notEqual(t1, t0);
    assert.ok(fingerprintEntries(root).has("src/odd\nname .ts"));
    writeFileSync(join(root, "src/odd\nname .ts"), "2\n");
    assert.notEqual(T(), t1);
    symlinkSync("a.ts", join(root, "src/link"));
    const t2 = T();
    rmSync(join(root, "src/link"));
    symlinkSync("b.ts", join(root, "src/link"));
    assert.notEqual(T(), t2, "the link's target is its content");
  });

  test("an edit to a tracked file git status skips (assume-unchanged, skip-worktree) still moves T", () => {
    const { root, git, T } = repo();
    const t0 = T();
    git("update-index", "--assume-unchanged", "src/a.ts");
    git("update-index", "--skip-worktree", "src/b.ts");
    assert.equal(T(), t0, "flags alone change nothing");
    writeFileSync(join(root, "src/a.ts"), "hidden edit\n");
    const t1 = T();
    assert.notEqual(t1, t0);
    writeFileSync(join(root, "src/b.ts"), "hidden edit\n");
    assert.notEqual(T(), t1);
  });

  test("writes nothing to the object store", () => {
    const { root, T } = repo();
    writeFileSync(join(root, "src/fresh.ts"), "never hashed by git\n");
    const objects = () => execFileSync("git", ["count-objects", "-v"], { cwd: root, encoding: "utf8" });
    const before = objects();
    T();
    assert.equal(objects(), before);
  });
});

describe("the context", () => {
  const tools = { bun: "1+r", node: "v24", git: "2", python: "3", platform: "linux", arch: "x64" };
  test("run-varying env and credentials don't move it; a keyed setting, the tier, the pass, a flag, a tool or the packages do", () => {
    const base = { tier: "unit", flags: ["--timeout=60000"], env: { NODE_ENV: "test", SOVA_X: "1" }, tools, packages: "d" };
    const c = contextHash(base);
    const noisy = { ...base.env, HOME: "/tmp/h1", TMPDIR: "/tmp/t1", PATH: "/a:/b", SOVA_CHAT_SLICE: "s", SOVA_FRESH: "1", SOVA_REUSE_SAMPLE: "0.05", TEST_BUN_JOBS: "3", SOVA_TEST_SHARED_TMP: "/x", XDG_RUNTIME_DIR: "/run/user/1", SOVA_TEST_RUNNER_PID: "9", GH_TOKEN: "t", ANTHROPIC_API_KEY: "k" };
    assert.equal(contextHash({ ...base, env: noisy }), c);
    assert.deepEqual(Object.keys(keyedEnv(noisy)), ["NODE_ENV", "SOVA_X"]);
    for (const name of ["TLS_KEY", "SOVA_JEV_KEY", "MY_SECRET", "DB_PASSWORD", "X_AUTH", "GITHUB_TOKEN", "AWS_CREDENTIALS"])
      assert.deepEqual(keyedEnv({ [name]: "x" }), {}, `${name} is never keyed`);
    assert.notEqual(contextHash({ ...base, env: { ...base.env, SOVA_X: "2" } }), c);
    assert.notEqual(contextHash({ ...base, env: { ...base.env, SOVA_GOLDEN_MODE: "record" } }), c);
    assert.notEqual(contextHash({ ...base, tier: "integration" }), c);
    assert.notEqual(contextHash({ ...base, pass: "browser" }), c);
    assert.notEqual(contextHash({ ...base, flags: ["--timeout=5000"] }), c);
    assert.notEqual(contextHash({ ...base, tools: { ...tools, bun: "1+s" } }), c);
    assert.notEqual(contextHash({ ...base, packages: "e" }), c);
    assert.notEqual(contextHash({ ...base, facts: { systemd: true } }), c);
    assert.throws(() => contextHash({ ...base, packages: null }), /no installed packages/, "no node_modules: never keyed");
  });

  test("the packages hash ignores prunedAt and storeDir, and follows what is installed", () => {
    const root = scratchRoot("test-cache-nm-");
    roots.push(root);
    assert.equal(packagesHash(root), null, "no node_modules");
    mkdirSync(join(root, "node_modules/.pnpm"), { recursive: true });
    const modules = (pruned: string, store: string, layout = "1") => `{\n  "layoutVersion": ${layout},\n  "prunedAt": "${pruned}",\n  "storeDir": "${store}"\n}\n`;
    writeFileSync(join(root, "node_modules/.modules.yaml"), modules("Mon", "/a"));
    writeFileSync(join(root, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: 9\n");
    const d = packagesHash(root);
    writeFileSync(join(root, "node_modules/.modules.yaml"), modules("Tue", "/b"));
    assert.equal(packagesHash(root), d);
    writeFileSync(join(root, "node_modules/.modules.yaml"), modules("Tue", "/b", "2"));
    assert.notEqual(packagesHash(root), d);
    writeFileSync(join(root, "node_modules/.modules.yaml"), modules("Tue", "/b"));
    writeFileSync(join(root, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: 10\n");
    assert.notEqual(packagesHash(root), d);
  });
});

describe("the store", () => {
  const C = "c".repeat(64);
  const C2 = "d".repeat(64);
  const T1 = "1".repeat(64);
  const T2 = "2".repeat(64);
  const fresh = () => {
    const s = scratchRoot("test-cache-store-");
    roots.push(s);
    return join(s, "v1");
  };

  test("lives in the git common dir, shared by a worktree", () => {
    const { root, git } = repo();
    const s = storeDir(root);
    assert.equal(s, join(root, ".git", "sova-test-results", "v1"));
    const wt = join(root, "..", `${root.split("/").pop()}-wt`);
    roots.push(wt);
    git("worktree", "add", "-q", "--detach", wt);
    assert.equal(storeDir(wt), s);
  });

  test("round-trips passes only, unions batches, and says why each other file missed", () => {
    const store = fresh();
    const by = { branch: "feat/x", worktree: "x" };
    const r1 = newRunId();
    const r2 = newRunId();
    assert.ok(r1 < r2 || r1.slice(0, 9) === r2.slice(0, 9), "run ids sort by time");
    record({ store, context: C, tree: T1, runId: r1, by, at: "2026-11-05T10:00:00Z", files: { "a.test.ts": { pass: 3, skip: 0, ms: 10 }, "f.test.ts": { pass: 2, fail: 1, skip: 0 }, "s.test.ts": { pass: 2, skip: 1 }, "z.test.ts": { pass: 0, skip: 0 } } });
    record({ store, context: C, tree: T1, runId: r2, by, at: "2026-11-05T11:00:00Z", files: { "a.test.ts": { pass: 3, skip: 0 }, "b.test.ts": { pass: 1, skip: 0 } } });
    record({ store, context: C2, tree: T1, runId: newRunId(), by, files: { "c.test.ts": { pass: 1, skip: 0 } } });
    record({ store, context: C, tree: T2, runId: newRunId(), by, files: { "d.test.ts": { pass: 1, skip: 0 } } });
    const all = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "f.test.ts", "s.test.ts", "z.test.ts", "n.test.ts"];
    const { hits, misses } = lookup({ store, context: C, tree: T1, files: all });
    assert.deepEqual([...hits.keys()].sort(), ["a.test.ts", "b.test.ts"]);
    assert.equal(hits.get("a.test.ts")!.at, "2026-11-05T11:00:00Z", "the newest pass is shown");
    assert.deepEqual(hits.get("a.test.ts")!.sources.sort(), [r1, r2].sort(), "every batch it came from");
    assert.deepEqual(Object.fromEntries(misses), {
      "c.test.ts": "settings differ",
      "d.test.ts": "code changed",
      "f.test.ts": "not passed before",
      "s.test.ts": "not passed before",
      "z.test.ts": "not passed before",
      "n.test.ts": "not passed before",
    });
    assert.equal(record({ store, context: C, tree: T1, runId: newRunId(), by, files: { "f.test.ts": { pass: 1, fail: 1 } } }), null, "nothing passed: no batch");
    assert.ok(!readdirSync(join(store, C.slice(0, 2), C, T1)).some((n) => n.endsWith(".tmp")), "no tmp file left");
  });

  test("dropRuns deletes the contradicted batches, whatever key they sit under", () => {
    const store = fresh();
    const r = newRunId();
    record({ store, context: C, tree: T1, runId: r, by: null, files: { "a.test.ts": { pass: 1 }, "b.test.ts": { pass: 1 } } });
    record({ store, context: C2, tree: T2, runId: r, by: null, files: { "a.test.ts": { pass: 1 } } });
    record({ store, context: C, tree: T1, runId: newRunId(), by: null, files: { "b.test.ts": { pass: 1 } } });
    assert.equal(dropRuns({ store, runIds: [r] }), 2);
    const { hits } = lookup({ store, context: C, tree: T1, files: ["a.test.ts", "b.test.ts"] });
    assert.deepEqual([...hits.keys()], ["b.test.ts"], "another run's record of b stands");
  });

  test("prune: at most daily, drops batches over 14 days, then oldest first above the size cap", () => {
    const store = fresh();
    const now = Date.now();
    const DAY = 86_400_000;
    const at = (runId: string, ageDays: number, tree = T1) => {
      const p = record({ store, context: C, tree, runId, by: null, files: { [`${runId}.test.ts`]: { pass: 1 } } })!;
      const t = (now - ageDays * DAY) / 1000;
      utimesSync(p, t, t);
      return p;
    };
    const old = at("old", 15, T2);
    const mid = at("mid", 3);
    const recent = at("recent", 1);
    let r = prune({ store, now });
    assert.equal(r.ran, true);
    assert.ok(!existsSync(old), "15 days old: gone");
    assert.ok(!existsSync(join(store, C.slice(0, 2), C, T2)), "its empty key folder too");
    assert.ok(existsSync(mid) && existsSync(recent));
    assert.equal(prune({ store, now: now + 1000 }).ran, false, "not again the same day");
    r = prune({ store, now, force: true, maxBytes: statSync(recent).size });
    assert.ok(!existsSync(mid), "over the cap: oldest first");
    assert.ok(existsSync(recent));
  });
});

describe("the re-check sample", () => {
  const files = Array.from({ length: 980 }, (_, i) => `f${i}.test.ts`);
  test("is deterministic in the run id, about the fraction, at least one, in the caller's order", () => {
    const a = sample(files, { seed: "run-1", fraction: 0.05 });
    assert.deepEqual(sample(files, { seed: "run-1", fraction: 0.05 }), a);
    assert.equal(a.length, 49);
    assert.notDeepEqual(sample(files, { seed: "run-2", fraction: 0.05 }), a, "another run, another sample");
    assert.deepEqual(a, files.filter((f) => a.includes(f)));
    assert.equal(sample(files.slice(0, 3), { seed: "x", fraction: 0.05 }).length, 1, "at least one");
    assert.deepEqual(sample(files, { seed: "x", fraction: 0 }), [], "fraction 0: none");
    assert.deepEqual(sample([], { seed: "x", fraction: 0.05 }), []);
  });
});

describe("edits during a run", () => {
  test("a file's window is clean only when every sample bracketing it equals the start", () => {
    let h = "A";
    const w = createTreeWatch("/nowhere", { intervalMs: 0, fingerprint: () => h });
    const s0 = w.samples[0].at;
    w.samples.push({ at: s0 + 10, hash: "A" }, { at: s0 + 20, hash: "B" }, { at: s0 + 30, hash: "A" });
    h = "A";
    assert.equal(w.cleanBetween(s0 + 1, s0 + 9), true, "between two clean samples");
    assert.equal(w.cleanBetween(s0 + 11, s0 + 19), false, "the sample after its end saw the edit");
    assert.equal(w.cleanBetween(s0 + 15, s0 + 25), false, "overlaps the edit");
    assert.equal(w.cleanBetween(s0 + 21, s0 + 29), false, "the sample before its start saw the edit");
    assert.equal(w.cleanBetween(s0 + 31, s0 + 40), false, "no closing sample yet");
    w.samples.push({ at: s0 + 50, hash: "A" });
    assert.equal(w.cleanBetween(s0 + 31, s0 + 40), true);
  });
  test("stop takes the closing sample", () => {
    let n = 0;
    const w = createTreeWatch("/nowhere", { intervalMs: 0, fingerprint: () => (n++ ? "B" : "A") });
    w.stop();
    assert.equal(w.samples.length, 2);
    assert.equal(w.cleanBetween(w.samples[0].at, w.samples[0].at), false, "changed by the end");
  });
});

describe("who may reuse", () => {
  test("only Bun runs of the project's own files, never from inside a test", () => {
    assert.equal(reuseRefusal({ env: {}, runtime: "bun", files: ["a.test.ts"], root: "/r" }), null);
    assert.equal(reuseRefusal({ env: {}, runtime: "node", root: "/r" }), "not on Bun");
    assert.equal(reuseRefusal({ env: { SOVA_TEST_HOME: "/h" }, root: "/r" }), "started from inside a test");
    assert.equal(reuseRefusal({ env: { SOVA_TEST_RUNNER_PID: "1" }, root: "/r" }), "started from inside a test");
    assert.equal(reuseRefusal({ env: {}, files: ["/elsewhere/a.test.ts"], root: "/r" }), "files outside the project");
    assert.equal(reuseRefusal({ env: {}, files: ["../x.test.ts"], root: "/r" }), "files outside the project");
  });
});

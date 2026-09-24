import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compactProcessed, execBounded, INDEX_TTL_MS, listProjectFiles, MAX_INDEX_FILES, REQUEST_BUDGET_MS, type FilesDeps } from "./files";
import { targetsRoot } from "./targets";

/** A small tree: files at the root, one nested dir, ignored dirs at two depths. */
async function tree(spec: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-files-"));
  for (const [rel, body] of Object.entries(spec)) {
    const full = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

/** No git, no remote reading: the seams a synthetic-tree test doesn't want to touch. */
const noGit: FilesDeps = { exec: async () => ({ code: 128, stdout: "", truncated: false }), remoteOf: () => null };
/** The same, for a root that exists only in the test's own listDir. */
const synthetic: FilesDeps = { ...noGit, isDirectory: async () => true };
/** A fresh absolute path nothing else in this file (or a previous run) has cached. */
let n = 0;
const fakeRoot = () => `/pi-files-synthetic/${process.pid}/${Date.now()}/${n++}`;

test("walk lists files relative and '/'-separated, ignoring the default set at every depth", async () => {
  const root = await tree({
    "README.md": "x",
    "src/main.ts": "x",
    "src/lib/util.ts": "x",
    "src/node_modules/skip.js": "x",
    "node_modules/skip.js": "x",
    ".git/config": "x",
    ".github/workflows/ci.yml": "x",
  });
  try {
    const r = await listProjectFiles(root, noGit);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.index, {
      files: [".github/workflows/ci.yml", "README.md", "src/lib/util.ts", "src/main.ts"],
      truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git output is the index verbatim (tracked + untracked, gitignore already applied)", async () => {
  const root = await tree({ "README.md": "x" });
  try {
    const r = await listProjectFiles(root, {
      remoteOf: () => null,
      exec: async (argv, opts) => {
        assert.equal(argv[0], "git");
        assert.deepEqual(argv.slice(1, 3), ["-C", root]);
        assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= REQUEST_BUDGET_MS, "git's timeout comes out of the request budget");
        return { code: 0, stdout: "src/a.ts\0src/b.ts\0README.md\0", truncated: false };
      },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.index, { files: ["README.md", "src/a.ts", "src/b.ts"], truncated: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git output cut at the byte cap drops the half-path and reports the index partial", async () => {
  const root = await tree({ "README.md": "x" });
  try {
    const r = await listProjectFiles(root, {
      remoteOf: () => null,
      // A killed child's exit code is not a verdict on the command: the partial output still counts.
      exec: async () => ({ code: -1, stdout: "src/a.ts\0src/b.ts\0src/half-writ", truncated: true }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.index, { files: ["src/a.ts", "src/b.ts"], truncated: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a git failure falls back to the walk", async () => {
  const root = await tree({ "a.ts": "x", "b.ts": "x" });
  try {
    const r = await listProjectFiles(root, { remoteOf: () => null, exec: async () => ({ code: 1, stdout: "", truncated: false }) });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.index.files, ["a.ts", "b.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cap cuts the index and flags it truncated", async () => {
  const root = await tree({ a: "x", b: "x", c: "x", d: "x", e: "x" });
  try {
    const r = await listProjectFiles(root, { ...noGit, max: 3 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.index.files.length, 3);
    assert.equal(r.index.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default cap and request budget are the exported constants", () => {
  assert.equal(MAX_INDEX_FILES, 20_000);
  assert.equal(REQUEST_BUDGET_MS, 6_000);
});

// ---------------------------------------------------------------------------
// the bounded walk

test("the walk stops gathering at the cap instead of collecting everything first", async () => {
  // A tree deep and wide enough that gather-then-slice would read thousands of directories.
  let listed = 0;
  const listDir = async (p: string) => {
    listed++;
    const depth = p.split("/").length;
    return [
      ...Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.ts`, dir: false })),
      ...(depth < 30 ? Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, dir: true })) : []),
    ];
  };
  const r = await listProjectFiles(fakeRoot(), { ...synthetic, listDir, max: 25 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.index.files.length, 25);
  assert.equal(r.index.truncated, true);
  assert.ok(listed <= 4, `stopped after ${listed} directories, not after the whole tree`);
});

test("a tree wider than the pending-directory cap is listed partially, not queued without bound", async () => {
  const listDir = async (p: string) =>
    p.endsWith("/root")
      ? Array.from({ length: 25_000 }, (_, i) => ({ name: `d${i}`, dir: true }))
      : [{ name: "leaf.ts", dir: false }];
  const r = await listProjectFiles(`${fakeRoot()}/root`, { ...synthetic, listDir, max: 50 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.index.truncated, true, "a queue we had to cut means files and folders are missing");
});

// ---------------------------------------------------------------------------
// the request deadline

test("a folder that never answers is a 504, and the late result never reaches the cache", async () => {
  const root = fakeRoot();
  let late: (() => void) | null = null;
  const hung: FilesDeps = {
    ...synthetic,
    budgetMs: 40,
    listDir: () =>
      new Promise((res) => {
        late = () => res([{ name: "late.ts", dir: false }]);
      }),
  };
  const started = Date.now();
  const r = await listProjectFiles(root, hung);
  assert.ok(Date.now() - started < 2_000, "the deadline answered; it did not wait for the filesystem");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 504);

  (late as unknown as () => void)(); // the readdir we abandoned finally comes back
  await new Promise((res) => setTimeout(res, 20));

  // Nothing it produced was stored: the retry recomputes, and sees the folder as it is now.
  const retry = await listProjectFiles(root, { ...synthetic, listDir: async () => [{ name: "now.ts", dir: false }] });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.deepEqual(retry.index, { files: ["now.ts"], truncated: false });
});

test("a walk the deadline cuts short keeps what it has, flags it partial, and is not cached", async () => {
  const root = fakeRoot();
  let listed = 0;
  const slow: FilesDeps = {
    ...synthetic,
    budgetMs: 120,
    // Each level costs 30ms and offers another level: the budget runs out long before the walk does.
    listDir: async () => {
      listed++;
      await new Promise((res) => setTimeout(res, 30));
      return [{ name: "a.ts", dir: false }, { name: "deeper", dir: true }];
    },
  };
  const r = await listProjectFiles(root, slow);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.index.files.includes("a.ts"));
  assert.equal(r.index.truncated, true);
  const before = listed;
  // Not cached: the next open reads the folder again rather than serving a partial list for 30s.
  await listProjectFiles(root, { ...synthetic, listDir: async () => [{ name: "b.ts", dir: false }] });
  assert.ok(listed === before, "the retry used its own listDir, so the partial answer was not served");
  const fresh = await listProjectFiles(root, { ...synthetic, listDir: async () => [{ name: "c.ts", dir: false }] });
  assert.equal(fresh.ok, true);
});

test("concurrent callers share one in-flight computation, and it is released when it settles", async () => {
  const root = fakeRoot();
  let calls = 0;
  const deps: FilesDeps = {
    ...synthetic,
    listDir: async () => {
      calls++;
      await new Promise((res) => setTimeout(res, 20));
      return [{ name: "a.ts", dir: false }];
    },
  };
  const [one, two] = await Promise.all([listProjectFiles(root, deps), listProjectFiles(root, deps)]);
  assert.equal(calls, 1);
  assert.deepEqual(one, two);
  // Released: a caller past the TTL computes again rather than awaiting a promise nobody owns.
  const later = await listProjectFiles(root, { ...deps, now: () => Date.now() + INDEX_TTL_MS * 2 });
  assert.equal(later.ok, true);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// what the root's own failure means

test("the root's failure says which failure it was, and never an empty success", async () => {
  const bad = await listProjectFiles("relative/path");
  assert.deepEqual(bad, { ok: false, status: 400, error: "cwd must be an absolute path" });
  assert.deepEqual(await listProjectFiles(undefined), bad);

  const denied = await listProjectFiles(fakeRoot(), {
    ...noGit, // the real stat seam is what these three are about
    isDirectory: async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 403);

  const missing = await listProjectFiles("/definitely/not/here");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);

  const odd = await listProjectFiles(fakeRoot(), {
    ...noGit,
    isDirectory: async () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    },
  });
  assert.equal(odd.ok, false);
  if (!odd.ok) {
    assert.equal(odd.status, 500);
    assert.match(odd.error, /EIO/);
  }

  const file = path.join(tmpdir(), `pi-files-file-${process.pid}`);
  await writeFile(file, "x");
  try {
    const r2 = await listProjectFiles(file, noGit);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.status, 404);
  } finally {
    await rm(file, { force: true });
  }
});

// ---------------------------------------------------------------------------
// cwds whose files aren't on this machine

test("a remote session's cwd is refused, before any filesystem call", async () => {
  let touched = 0;
  const watched: FilesDeps = {
    ...noGit,
    remoteOf: undefined, // the real targets.ts reading
    isDirectory: async () => {
      touched++;
      return true;
    },
    listDir: async () => {
      touched++;
      return [];
    },
  };
  const remote = await listProjectFiles(path.join(targetsRoot(), "box-1", "srv", "app"), watched);
  assert.equal(remote.ok, false);
  if (!remote.ok) {
    assert.equal(remote.status, 501);
    assert.match(remote.error, /box-1/);
    assert.doesNotMatch(remote.error, /mount/i, "the mount seam is gone: nothing tells the user to turn one on");
    assert.doesNotMatch(remote.error, /start|instead|browse/i, "a new remote session is refused the same way: promise nothing");
  }
  assert.equal(touched, 0, "a dead sshfs mount is never stat'ed");
});

// ---------------------------------------------------------------------------
// the cache

test("the index is cached for the TTL and recomputed once stale", async () => {
  const root = await tree({ "a.ts": "x" });
  let clock = 1_000;
  let calls = 0;
  const exec = async () => {
    calls++;
    return { code: 0, stdout: "a.ts\0", truncated: false };
  };
  try {
    const first = await listProjectFiles(root, { remoteOf: () => null, exec, now: () => clock });
    assert.equal(calls, 1);
    assert.deepEqual(first.ok && first.index.files, ["a.ts"]);
    await listProjectFiles(root, { remoteOf: () => null, exec, now: () => clock }); // same instant: cached
    assert.equal(calls, 1);
    clock += INDEX_TTL_MS; // exactly stale: recompute
    await listProjectFiles(root, { remoteOf: () => null, exec, now: () => clock });
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// execBounded itself — a real subprocess, because a stubbed exec proves none of this

const node = process.execPath;

test("execBounded decodes one character split across two stdout chunks", async () => {
  // "…" is 3 bytes; the child writes the first byte of it in one chunk and the rest in another,
  // which is what a decode-per-chunk implementation turns into replacement characters.
  const src = `const b = Buffer.from("a…b", "utf8");
    process.stdout.write(b.subarray(0, 2));
    setTimeout(() => process.stdout.write(b.subarray(2)), 30);`;
  const r = await execBounded([node, "-e", src], { timeoutMs: 5_000, byteCap: 1024 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "a…b");
  assert.equal(r.truncated, false);
});

test("execBounded caps stdout by bytes before storing it, and says so", async () => {
  const r = await execBounded([node, "-e", `process.stdout.write("x".repeat(200_000))`], { timeoutMs: 5_000, byteCap: 1_000 });
  assert.equal(Buffer.byteLength(r.stdout), 1_000, "exactly the cap was kept — the over-limit chunk was never stored whole");
  assert.equal(r.truncated, true);
});

test("execBounded kills a child that outruns its timeout and rejects", async () => {
  const started = Date.now();
  await assert.rejects(
    execBounded([node, "-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 150, byteCap: 1024 }),
    /timed out/,
  );
  assert.ok(Date.now() - started < 5_000, "it answered at its timeout, not at the child's");
});

test("execBounded rejects when the binary isn't there", async () => {
  await assert.rejects(execBounded(["definitely-not-a-binary-xyz"], { timeoutMs: 1_000, byteCap: 16 }));
});

// ---------------------------------------------------------------------------
// the bounds the review found holes in

test("a root that stats as a folder but won't open is the answer, not an empty index", async () => {
  // A directory with --x and no r: stat succeeds, readdir raises EACCES. The walk used to skip it
  // like any other unreadable subtree and hand back a cheerful empty list.
  const denied = await listProjectFiles(fakeRoot(), {
    ...synthetic,
    listDir: async () => {
      throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
    },
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.status, 403);
    assert.equal(denied.error, "Sova can't read this folder");
  }
  // Gone between the stat and the readdir: still not an empty success.
  const vanished = await listProjectFiles(fakeRoot(), {
    ...synthetic,
    listDir: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(vanished.ok, false);
  if (!vanished.ok) assert.equal(vanished.status, 404);
});

test("a subtree that won't open is still skipped, and still doesn't make the index partial", async () => {
  const listDir = async (p: string) => {
    if (p.endsWith("/secret")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return [{ name: "a.ts", dir: false }, { name: "secret", dir: true }];
  };
  const r = await listProjectFiles(fakeRoot(), { ...synthetic, listDir });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.index, { files: ["a.ts"], truncated: false });
});

test("compactProcessed releases the processed prefix and leaves the pending entries alone", () => {
  const queue = Array.from({ length: 600 }, (_, i) => i);
  assert.equal(compactProcessed(queue, 511), 511, "below the threshold it costs nothing");
  assert.equal(queue.length, 600);
  const head = compactProcessed(queue, 512);
  assert.equal(head, 0);
  assert.equal(queue.length, 88, "the 512 processed entries are gone, the 88 pending ones remain");
  assert.deepEqual(queue.slice(0, 3), [512, 513, 514]);
});

test("a tree with far more directories than the compaction threshold is listed in full", async () => {
  // 5,000 sibling directories, each with a file: the walk processes them all, and holds nothing
  // like 5,000 queue entries while doing it.
  const listDir = async (p: string) =>
    p.endsWith("/root")
      ? Array.from({ length: 5_000 }, (_, i) => ({ name: `d${i}`, dir: true }))
      : [{ name: "leaf.ts", dir: false }];
  const r = await listProjectFiles(`${fakeRoot()}/root`, { ...synthetic, listDir });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.index.files.length, 5_000);
  assert.equal(r.index.truncated, false);
});

test("the depth limit omits everything below it, and the index says it is partial", async () => {
  // Every level offers one file and one deeper directory, for ever: the walk stops at its depth
  // limit, and what it hands back is missing whole subtrees.
  const listDir = async () => [{ name: "a.ts", dir: false }, { name: "deeper", dir: true }];
  const r = await listProjectFiles(fakeRoot(), { ...synthetic, listDir });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.index.files.length > 1, "it listed what it could reach");
  assert.equal(r.index.truncated, true, "a depth cut is a partial list, not a complete one");
});

test("a git that never answers can't hold the request open, and its late answer is dropped", async () => {
  const root = fakeRoot();
  let settleGit: ((r: { code: number; stdout: string; truncated: boolean }) => void) | null = null;
  const started = Date.now();
  const r = await listProjectFiles(root, {
    remoteOf: () => null,
    isDirectory: async () => true,
    budgetMs: 60,
    exec: () =>
      new Promise((res) => {
        settleGit = res;
      }),
    listDir: async () => [{ name: "walked.ts", dir: false }],
  });
  assert.ok(Date.now() - started < 2_000, "the request deadline answered, not git's own timer");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 504);

  (settleGit as unknown as (r: { code: number; stdout: string; truncated: boolean }) => void)({ code: 0, stdout: "ghost.ts\0", truncated: false });
  await new Promise((res) => setTimeout(res, 20));

  const retry = await listProjectFiles(root, { ...synthetic, listDir: async () => [{ name: "real.ts", dir: false }] });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.deepEqual(retry.index, { files: ["real.ts"], truncated: false }, "the ghost never reached the cache");
});

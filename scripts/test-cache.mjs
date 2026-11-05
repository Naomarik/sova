// Test results kept per file, keyed by exactly what the file ran on: the reusable core behind the
// runner's and the type check's "already passed on identical code" (scripts/run-tests.mjs,
// scripts/checked.mjs). Builtins only (plus the spec's own layout module for its paths), Node and Bun alike. It reads git, never writes to the object
// store or the index (`--no-optional-locks`), and writes only under its store directory.
//
// What a record proves: file F passed (fail 0, skip 0, pass > 0) under context C over tree T.
//
//   T  treeFingerprint(root): every file of the work tree as it is on disk, committed or not,
//      untracked included, gitignored left out, plus each file's mode. Tracked unmodified files take
//      their index blob id; modified and untracked files are hashed here, as git would (a blob id),
//      so an uncommitted file and the same file committed fingerprint alike. A file `git rm --cached`
//      but still on disk counts (status lists it untracked). Left out: SPEC_EXCLUDED (what landing
//      makes official, and only that) and `.merge_file_*` leftovers. -z throughout: newline-safe.
//   C  contextHash({...}): the tier and pass, runner flags after defaults, the run-stable part of the
//      test env (keyedEnv: RUN_UNSTABLE_ENV and credentials never count), tool versions
//      (toolVersions: bun version+revision, node, git, python, platform, arch; not os.release) and
//      the installed packages (packagesHash: pnpm's .modules.yaml minus prunedAt/storeDir, plus
//      .pnpm/lock.yaml), plus any `facts` (the integration tier's "systemd reachable").
//
// Blind spots (misses or the backstops cover them): gitignored files tests read (dist/, .agent/);
// hand edits inside node_modules; an untracked nested repository is keyed by its presence only; a
// tracked file's mode change where core.fileMode is false. Tracked files git status doesn't look at
// (assume-unchanged, skip-worktree) are hashed from disk.
//
// The store: <git common dir>/sova-test-results/v1/<C[0:2]>/<C>/<T>/<runId>.json, one batch per run
// and key, {v, at, by: {branch, worktree}, files: {<file>: {pass, skip, ms}}}: counts, a time and
// where it ran; no output, no env values. A lookup takes the union of every batch under <C>/<T>.
// Writes go to a tmp file then rename (no locks: two runs never write the same batch name). A failed
// re-check of a reused file deletes the batches it came from (dropRuns). prune() runs at most daily:
// batches older than 14 days, then oldest first above ~100 MB. Deleting the store costs only speed.
//
// API (all synchronous unless noted):
//   STORE_VERSION, SPEC_EXCLUDED, RUN_UNSTABLE_ENV, CREDENTIAL_ENV
//   isExcluded(path) → bool
//   treeFingerprint(root, {git?}) → {hash, entries, ms}
//   fingerprintEntries(root, {git?}) → Map<path, "mode oid">      (what hash is made of; tests/debug)
//   packagesHash(root) → hex | null      (null: no node_modules; contextHash throws on it: never reusable)
//   toolVersions({env?, bun?}) → {bun, node, git, python, platform, arch}   (cached per process)
//   systemdReachable(env?) → bool
//   keyedEnv(env) → sorted {name: value} without RUN_UNSTABLE_ENV / credentials
//   contextHash({tier, pass?, flags?, env?, tools, packages, facts?}) → hex
//   storeDir(root) → absolute path | null   (null: not a git checkout)
//   newRunId() → string (sortable: time + random)
//   runBy(root, env?) → {branch, worktree}
//   lookup({store, context, tree, files}) → {hits: Map<file, {at, by, runId, sources, pass, skip, ms}>,
//                                            misses: Map<file, MissReason>}
//       MissReason: "settings differ" (passed on this tree under other settings) | "code changed"
//       (passed under these settings on another tree) | "not passed before"; hits carry every
//       source batch (sources: [runId]) so a failed re-check can drop them all.
//   record({store, context, tree, runId, by, files: {file: {pass, skip, fail?, ms}}, at?}) → path|null
//       keeps only files with pass > 0, skip 0, fail 0; writes nothing when none qualifies.
//   dropRuns({store, runIds}) → number of batches deleted (every key dir)
//   prune({store, now?, maxAgeDays?, maxBytes?, force?}) → {ran, deleted, bytes}
//   sample(items, {seed, fraction?, min?}) → items subset (deterministic in seed; at least min of a
//       non-empty list; fraction 0 → none)
//   createTreeWatch(root, {intervalMs?, fingerprint?}) → {start, sample(), stop(), cleanBetween(a, b)}
//       samples T every intervalMs; cleanBetween(startMs, endMs) (Date.now() times) is true when every
//       sample from the last one at or before startMs to the first one after endMs equals the start
//       (call stop() first: it takes the closing sample).
//   reuseRefusal({env?, runtime?, files?, root}) → why | null  (a16/a17: no reuse and no save)
//   whenOf(at, now?) → "14:02" today, else "Nov 4 14:02" (local time)
//   sourceOf(by) → "feat/x's chat" | "an earlier landing run" | "an earlier run"
//   hitWording(hit, now?) → "already passed on identical code at 14:02 (feat/x's chat)": the SOVA_OUT
//       `skipped` text and the core of every summary line
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { claimsRootOf, DEFAULT_SPEC, ROOT_FILE } from "../pi-config/extensions/spec/core/layout.mjs";

export const STORE_VERSION = "v1";
/**
 * Paths landing makes official, and nothing else (a prefix ending in `/` covers a folder): the spec's
 * claims and its root file, named as the spec's own layout module names them (default claims root).
 */
export const SPEC_EXCLUDED = [`${DEFAULT_SPEC}/${claimsRootOf({})}/`, `${DEFAULT_SPEC}/${ROOT_FILE}`];
const MERGE_LEFTOVER = /(^|\/)\.merge_file_[^/]*$/;

export function isExcluded(p) {
  if (MERGE_LEFTOVER.test(p)) return true;
  return SPEC_EXCLUDED.some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x));
}

/** git with no GIT_DIR-like variable, so it reads the repo `cwd` is in, as git itself would. */
function gitEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE|PREFIX)$/.test(k)) delete out[k];
  out.GIT_OPTIONAL_LOCKS = "0";
  return out;
}

function git(root, args, gitBin = "git") {
  return execFileSync(gitBin, ["--no-optional-locks", ...args], { cwd: root, env: gitEnv(), maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
}

/** A blob id as git computes it, over `algo` (sha1 or sha256). */
function blobId(buf, algo) {
  return createHash(algo).update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/** [mode, oid] of a file on disk, or null when it is gone or a folder (an untracked nested repo). */
function hashOnDisk(abs, algo) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return ["120000", blobId(Buffer.from(fs.readlinkSync(abs)), algo)];
  if (st.isDirectory()) return ["040000", "dir"]; // a nested repo/submodule shows as a folder: keyed by presence
  if (!st.isFile()) return null;
  const mode = st.mode & 0o111 ? "100755" : "100644";
  return [mode, blobId(fs.readFileSync(abs), algo)];
}

/** The fingerprint's entries: path → "mode oid". */
export function fingerprintEntries(root, { git: gitBin = "git" } = {}) {
  const entries = new Map();
  // -v tags each entry: lowercase = assume-unchanged, S/s = skip-worktree. git status never looks at
  // those files, so their index blob may not be what is on disk: they are hashed from disk.
  const ls = git(root, ["ls-files", "-s", "-v", "-z"], gitBin).toString("utf8").split("\0");
  let algo = "sha1";
  const hidden = [];
  for (const rec of ls) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [tag, mode, oid, stage] = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    if (oid.length === 64) algo = "sha256";
    if (stage !== "0" || isExcluded(p)) continue; // an unmerged path is hashed from disk below
    if (tag === "S" || tag !== tag.toUpperCase()) hidden.push(p);
    else entries.set(p, `${mode} ${oid}`);
  }
  for (const p of hidden) {
    const h = hashOnDisk(path.join(root, p), algo);
    if (h) entries.set(p, `${h[0]} ${h[1]}`); // absent (a sparse checkout): no file a test could read
  }
  const st = git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"], gitBin)
    .toString("utf8")
    .split("\0");
  for (const rec of st) {
    if (!rec) continue;
    const kind = rec[0];
    let p;
    if (kind === "?") p = rec.slice(2);
    else if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path: worktree side unchanged (Y '.') → the index entry stands.
      const f = rec.split(" ");
      if (f[1][1] === ".") continue;
      p = f.slice(8).join(" ");
    } else if (kind === "u") p = rec.split(" ").slice(10).join(" ");
    else continue; // '!' (ignored) isn't asked for; '2' can't occur with --no-renames
    if (isExcluded(p)) continue;
    const h = hashOnDisk(path.join(root, p), algo);
    if (h) entries.set(p, `${h[0]} ${h[1]}`);
    else entries.delete(p); // deleted on disk: dropped
  }
  return entries;
}

export function treeFingerprint(root, opts = {}) {
  const t0 = performance.now();
  const entries = fingerprintEntries(root, opts);
  const keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const k of keys) h.update(k).update("\0").update(entries.get(k)).update("\0");
  return { hash: h.digest("hex"), entries: keys.length, ms: performance.now() - t0 };
}

/** pnpm's record of what is installed: .modules.yaml minus the run-varying prunedAt/storeDir, plus .pnpm/lock.yaml. */
export function packagesHash(root) {
  const nm = path.join(root, "node_modules");
  let modules;
  try {
    modules = fs.readFileSync(path.join(nm, ".modules.yaml"), "utf8");
  } catch {
    return null;
  }
  const stripped = modules
    .split("\n")
    .filter((l) => !/^\s*"?(prunedAt|storeDir)"?\s*:/.test(l))
    .join("\n");
  const h = createHash("sha256").update(stripped).update("\0");
  try {
    h.update(fs.readFileSync(path.join(nm, ".pnpm", "lock.yaml")));
  } catch {
    h.update("no lock");
  }
  return h.digest("hex");
}

let toolCache = null;
function versionOf(bin, args, env) {
  try {
    return execFileSync(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).toString().trim().split("\n")[0] || "none";
  } catch {
    return "none";
  }
}
/** The versions tests run on. `bun` is the Bun the runner chose; PATH comes from `env` (the test env's). */
export function toolVersions({ env = process.env, bun = "bun" } = {}) {
  const key = `${bun}\0${env.PATH ?? ""}`;
  if (toolCache?.key === key) return toolCache.value;
  const value = {
    bun: `${versionOf(bun, ["--version"], env)}+${versionOf(bun, ["--revision"], env)}`,
    node: versionOf("node", ["--version"], env),
    git: versionOf("git", ["--version"], env),
    python: versionOf("python3", ["--version"], env),
    platform: process.platform,
    arch: process.arch,
  };
  toolCache = { key, value };
  return value;
}

/** Whether a test could reach the user's systemd (the integration tier keys this fact, not XDG_RUNTIME_DIR's value). */
export function systemdReachable(env = process.env) {
  const dir = env.XDG_RUNTIME_DIR;
  if (!dir) return false;
  return fs.existsSync(path.join(dir, "systemd", "private")) || fs.existsSync(path.join(dir, "bus"));
}

/** Env names that differ between runs of the same code and so never enter the key (a18). */
export const RUN_UNSTABLE_ENV = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PATH", // as built by the runner; tool versions are keyed instead
  "PWD",
  "OLDPWD",
  "SOVA_CHAT_SLICE",
  "SOVA_TEST_HOME",
  "SOVA_TEST_RUNNER_PID",
  "SOVA_TEST_GUARD_DIR",
  "SOVA_TEST_AUDIT",
  "SOVA_FRESH",
  "SOVA_REUSE_SAMPLE",
  "SOVA_RUN_ID",
  "TEST_BUN_JOBS",
  "TEST_INT_JOBS",
  "SOVA_TEST_SHARED_TMP",
  "XDG_RUNTIME_DIR",
  "GIT_CEILING_DIRECTORIES",
  "SOVA_OUT",
];
/** Never keyed, whatever list a caller passes: credentials don't belong in a key or a test env. */
export const CREDENTIAL_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|AUTH|PRIVATE_KEY|SESSION_KEY)/i;

export function keyedEnv(env = {}) {
  const out = {};
  for (const k of Object.keys(env).sort()) {
    if (RUN_UNSTABLE_ENV.includes(k) || CREDENTIAL_ENV.test(k)) continue;
    if (env[k] === undefined) continue;
    out[k] = String(env[k]);
  }
  return out;
}

/** C: everything a record depends on but the tree and the file. Throws without packages (no node_modules: never keyed). */
export function contextHash({ tier, pass = "main", flags = [], env = {}, tools, packages, facts = {} }) {
  if (!tier) throw new Error("contextHash: tier is required");
  if (!tools) throw new Error("contextHash: tools is required");
  if (!packages) throw new Error("contextHash: no installed packages (no node_modules): nothing may be reused or recorded");
  const canon = JSON.stringify({ v: STORE_VERSION, tier, pass, flags: [...flags], env: keyedEnv(env), tools, packages, facts: sortObj(facts) });
  return createHash("sha256").update(canon).digest("hex");
}
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** The store folder of the repo `root` is in (shared by its worktrees and the merge copy), or null. */
export function storeDir(root) {
  try {
    const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
    return common ? path.join(common, "sova-test-results", STORE_VERSION) : null;
  } catch {
    return null;
  }
}

export function newRunId() {
  return `${Date.now().toString(36).padStart(9, "0")}-${randomBytes(5).toString("hex")}`;
}

export function runBy(root, env = process.env) {
  if (env.SOVA_MERGE_TIP || env.SOVA_MERGE_TARGET) return { branch: "merge copy", worktree: path.basename(root) };
  let branch = "detached";
  try {
    branch = git(root, ["symbolic-ref", "-q", "--short", "HEAD"]).toString().trim() || "detached";
  } catch {}
  return { branch, worktree: path.basename(root) };
}

const keyDir = (store, context, tree) => path.join(store, context.slice(0, 2), context, tree);

function readBatch(file) {
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    return b && b.v === 1 && b.files && typeof b.files === "object" ? b : null;
  } catch {
    return null; // a torn or foreign file counts as nothing
  }
}

function batchesIn(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json")).map((n) => ({ runId: n.slice(0, -5), file: path.join(dir, n) }));
}

const listFiles = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return []; // removed meanwhile by another prune or dropRuns
  }
};
const listDirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** Files a batch counts as passed (pass > 0, skip 0). */
const passedIn = (b) => Object.entries(b.files).filter(([, r]) => r && r.pass > 0 && !r.skip && !r.fail);

export function lookup({ store, context, tree, files }) {
  const hits = new Map();
  const misses = new Map();
  const want = new Set(files);
  if (store) {
    for (const { runId, file } of batchesIn(keyDir(store, context, tree))) {
      const b = readBatch(file);
      if (!b) continue;
      for (const [f, r] of passedIn(b)) {
        if (!want.has(f)) continue;
        const prev = hits.get(f);
        if (!prev) hits.set(f, { at: b.at, by: b.by, runId, sources: [runId], pass: r.pass, skip: r.skip ?? 0, ms: r.ms ?? 0 });
        else {
          prev.sources.push(runId);
          if (String(b.at) > String(prev.at)) Object.assign(prev, { at: b.at, by: b.by, runId, pass: r.pass, ms: r.ms ?? 0 });
        }
      }
    }
  }
  let rest = files.filter((f) => !hits.has(f));
  if (!rest.length) return { hits, misses };
  if (store) {
    // Same tree, other settings.
    const sameTree = new Set();
    for (const pre of listDirs(store))
      for (const c of listDirs(path.join(store, pre))) {
        if (c === context) continue;
        for (const { file } of batchesIn(path.join(store, pre, c, tree))) {
          const b = readBatch(file);
          if (b) for (const [f] of passedIn(b)) sameTree.add(f);
        }
      }
    // Same settings, another tree: the newest 50 batches are enough to say "code changed".
    const sameCtx = new Set();
    const cdir = path.join(store, context.slice(0, 2), context);
    const others = listDirs(cdir)
      .filter((t) => t !== tree)
      .flatMap((t) => batchesIn(path.join(cdir, t)))
      .sort((a, b) => (a.runId < b.runId ? 1 : -1))
      .slice(0, 50);
    for (const { file } of others) {
      const b = readBatch(file);
      if (b) for (const [f] of passedIn(b)) sameCtx.add(f);
    }
    for (const f of rest) misses.set(f, sameTree.has(f) ? "settings differ" : sameCtx.has(f) ? "code changed" : "not passed before");
  } else for (const f of rest) misses.set(f, "not passed before");
  return { hits, misses };
}

export function record({ store, context, tree, runId, by, files, at = new Date().toISOString() }) {
  if (!store) return null;
  const kept = {};
  for (const [f, r] of Object.entries(files ?? {})) {
    if (!r || !(r.pass > 0) || r.skip || r.fail) continue;
    kept[f] = { pass: r.pass, skip: 0, ms: Math.round(r.ms ?? 0) };
  }
  if (!Object.keys(kept).length) return null;
  const dir = keyDir(store, context, tree);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${runId}.json`);
  const tmp = path.join(dir, `.${runId}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, at, by: by ?? null, files: kept }));
  fs.renameSync(tmp, dest);
  return dest;
}

export function dropRuns({ store, runIds }) {
  if (!store || !runIds?.length) return 0;
  const names = new Set(runIds.map((r) => `${r}.json`));
  let n = 0;
  for (const pre of listDirs(store))
    for (const c of listDirs(path.join(store, pre)))
      for (const t of listDirs(path.join(store, pre, c)))
        for (const name of names) {
          try {
            fs.unlinkSync(path.join(store, pre, c, t, name));
            n++;
          } catch {}
        }
  return n;
}

const DAY = 86_400_000;
export function prune({ store, now = Date.now(), maxAgeDays = 14, maxBytes = 100 * 1024 * 1024, force = false }) {
  if (!store || !fs.existsSync(store)) return { ran: false, deleted: 0, bytes: 0 };
  const stamp = path.join(store, ".pruned");
  if (!force) {
    try {
      if (now - fs.statSync(stamp).mtimeMs < DAY) return { ran: false, deleted: 0, bytes: 0 };
    } catch {}
  }
  try {
    fs.writeFileSync(stamp, "");
    fs.utimesSync(stamp, now / 1000, now / 1000);
  } catch {}
  const all = [];
  for (const pre of listDirs(store))
    for (const c of listDirs(path.join(store, pre)))
      for (const t of listDirs(path.join(store, pre, c)))
        for (const name of listFiles(path.join(store, pre, c, t))) {
          const file = path.join(store, pre, c, t, name);
          try {
            const st = fs.statSync(file);
            all.push({ file, mtime: st.mtimeMs, size: st.size, tmp: name.endsWith(".tmp") });
          } catch {}
        }
  let deleted = 0;
  const gone = (f) => {
    try {
      fs.unlinkSync(f);
      deleted++;
    } catch {}
  };
  const cutoff = now - maxAgeDays * DAY;
  let keep = [];
  for (const e of all) {
    if (e.mtime < cutoff || (e.tmp && e.mtime < now - DAY)) gone(e.file);
    else keep.push(e);
  }
  keep.sort((a, b) => a.mtime - b.mtime);
  let bytes = keep.reduce((s, e) => s + e.size, 0);
  while (bytes > maxBytes && keep.length) {
    const e = keep.shift();
    gone(e.file);
    bytes -= e.size;
  }
  // Empty key folders go too.
  for (const pre of listDirs(store)) {
    for (const c of listDirs(path.join(store, pre))) {
      for (const t of listDirs(path.join(store, pre, c))) rmdirIfEmpty(path.join(store, pre, c, t));
      rmdirIfEmpty(path.join(store, pre, c));
    }
    rmdirIfEmpty(path.join(store, pre));
  }
  return { ran: true, deleted, bytes };
}
function rmdirIfEmpty(d) {
  try {
    fs.rmdirSync(d);
  } catch {}
}

/** A deterministic pick of about `fraction` of `items` (at least `min` of a non-empty list), seeded by `seed` (the run id). */
export function sample(items, { seed, fraction = 0.05, min = 1 } = {}) {
  if (!items.length || !(fraction > 0)) return [];
  const n = Math.min(items.length, Math.max(min, Math.round(items.length * Math.min(1, fraction))));
  const score = (x) => createHash("sha256").update(`${seed}\0${x}`).digest("hex");
  const picked = new Set(
    [...items]
      .map((x) => [score(x), x])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, n)
      .map((p) => p[1]),
  );
  return items.filter((x) => picked.has(x)); // the caller's order
}

/** Mid-run edits: T sampled every intervalMs; a file's window is clean when every sample bracketing it equals the start. */
export function createTreeWatch(root, { intervalMs = 5000, fingerprint = () => treeFingerprint(root).hash } = {}) {
  const t0 = Date.now();
  const start = fingerprint();
  const samples = [{ at: t0, hash: start }];
  const take = () => {
    try {
      samples.push({ at: Date.now(), hash: fingerprint() });
    } catch {
      samples.push({ at: Date.now(), hash: "unreadable" });
    }
  };
  const timer = intervalMs > 0 ? setInterval(take, intervalMs) : null;
  timer?.unref?.();
  let stopped = false;
  return {
    start,
    samples,
    sample: take,
    stop() {
      if (timer) clearInterval(timer);
      if (!stopped) {
        const t = Date.now();
        while (Date.now() === t); // the closing sample is later than any end time taken before stop()
        take();
      }
      stopped = true;
    },
    cleanBetween(startMs, endMs) {
      let first = 0;
      for (let i = 0; i < samples.length; i++) if (samples[i].at <= startMs) first = i;
      const last = samples.findIndex((s) => s.at > endMs); // strictly after: a same-ms sample may predate the end
      if (last < 0) return false; // no sample after its end yet: can't vouch for it
      for (let i = first; i <= last; i++) if (samples[i].hash !== start) return false;
      return true;
    },
  };
}

/** Why a run may neither reuse nor save (a16, a17), or null. */
export function reuseRefusal({ env = process.env, runtime = "bun", files = [], root }) {
  if (runtime !== "bun") return "not on Bun";
  if (env.SOVA_TEST_HOME || env.SOVA_TEST_RUNNER_PID) return "started from inside a test";
  if (root) {
    const r = path.resolve(root) + path.sep;
    if (files.some((f) => !path.resolve(root, f).startsWith(r))) return "files outside the project";
  }
  return null;
}

/** A record's time as a reader wants it: "14:02" today, else "Nov 4 14:02" (local time). */
export function whenOf(at, now = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "an earlier run";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return same ? hm : `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${hm}`;
}

/** Where a record came from, in words. */
export function sourceOf(by) {
  if (!by?.branch || by.branch === "detached") return "an earlier run";
  if (by.branch === "merge copy") return "an earlier landing run";
  return `${by.branch}'s chat`;
}

export function hitWording(hit, now = new Date()) {
  return `already passed on identical code at ${whenOf(hit.at, now)} (${sourceOf(hit.by)})`;
}

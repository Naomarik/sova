// Census timing bench (lane B1, fix 9): how long `census --changed` takes on a copy of a real project with
// N changed files, against the 5000 ms the spec hooks allow it (mode/spec-guard.ts TOOL_TIMEOUT_MS).
// Not a test (the runner's glob is tests/*.test.mjs). Node stdlib, git and tar only; writes only under --work.
//
//   node census-timing.mjs --src <git repo> [--rev REV] --work DIR [--core DIR] [--sizes 10,50,200] [--runs 20]
//                          [--out FILE] [--compare FILE]
//
// --src/--rev: the project copied with `git archive` into DIR/n<N> (once; reused later, so outputs compare).
// Each copy is committed, then N tracked in-boundary files get one appended line, uncommitted.
// Variants: "current" (no --spec) and "draft" (--spec a full copy of the spec, as the hook passes a draft).
// --compare: a previous --out; every variant's output must be byte-identical to it (sha256), else exit 1.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_TIMEOUT_MS = 5000;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const src = arg("--src"), rev = arg("--rev", "HEAD"), work = resolve(arg("--work", ""));
const core = resolve(arg("--core", join(dirname(fileURLToPath(import.meta.url)), "../../core")));
const sizes = arg("--sizes", "10,50,200").split(",").map(Number), runs = Number(arg("--runs", "20"));
const out = arg("--out"), compare = arg("--compare");
if (!arg("--work")) { console.error("--work DIR is required"); process.exit(2); }

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1" };
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
const git = (dir, ...a) => sh("git", ["-c", "user.name=b", "-c", "user.email=b@b", "-c", "commit.gpgsign=false", "-C", dir, ...a]);

function prepare(n) {
  const dir = join(work, `n${n}`);
  if (existsSync(join(dir, ".git"))) return dir;
  if (!src) throw new Error(`${dir} missing and no --src given`);
  mkdirSync(dir, { recursive: true });
  const tar = spawnSync("git", ["-C", src, "archive", rev], { env, maxBuffer: 1 << 30 });
  if (tar.status !== 0) throw new Error(`git archive: ${tar.stderr}`);
  sh("tar", ["-x", "-C", dir], { input: tar.stdout, encoding: undefined });
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
  const m = JSON.parse(readFileSync(join(dir, ".sova/spec/manifest.json"), "utf8"));
  const inc = m.boundary?.include ?? ["."];
  const files = git(dir, "ls-files", "-z", "--", ...inc).split("\0").filter(Boolean).sort();
  if (files.length < n) throw new Error(`only ${files.length} files in the boundary`);
  // Evenly spaced, so each size mixes mapped and unmapped files across the tree.
  for (let i = 0; i < n; i++) appendFileSync(join(dir, files[Math.floor((i * files.length) / n)]), "\n// census bench\n");
  // A draft as the draft tool makes it (a full copy of the spec), which the hook would pass as --spec.
  sh(process.execPath, [join(core, "sova-spec-draft.mjs"), "new", "bench", "--write", "--root", dir, "--json"], { cwd: dir });
  return dir;
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const results = { core, rev, hookTimeoutMs: HOOK_TIMEOUT_MS, runs, node: process.version, at: new Date().toISOString(), variants: [] };
for (const n of sizes) {
  const dir = prepare(n);
  for (const variant of ["current", "draft"]) {
    const args = [join(core, "sova-spec.mjs"), "census", "--changed", "--json", "--root", dir, "--base", "HEAD", ...(variant === "draft" ? ["--spec", ".sova/spec/drafts/bench/spec"] : [])];
    const ms = [], hashes = new Set();
    let exit, changed, bytes;
    for (let i = 0; i < runs; i++) {
      const t = process.hrtime.bigint();
      const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: dir, env, maxBuffer: 1 << 28 });
      ms.push(Number(process.hrtime.bigint() - t) / 1e6);
      hashes.add(createHash("sha256").update(r.stdout).digest("hex"));
      if (i === 0) { exit = r.status; bytes = r.stdout.length; try { changed = JSON.parse(r.stdout).census?.changed; } catch { changed = null; } }
    }
    const v = { n, variant, changed, exit, bytes, deterministic: hashes.size === 1, sha256: [...hashes][0],
      firstMs: Math.round(ms[0]), p50Ms: Math.round(pct(ms, 50)), p95Ms: Math.round(pct(ms, 95)), maxMs: Math.round(Math.max(...ms)),
      overTimeout: ms.filter((x) => x > HOOK_TIMEOUT_MS).length };
    results.variants.push(v);
    console.log(`n=${n} ${variant}: changed ${changed}, exit ${exit}, first ${v.firstMs} ms, p50 ${v.p50Ms} ms, p95 ${v.p95Ms} ms, max ${v.maxMs} ms, over ${HOOK_TIMEOUT_MS} ms ${v.overTimeout}/${runs}, deterministic ${v.deterministic}`);
  }
}
if (out) writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
if (compare) {
  const before = JSON.parse(readFileSync(compare, "utf8")), diff = [];
  for (const v of results.variants) {
    const b = before.variants.find((x) => x.n === v.n && x.variant === v.variant);
    if (!b || b.sha256 !== v.sha256 || !v.deterministic) diff.push(`n=${v.n} ${v.variant}`);
  }
  console.log(diff.length ? `output differs from ${compare}: ${diff.join(", ")}` : `outputs byte-identical to ${compare}`);
  if (diff.length) process.exitCode = 1;
}

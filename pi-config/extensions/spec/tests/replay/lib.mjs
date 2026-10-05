// Replay harness plumbing: seeded scratch Git repos and the spec CLIs of one tool tree, run hermetically.
// Node stdlib only; imports nothing outside pi-config. Every Git commit gets a fixed author and a
// date from a per-repo counter, so the same script yields the same commit ids on every run.
import { spawnSync, execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Epoch second of the first scratch commit; each later commit in a repo is one minute on. */
const EPOCH = 1700000000;
const AUTHOR = { name: "Replay Fixture", email: "replay@example.invalid" };

/** The environment every child process gets: PATH and a scratch home, nothing inherited from the caller's Git or home. */
export function childEnv(home) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: join(dirname(home), "tmp"),
    LANG: "C", LC_ALL: "C", TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  };
}

/** Drop the caller's Git variables from this process, so hook code (which spawns git with process.env) sees none. */
export function scrubProcessEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.TZ = "UTC";
}

/** A temp workspace for one arm's run; removed by `dispose`. */
export function workspace(label) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `spec-replay-${label}-`)));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(base, "tmp"));
  writeFileSync(join(home, ".gitconfig"), "");
  let n = 0;
  return {
    base, home,
    dir(name) { const d = join(base, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; },
    dispose() { rmSync(base, { recursive: true, force: true }); },
  };
}

/** A scratch Git repository with deterministic commits. */
export class Repo {
  constructor(root, home) {
    this.root = root;
    this.home = home;
    this.tick = 0;
  }

  /** `git …` in the repo; throws on a non-zero exit unless `allowFail`. */
  git(args, { allowFail = false, cwd } = {}) {
    const at = `@${EPOCH + 60 * this.tick} +0000`;
    const env = { ...childEnv(this.home), GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=master", "-c", "merge.conflictStyle=merge", "-c", "rerere.enabled=false", ...args], { cwd: cwd ?? this.root, env, encoding: "utf8" });
    if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
  }

  init() { this.git(["init", "-q"]); return this; }
  write(rel, text) { const p = join(this.root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  read(rel) { return readFileSync(join(this.root, rel), "utf8"); }
  has(rel) { return existsSync(join(this.root, rel)); }
  /** Stage the paths (all when none) and commit at the next tick. */
  commit(message, paths = ["-A"]) {
    this.tick++;
    this.git(["add", ...paths]);
    this.git(["commit", "-q", "--allow-empty", "-m", message]);
    return this.head();
  }
  merge(rev, message) { this.tick++; return this.git(["merge", "-q", "--no-ff", "--no-edit", "-m", message ?? `Merge ${rev}`, rev], { allowFail: true }); }
  head() { return this.git(["rev-parse", "HEAD"]).stdout; }
  checkout(...args) { this.tick++; this.git(["checkout", "-q", ...args]); }
}

/** One arm's tools: a copy of `pi-config/extensions` holding spec/, mode/ and claude-code/. */
export class Tools {
  constructor(tree) {
    this.tree = tree;
    this.core = join(tree, "spec/core");
  }

  /** Run a spec CLI (`sova-spec.mjs` by default) with `--root <root> --json`; parses the JSON when there is one. */
  run(root, home, args, { script = "sova-spec.mjs", json = true, rootFlag = true } = {}) {
    const argv = [join(this.core, script), ...args, ...(rootFlag ? ["--root", root] : []), ...(json ? ["--json"] : [])];
    const r = spawnSync(process.execPath, argv, { cwd: root, env: childEnv(home), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: out };
  }
  /** `run`, without blocking: for read-only commands that may run side by side. */
  runAsync(root, home, args, { script = "sova-spec.mjs", json = true, rootFlag = true } = {}) {
    const argv = [join(this.core, script), ...args, ...(rootFlag ? ["--root", root] : []), ...(json ? ["--json"] : [])];
    return new Promise((done) => execFile(process.execPath, argv, { cwd: root, env: childEnv(home), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(stdout); } catch { /* not JSON */ }
      done({ status: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout, stderr, json: out });
    }));
  }
  spec(root, home, args, o) { return this.run(root, home, args, o); }
  draft(root, home, args, o) { return this.run(root, home, args, { ...o, script: "sova-spec-draft.mjs" }); }
}

/** The outcome code of a CLI result: its refusal or usage code, else `exit<N>`. */
export function outcome(r) {
  const j = r.json;
  if (!j) return `no-json(status ${r.status})`;
  if (typeof j.code === "string") return j.code;
  if (Array.isArray(j.refusals) && j.refusals.length) return [...new Set(j.refusals.map((x) => x.code))].sort().join("+");
  const errors = (j.findings ?? []).filter((f) => f.severity === "error").map((f) => f.code);
  if (errors.length) return [...new Set(errors)].sort().join("+");
  return `exit${j.exit ?? r.status}`;
}

/** A spec project's starting files: a manifest plus claim files, under `.sova/spec`. */
export function seedSpec(repo, { claims, files, boundary }) {
  repo.write(".sova/spec/manifest.json", JSON.stringify({
    formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, ...(boundary ? { boundary } : {}), claims,
  }, null, 2) + "\n");
  for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
  repo.write(".gitignore", ".sova/spec/drafts/\n.hook-state/\n");
}

/** Edit a draft's manifest record in place. */
export function editDraftRecord(repo, draft, id, fn) {
  const rel = `.sova/spec/drafts/${draft}/spec/manifest.json`;
  const m = JSON.parse(repo.read(rel));
  fn(m.claims[id]);
  repo.write(rel, JSON.stringify(m, null, 2) + "\n");
}

/** Replace `from` with `to` in a file; throws if `from` is absent, so a fixture can't silently do nothing. */
export function replaceIn(repo, rel, from, to) {
  const text = repo.read(rel);
  if (!text.includes(from)) throw new Error(`${rel} has no ${JSON.stringify(from)}`);
  repo.write(rel, text.replace(from, to));
}

/** A stable rendering of a value for comparison (sorted object keys). */
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

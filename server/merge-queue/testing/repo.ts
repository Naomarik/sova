/**
 * Tests only. A throwaway project for the merge-queue scenarios: a real git repository with a bare
 * `origin`, its main checkout on the target branch (the "live tree"), branch worktrees beside it at
 * `<parent>/.worktrees/<repo>-<name>` (as Sova cuts them), and checks and setup that are small node
 * scripts whose pass or fail the test controls by file content in the commit being checked:
 *
 * - `setup.conf`: `ok` | `broken` (setup exits 1) | `broken-once` (fails on its first run only).
 * - `build.conf`: `ok` | `broken`: the `build` check fails with no file named (a typecheck/build kind).
 * - `tests/<name>.txt`: `pass` | `fail` | `flaky` (fails its first run per content, passes after) |
 *   `hang` (sleeps until killed): the `unit` check, which names its failing files in SOVA_OUT and reruns
 *   only the files passed as argv.
 *   `gate <name>` (held until the test opens the gate) | `forbid <w>...` (fails when src/list.txt holds every word).
 * - `deps.lock`: the `merge.install` step's input (an offline install when a branch changes it); `broken` fails it.
 *
 * Every script appends one JSON line per run to `<root>/state/calls.jsonl` ({script, cwd, head, argv,
 * env subset}), so a test asserts WHERE a check ran (the merge copy, never the state root), on WHICH
 * commit (the merge tip, master alone), and what was rerun, without reading the queue's own records.
 * The state dir is outside the repository, so nothing a check writes is ever committed or cleaned.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchRoot } from "../../test-scratch";

export type ChecksKind = "declared" | "test-command" | "none" | "unset";

export interface FixtureOptions {
  /** The target branch (motorsaif uses `main`). */
  target?: string;
  /** What the definition declares: a `merge.checks` list, only `test.run`, `"none"`, or nothing. */
  checks?: ChecksKind;
  /** test-command only: `test.requires` an on-demand service (`svc`) the runner talks to on its port. */
  requireService?: { portBase: number };
  /** A bare `origin` beside the project, pushed to at creation (default true). */
  remote?: boolean;
  /** Ship a review kit at `.sova/playbooks/review/` and declare it. */
  review?: boolean;
  /** Extra `merge` section keys (merged over the defaults). */
  merge?: Record<string, unknown>;
  /** The repo's folder name (default `demo`). */
  name?: string;
  /** Files on the target's first commit, over the defaults (e.g. `{"setup.conf": "broken\n"}`: master already broken). */
  files?: Record<string, string>;
  /** Make the scratch root under this folder instead of the OS temp dir (the copy-under-state-root case). */
  under?: string;
}

export interface CallRecord {
  script: "setup" | "install" | "build" | "unit" | "svc" | "runner";
  cwd: string;
  head: string;
  argv: string[];
  env: Record<string, string | undefined>;
  at: number;
  result?: "pass" | "fail";
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  // No background cleanup: a commit's detached `git rerere gc` (or maintenance) could write into a worktree's admin
  // folder while a following `git worktree remove` deletes it.
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} in ${cwd} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/** The SOVA_OUT writer and call logger every script shares (inlined so a script has no imports of ours). */
const prelude = (stateDir: string, script: CallRecord["script"]) => `
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const STATE = ${JSON.stringify(stateDir)};
const head = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
const pick = (k) => process.env[k];
const ENV = Object.fromEntries(["SOVA_VERB","SOVA_STEP","SOVA_OUT","SOVA_MERGE_BASE","SOVA_MERGE_TIP","SOVA_MERGE_CHANGED","SOVA_INSTANCE","SOVA_SLOT","CLAUDE_CONFIG_DIR","SOVA_CHAT_ID","FIXTURE_LEAK"].map((k) => [k, pick(k)]));
const log = (result) => appendFileSync(STATE + "/calls.jsonl", JSON.stringify({ script: ${JSON.stringify(script)}, cwd: process.cwd(), head, argv: process.argv.slice(2), env: ENV, at: Date.now(), result }) + "\\n");
const conf = (f, d) => (existsSync(f) ? readFileSync(f, "utf8").trim() : d);
const once = (key) => { mkdirSync(STATE + "/once", { recursive: true }); const p = STATE + "/once/" + createHash("sha1").update(key).digest("hex"); if (existsSync(p)) return false; writeFileSync(p, key); return true; };
const out = (o) => { if (process.env.SOVA_OUT) writeFileSync(process.env.SOVA_OUT, JSON.stringify(o)); };
`;

const SETUP = (s: string) => `${prelude(s, "setup")}
console.log("setup: start in " + process.cwd() + " at " + head);
const c = conf("setup.conf", "ok");
if (c === "broken" || (c === "broken-once" && once("setup-once"))) { console.log("setup: broken (" + c + ")"); log("fail"); process.exit(1); }
writeFileSync(".setup-done", head + "\\n");
console.log("setup: done"); log("pass");
`;

const INSTALL = (s: string) => `${prelude(s, "install")}
const c = conf("deps.lock", "v1");
console.log("install: deps " + c);
if (c.includes("broken")) { console.log("install: cannot resolve " + c); log("fail"); process.exit(1); }
log("pass");
`;

const BUILD = (s: string) => `${prelude(s, "build")}
const c = conf("build.conf", "ok");
console.log("build: " + c);
if (c === "broken") { console.error("build: error TS2322 in src/app.ts"); log("fail"); process.exit(2); }
log("pass");
`;

const UNIT = (s: string) => `${prelude(s, "unit")}
const sel = process.argv.slice(2);
const all = existsSync("tests") ? readdirSync("tests").filter((f) => f.endsWith(".txt")).sort().map((f) => "tests/" + f) : [];
const files = sel.length ? all.filter((f) => sel.includes(f)) : all;
// unit.basename: a selector that names no repo path can't be loaded, as nasabii's test.bb errors on "handler_test.clj".
if (existsSync("unit.basename") && sel.length && !files.length) { console.log("unit: could not locate " + sel.join(" ")); out({ passed: 0, failed: 0, errors: 1, skipped: 0, failures: [{ name: "test run", message: "could not locate " + sel.join(" ") }] }); log("fail"); process.exit(1); }
const failures = [];
let passed = 0;
for (const f of files) {
  const c = readFileSync(f, "utf8").trim();
  if (c === "hang") { console.log("unit: " + f + " hangs"); log("hang"); setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (c.startsWith("gate")) {
    // Held until the test writes <state>/gates/<name> (released) — a check that is "running" for as long as a test needs.
    const g = STATE + "/gates/" + (c.split(/\\s+/)[1] || "main");
    mkdirSync(STATE + "/gates", { recursive: true });
    writeFileSync(STATE + "/gates/" + (c.split(/\\s+/)[1] || "main") + ".waiting", head);
    console.log("unit: " + f + " waits at gate");
    while (!existsSync(g)) await new Promise((r) => setTimeout(r, 50));
  }
  // "forbid w1 w2": fails when src/list.txt holds every word (a combination of two branches breaks it).
  const forbid = c.startsWith("forbid ") && c.split(/\\s+/).slice(1).every((w) => conf("src/list.txt", "").split("\\n").includes(w));
  const bad = forbid || c === "fail" || (c === "flaky" && once("flaky:" + f + ":" + head));
  // unit.names-only at the root: failures carry a name and no file (as Kaocha's runner reports them: motorsaif).
  // unit.basename: the file is its bare name, not a repo path (nasabii's test.bb: "handler_test.clj"), and a selector
  // of that name finds nothing to run.
  const named = existsSync("unit.names-only") || existsSync("unit.kaocha") ? {} : { file: existsSync("unit.basename") ? f.replace(/^.*\\//, "") : f };
  // unit.kaocha: Kaocha's own line, "FAIL in (<ns>/<test>) (<file>:<line>)", the line being the file's line count.
  const base = f.replace(/^tests\\//, "");
  const name = existsSync("unit.kaocha") ? "FAIL in (app.unit-test/" + base.replace(/\\.txt$/, "") + ") (unit_test.clj:" + readFileSync(f, "utf8").split("\\n").length + ")" : base;
  if (bad) { failures.push({ ...named, name, message: "expected pass, got " + c }); console.log("not ok " + f); }
  else { passed++; console.log("ok " + f); }
}
out({ passed, failed: failures.length, errors: 0, skipped: 0, failures });
log(failures.length ? "fail" : "pass");
process.exit(failures.length ? 1 : 0);
`;

/** test-command projects: one runner; with a service, it must reach it on its port first. */
const RUNNER = (s: string, withSvc: boolean) => `${prelude(s, "runner")}
import { connect } from "node:net";
const go = () => {
  const sel = process.argv.slice(2);
  const all = existsSync("tests") ? readdirSync("tests").filter((f) => f.endsWith(".txt")).sort().map((f) => "tests/" + f) : [];
  const files = sel.length ? all.filter((f) => sel.includes(f)) : all;
// unit.basename: a selector that names no repo path can't be loaded, as nasabii's test.bb errors on "handler_test.clj".
if (existsSync("unit.basename") && sel.length && !files.length) { console.log("unit: could not locate " + sel.join(" ")); out({ passed: 0, failed: 0, errors: 1, skipped: 0, failures: [{ name: "test run", message: "could not locate " + sel.join(" ") }] }); log("fail"); process.exit(1); }
  const failures = files.filter((f) => { const c = readFileSync(f, "utf8").trim(); return c === "fail" || (c === "flaky" && once("flaky:" + f + ":" + head)); })
    .map((f) => ({ file: f, name: f, message: "failed" }));
  out({ passed: files.length - failures.length, failed: failures.length, errors: 0, skipped: 0, failures });
  log(failures.length ? "fail" : "pass");
  process.exit(failures.length ? 1 : 0);
};
${withSvc
    ? `const s = connect(Number(process.env.SOVA_PORT_SVC_TCP), "127.0.0.1");
s.on("error", (e) => { console.log("runner: no service: " + e.message); log("fail"); process.exit(3); });
s.on("connect", () => { s.end(); go(); });`
    : "go();"}
`;

const SVC = (s: string) => `${prelude(s, "svc")}
import { createServer } from "node:net";
createServer((c) => { c.on("error", () => {}); c.end("ok\\n"); }).listen(Number(process.env.SOVA_PORT_TCP), "127.0.0.1", () => { console.log("svc up"); log("pass"); });
`;

const REVIEW_KIT = `# Review kit (fixture)

Review exactly the commit you are given. Answer one of: ok, notes, blocking. The fixture's stand-in
reviewer reads \`review.conf\` in the commit: \`ok\` | \`notes: <text>\` | \`blocking: <text>\` | \`crash\`.
`;

export class Fixture {
  readonly root: string;
  readonly parent: string;
  readonly project: string;
  readonly origin: string;
  readonly state: string;
  readonly target: string;
  readonly name: string;
  readonly opts: FixtureOptions;

  constructor(opts: FixtureOptions = {}) {
    this.opts = opts;
    if (opts.under) {
      mkdirSync(opts.under, { recursive: true });
      this.root = mkdtempSync(join(opts.under, "sova-mq-"));
    } else this.root = scratchRoot("sova-mq-");
    this.parent = join(this.root, "projects");
    this.name = opts.name ?? "demo";
    this.project = join(this.parent, this.name);
    this.origin = join(this.root, "origin.git");
    this.state = join(this.root, "state");
    this.target = opts.target ?? "master";
    mkdirSync(this.project, { recursive: true });
    mkdirSync(this.state, { recursive: true });
    writeFileSync(join(this.state, "calls.jsonl"), "");
    this.writeBase();
    git(this.project, ["init", "-q", "-b", this.target]);
    git(this.project, ["add", "-A"]);
    git(this.project, ["commit", "-q", "-m", "fixture: base"]);
    if (opts.remote !== false) {
      git(this.root, ["init", "-q", "--bare", "-b", this.target, this.origin]);
      git(this.project, ["remote", "add", "origin", this.origin]);
      git(this.project, ["push", "-q", "origin", `${this.target}:refs/heads/${this.target}`]);
      git(this.project, ["fetch", "-q", "origin"]);
    }
  }

  /** The definition for `checks` (exported so a test can rewrite it on the target). */
  definition(checks: ChecksKind = this.opts.checks ?? "declared"): Record<string, unknown> {
    const def: Record<string, unknown> = {
      version: 1,
      slots: { cap: 4 },
      setup: [{ id: "prep", run: ["node", "setup.mjs"] }],
      services: {} as Record<string, unknown>,
    };
    // The parser wants at least one service: an on-demand one nothing starts unless the test command requires it.
    (def.services as Record<string, unknown>).svc = {
      cmd: ["node", "svc.mjs"],
      start: "on-demand",
      ports: { tcp: { base: this.opts.requireService?.portBase ?? 39_000 } },
      ready: { tcp: "tcp", timeout: 10 },
    };
    if (checks === "test-command") {
      def.test = { run: ["node", "runner.mjs"], ...(this.opts.requireService ? { requires: ["svc"] } : {}), timeout: 60, smoke: ["tests/a.txt"] };
    }
    if (checks === "unset") return def;
    const merge: Record<string, unknown> = {
      target: this.target,
      // The offline install a lockfile change needs (here: deps.lock).
      install: { run: ["node", "install.mjs"], inputs: ["deps.lock"] },
      ...(this.opts.review ? { review: ".sova/playbooks/review" } : {}),
      ...(this.opts.merge ?? {}),
    };
    if (checks === "declared") {
      merge.checks = [
        { id: "build", label: "Build", run: ["node", "checks/build.mjs"] },
        { id: "unit", label: "Unit tests", run: ["node", "checks/unit.mjs"], rerun: true, timeout: 60 },
      ];
    } else if (checks === "none") merge.checks = "none";
    def.merge = merge;
    return def;
  }

  private writeBase(): void {
    const p = this.project;
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(p, rel)), { recursive: true });
      writeFileSync(join(p, rel), text);
    };
    put(".gitignore", ".setup-done\n.sova/spec/drafts/\nnode_modules/\n.agent/\n");
    put(".sova/project.json", JSON.stringify(this.definition(), null, 2) + "\n");
    put("setup.mjs", SETUP(this.state));
    put("install.mjs", INSTALL(this.state));
    put("checks/build.mjs", BUILD(this.state));
    put("checks/unit.mjs", UNIT(this.state));
    put("runner.mjs", RUNNER(this.state, !!this.opts.requireService));
    put("svc.mjs", SVC(this.state));
    put("setup.conf", "ok\n");
    put("build.conf", "ok\n");
    put("deps.lock", "v1\n");
    put("tests/a.txt", "pass\n");
    put("tests/b.txt", "pass\n");
    put("src/list.txt", "alpha\nbravo\ncharlie\n");
    put("src/app.txt", "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n");
    put("README.md", "# demo\n");
    if (this.opts.review) {
      put(".sova/playbooks/review/SKILL.md", REVIEW_KIT);
      put("review.conf", "ok\n");
    }
    for (const [rel, text] of Object.entries(this.opts.files ?? {})) put(rel, text);
  }

  /** A check holding at gate `name` (tests/<x>.txt = `gate <name>`) has reached it. */
  atGate(name = "main"): boolean {
    return existsSync(join(this.state, "gates", `${name}.waiting`));
  }
  /** Release gate `name`: the held check goes on (and passes, unless its file says otherwise). */
  openGate(name = "main"): void {
    mkdirSync(join(this.state, "gates"), { recursive: true });
    writeFileSync(join(this.state, "gates", name), "open");
  }

  // ------------------------------------------------------------------ branches

  worktreeOf(name: string): string {
    return join(this.parent, ".worktrees", `${this.name}-${name.replace(/[^a-z0-9-]/gi, "-")}`);
  }

  /** A branch `feat/<name>` in its own worktree, cut from `from` (default the target), with one commit of `files` (null deletes). */
  branch(name: string, files: Record<string, string | null>, opts: { from?: string; message?: string } = {}): { branch: string; checkout: string; commit: string } {
    const branch = `feat/${name}`;
    const checkout = this.worktreeOf(name);
    git(this.project, ["worktree", "add", "-q", "-b", branch, checkout, opts.from ?? this.target]);
    const commit = this.commitIn(checkout, files, opts.message ?? `${name}: change`);
    return { branch, checkout, commit };
  }

  /** One commit of `files` in `cwd` (a branch worktree, or the project for a move of the target from outside). */
  commitIn(cwd: string, files: Record<string, string | null>, message: string): string {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(cwd, rel);
      if (text === null) git(cwd, ["rm", "-q", rel]);
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text);
        git(cwd, ["add", rel]);
      }
    }
    git(cwd, ["commit", "-q", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
  }

  /** Move the target from outside the queue (a hand commit in the live tree). */
  moveTargetOutside(files: Record<string, string | null> = { "outside.txt": `moved ${Date.now()}\n` }): string {
    return this.commitIn(this.project, files, "outside the queue");
  }

  /** Leave a tracked, uncommitted edit in the live tree (the "dirty live tree" case). */
  dirtyLiveTree(): void {
    appendFileSync(join(this.project, "README.md"), "uncommitted edit\n");
  }

  cleanLiveTree(): void {
    git(this.project, ["checkout", "--", "README.md"]);
  }

  // ------------------------------------------------------------------ reads

  head(ref = this.target): string {
    return git(this.project, ["rev-parse", ref]);
  }
  tree(ref = this.target): string {
    return git(this.project, ["rev-parse", `${ref}^{tree}`]);
  }
  originHead(): string | null {
    if (this.opts.remote === false) return null;
    return git(this.origin, ["rev-parse", `refs/heads/${this.target}`], { allowFail: true }) || null;
  }
  isAncestor(a: string, b: string): boolean {
    return spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: this.project }).status === 0;
  }
  /** First-parent commits on the target since `from` (exclusive), oldest first. */
  firstParentSince(from: string, ref = this.target): string[] {
    const out = git(this.project, ["rev-list", "--first-parent", "--reverse", `${from}..${ref}`]);
    return out ? out.split("\n") : [];
  }
  fileAt(ref: string, rel: string): string | null {
    const r = spawnSync("git", ["show", `${ref}:${rel}`], { cwd: this.project, encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  }
  liveTreeFile(rel: string): string {
    return readFileSync(join(this.project, rel), "utf8");
  }
  liveTreeHead(): string {
    return git(this.project, ["rev-parse", "HEAD"]);
  }

  calls(): CallRecord[] {
    const text = readFileSync(join(this.state, "calls.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallRecord);
  }
  callsSince(mark: number): CallRecord[] {
    return this.calls().slice(mark);
  }
  /** Forget the flaky/once marks (a fresh "first run"). */
  resetOnce(): void {
    rmSync(join(this.state, "once"), { recursive: true, force: true });
  }

  /** A spec in the project (minimal, one claim), committed on the target, so branches can carry drafts. */
  async withSpec(): Promise<void> {
    // A variable specifier: the spec tools' own fixture writer is plain JS with no declarations.
    const where = "../../../pi-config/extensions/spec/tests/spec-fixture.mjs";
    const specFixture = (await import(where)) as {
      writeSpec: (root: string, o: Record<string, unknown>) => void;
    };
    specFixture.writeSpec(this.project, {
      layout: 2,
      records: { "§a/top": { kind: "behavior", authority: "accepted", requires: [], code: ["src/app.txt"] } },
      claims: { "a/top.md": "# §a/top\n\nThe top does X.\n" },
    });
    writeFileSync(join(this.project, ".sova/spec/.gitignore"), "/drafts/\n");
    git(this.project, ["add", ".sova/spec"]);
    git(this.project, ["commit", "-q", "-m", "fixture: spec"]);
    if (this.opts.remote !== false) git(this.project, ["push", "-q", "origin", this.target]);
  }

  /** A spec draft `name` in a branch checkout adding §b/<name>, with a chat's note (what Sova's chats write). */
  draft(checkout: string, name: string, prose = `The ${name} feature does its one thing.`): void {
    const cli = join(REPO_ROOT, "pi-config/extensions/spec/core/sova-spec-draft.mjs");
    const run = (...a: string[]) => {
      const r = spawnSync(process.execPath, [cli, ...a, "--root", checkout, "--json"], { encoding: "utf8", cwd: checkout });
      if (r.status !== 0) throw new Error(`spec draft ${a.join(" ")}: ${r.stdout}${r.stderr}`);
    };
    run("new", name, "--write");
    const spec = join(checkout, ".sova/spec/drafts", name, "spec");
    const id = `§b/${name}`;
    const recFile = join(spec, "claims/b", `${name}.json`);
    mkdirSync(dirname(recFile), { recursive: true });
    writeFileSync(recFile, JSON.stringify({ [id]: { kind: "behavior", authority: "accepted", requires: [], code: ["src/app.txt"] } }, null, 2) + "\n");
    writeFileSync(join(spec, "claims/b", `${name}.md`), `# ${id}\n\n${prose}\n`);
    run("evidence", name, "--id", id, "--by", "chat", "--verification", "checked by hand", "--note", "--write");
  }

  /** Record the chat's verification note on draft `name` again (after an edit). */
  noteDraft(checkout: string, name: string): void {
    const cli = join(REPO_ROOT, "pi-config/extensions/spec/core/sova-spec-draft.mjs");
    const r = spawnSync(process.execPath, [cli, "evidence", name, "--id", `§b/${name}`, "--by", "chat", "--verification", "checked again", "--note", "--write", "--root", checkout, "--json"], { encoding: "utf8", cwd: checkout });
    if (r.status !== 0) throw new Error(`spec draft note: ${r.stdout}${r.stderr}`);
  }

  /** Edit a draft's prose after approval (the "drafts changed since you approved" case). */
  editDraft(checkout: string, name: string, prose: string): void {
    writeFileSync(join(checkout, ".sova/spec/drafts", name, "spec/claims/b", `${name}.md`), `# §b/${name}\n\n${prose}\n`);
  }

  dispose(): void {
    // Worktrees are registered in the project's .git; remove the whole scratch root.
    rmSync(this.root, { recursive: true, force: true });
  }
}

export const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "../../..");

/** Poll `fn` until it returns a truthy value, or fail after `ms` naming `what`. */
export async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000, every = 50): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

export { execFileSync };

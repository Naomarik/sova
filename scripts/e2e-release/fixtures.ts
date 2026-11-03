/**
 * Tests and e2e drives only (nothing in the server imports this). Throwaway projects for Release (al_1):
 *
 * - `remote` (F-REMOTE): a git repo whose main checkout is on `master`, a bare `origin.git` beside it, annotated
 *   numbered tags (default v0.1.0) plus an annotated `stable` at the newest, pushed to origin.
 * - `local` (F-LOCAL): the same with no origin (`merge.push: false`); its playbook's build step writes an
 *   artifact into a gitignored `dist/` and reports {artifact, sha256, size}.
 * - `bare` (F-BARE): merge set up, but no `release` pointer and no release playbook (not initialized).
 *
 * Every project has: `.sova/project.json` (a `merge` section with one gating check `unit` whose pass/fail is
 * the file `gate.conf` in the commit checked: `pass` | `fail` | `hold` (waits until `<state>/open-gate.conf` exists);
 * the release pointer adds a release-only check `full` read from `release-gate.conf` the same way),
 * `CHANGELOG.md` with one `## vX.Y.Z` section per tag, `package.json` with the version, `site/index.html`, and,
 * when `deploy` is on, a stand-in deploy target `site` that copies `site/` into `<root>/deploy-target` and writes
 * the commit to `<root>/deploy-target/version` (no host, no network).
 *
 * The release pointer's shape follows the lead's CONTRACT.md; pass `release` to override it, `false` to omit it.
 * Every script appends a JSON line to `<state>/calls.jsonl` ({script, cwd, head, argv}), so a test asserts where a
 * check ran and on which commit. The state dir is outside the repository: nothing a script writes is committed.
 *
 * Node builtins only, so `bun scripts/e2e-release/make-scratch.ts` can build the same projects for a UI drive.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Kind = "remote" | "local" | "bare";

export interface ReleaseFixtureOptions {
  kind?: Kind;
  /** Folder name of the project (default by kind: pub, solo, fresh). */
  name?: string;
  /** Make the scratch root under this folder (default: a fresh dir in the OS temp dir). */
  under?: string;
  /** Released versions already tagged, oldest first (default ["0.1.0"]); `stable` points at the last. */
  versions?: string[];
  /** Override the `release` pointer in .sova/project.json; `false` leaves it out. */
  release?: Record<string, unknown> | false;
  /** Leave the release playbook out (implied by kind "bare"). */
  noPlaybook?: boolean;
  /** Steps of the playbook's manifest (default: DEFAULT_STEPS, or LOCAL_STEPS for kind local). */
  steps?: ReleaseStep[];
  /** Declare the stand-in deploy target `site` (default true for remote). */
  deploy?: boolean | { releasesOnly?: boolean };
  /** Extra `merge` keys over the defaults. */
  merge?: Record<string, unknown>;
  /** Extra files on the first commit. */
  files?: Record<string, string>;
}

/** A manifest step (CONTRACT.md §2): Sova adds its own `checks` and `publish` itself. */
export interface ReleaseStep {
  id: string;
  label: string;
  phase: "prepare" | "check" | "after" | "withdraw";
  /** Ends held for the operator's Continue (a live try-out). */
  held?: true;
  /** Its done report carries an artifact's facts. */
  artifact?: true;
}

export const DEFAULT_STEPS: ReleaseStep[] = [
  { id: "version", label: "Pick the version", phase: "prepare" },
  { id: "notes", label: "Draft the notes", phase: "prepare" },
  { id: "bump", label: "Bump the files", phase: "prepare" },
  { id: "commit", label: "Make the release commit", phase: "prepare" },
  { id: "try-live", label: "Try it", phase: "check", held: true },
  { id: "page", label: "Release page", phase: "after" },
  { id: "page-withdrawn", label: "Mark the page withdrawn", phase: "withdraw" },
];

export const LOCAL_STEPS: ReleaseStep[] = [
  { id: "version", label: "Pick the version", phase: "prepare" },
  { id: "notes", label: "Draft the notes", phase: "prepare" },
  { id: "bump", label: "Bump the files", phase: "prepare" },
  { id: "commit", label: "Make the release commit", phase: "prepare" },
  { id: "artifact", label: "Build the app", phase: "after", artifact: true },
];

/** The default `release` pointer (CONTRACT.md §1); spread it to vary one key (`{...DEFAULT_POINTER, commit: false}`). */
export const DEFAULT_POINTER: Record<string, unknown> = {
  playbook: ".sova/playbooks/release",
  tag: "v${version}",
  scheme: "semver",
  channels: ["stable"],
  commit: true,
  // A release-only gating check after the merge set: `release-gate.conf` in the release commit decides.
  checks: [{ id: "full", label: "Full tests", run: ["node", "checks/unit.mjs", "release-gate.conf"], timeout: 120 }],
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} in ${cwd} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/** The gating check: `gate.conf` in the checked commit decides; logs every run. */
const UNIT = (state: string) => `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const STATE = ${JSON.stringify(state)};
const head = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
const conf = process.argv[2] || "gate.conf";
const c = existsSync(conf) ? readFileSync(conf, "utf8").trim() : "pass";
const log = (result) => appendFileSync(STATE + "/calls.jsonl", JSON.stringify({ script: conf === "gate.conf" ? "unit" : "full", cwd: process.cwd(), head, argv: process.argv.slice(2), at: Date.now(), result }) + "\\n");
if (c === "hold") { writeFileSync(STATE + "/" + conf + ".waiting", head); while (!existsSync(STATE + "/open-" + conf)) await new Promise((r) => setTimeout(r, 50)); }
const out = (o) => { if (process.env.SOVA_OUT) writeFileSync(process.env.SOVA_OUT, JSON.stringify(o)); };
if (c === "fail") { console.log("not ok gate"); out({ passed: 0, failed: 1, errors: 0, skipped: 0, failures: [{ name: "gate", message: "gate.conf says fail" }] }); log("fail"); process.exit(1); }
console.log("ok gate"); out({ passed: 1, failed: 0, errors: 0, skipped: 0, failures: [] }); log("pass");
`;

/** The playbook's driver: next | notes | bump <v> | page | build. Digest on stdout, exit 0/1/2 (bundle conventions). */
const DRIVER = (state: string) => `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const STATE = ${JSON.stringify(state)};
const [sub, arg] = process.argv.slice(2);
const sh = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
appendFileSync(STATE + "/calls.jsonl", JSON.stringify({ script: "driver", sub, arg, cwd: process.cwd(), at: Date.now() }) + "\\n");
const tags = sh("tag", "--list", "v[0-9]*", "--sort=-v:refname").split("\\n").filter(Boolean);
const prev = tags[0] ?? "v0.0.0";
const [ma, mi] = prev.slice(1).split(".").map(Number);
if (sub === "next") {
  const log = sh("log", "--format=%s", prev + "..HEAD");
  const feat = /feat|add/i.test(log);
  const next = feat ? ma + "." + (mi + 1) + ".0" : prev.slice(1).replace(/\\d+$/, (p) => String(Number(p) + 1));
  console.log(JSON.stringify({ previous: prev, version: next, why: feat ? "adds features" : "fixes only" }));
} else if (sub === "notes") {
  const lines = sh("log", "--format=- %s", "--no-merges", prev + "..HEAD").split("\\n").filter(Boolean);
  console.log(lines.join("\\n") || "- maintenance");
} else if (sub === "bump") {
  if (!arg) { console.log("bump needs a version"); process.exit(2); }
  const pkg = JSON.parse(readFileSync("package.json", "utf8")); pkg.version = arg;
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n");
  const notes = existsSync(STATE + "/notes.md") ? readFileSync(STATE + "/notes.md", "utf8") : "- release " + arg + "\\n";
  writeFileSync("CHANGELOG.md", "# Changelog\\n\\n## v" + arg + "\\n\\n" + notes + "\\n" + readFileSync("CHANGELOG.md", "utf8").replace(/^# Changelog\\n\\n/, ""));
  console.log("bumped package.json and CHANGELOG.md to " + arg);
} else if (sub === "page") {
  if (existsSync(STATE + "/page.conf") && readFileSync(STATE + "/page.conf", "utf8").trim() === "fail") { console.log("release page: host refused"); process.exit(1); }
  writeFileSync(STATE + "/page-" + (arg ?? prev), "made\\n");
  console.log("release page made for " + (arg ?? prev));
} else if (sub === "build") {
  mkdirSync("dist", { recursive: true });
  const body = "app " + (arg ?? prev) + " built from " + sh("rev-parse", "HEAD") + "\\n";
  const file = "dist/app-" + (arg ?? prev) + ".jar";
  writeFileSync(file, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  console.log(JSON.stringify({ artifact: process.cwd() + "/" + file, sha256, size: Buffer.byteLength(body) }));
} else { console.log("unknown: " + sub); process.exit(2); }
`;

const PLAYBOOK = (kind: Kind) => `# Release (fixture)

Follow Sova's general release method. This project's additions:

- Version: patch for fixes only, minor when any landing adds a feature (\`release.mjs next\`).
- Notes: one line per landing since the previous release, for people who installed it (\`release.mjs notes\`).
- Bump: \`release.mjs bump <version>\` writes package.json and the CHANGELOG section; commit both as "Release v<version>".
${kind === "local" ? "- After publish: `release.mjs build <version>` builds the app into dist/ (gitignored, never committed) and prints {artifact, sha256, size}; report those facts with the build step.\n" : "- After publish: `release.mjs page <version>` makes the release page.\n"}
Never push or tag: Sova's Publish does that.
`;

const SHIP = `import { cpSync, mkdirSync, writeFileSync } from "node:fs";
const [dir, commit] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
cpSync("site", dir, { recursive: true });
writeFileSync(dir + "/version", commit + "\\n");
console.log("shipped " + commit + " to the stand-in target");
`;

export class ReleaseFixture {
  readonly root: string;
  readonly parent: string;
  readonly project: string;
  readonly origin: string | null;
  readonly state: string;
  readonly deployTarget: string;
  readonly kind: Kind;
  readonly name: string;
  readonly target = "master";
  readonly opts: ReleaseFixtureOptions;

  constructor(opts: ReleaseFixtureOptions = {}) {
    this.opts = opts;
    this.kind = opts.kind ?? "remote";
    this.name = opts.name ?? { remote: "pub", local: "solo", bare: "fresh" }[this.kind];
    const base = opts.under ?? tmpdir();
    mkdirSync(base, { recursive: true });
    this.root = realpathSync(mkdtempSync(join(base, `sova-rel-${this.kind}-`)));
    const inRepo = git(this.root, ["rev-parse", "--absolute-git-dir"], { allowFail: true });
    if (inRepo) {
      rmSync(this.root, { recursive: true, force: true });
      throw new Error(`ReleaseFixture: ${this.root} is inside the git repository ${inRepo}; use a temp dir outside every repository`);
    }
    this.parent = join(this.root, "projects");
    this.project = join(this.parent, this.name);
    this.origin = this.kind === "local" ? null : join(this.root, "origin.git");
    this.state = join(this.root, "state");
    this.deployTarget = join(this.root, "deploy-target");
    mkdirSync(this.project, { recursive: true });
    mkdirSync(this.state, { recursive: true });
    writeFileSync(join(this.state, "calls.jsonl"), "");

    const versions = opts.versions ?? ["0.1.0"];
    this.writeBase(versions[0] ?? "0.0.0");
    git(this.project, ["init", "-q", "-b", this.target]);
    git(this.project, ["add", "-A"]);
    git(this.project, ["commit", "-q", "-m", "fixture: base"]);
    versions.forEach((v, i) => {
      if (i > 0) this.commitIn(this.project, this.releaseFiles(v), `Release v${v}`);
      git(this.project, ["tag", "-a", `v${v}`, "-m", `v${v}`]);
    });
    if (versions.length) git(this.project, ["tag", "-a", "stable", "-m", "stable", `v${versions[versions.length - 1]}^{commit}`]);
    if (this.origin) {
      git(this.root, ["init", "-q", "--bare", "-b", this.target, this.origin]);
      git(this.project, ["remote", "add", "origin", this.origin]);
      git(this.project, ["push", "-q", "origin", `${this.target}:refs/heads/${this.target}`, "--tags"]);
      git(this.project, ["fetch", "-q", "origin"]);
    }
  }

  /** The `release` pointer written by default (CONTRACT.md §1). */
  releasePointer(): Record<string, unknown> {
    return structuredClone(DEFAULT_POINTER);
  }

  definition(): Record<string, unknown> {
    const def: Record<string, unknown> = {
      version: 1,
      services: { site: { static: "site", ports: { http: { base: 47_700 } } } },
      merge: {
        target: this.target,
        checks: [{ id: "unit", label: "Unit tests", run: ["node", "checks/unit.mjs"], timeout: 120 }],
        ...(this.kind === "local" ? { push: false } : {}),
        ...(this.opts.merge ?? {}),
      },
    };
    const deploy = this.opts.deploy ?? this.kind === "remote";
    if (deploy) {
      def.deploy = {
        targets: {
          site: {
            about: "Stand-in target: a local folder.",
            requires: { tests: "none" },
            steps: [{ id: "ship", run: ["node", "ship.mjs", this.deployTarget, "${commit}"] }],
            rollback: "redeploy-previous",
            ...(typeof deploy === "object" && deploy.releasesOnly ? { releases: "only" } : {}),
          },
        },
      };
    }
    const release = this.opts.release ?? (this.kind === "bare" ? false : this.releasePointer());
    if (release) def.release = release;
    return def;
  }

  manifest(): { v: 1; steps: ReleaseStep[] } {
    return { v: 1, steps: this.opts.steps ?? (this.kind === "local" ? LOCAL_STEPS : DEFAULT_STEPS) };
  }

  private put(rel: string, text: string, root = this.project): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }

  private writeBase(first: string): void {
    this.put(".gitignore", "node_modules/\n.agent/\ndist/\n.sova/spec/drafts/\n");
    this.put(".sova/project.json", JSON.stringify(this.definition(), null, 2) + "\n");
    this.put("checks/unit.mjs", UNIT(this.state));
    this.put("ship.mjs", SHIP);
    this.put("gate.conf", "pass\n");
    this.put("release-gate.conf", "pass\n");
    this.put("site/index.html", `<h1>${this.name}</h1>\n`);
    this.put("src/app.txt", "line 1\nline 2\nline 3\n");
    this.put("README.md", `# ${this.name}\n`);
    this.put("package.json", JSON.stringify({ name: this.name, version: first, private: true }, null, 2) + "\n");
    this.put("CHANGELOG.md", `# Changelog\n\n## v${first}\n\n- First release.\n`);
    if (this.kind !== "bare" && !this.opts.noPlaybook) {
      this.put(".sova/playbooks/release/PLAYBOOK.md", `---\nname: Release\ndescription: How ${this.name} is released.\n---\n${PLAYBOOK(this.kind)}`);
      this.put(".sova/playbooks/release/release.json", JSON.stringify(this.manifest(), null, 2) + "\n");
      this.put(".sova/playbooks/release/scripts/release.mjs", DRIVER(this.state));
    }
    for (const [rel, text] of Object.entries(this.opts.files ?? {})) this.put(rel, text);
  }

  /** The files a release of `v` changes (what the playbook's bump step writes). */
  releaseFiles(v: string, notes = `- release ${v}`): Record<string, string> {
    const pkg = JSON.parse(readFileSync(join(this.project, "package.json"), "utf8")) as Record<string, unknown>;
    const log = readFileSync(join(this.project, "CHANGELOG.md"), "utf8").replace(/^# Changelog\n\n/, "");
    return {
      "package.json": JSON.stringify({ ...pkg, version: v }, null, 2) + "\n",
      "CHANGELOG.md": `# Changelog\n\n## v${v}\n\n${notes}\n\n${log}`,
    };
  }

  // ------------------------------------------------------------------ writes

  worktreeOf(name: string): string {
    return join(this.parent, ".worktrees", `${this.name}-${name.replace(/[^a-z0-9-]/gi, "-")}`);
  }

  /** A branch `feat/<name>` in its own worktree from `from` (default master), one commit of `files` (null deletes). */
  branch(name: string, files: Record<string, string | null>, opts: { from?: string; message?: string; prefix?: string } = {}): { branch: string; checkout: string; commit: string } {
    const branch = `${opts.prefix ?? "feat"}/${name}`;
    const checkout = this.worktreeOf(name);
    git(this.project, ["worktree", "add", "-q", "-b", branch, checkout, opts.from ?? this.target]);
    const commit = this.commitIn(checkout, files, opts.message ?? `feat: ${name}`);
    return { branch, checkout, commit };
  }

  commitIn(cwd: string, files: Record<string, string | null>, message: string): string {
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) git(cwd, ["rm", "-q", rel]);
      else {
        this.put(rel, text, cwd);
        git(cwd, ["add", rel]);
      }
    }
    git(cwd, ["commit", "-q", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
  }

  /** Commits landed on master since the newest tag, as a project with history would have (direct, then pushed). */
  seedLandings(n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(this.commitIn(this.project, { [`src/landing-${i}.txt`]: `landing ${i}\n` }, i % 2 ? `fix: landing ${i}` : `feat: landing ${i}`));
    if (this.origin) git(this.project, ["push", "-q", "origin", this.target]);
    return out;
  }

  /** A check's verdict for commits made after this, in the commit (so per branch): `gate.conf` is the merge check
   *  `unit` (every landing), `release-gate.conf` the release-only check `full`. */
  gateOn(cwd: string, verdict: "pass" | "fail" | "hold", file: "gate.conf" | "release-gate.conf" = "gate.conf"): string {
    return this.commitIn(cwd, { [file]: `${verdict}\n` }, `gate: ${file} ${verdict}`);
  }
  /** A `hold` check is waiting / let it go on. */
  gateWaiting(file: "gate.conf" | "release-gate.conf" = "gate.conf"): boolean {
    return existsSync(join(this.state, `${file}.waiting`));
  }
  openGate(file: "gate.conf" | "release-gate.conf" = "gate.conf"): void {
    writeFileSync(join(this.state, `open-${file}`), "open\n");
  }
  /** The after-publish `page` step fails until cleared. */
  failPage(on = true): void {
    if (on) writeFileSync(join(this.state, "page.conf"), "fail\n");
    else rmSync(join(this.state, "page.conf"), { force: true });
  }

  // ------------------------------------------------------------------ facts (git, never Sova's view)

  head(ref = this.target): string {
    return git(this.project, ["rev-parse", ref]);
  }
  liveTreeHead(): string {
    return git(this.project, ["rev-parse", "HEAD"]);
  }
  /** The commit a tag points at locally, or null. */
  tagAt(tag: string): string | null {
    return git(this.project, ["rev-parse", "--verify", "-q", `refs/tags/${tag}^{commit}`], { allowFail: true }) || null;
  }
  /** The tag object's own id (moves when a tag is re-made even at the same commit). */
  tagObject(tag: string): string | null {
    return git(this.project, ["rev-parse", "--verify", "-q", `refs/tags/${tag}`], { allowFail: true }) || null;
  }
  tags(): string[] {
    return git(this.project, ["tag", "--list"]).split("\n").filter(Boolean).sort();
  }
  /** origin's refs as `ref -> commit` (peeled for annotated tags); null for a local-only project. */
  originRefs(): Record<string, string> | null {
    if (!this.origin) return null;
    const out: Record<string, string> = {};
    const raw = git(this.origin, ["for-each-ref", "--format=%(refname) %(objectname) %(*objectname)"]);
    for (const line of raw.split("\n").filter(Boolean)) {
      const [ref, obj, peeled] = line.split(" ");
      out[ref!] = peeled || obj!;
    }
    return out;
  }
  originHead(): string | null {
    return this.originRefs()?.[`refs/heads/${this.target}`] ?? null;
  }
  originTag(tag: string): string | null {
    return this.originRefs()?.[`refs/tags/${tag}`] ?? null;
  }
  isAncestor(a: string, b: string): boolean {
    return spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: this.project }).status === 0;
  }
  fileAt(ref: string, rel: string): string | null {
    const r = spawnSync("git", ["show", `${ref}:${rel}`], { cwd: this.project, encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  }
  subject(ref = this.target): string {
    return git(this.project, ["log", "-1", "--format=%s", ref]);
  }
  /** Every path ever committed on any ref (an artifact must never show up here). */
  everCommitted(): string[] {
    return git(this.project, ["log", "--all", "--name-only", "--format="]).split("\n").filter(Boolean);
  }
  /** Whether the working tree is clean of tracked changes (gitignored files don't count). */
  clean(): boolean {
    return git(this.project, ["status", "--porcelain", "--untracked-files=no"]) === "";
  }
  calls(): Array<Record<string, unknown>> {
    return readFileSync(join(this.state, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  deployedVersion(): string | null {
    const f = join(this.deployTarget, "version");
    return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  }
  /** A snapshot of every fact a no-change assertion compares. */
  facts(): { master: string; live: string; tags: Record<string, string | null>; origin: Record<string, string> | null } {
    const tags: Record<string, string | null> = {};
    for (const t of this.tags()) tags[t] = this.tagObject(t);
    return { master: this.head(), live: this.liveTreeHead(), tags, origin: this.originRefs() };
  }

  /** Private names for the leak scan, as the names interview writes them, so the queue's first push isn't held. */
  seedNames(stateRoot: string, names: string[] = []): void {
    const dir = join(stateRoot, "sova", "merge-queue", createHash("sha256").update(this.project).digest("hex").slice(0, 16));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "names.json"), JSON.stringify({ privateNames: names }) + "\n");
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Poll `fn` until truthy, or fail after `ms` naming `what`. */
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

export const fileSize = (p: string): number => statSync(p).size;

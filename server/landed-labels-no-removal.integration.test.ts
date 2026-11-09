// §chat.worktrees/nothing-left: "Clean Up Merged and archive's folder removal don't read it". The shared answer decides
// labels, lists, counts and Land, and nothing on disk. Two proofs:
//   1. The code as it stood before the answer existed (BASE, extracted from git) and this tree's code read the same real
//      repositories: Clean Up Merged's count and dry run, classifyRepo, and archive's removal, with what it leaves on disk.
//   2. No file on a removal path can reach the shared answer or the draft proof.
// The promise is that a change makes no difference, so BASE's own answer is the expected one. The hand-written table says
// what each repository had to read, so the comparison can't pass on repositories that all read the same.
// A deliberate change to what cleanup offers moves BASE, in the same commit, with the new table.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { registerQueueReading } from "./nothing-left";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Master when the shared answer was built: the last commit whose cleanup can't have read it. */
const BASE = "49099d87b9317712a35f2b440083c73df7a00d5a";

const top = realpathSync(mkdtempSync(join(tmpdir(), "sova-no-removal-")));
process.env.PI_CODING_AGENT_DIR = join(top, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR);
after(() => rmSync(top, { recursive: true, force: true }));

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (dir: string, file: string, content: string): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
};
const commit = (dir: string, files: Record<string, string>, message: string): void => {
  for (const [f, c] of Object.entries(files)) put(dir, f, c);
  git(dir, "add", "-Af");
  git(dir, "commit", "-q", "-m", message);
};

// ---------------------------------------------------------------- the repositories

const CASES = ["landed", "leftover-clean", "leftover-conflict", "hand-edit", "squash-leftover", "squash-conflict", "real-after", "draft-tracked", "draft-untracked", "resolve-mq_old", "detached", "no-commits", "noisy-driver", "locked", "dirty", "gone", "session-inside"] as const;
type Case = (typeof CASES)[number];

/** What each must read: `go/...` is offered for removal, `stay/...` the reason it's kept. By hand, and true at BASE. */
const NOT_MERGED = "stay/Not merged into master.";
const OFFERS: Record<Case, string> = {
  landed: "go/ancestor/branch deleted",
  "leftover-clean": "go/content/branch kept",
  "leftover-conflict": NOT_MERGED, // the row reads Landed; Clean Up Merged still says this
  "hand-edit": NOT_MERGED,
  "squash-leftover": "go/content/branch kept",
  "squash-conflict": NOT_MERGED,
  "real-after": NOT_MERGED,
  "draft-tracked": "go/ancestor/branch deleted", // a draft the answer calls left to land is no reason here
  "draft-untracked": "stay/ignored",
  "resolve-mq_old": "go/content/branch kept",
  detached: "stay/Not on a branch.",
  "no-commits": "go/empty/branch deleted",
  "noisy-driver": NOT_MERGED, // BASE reads a driver's stdout as the tree; the shared answer doesn't, and may not teach cleanup
  locked: "stay/Locked.",
  dirty: "stay/uncommitted",
  gone: "go/ancestor/branch deleted",
  "session-inside": "stay/Session “Inside”'s folder is inside it.",
};

const NOISE = "noise-from-the-driver";
const wtOf = (root: string, c: Case) => join(root, "wt", c);

/** One repository holding every case, each on files of its own, the target moved as each case's history needs. */
function buildRepos(root: string): { project: string } {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "master");
  git(project, "config", "merge.noisy.driver", `echo ${NOISE}; exit 0`);
  commit(project, { "a.txt": "a\n", "noisy.txt": "base\n", ".gitattributes": "noisy.txt merge=noisy\n", ".gitignore": ".sova/spec/drafts/\n" }, "init");
  const branch = (c: Case, files?: Record<string, string>): string => {
    const b = `feat/${c}`;
    git(project, "worktree", "add", "-q", "-b", b, wtOf(root, c));
    if (files) commit(wtOf(root, c), files, c);
    return b;
  };
  const landNoFf = (b: string): void => void git(project, "merge", "-q", "--no-ff", "--no-edit", b);
  const onTarget = (files: Record<string, string>, message: string): void => commit(project, files, message);
  const squash = (b: string, subject: string): void => {
    git(project, "merge", "-q", "--squash", b);
    git(project, "commit", "-q", "-m", subject);
  };
  const catchUp = (c: Case, edit?: Record<string, string>): void => {
    const w = wtOf(root, c);
    git(w, "merge", "-q", "--no-ff", "--no-edit", "master");
    if (!edit) return;
    for (const [f, v] of Object.entries(edit)) put(w, f, v);
    git(w, "add", "-A");
    git(w, "commit", "-q", "--amend", "--no-edit");
  };

  landNoFf(branch("landed", { "landed.txt": "l\n" }));

  landNoFf(branch("leftover-clean", { "lc.txt": "lc\n" }));
  onTarget({ "after-lc.txt": "x\n" }, "moves on");
  catchUp("leftover-clean");

  landNoFf(branch("leftover-conflict", { "lf.txt": "lf\n" }));
  onTarget({ "after-lf.txt": "x\n" }, "moves on");
  catchUp("leftover-conflict", { "lf.txt": "regenerated on the branch\n" });
  onTarget({ "lf.txt": "regenerated on the target\n" }, "regenerates");

  landNoFf(branch("hand-edit", { "he.txt": "he\n" }));
  onTarget({ "after-he.txt": "x\n" }, "moves on");
  catchUp("hand-edit", { "he.txt": "a hand edit no one landed\n" });

  squash(branch("squash-leftover", { "sl.txt": "sl\n" }), "squashed (#1)");
  catchUp("squash-leftover");

  squash(branch("squash-conflict", { "sc.txt": "sc\n" }), "squashed (#2)");
  catchUp("squash-conflict");
  onTarget({ "sc.txt": "rewritten on the target\n" }, "rewrites");
  put(wtOf(root, "squash-conflict"), "sc.txt", "rewritten on the branch\n");
  git(wtOf(root, "squash-conflict"), "add", "-A");
  git(wtOf(root, "squash-conflict"), "commit", "-q", "--amend", "--no-edit");

  landNoFf(branch("real-after", { "ra.txt": "ra\n" }));
  commit(wtOf(root, "real-after"), { "ra2.txt": "real\n" }, "real work");

  landNoFf(branch("draft-tracked", { "dt.txt": "dt\n", ".sova/spec/drafts/dt/spec/claims/b/dt.md": "# §b/dt\n" }));
  landNoFf(branch("draft-untracked", { "du.txt": "du\n" }));
  put(wtOf(root, "draft-untracked"), ".sova/spec/drafts/du/spec/claims/b/du.md", "# §b/du\n");

  git(project, "worktree", "add", "-q", "-b", "feat/resolve-mq_old", wtOf(root, "resolve-mq_old"));
  // The copy's other parent is a line of its own that lands, so both parents end up on the target.
  git(project, "branch", "side-of-copy");
  git(project, "worktree", "add", "-q", join(root, "wt", "side"), "side-of-copy");
  commit(join(root, "wt", "side"), { "side.txt": "s\n" }, "side");
  git(wtOf(root, "resolve-mq_old"), "merge", "-q", "--no-ff", "--no-edit", "side-of-copy");
  landNoFf("side-of-copy");
  git(project, "worktree", "remove", join(root, "wt", "side"));
  git(project, "branch", "-q", "-d", "side-of-copy");

  branch("no-commits");

  git(project, "worktree", "add", "-q", "--detach", wtOf(root, "detached"), "master");
  commit(wtOf(root, "detached"), { "det.txt": "d\n" }, "detached work");

  branch("noisy-driver", { "noisy.txt": "the branch's\n" });
  onTarget({ "noisy.txt": "the target's\n" }, "the driver has both sides to merge");

  landNoFf(branch("locked", { "locked.txt": "l\n" }));
  git(project, "worktree", "lock", wtOf(root, "locked"));
  landNoFf(branch("dirty", { "dirty.txt": "d\n" }));
  put(wtOf(root, "dirty"), "scratch.txt", "uncommitted\n");
  landNoFf(branch("gone", { "gone.txt": "g\n" }));
  rmSync(wtOf(root, "gone"), { recursive: true, force: true });
  landNoFf(branch("session-inside", { "si.txt": "s\n" }));
  return { project };
}

// ---------------------------------------------------------------- reading one tree of the code

type Cleanup = typeof import("./worktree-cleanup");
type Archive = typeof import("./archive-worktrees");
interface Code {
  cleanup: Cleanup;
  archive: Archive;
}

const SESSION = "s1";
/** What the two sides are compared on: root and home replaced, lists in a stable order. */
const stable = (v: unknown, root: string): unknown => {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return JSON.parse(JSON.stringify(walk(v)).replaceAll(root, "<root>").replaceAll(homedir(), "<home>"));
};

interface Reading {
  summary: unknown;
  plan: unknown;
  classified: unknown;
  classifiedTrialFails: unknown;
  archiveDirty: unknown;
  archive: unknown;
  torn: unknown;
  ledger: unknown;
  folders: unknown;
  branches: unknown;
  listed: unknown;
}

async function read(code: Code, root: string): Promise<{ reading: Reading; plan: Awaited<ReturnType<Cleanup["cleanupPlan"]>> }> {
  const { project } = buildRepos(root);
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const trees = CASES.filter((c) => c !== "detached").map((c) => ({ path: wtOf(root, c), branch: `feat/${c}`, base: "x", baseBranch: "master", status: "active", session: SESSION, how: "created", at: 1 }));
  const branches: Record<string, unknown[]> = {};
  const add = (id: string, cwd: string, entries: unknown[]): string => {
    const p = join(sessions, `${id}.jsonl`);
    writeFileSync(p, [{ type: "session", version: 3, id, timestamp: "", cwd }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    branches[p] = entries;
    return p;
  };
  const path = add(SESSION, project, [{ type: "custom", customType: "worktrees", data: { version: 1, trees } }]);
  const inside = add("s2", wtOf(root, "session-inside"), []);
  const ledger: unknown[] = [];
  const titled: Record<string, string> = { [path]: "Owner", [inside]: "Inside" };
  code.cleanup.resetCleanup();
  code.cleanup.configureCleanup({
    summary: async (p) => ({ id: p, path: p, title: titled[p] ?? "", busy: false, live: null }) as never,
    sessionFiles: async () => [path, inside],
    readBranch: async (p) => branches[p] ?? [],
    processes: async () => [],
    alive: () => false,
    ledger: (e) => void ledger.push(...e.map((r) => ({ path: r.path, branch: r.branch, merged: r.merged, branchDeleted: r.branchDeleted }))),
    removed: async () => {},
  });
  const summary = await code.cleanup.worktreesSummary(path);
  const plan = await code.cleanup.cleanupPlan(path);
  const classified = (await code.cleanup.classifyRepo(project))?.trees.map((t) => ({ path: t.path, branch: t.branch, class: t.class, merged: t.merged, ancestor: t.ancestor, why: t.why, gone: t.gone, locked: t.locked }));
  // git failing the trial is "can't tell" to the shared answer. Cleanup keeps its own reading of that.
  code.cleanup.resetCleanup();
  const { execGit } = await import("./worktrees");
  const trialFails: typeof execGit = (args, opts) => (args.includes("merge-tree") ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: no\n" }) : execGit(args, opts));
  const classifiedTrialFails = (await code.cleanup.classifyRepo(project, trialFails))?.trees.map((t) => ({ path: t.path, class: t.class, merged: t.merged }));
  code.cleanup.resetCleanup();

  const torn: string[] = [];
  const archive = code.archive.archiveWorktrees(async (p) => branches[p] ?? [], undefined, async (p) => void torn.push(p));
  const archived = await archive.plan({ id: SESSION, path });
  const lines = await archive.remove(archived, project);

  const folders = CASES.map((c) => (existsSync(wtOf(root, c)) ? c : null)).filter(Boolean);
  const reading: Reading = {
    summary,
    plan,
    classified,
    classifiedTrialFails,
    archiveDirty: archived.dirty,
    archive: lines,
    torn,
    ledger,
    folders,
    branches: git(project, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n"),
    listed: git(project, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")),
  };
  return { reading: stable(reading, root) as Reading, plan };
}

/** One row of the plan in the table's words. */
function offerOf(plan: NonNullable<Awaited<ReturnType<Cleanup["cleanupPlan"]>>>, root: string, c: Case): string {
  const path = wtOf(root, c);
  const go = plan.remove.find((r) => r.path === path);
  if (go) return `go/${go.kind}/branch ${go.branchDeleted ? "deleted" : "kept"}`;
  const stay = plan.keep.find((r) => r.path === path);
  assert.ok(stay, `${c} is in the plan`);
  if (c === "draft-untracked") return /ignored|rebuilt/i.test(stay.reason) ? "stay/ignored" : `stay/${stay.reason}`;
  if (c === "dirty") return /uncommitted|untracked/i.test(stay.reason) ? "stay/uncommitted" : `stay/${stay.reason}`;
  return `stay/${stay.reason}`;
}

// ---------------------------------------------------------------- the import guard

const REMOVAL_FILES = ["server/worktree-cleanup.ts", "server/archive-worktrees.ts", "server/merge-tree-probe.ts", "server/worktree-leftovers.ts"];
const FORBIDDEN_FILES = new Set(["server/nothing-left.ts", "server/spec-drafts-state.ts"]);
/** Modules holding the shared answer's readers as well as what a removal path needs: only these names may come from them. */
const NAMED_ONLY: Record<string, readonly string[]> = {
  "server/merge-readiness.ts": ["worktreesRemoved"],
  "server/worktrees.ts": ["execGit", "GitResult", "GitRunner"],
  "server/project-worktrees.ts": ["uncommitted"],
  "server/worktrees-state.ts": ["worktreesOf"],
  // It also reads a gone folder's label from the shared answer. Only these are on a removal path; `mergedByContent` is checked by its own text below.
  "server/removed-worktrees.ts": ["appendLedger", "mergedByContent", "resetContentMerges", "RemovedWorktree", "besideGone"],
  // Stops a running copy; it decides nothing about what goes.
  "server/project-services/checkout-teardown.ts": ["*"],
};

interface Edge {
  file: string;
  names: string[];
  /** `import type`: gone at run time, so nothing past it can run, though it may still not name the answer. */
  typeOnly: boolean;
}

/** Every relative import of a source, static (types too), re-exported or dynamic. */
function edgesOf(source: string, from: string): Edge[] {
  const out: Edge[] = [];
  const resolveTo = (spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = join(dirname(from), spec);
    // A data file is its own path: nothing to walk. A name with no file yet reads as the .ts it would be.
    for (const f of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(join(ROOT, f)) && /\.[a-z]+$/.test(f)) return f;
    return /\.[a-z]+$/.test(base) ? base : `${base}.ts`;
  };
  for (const m of source.matchAll(/\b(?:import|export)\s+(type\s+)?([^;'"]*?)\s+from\s+["']([^"']+)["']/g)) {
    const file = resolveTo(m[3]!);
    if (file) out.push({ file, typeOnly: !!m[1], names: [...m[2]!.matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+[\w$]+)?/g)].map((n) => n[1]!).filter((n) => n !== "type") });
  }
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    const file = resolveTo(m[1]!);
    if (file) out.push({ file, typeOnly: false, names: ["*"] });
  }
  return out;
}

/** What's wrong with the graph from `roots`, empty when no removal path can reach the shared answer. */
export function removalImportProblems(roots: readonly string[], read: (file: string) => string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const e of edgesOf(read(file), file)) {
      if (FORBIDDEN_FILES.has(e.file)) {
        problems.push(`${file} imports ${e.file}`);
        continue;
      }
      const allowed = NAMED_ONLY[e.file];
      if (allowed) {
        const extra = e.names.filter((n) => !allowed.includes(n));
        if (extra.length) problems.push(`${file} takes ${extra.join(", ")} from ${e.file}`);
        continue;
      }
      if (!e.typeOnly && /^(server|shared|pi-config)\//.test(e.file) && /\.tsx?$/.test(e.file)) walk(e.file);
    }
  };
  for (const r of roots) walk(r);
  return problems;
}

// ---------------------------------------------------------------- the proofs

describe("Clean Up Merged and archive read as they did before the shared answer", () => {
  let baseline: Code;
  let current: Code;
  let before_: Awaited<ReturnType<typeof read>>;
  let after_: Awaited<ReturnType<typeof read>>;

  before(async () => {
    const dir = join(top, "base");
    mkdirSync(dir);
    const tar = join(top, "base.tar");
    execFileSync("git", ["archive", `--output=${tar}`, BASE, "server", "shared", "pi-config", "src", "package.json", "tsconfig.json"], { cwd: ROOT });
    execFileSync("tar", ["-xf", tar, "-C", dir]);
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    baseline = { cleanup: await import(join(dir, "server/worktree-cleanup.ts")), archive: await import(join(dir, "server/archive-worktrees.ts")) };
    current = { cleanup: await import("./worktree-cleanup"), archive: await import("./archive-worktrees") };
    assert.notEqual(baseline.cleanup.classifyRepo, current.cleanup.classifyRepo, "two copies of the code, not one module twice");
    before_ = await read(baseline, join(top, "before"));
    // The queue's records stand ready for any removal path that reads them: every head of this tree's repositories landed.
    const project = join(top, "after", "project");
    mkdirSync(project, { recursive: true });
    const off = registerQueueReading(project, { landings: () => ({ pins: heads(project), landed: heads(project) }), approvedAt: () => true });
    try {
      after_ = await read(current, join(top, "after"));
    } finally {
      off();
    }
  });

  /** The repository's every branch head, or none while it's still being built. */
  function heads(project: string): string[] {
    try {
      return git(project, "for-each-ref", "--format=%(objectname)", "refs/heads").split("\n");
    } catch {
      return [];
    }
  }

  for (const key of ["summary", "plan", "classified", "classifiedTrialFails", "archiveDirty", "archive", "torn", "ledger", "folders", "branches", "listed"] as const) {
    test(`${key} is what it was at ${BASE.slice(0, 7)}`, () => assert.deepEqual(after_.reading[key], before_.reading[key]));
  }

  test("each repository reads what it has to, so the comparison isn't over repositories that all read alike", () => {
    const got = (r: typeof before_, root: string) => Object.fromEntries(CASES.map((c) => [c, offerOf(r.plan!, root, c)]));
    assert.deepEqual(got(before_, join(top, "before")), OFFERS, "the table, at the old code");
    assert.deepEqual(got(after_, join(top, "after")), OFFERS, "the table, at this tree");
  });

  test("the noisy driver really prints: a reading of git's first line is wrong on it", () => {
    const project = join(top, "probe", "project");
    const root = join(top, "probe");
    buildRepos(root);
    const out = git(project, "merge-tree", "--write-tree", "--no-messages", "master", "feat/noisy-driver");
    const lines = out.split("\n");
    assert.equal(lines[0], NOISE);
    assert.equal(lines.at(-1), git(project, "rev-parse", "master^{tree}"), "after the noise, merging changes nothing");
  });
});

describe("no removal path can reach the shared answer", () => {
  const onDisk = (f: string) => readFileSync(join(ROOT, f), "utf8");

  test("this tree's removal paths", () => assert.deepEqual(removalImportProblems(REMOVAL_FILES, onDisk), []));

  test("cleanup's by-content reading is its own: nothing in it names the shared answer", () => {
    const source = onDisk("server/removed-worktrees.ts");
    const at = source.indexOf("export async function mergedByContent");
    assert.ok(at >= 0, "the function this checks is still there");
    const body = source.slice(at, source.indexOf("\n}\n", at));
    assert.ok(body.includes("trialMergeTree"), "and this is its body");
    assert.deepEqual(body.match(/\b(codeLeft|branchLeft|landingRecordsAt|queueReadingAt|trialNoOp|mergeTreeOid|draftsLeft|draftProofVia)\b/g), null);
  });

  test("the guard sees the imports it's for", () => {
    const graph = (body: string) => (f: string) => (f === "server/a.ts" ? body : "");
    for (const body of [`import { branchLeft } from "./nothing-left";`, `export { draftsLeft } from "./spec-drafts-state";`, `const m = await import("./nothing-left");`, `import type { BranchLeft } from "./nothing-left";`, `import { branchLeft } from "./worktrees";`]) {
      assert.notDeepEqual(removalImportProblems(["server/a.ts"], graph(body)), [], body);
    }
    // Through a file between them, too.
    const twoSteps = (f: string) => (f === "server/a.ts" ? `import { x } from "./merge-tree-probe";` : f === "server/merge-tree-probe.ts" ? `import { branchLeft } from "./nothing-left";` : "");
    assert.notDeepEqual(removalImportProblems(["server/a.ts"], twoSteps), []);
    assert.deepEqual(removalImportProblems(["server/a.ts"], graph(`import { execGit } from "./worktrees";`)), [], "what a removal path needs from it stays allowed");
  });
});

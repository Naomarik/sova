// §chat.worktrees/retirement, the rehearsal's oracle in the unit tier: real git and the real retirePass on a generated
// world, every file inventoried before and after, so a case nobody named still gets compared. The named cases live in
// worktree-retire-safety.integration.test.ts; this file asserts only what the outcome must be:
//   1. every file a first-pass removal deleted is listed in the report, or is of a kind the rule lets go; a tree still
//      waiting when the first pass closed stays one waiting row, and its later removal is in the ledger;
//   2. nothing unique is lost: no file the rule doesn't let go, and no commit;
//   3. every worktree is in exactly one group, across every repository in the report;
//   4. a pass stopped at each removal in turn ends with the same report and files as an unbroken one;
//   5. a pass after quiet changes nothing, and no pass after the first changes the closed report;
//   6. a world needing more than one wake-up is run until quiet, the way the server does;
//   7. a removal cut off with git still listing it is finished under the proof when Sova's intent names it, and is left alone when not;
//   8. only this process's own git children are looked through when asking what is running in a folder.
// The kinds in `letGo` are this file's own reading of §chat.worktrees/leftovers, written from the spec, not from the code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { type ChildProcess, spawn } from "node:child_process";
import { canonical, isWithin } from "../pi-config/extensions/worktrees/state.ts";
import type { Git } from "../pi-config/extensions/worktrees/git.ts";
import { Fixture, git } from "./merge-queue/testing/repo";
import { branchLeft } from "./nothing-left";
import { appendLedger, markLedger, readLedger, type RemovedWorktree } from "./removed-worktrees";
import { classifyRepo, pidAlive, type ChatUse, type ProcFacts, scanProcesses } from "./worktree-cleanup";
import { retirePass, type RetireDeps } from "./worktree-retire";
import { removeTree } from "./worktree-remove";
import { execGit } from "./worktrees";

const MIN = 60_000;

// --- the world ---------------------------------------------------------------------------------

interface WorldData {
  fx: Fixture;
  root: string;
  main: string;
  sibling: string;
  other: string;
  /** Every worktree and every folder left behind a record names, which the report must place. */
  places: string[];
  /** Draft folder names the proof calls landed; anything else under drafts isn't. */
  proved: Set<string>;
  queueMade: Set<string>;
  /** Folders still brand new at the first pass: copying them back mustn't age or renew them. */
  fresh: string[];
  /** Trees whose chat runs until this time. */
  busyUntil: Map<string, number>;
  start: number;
  /** The projects a pass goes over, when not the three of the big world. */
  repos?: string[];
  /** What's running, when not nothing. */
  processes?: () => Promise<ProcFacts[]>;
  /** Removals git stops part way through while this process lives on (the time limit, a kill of git alone). */
  cutNow?: Map<string, CutPoint>;
}

/** How far `git worktree remove` got before it died, its registration still in git's list. */
type CutPoint = "before any file" | ".git gone" | "half the files gone" | "half gone, .git left";

/** What the kill leaves. Every other file, by name, is as good as git's own order (the directory's) for what stays. */
function cutFolder(t: string, point: CutPoint): void {
  if (point === "before any file") return;
  if (point !== "half gone, .git left") rmSync(join(t, ".git"), { force: true });
  if (point === ".git gone") return;
  const files = new Map<string, { sha: string; blob: string; link: boolean }>();
  walkFiles(t, files);
  [...files.keys()].sort().forEach((f, i) => i % 2 === 0 && rmSync(f, { force: true }));
}

const put = (dir: string, rel: string, data: string | Buffer) => {
  const f = join(dir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, data);
};
function exclude(repo: string, pattern: string): void {
  const f = join(repo, ".git/info/exclude");
  writeFileSync(f, `${readFileSync(f, "utf8")}${pattern}\n`);
}
function emptyRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "master"]);
  put(dir, "a.txt", "another project\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "first"]);
}

function build(): WorldData {
  const fx = new Fixture({ remote: false });
  const root = fx.root;
  const main = fx.project;
  const sibling = join(fx.parent, "demo-old");
  cpSync(main, sibling, { recursive: true, verbatimSymlinks: true });
  const other = join(fx.parent, "other");
  emptyRepo(other);
  const start = Date.now() + 60 * MIN;
  const places: string[] = [];
  const proved = new Set<string>();
  const queueMade = new Set<string>();
  const busyUntil = new Map<string, number>();

  for (const r of [main, sibling, other]) {
    for (const p of [".agent/", "*.log", "*.mp4", "/tmp/", "out/"]) exclude(r, p);
  }
  // A real, merged branch in its own worktree of `repo`, with what the shape needs.
  const landed = (repo: string, name: string, files: Record<string, string>, extras: (t: string) => void = () => undefined) => {
    const t = join(fx.parent, ".worktrees", `${basename(repo)}-${name}`);
    git(repo, ["worktree", "add", "-q", "-b", `feat/${name}`, t, "master"]);
    for (const [rel, data] of Object.entries(files)) put(t, rel, data);
    git(t, ["add", "-A"]);
    git(t, ["commit", "-q", "-m", name]);
    git(repo, ["merge", "-q", "--no-ff", "--no-edit", `feat/${name}`]);
    extras(t);
    places.push(t);
    return t;
  };

  // Shapes the real state has, each in its own tree, then one finished tree per file kind so the 3-at-a-time pool is really used.
  landed(main, "testcopy", { "tc.txt": "tc\n" }, (t) => {
    put(t, ".agent/auth.json", '{"fake":"k"}\n');
    put(t, ".agent/claude-accounts/x/creds", "fake\n");
    put(t, ".agent/sova/usage.json", "{}\n");
    put(t, ".agent/sessions/--x--/unique.jsonl", '{"type":"session","id":"only-here"}\n{"text":"made in a test copy"}\n');
    put(t, ".agent/sessions/--x--/copied.jsonl", '{"type":"session","id":"copied"}\n{"text":"a real chat holds this"}\n');
    put(t, "node_modules/dep/i.js", "// dependency\n");
    put(t, "run.log", "a log\n");
  });
  landed(main, "tmp", { "t.txt": "t\n" }, (t) => put(t, "tmp/scratch/a", "scratch\n"));
  landed(main, "links", { "l.txt": "l\n" }, (t) => {
    writeFileSync(join(root, "out-of-tree.txt"), "kept out of tree\n");
    symlinkSync(join(root, "out-of-tree.txt"), join(t, "link-out"));
  });
  landed(main, "draft", { "d.txt": "d\n" }, (t) => {
    put(t, ".sova/spec/drafts/landedone/draft.json", '{"name":"landedone"}\n');
    put(t, ".sova/spec/drafts/landedone/spec/manifest.json", "{}\n");
    proved.add("landedone");
  });
  landed(main, "draftnot", { "n.txt": "n\n" }, (t) => put(t, ".sova/spec/drafts/notproved/draft.json", '{"name":"notproved"}\n'));
  landed(main, "dotdraft", { "o.txt": "o\n" }, (t) => put(t, ".sova/spec/drafts/.old/note.md", "only here\n"));
  landed(main, "recording", { "r.txt": "r\n" }, (t) => put(t, "demo.mp4", Buffer.from([1, 2, 3, 4, 5, 200])));
  landed(main, "reccopy", { "c.txt": "c\n" }, (t) => {
    put(t, "copy.mp4", Buffer.from([9, 9, 9, 9]));
    put(main, "copy-in-main.mp4", Buffer.from([9, 9, 9, 9]));
  });
  landed(main, "wip", { "w.txt": "w\n" }, (t) => put(t, "uncommitted.txt", "only here\n"));
  landed(main, "ignoredwork", { "i.txt": "i\n" }, (t) => {
    exclude(main, "secrets.local");
    put(t, "secrets.local", "only here\n");
  });
  for (let i = 0; i < 4; i++) landed(main, `plain${i}`, { [`p${i}.txt`]: "p\n" }, (t) => put(t, `out/build-${i}.js`, "x\n"));

  // More than one wake-up: folders still brand new, and chats still busy, at the first pass.
  const fresh: string[] = [];
  for (let i = 0; i < 3; i++) fresh.push(landed(main, `fresh${i}`, { [`f${i}.txt`]: "f\n" }, (x) => put(x, ".agent/auth.json", "{}\n")));
  for (const t of fresh) utimesSync(t, new Date(start - 2 * MIN), new Date(start - 2 * MIN));
  for (let i = 0; i < 2; i++) {
    const t = landed(main, `busy${i}`, { [`b${i}.txt`]: "b\n" }, (x) => put(x, "run.log", "a log\n"));
    busyUntil.set(t, start + 15 * MIN);
  }

  // With commits of its own: never touched.
  const work = join(fx.parent, ".worktrees", "demo-work");
  git(main, ["worktree", "add", "-q", "-b", "feat/work", work, "master"]);
  put(work, "w.txt", "work\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "unlanded work"]);
  places.push(work);

  // The queue's own: a finished copy and one with a commit of its own.
  queueMade.add(landed(main, "resolve-mq_1", { "q.txt": "q\n" }));
  const queueWork = join(fx.parent, ".worktrees", "demo-resolve-mq_2");
  git(main, ["worktree", "add", "-q", "-b", "feat/resolve-mq_2", queueWork, "master"]);
  put(queueWork, "qq.txt", "own\n");
  git(queueWork, ["add", "-A"]);
  git(queueWork, ["commit", "-q", "-m", "queue copy's own commit"]);
  queueMade.add(queueWork);
  places.push(queueWork);

  // Sibling repositories sharing history: a live worktree of the copy, a finished one, and kept branches there (setting off).
  const sibLive = join(fx.parent, ".worktrees", "demo-old-live");
  git(sibling, ["worktree", "add", "-q", "-b", "feat/live", sibLive, "master"]);
  put(sibLive, "live.txt", "live\n");
  git(sibLive, ["add", "-A"]);
  git(sibLive, ["commit", "-q", "-m", "work in the copy"]);
  places.push(sibLive);
  landed(sibling, "kept", { "k.txt": "k\n" });
  landed(other, "unrelated", { "u.txt": "u\n" });
  return { fx, root, main, sibling, other, places, proved, queueMade, fresh, busyUntil, start };
}

/** Folders left behind, on their records: recorded with a shared base (a doubt), and one no record names (never touched). */
function leftovers(w: WorldData): { path: string; branch: string; base: string; session: string }[] {
  const base = git(w.main, ["rev-list", "--max-parents=0", "master"]);
  const shared = join(w.fx.parent, ".worktrees", "demo-left-shared");
  put(shared, "node_modules/a.js", "x\n");
  w.places.push(shared);
  const unnamed = join(w.fx.parent, ".worktrees", "demo-no-record");
  put(unnamed, "notes.md", "only here\n");
  const sibLive = join(w.fx.parent, ".worktrees", "demo-old-live");
  return [{ path: shared, branch: "feat/left", base, session: "s" }, { path: sibLive, branch: "feat/live", base, session: "s" }];
}

const worlds: WorldData[] = [];
after(() => worlds.forEach((w) => w.fx.dispose()));

// --- a run -------------------------------------------------------------------------------------

interface Clock {
  t: number;
}
interface Stop {
  /** Dies right after this many removals are recorded: every later step does nothing, as a dead process does. */
  at: number;
  seen: number;
  dead: boolean;
  /** Or dies inside the removal of this folder, git having got this far. */
  cut?: { tree: string; point: CutPoint };
}

function depsOf(w: WorldData, records: ReturnType<typeof leftovers>, clock: Clock, stop: Stop | null): RetireDeps {
  const state = w.fx.state;
  const ledgerFile = join(state, "removed-worktrees.json");
  const dead = () => stop?.dead === true;
  const alive = (what: string) => {
    if (dead()) throw new Error(`stopped: ${what}`);
  };
  const realGit: Git = async (args, cwd) => {
    alive("git");
    const r = await execGit(args, { cwd });
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  // After the stop, what would have been written lands in a scratch place nobody reads.
  const stateFile = (name: string) => (dead() ? join(state, "dead-process", name) : join(state, name));
  return {
    allowed: () => ({ on: true }),
    repos: () => w.repos ?? [w.main, w.sibling, w.other],
    git: execGit,
    gitWrite: realGit,
    gitRemove: async (args, cwd) => {
      const path = args[args.length - 1]!;
      if (args[1] === "remove" && stop?.cut && !stop.dead && basename(path) === stop.cut.tree) {
        cutFolder(path, stop.cut.point);
        stop.dead = true;
        throw new Error("killed inside git worktree remove");
      }
      const live = args[1] === "remove" ? w.cutNow?.get(path) : undefined;
      if (live) {
        w.cutNow!.delete(path);
        cutFolder(path, live);
        return { code: 137, stdout: "", stderr: "Killed" };
      }
      return realGit(args, cwd);
    },
    classify: (root, only) => {
      alive("classify");
      return classifyRepo(root, {
        git: execGit,
        withQueueMade: true,
        queueMade: async () => (p) => w.queueMade.has(p),
        left: async (o) => {
          const l = await branchLeft(o);
          const drafts = l.drafts.filter((d) => !w.proved.has(d));
          return { ...l, drafts, whole: drafts.length ? "work" : l.codeOnly, nothingLeft: !drafts.length && l.codeOnly === "nothing" };
        },
        ...(only ? { only } : {}),
      });
    },
    chats: async (paths) => {
      alive("chats");
      const uses: ChatUse[] = [];
      for (const [cwd, until] of w.busyUntil) {
        const inside = paths.filter((p) => isWithin(canonical(cwd), canonical(p)));
        if (inside.length) uses.push({ path: `${cwd}.jsonl`, id: basename(cwd), name: basename(cwd), cwd: canonical(cwd), inside, tracks: [], archived: false, running: clock.t < until, tui: false, workers: 0, sandbox: false, lastActiveAt: clock.t - 60 * MIN });
      }
      return { uses, unreadable: [] };
    },
    records: async () => ({ records, unreadable: [] }),
    processes: async () => {
      alive("processes");
      return w.processes ? w.processes() : [];
    },
    alive: pidAlive,
    openEntry: () => null,
    draftsUnproved: async (main, folder) => {
      const dir = join(folder, ".sova/spec/drafts");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((n) => !n.startsWith(".") && !w.proved.has(n));
    },
    branchFinished: async (main, branch) => {
      const tip = await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main });
      if (tip.code !== 0) return false;
      const target = { name: "master", oid: git(main, ["rev-parse", "master"]) };
      const left = await branchLeft({ root: main, branch, head: tip.stdout.trim(), target });
      return !left.code.left && left.code.kind !== "unknown";
    },
    copies: { of: () => null, teardown: async () => {} },
    ledger: () => readLedger(ledgerFile),
    appendLedger: (e) => {
      alive("ledger");
      appendLedger(e, ledgerFile);
      if (stop && ++stop.seen === stop.at) stop.dead = true;
    },
    markLedger: (m, p) => {
      alive("ledger");
      return markLedger(m, p, ledgerFile);
    },
    removed: async () => {},
    now: () => clock.t,
    pendingFile: () => stateFile("retire-pending.json"),
    firstPassFile: () => stateFile("retire-first-pass.json"),
    testChatsAside: () => join(state, "retired-test-chats"),
    realChatsDir: () => join(state, "real-sessions"),
    platform: () => "linux",
    deleteBranches: (main) => main !== w.sibling,
  };
}

// --- the inventory -----------------------------------------------------------------------------

interface FileFacts {
  sha: string;
  /** Git's name for these bytes. */
  blob: string;
  link: boolean;
  kind: "tracked" | "ignored" | "untracked";
}
type Inventory = Map<string, FileFacts>;

function walkFiles(top: string, out: Map<string, { sha: string; blob: string; link: boolean }>): void {
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) out.set(p, { sha: `link:${readlinkSync(p)}`, blob: "", link: true });
      else if (e.isDirectory()) visit(p);
      else {
        const data = readFileSync(p);
        out.set(p, { sha: createHash("sha256").update(data).digest("hex"), blob: createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"), link: false });
      }
    }
  };
  if (existsSync(top)) visit(top);
}

/** Everything in the projects folder, and the kept place for test chats: nothing a pass can touch is outside these. Asking git what each file is only matters before a pass. */
function inventory(w: WorldData, o: { kinds?: boolean } = {}): Inventory {
  const raw = new Map<string, { sha: string; blob: string; link: boolean }>();
  walkFiles(w.fx.parent, raw);
  walkFiles(join(w.fx.state, "retired-test-chats"), raw);
  if (!o.kinds) return new Map([...raw].map(([p, f]) => [p, { ...f, kind: "untracked" as const }]));
  const out: Inventory = new Map();
  const trackedOf = new Map<string, Set<string>>();
  const tracked = (top: string): Set<string> => {
    let s = trackedOf.get(top);
    if (!s) {
      s = new Set(existsSync(join(top, ".git")) ? git(top, ["ls-files"]).split("\n").filter(Boolean) : []);
      trackedOf.set(top, s);
    }
    return s;
  };
  for (const [p, f] of raw) {
    const top = treeOf(w, p);
    const rel = top ? relative(top, p) : p;
    const inTree = top && tracked(top).has(rel);
    out.set(p, { ...f, kind: inTree ? "tracked" : ignoredIn(top, rel) ? "ignored" : "untracked" });
  }
  return out;
}

const treeOf = (w: WorldData, file: string): string | null => {
  const wt = join(w.fx.parent, ".worktrees");
  if (file.startsWith(`${wt}/`)) return join(wt, relative(wt, file).split("/")[0]!);
  for (const m of [w.main, w.sibling, w.other]) if (file.startsWith(`${m}/`)) return m;
  return null;
};

const ignoredIn = (top: string | null, rel: string): boolean => {
  if (!top || !existsSync(join(top, ".git"))) return true; // a folder with no .git: what a partial delete leaves, judged as ignored, as the rehearsal does
  return git(top, ["check-ignore", "-q", "--", rel], { allowFail: true }) === "" && spawnIgnored(top, rel);
};
function spawnIgnored(top: string, rel: string): boolean {
  try {
    git(top, ["check-ignore", "--", rel]);
    return true;
  } catch {
    return false;
  }
}

// --- the report ---------------------------------------------------------------------------------

interface Row {
  path: string;
  retired?: boolean;
  reason?: string;
  rebuildable?: string[];
  testCopy?: Record<string, string[]>;
}
type Groups = Record<string, Row[]>;
interface Report {
  list: { path: string }[];
  groups: Groups;
  repos: Record<string, Groups>;
  done?: boolean;
}
const ledgerOf = (w: WorldData) => readLedger(join(w.fx.state, "removed-worktrees.json"));
const reportOf = (w: WorldData): Report => JSON.parse(readFileSync(join(w.fx.state, "retire-first-pass.json"), "utf8")) as Report;

const refsOf = (w: WorldData): Record<string, string> => Object.fromEntries([w.main, w.sibling, w.other].map((r) => [basename(r), git(r, ["for-each-ref", "--format=%(refname) %(objectname)"])]));

const norm = (w: WorldData, r: Report) => {
  const rows = (g: Groups) => Object.fromEntries(Object.entries(g).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort((a, b) => a.path.localeCompare(b.path)).map((row) => strip(row))]));
  const strip = (row: Row) => {
    const { tip: _tip, ...rest } = row as Row & { tip?: string };
    return JSON.parse(JSON.stringify(rest).replaceAll(w.root, "<root>")) as Row;
  };
  return { groups: rows(r.groups), repos: Object.fromEntries(Object.entries(r.repos).sort().map(([k, g]) => [basename(k), rows(g)])), listed: r.list.map((x) => x.path.replaceAll(w.root, "<root>")).sort() };
};

/** Pass after pass with the clock moving by a wake-up, until a pass changes nothing and nothing can still clear: the way the server runs. */
async function untilQuiet(w: WorldData, records: ReturnType<typeof leftovers>, clock: Clock, stop: Stop | null, onFirst?: () => void): Promise<void> {
  const deps = depsOf(w, records, clock, stop);
  let last = "";
  for (let i = 0; i < 12; i++) {
    await retirePass(deps);
    if (stop?.dead) return;
    if (i === 0) onFirst?.();
    const now = JSON.stringify([...inventory(w).keys()].sort());
    const movable = clock.t < w.start + 40 * MIN;
    if (now === last && !movable) return;
    last = now;
    clock.t += 11 * MIN;
  }
  assert.fail("the passes never went quiet");
}

// --- the oracle ---------------------------------------------------------------------------------

const REAL_COPIED = '{"type":"session","id":"copied"}\n{"text":"a real chat holds this"}\n{"text":"later"}\n';

interface LetGoFacts {
  reachable: Set<string>;
  post: Inventory;
}

/** What the rule lets go, or null: this file's reading of §chat.worktrees/leftovers, kept apart from the code. */
function letGo(w: WorldData, tree: string, rel: string, f: FileFacts, facts: LetGoFacts): string | null {
  if (f.link) return "symlink";
  if (f.kind === "tracked" && facts.reachable.has(blobOf(f))) return "in git";
  const draft = /^\.sova\/spec\/drafts\/([^/]+)\//.exec(rel);
  if (draft) return w.proved.has(draft[1]!) ? "proved draft" : null;
  if (/^\.agent\/sessions\/(?!live\/)/.test(rel)) {
    const aside = join(w.fx.state, "retired-test-chats", basename(tree));
    const moved = [...facts.post.entries()].some(([p, x]) => p.startsWith(`${aside}/`) && x.sha === f.sha);
    return moved ? "chat moved aside" : rel.endsWith(".jsonl") && heldByReal(w, f) ? "real chat holds it" : null;
  }
  if (rel.startsWith(".agent/")) return ".agent rest or login";
  if (f.kind === "ignored" && rel.endsWith(".log")) return "test log";
  if (f.kind === "ignored" && /\.(mp4|webm|mov|mkv)$/i.test(rel)) {
    const elsewhere = [...facts.post.entries()].some(([p, x]) => !p.startsWith(`${tree}/`) && x.sha === f.sha);
    return elsewhere || facts.reachable.has(blobOf(f)) ? "recording that outlives" : null;
  }
  if (/^tmp(\/|$)/.test(rel)) return "top-level tmp";
  if (/(^|\/)(node_modules|__pycache__)\//.test(rel)) return "rebuildable";
  if (/^(dist|dist-[^/]+|build|out|target|coverage|\.cache)\//.test(rel) || /\.(tsbuildinfo|pyc)$/.test(rel) || rel.endsWith(".DS_Store")) return "rebuildable";
  return null;
}
const blobOf = (f: FileFacts): string => f.blob;
function heldByReal(w: WorldData, f: FileFacts): boolean {
  const real = join(w.fx.state, "real-sessions");
  const out: Map<string, { sha: string; blob: string; link: boolean }> = new Map();
  walkFiles(real, out);
  for (const p of out.keys()) {
    const body = readFileSync(p);
    // A real chat holds it when it starts with every one of the test chat's bytes.
    for (let n = 1; n <= body.length; n++) if (createHash("sha256").update(body.subarray(0, n)).digest("hex") === f.sha) return true;
  }
  return false;
}

/** Every blob and commit some ref reaches after git's own tidy-up. Read once per check. */
function reachableAfterGc(w: WorldData): Set<string> {
  const out = new Set<string>();
  for (const r of [w.main, w.sibling, w.other]) {
    git(r, ["gc", "-q", "--prune=now"]);
    for (const l of git(r, ["rev-list", "--objects", "--no-object-names", "--all"]).split("\n")) if (l) out.add(l);
  }
  return out;
}

interface Verdict {
  listed: string[];
  lost: string[];
  group: string[];
}

function judgeRun(w: WorldData, pre: Inventory, post: Inventory, reachable: Set<string>, report: Report, ledger: readonly RemovedWorktree[]): Verdict {
  const v: Verdict = { listed: [], lost: [], group: [] };
  const waitingAtClose = new Set(Object.values(report.repos).flatMap((g) => (g.waiting ?? []).map((r) => r.path)));
  const facts: LetGoFacts = { reachable, post };
  const rowFor = new Map<string, Row>();
  for (const g of Object.values(report.repos)) {
    for (const r of g.retired ?? []) rowFor.set(r.path, r);
    for (const r of g.queueOwn ?? []) if (r.retired) rowFor.set(r.path, r);
  }
  for (const [p, f] of pre) {
    const after = post.get(p);
    if (after && after.sha === f.sha) continue;
    const tree = treeOf(w, p);
    if (!tree || tree === w.main || tree === w.sibling || tree === w.other) {
      v.lost.push(p);
      continue;
    }
    const rel = relative(tree, p);
    const kind = letGo(w, tree, rel, f, facts);
    if (kind === null) {
      v.lost.push(`${rel} in ${tree}`);
      continue;
    }
    if (kind === "in git" || kind === "symlink") continue;
    // A later pass's removal: the closed report has this tree as waiting, and only the ledger says it went.
    if (waitingAtClose.has(tree)) {
      if (!ledger.some((e) => e.path === tree && e.retired)) v.listed.push(`${tree} waited in the report and its files went with no ledger entry`);
      continue;
    }
    const row = rowFor.get(tree);
    if (!row) {
      v.listed.push(`${rel} (${kind}) went from ${tree}, and the report has no row for it`);
      continue;
    }
    const entries = [...(row.rebuildable ?? []), ...Object.values(row.testCopy ?? {}).flat()].map((x) => x.replace(/\/+$/, ""));
    if (!entries.some((e) => rel === e || rel.startsWith(`${e}/`))) v.listed.push(`${rel} (${kind}) went from ${tree}, and row lists: ${JSON.stringify(entries)}`);
  }
  for (const place of w.places) {
    const groups = Object.entries(report.repos).flatMap(([repo, g]) => Object.entries(g).flatMap(([name, rows]) => rows.filter((r) => r.path === place).map(() => `${basename(repo)}:${name}`)));
    if (groups.length !== 1) v.group.push(`${place}: ${groups.length} groups: ${groups.join(", ")}`);
  }
  return v;
}

const assertOracle = (name: string, v: Verdict) => {
  assert.deepEqual(v.lost, [], `${name}: nothing unique is lost`);
  assert.deepEqual(v.listed, [], `${name}: every deleted file is listed`);
  assert.deepEqual(v.group, [], `${name}: every worktree in exactly one group`);
};

/** In the repository with the setting off, no branch goes, whatever retired. */
const branchesOf = (w: WorldData): string => git(w.sibling, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);

/** Fixture state restored exactly, paths and all, so each run starts from the same world at no build cost. */
function restorable(w: WorldData): () => void {
  const backup = `${w.root}-backup`;
  rmSync(backup, { recursive: true, force: true });
  cpSync(w.root, backup, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  return () => {
    rmSync(w.root, { recursive: true, force: true });
    cpSync(backup, w.root, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    // A folder's own time isn't what the copy kept: the brand-new ones must read as brand new again.
    for (const t of w.fresh) utimesSync(t, new Date(w.start - 2 * MIN), new Date(w.start - 2 * MIN));
  };
}

test("the world, run to quiet, stopped at every removal: nothing lost, everything reported, one group each, the same result", { timeout: 120_000 }, async () => {
  const w = build();
  worlds.push(w);
  const records = leftovers(w);
  mkdirSync(join(w.fx.state, "real-sessions/--y--"), { recursive: true });
  writeFileSync(join(w.fx.state, "real-sessions/--y--/copied.jsonl"), REAL_COPIED);
  const restore = restorable(w);
  const pre = inventory(w, { kinds: true });
  const keptBefore = branchesOf(w);
  assert.ok(pre.size > 80, `the inventory really holds the world: ${pre.size}`);
  assert.ok(w.places.length >= 18, `enough places to reach the pool's limit: ${w.places.length}`);

  // Unbroken.
  const clock = { t: w.start };
  let closed = "";
  await untilQuiet(w, records, clock, null, () => (closed = readFileSync(join(w.fx.state, "retire-first-pass.json"), "utf8")));
  assert.ok(closed, "the first pass closed its report");
  assert.equal(readFileSync(join(w.fx.state, "retire-first-pass.json"), "utf8"), closed, "no later pass changes the closed report");
  assert.ok(reportOf(w).done, "the report says it's closed");
  // The more-than-one-wake-up case really happened: brand-new folders and busy chats waited, and later passes took them.
  const waited = (reportOf(w).groups.waiting ?? []).map((r) => r.path);
  assert.ok(waited.length >= 5, `the world waited in its first pass: ${waited.length}`);
  for (const p of waited) assert.equal(existsSync(p), false, `${p} waited, then a later pass took it`);
  const post = inventory(w);
  const reachable = reachableAfterGc(w);
  const report = reportOf(w);
  const removals = readLedger(join(w.fx.state, "removed-worktrees.json")).length;
  assert.ok(removals > 3, `enough removals to reach past the pool of 3: ${removals}`);
  assert.ok(pre.size > post.size, "the pass really deleted something, so the checks below have something to compare");
  assertOracle("unbroken", judgeRun(w, pre, post, reachable, report, ledgerOf(w)));
  assert.equal(branchesOf(w), keptBefore, "kept branches stay: the setting was off in the copy");
  const want = { report: norm(w, report), files: [...post].map(([p, f]) => [p.replaceAll(w.root, "<root>"), f.sha]).sort(), refs: refsOf(w) };

  // A pass after quiet changes nothing: files, report, branches.
  const before = { files: [...inventory(w)].map(([p, f]) => [p, f.sha]).sort(), report: readFileSync(join(w.fx.state, "retire-first-pass.json"), "utf8"), refs: refsOf(w) };
  clock.t += 11 * MIN; // a later wake-up, as the server's next pass is
  await retirePass(depsOf(w, records, clock, null));
  assert.deepEqual({ files: [...inventory(w)].map(([p, f]) => [p, f.sha]).sort(), report: readFileSync(join(w.fx.state, "retire-first-pass.json"), "utf8"), refs: refsOf(w) }, before, "a pass after quiet changes nothing");

  // Stopped at each removal in turn.
  for (let k = 1; k <= removals; k++) {
    restore();
    const c = { t: w.start };
    const stop: Stop = { at: k, seen: 0, dead: false };
    await untilQuiet(w, records, c, stop);
    assert.ok(stop.dead, `stop ${k}: the run really reached removal ${k}`);
    rmSync(join(w.fx.state, "dead-process"), { recursive: true, force: true });
    await untilQuiet(w, records, c, null);
    const after = inventory(w);
    const r = reportOf(w);
    assertOracle(`stopped at removal ${k}`, judgeRun(w, pre, after, reachable, r, ledgerOf(w)));
    assert.equal(branchesOf(w), keptBefore, `stopped at removal ${k}: kept branches stay`);
    assert.deepEqual(norm(w, r), want.report, `stopped at removal ${k}: the report matches an unbroken run`);
    assert.deepEqual({ files: [...after].map(([p, f]) => [p.replaceAll(w.root, "<root>"), f.sha]).sort(), refs: refsOf(w) }, { files: want.files, refs: want.refs }, `stopped at removal ${k}: the files and branches match`);
  }

  // Killed inside git, at each point its own delete can stop, in the tree that has the most kinds of file: the same end as no stop at all.
  for (const point of ["before any file", ".git gone", "half the files gone"] as CutPoint[]) {
    restore();
    const c = { t: w.start };
    const stop: Stop = { at: -1, seen: 0, dead: false, cut: { tree: "demo-testcopy", point } };
    await untilQuiet(w, records, c, stop);
    assert.ok(stop.dead, `${point}: the run really reached that removal`);
    rmSync(join(w.fx.state, "dead-process"), { recursive: true, force: true });
    await untilQuiet(w, records, c, null);
    const after = inventory(w);
    const r = reportOf(w);
    const tree = join(w.fx.parent, ".worktrees", "demo-testcopy");
    assertOracle(`killed in git, ${point}`, judgeRun(w, pre, after, reachable, r, ledgerOf(w)));
    assert.deepEqual(norm(w, r), want.report, `killed in git, ${point}: the report matches an unbroken run`);
    assert.deepEqual({ files: [...after].map(([p, f]) => [p.replaceAll(w.root, "<root>"), f.sha]).sort(), refs: refsOf(w) }, { files: want.files, refs: want.refs }, `killed in git, ${point}: the files and branches match`);
    assert.equal(ledgerOf(w).filter((e) => e.path === tree && e.retired && !e.partial).length, 1, `killed in git, ${point}: one plain ledger entry`);
  }
});

// --- a removal cut off, one world per pass ------------------------------------------------------

interface CutCase {
  name: string;
  /** Inside `.worktrees`, or a linked worktree anywhere else git has one. */
  outside?: boolean;
  point: CutPoint | "folder gone";
  /** Sova's own note that it was removing this very folder. */
  intent?: boolean;
  /** A file nothing else has. */
  unique?: boolean;
  /** The branch moved after the note. */
  moved?: boolean;
  /** The setting kept this branch when the removal began. */
  kept?: boolean;
  /** Something is running in it. */
  busy?: boolean;
  /** Stopped with this process alive, so the removal itself finds it. */
  live?: boolean;
  want: "retired" | "held";
}

const CUTS: CutCase[] = [
  { name: "gitgone-intent", point: ".git gone", intent: true, want: "retired" },
  { name: "half-intent", point: "half the files gone", intent: true, want: "retired" },
  { name: "gitgone-out", outside: true, point: ".git gone", intent: true, want: "retired" },
  { name: "half-out", outside: true, point: "half the files gone", intent: true, want: "retired" },
  { name: "folder-gone", point: "folder gone", intent: true, want: "retired" },
  { name: "kept-branch", point: ".git gone", intent: true, kept: true, want: "retired" },
  { name: "live-half", point: "half the files gone", live: true, want: "retired" },
  { name: "live-out", outside: true, point: ".git gone", live: true, want: "retired" },
  { name: "gitgone-nointent", point: ".git gone", want: "held" },
  { name: "half-nointent", point: "half the files gone", want: "held" },
  { name: "out-nointent", outside: true, point: ".git gone", want: "held" },
  { name: "unique-intent", point: ".git gone", intent: true, unique: true, want: "held" },
  { name: "unique-out", outside: true, point: "half the files gone", intent: true, unique: true, want: "held" },
  { name: "unique-live", point: ".git gone", live: true, unique: true, want: "held" },
  { name: "moved-branch", point: ".git gone", intent: true, moved: true, want: "held" },
  { name: "busy-inside", point: ".git gone", intent: true, busy: true, want: "held" },
  { name: "git-still-there", point: "half gone, .git left", intent: true, want: "held" },
];

test("a removal cut off with git still listing the folder: finished only under the proof and Sova's own note, one registration dropped", { timeout: 60_000 }, async () => {
  const fx = new Fixture({ remote: false });
  const main = fx.project;
  for (const p of ["node_modules/", ".agent/"]) exclude(main, p);
  const w: WorldData = { fx, root: fx.root, main, sibling: join(fx.parent, "no-sibling"), other: join(fx.parent, "no-other"), places: [], proved: new Set(), queueMade: new Set(), fresh: [], busyUntil: new Map(), start: Date.now() + 60 * MIN, repos: [main], cutNow: new Map() };
  worlds.push(w);
  const commonDir = canonical(join(main, ".git"));
  const held = new Map<string, ProcFacts>();
  w.processes = async () => [...held.values()];

  const paths = new Map<CutCase, string>();
  const tips = new Map<CutCase, string>();
  const intents: RemovedWorktree[] = [];
  for (const c of CUTS) {
    const t = c.outside ? join(fx.parent, "elsewhere", "hash", `wf_${c.name}`, "alignment") : join(fx.parent, ".worktrees", `demo-${c.name}`);
    mkdirSync(dirname(t), { recursive: true });
    git(main, ["worktree", "add", "-q", "-b", `feat/${c.name}`, t, "master"]);
    for (const f of ["a", "b", "c", "d"]) put(t, `${c.name}-${f}.txt`, `${f}\n`);
    git(t, ["add", "-A"]);
    git(t, ["commit", "-q", "-m", c.name]);
    git(main, ["merge", "-q", "--no-ff", "--no-edit", `feat/${c.name}`]);
    put(t, "node_modules/dep/i.js", "// dependency\n");
    paths.set(c, t);
    tips.set(c, git(t, ["rev-parse", "HEAD"]));
    w.places.push(t);
  }
  for (const c of CUTS) {
    const t = paths.get(c)!;
    if (c.intent) intents.push({ v: 1, path: t, branch: `feat/${c.name}`, commonDir, tip: tips.get(c)!, merged: "ancestor", branchDeleted: false, at: w.start - 5 * MIN, retired: true, pinned: true, ...(c.kept ? { branchKept: true as const } : {}) });
    if (c.unique) put(t, "only-here.txt", "not anywhere else\n");
    if (c.live) {
      w.cutNow!.set(t, c.point as CutPoint);
      continue;
    }
    if (c.moved) {
      git(t, ["commit", "-q", "--allow-empty", "-m", "after the note"]);
    }
    if (c.point === "folder gone") rmSync(t, { recursive: true, force: true });
    else cutFolder(t, c.point);
    if (c.busy) held.set(c.name, { pid: 4242, command: "vim", paths: [t] });
  }
  mkdirSync(fx.state, { recursive: true });
  writeFileSync(join(fx.state, "retire-pending.json.intents"), JSON.stringify(intents));
  const records: ReturnType<typeof leftovers> = [];
  const before = inventory(w);
  const listedBefore = git(main, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const fileOf = (t: string, m: Inventory) => [...m].filter(([p]) => p === t || p.startsWith(`${t}/`)).map(([p, f]) => [p, f.sha]).sort();

  const clock = { t: w.start };
  await retirePass(depsOf(w, records, clock, null));
  const report = reportOf(w);
  const after = inventory(w);
  const listedAfter = new Set(git(main, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)));
  const groupsOfPath = (t: string) => Object.entries(report.groups).filter(([, rows]) => rows.some((r) => r.path === t)).map(([g]) => g);
  for (const c of CUTS) {
    const t = paths.get(c)!;
    const entries = ledgerOf(w).filter((e) => e.path === t);
    if (c.want === "retired") {
      assert.equal(existsSync(t), false, `${c.name}: the folder is gone`);
      assert.equal(listedAfter.has(t), false, `${c.name}: git no longer lists it`);
      assert.equal(entries.filter((e) => e.retired && !e.partial).length, 1, `${c.name}: one plain ledger entry, as an unbroken removal writes`);
      assert.deepEqual(groupsOfPath(t), ["retired"], `${c.name}: in the retired group only`);
      assert.equal(git(main, ["rev-parse", "--verify", "-q", `refs/sova/retired/${tips.get(c)!}`]), tips.get(c)!, `${c.name}: its last commit is pinned`);
      const branch = git(main, ["for-each-ref", `refs/heads/feat/${c.name}`]);
      if (c.kept) {
        assert.notEqual(branch, "", `${c.name}: the setting kept its branch`);
        assert.equal(entries[0]!.branchKept, true, `${c.name}: the ledger says it was kept`);
      } else assert.equal(branch, "", `${c.name}: its branch went, the setting being on`);
    } else {
      assert.equal(listedAfter.has(t), true, `${c.name}: git still lists it`);
      assert.deepEqual(entries, [], `${c.name}: nothing says it went`);
      assert.deepEqual(groupsOfPath(t), ["held"], `${c.name}: in the held group only`);
      assert.deepEqual(fileOf(t, after), c.live ? fileOf(t, after) : fileOf(t, before), `${c.name}: not one file touched`);
      assert.notEqual(git(main, ["for-each-ref", `refs/heads/feat/${c.name}`]), "", `${c.name}: its branch stays`);
      const reason = report.groups.held!.find((r) => r.path === t)!.reason!;
      assert.ok(reason.length > 20, `${c.name}: a reason a person can act on: ${reason}`);
      if (c.unique) assert.match(reason, /only-here\.txt/, `${c.name}: names the file that keeps it`);
      if (!c.intent && !c.live) assert.match(reason, /git worktree repair/, `${c.name}: says how to keep it, and no retry came near it: ${reason}`);
    }
    if (c.unique) assert.ok(existsSync(join(t, "only-here.txt")), `${c.name}: the unique file is there`);
  }
  // A repo-wide prune would have forgotten every held row above; this says it in one line.
  assert.deepEqual([...listedAfter].sort(), listedBefore.filter((p) => !CUTS.some((c) => c.want === "retired" && paths.get(c) === p)).sort(), "only the finished ones left git's list");
  assert.ok(report.done, "the first pass closed");

  // No pass and no caller finishes one with no note: this very step, handed a proof that always says yes, still leaves it to git's refusal.
  const noNote = paths.get(CUTS.find((c) => c.name === "gitgone-nointent")!)!;
  const refused = await removeTree({ path: noNote, main, git: (args, cwd) => execGit(args, { cwd }).then((r) => ({ code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr })), proof: async () => null });
  assert.equal(refused.state, "refused", "a .git already gone when the removal started is git's to refuse");
  assert.deepEqual(fileOf(noNote, inventory(w)), fileOf(noNote, before), "and nothing was touched");

  // Doubts clear, and the row isn't stuck; the ones with no note stay exactly as they are.
  for (const c of CUTS) {
    if (c.unique) rmSync(join(paths.get(c)!, "only-here.txt"));
    if (c.busy) held.clear();
  }
  clock.t += 11 * MIN;
  await retirePass(depsOf(w, records, clock, null));
  for (const c of CUTS.filter((x) => x.want === "held")) {
    const t = paths.get(c)!;
    const clears = c.unique || c.busy;
    assert.equal(existsSync(t), !clears, `${c.name}: ${clears ? "the doubt cleared, so the next pass finished it" : "still there"}`);
    if (clears) assert.equal(ledgerOf(w).filter((e) => e.path === t && e.retired && !e.partial).length, 1, `${c.name}: one ledger entry`);
  }
});

// --- what is running in a folder ----------------------------------------------------------------

/** Until a child's own git is what's running in its pid: between fork and exec it is still this program. */
async function untilGit(pid: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "git") return;
    } catch {
      // not there yet
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`git never started in pid ${pid}`);
}

test("what's running in a folder: this process's own git child doesn't hold it, a git it didn't start does", { timeout: 60_000, skip: process.platform !== "linux" }, async () => {
  const fx = new Fixture({ remote: false });
  const main = fx.project;
  const w: WorldData = { fx, root: fx.root, main, sibling: join(fx.parent, "no-sibling"), other: join(fx.parent, "no-other"), places: [], proved: new Set(), queueMade: new Set(), fresh: [], busyUntil: new Map(), start: Date.now() + 60 * MIN, repos: [main], processes: () => scanProcesses() };
  worlds.push(w);
  const tree = (name: string): string => {
    const t = join(fx.parent, ".worktrees", `demo-${name}`);
    git(main, ["worktree", "add", "-q", "-b", `feat/${name}`, t, "master"]);
    put(t, `${name}.txt`, "x\n");
    git(t, ["add", "-A"]);
    git(t, ["commit", "-q", "-m", name]);
    git(main, ["merge", "-q", "--no-ff", "--no-edit", `feat/${name}`]);
    w.places.push(t);
    return t;
  };
  const mineIn = tree("own-child");
  const theirsIn = tree("not-a-child");
  // `cat-file --batch` waits on its stdin: a git that stays until this test lets go of it.
  const kids: ChildProcess[] = [];
  const run = (args: string[], cwd: string): ChildProcess => {
    const c = spawn("git", args, { cwd, stdio: ["pipe", "ignore", "ignore"] });
    kids.push(c);
    return c;
  };
  try {
    const mine = run(["cat-file", "--batch"], mineIn);
    await untilGit(mine.pid!);
    // Started by git, not by this process: its parent is that git, whatever it's called.
    const wrapper = run(["-c", "alias.stay=!exec git cat-file --batch", "stay"], theirsIn);
    await untilGit(wrapper.pid!);
    const theirs = await (async () => {
      for (let i = 0; i < 400; i++) {
        const found = (await scanProcesses()).find((p) => p.pid !== wrapper.pid && p.pid !== mine.pid && p.command === "git" && p.paths.some((x) => isWithin(x, canonical(theirsIn))));
        if (found) return found;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.fail("the git nobody here started never appeared");
    })();
    await retirePass(depsOf(w, [], { t: w.start }, null));
    const report = reportOf(w);
    assert.equal(existsSync(mineIn), false, "its own git child didn't keep the folder");
    assert.deepEqual(report.groups.retired!.map((r) => r.path), [mineIn], "and it reads as retired");
    assert.ok(existsSync(theirsIn), "the other git kept its folder");
    assert.match(report.groups.held!.find((r) => r.path === theirsIn)!.reason!, new RegExp(`A process is running in it: git \\(${theirs.pid}\\)`), "the held row names the git that isn't this process's");
  } finally {
    for (const k of kids) {
      k.stdin?.end();
      k.kill();
    }
  }
});

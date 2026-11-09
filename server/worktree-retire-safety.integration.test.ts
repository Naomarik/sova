// §chat.worktrees/retirement and §chat.worktrees/cleanup: deletion safety. Every test here is real git on a temp
// repository, with real processes where a process is the point; only what chats report is stood in for.
//
// Two rules keep a test from passing on a retirer that does nothing:
// - every hold compares a full snapshot (files with contents, refs, git's list, the ledger) before and after;
// - every hold then clears its reason and must retire on the next pass, so the hold was that reason and no other.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { cpSync, utimesSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { canonical, isWithin } from "../pi-config/extensions/worktrees/state.ts";
import type { Git } from "../pi-config/extensions/worktrees/git.ts";
import { Fixture, git } from "./merge-queue/testing/repo";
import { chatUses, classifyRepo, configureCleanup, pidAlive, scanProcesses, type ChatFacts, type ChatUse, type ProcFacts, type TreeRecord } from "./worktree-cleanup";
import { leftoverCandidates, removeFinished, retireFiles, retirePass, retireTree, retirementAllowed, restoreRetired, bringBack, retireNow, setRealRetireDeps, startWorktreeRetirer, type RetireDeps, type CopyFacts, type PassResult } from "./worktree-retire";
import { archiveWorktrees } from "./archive-worktrees";
import { DEFAULT_CAPS } from "./overseer-store";
import { overseerTools, TurnLimits, type OverseerToolHost } from "./overseer-tools";
import { removeWorktree } from "./project-worktrees";
import { retirementViewOf } from "./worktree-retire-view";
import type { SessionSummary } from "../shared/protocol";
import { branchLeft } from "./nothing-left";
import { leftovers, leftoversReason } from "./worktree-leftovers";
import { leftoverRefusal, type LeftoverChat, type LeftoverInput } from "./worktree-remove";
import { bringBackForChat, needsBringBack, takeRetireLines } from "./worktree-retire-notes";
import { inHeldPartialFolder, retiredFallbackFacts } from "./session-cwd";
import { appendLedger, markLedger, readLedger, type RemovedWorktree } from "./removed-worktrees";
import { execGit, type GitRunner } from "./worktrees";
import { startHermeticServer } from "./testing/hermetic-server";
import { until } from "./test-wait";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const fixtures: Fixture[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const f of fixtures) f.dispose();
});

/** What a test acts on around each write the retirer sends. */
type WriteHook = (args: readonly string[], cwd: string, phase: "before" | "after") => void | Promise<void>;
const realGit: Git = async (args, cwd) => {
  const r = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
/** The command under any leading `-c k=v`. */
const verbOf = (args: readonly string[]): string[] => {
  const a = [...args];
  while (a[0] === "-c") a.splice(0, 2);
  return a;
};
const isRemove = (args: readonly string[]) => verbOf(args)[0] === "worktree" && verbOf(args)[1] === "remove";
const isPin = (args: readonly string[]) => verbOf(args)[0] === "update-ref" && !!verbOf(args)[1]?.startsWith("refs/sova/retired/");
/** The branch a write deletes, if it does. */
const deletesBranch = (args: readonly string[]): string | null => {
  const a = verbOf(args).filter((x) => x !== "--");
  if (a[0] === "branch" && (a[1] === "-d" || a[1] === "-D")) return a[2] ?? null;
  if (a[0] === "update-ref" && a[1] === "-d" && a[2]?.startsWith("refs/heads/")) return a[2].slice(11);
  return null;
};

/** A chat as a world holds it: what it would be asked about is worked out as the real reader does (chatUses). */
type Chat = Omit<ChatUse, "inside" | "tracks"> & { tracking: string[] };

interface World {
  fx: Fixture;
  deps: RetireDeps;
  chats: Chat[];
  procs: () => Promise<ProcFacts[]>;
  entries: Map<string, { id: string; state: string }>;
  records: TreeRecord[];
  writes: { args: readonly string[]; cwd: string }[];
  hooks: WriteHook[];
  copies: Map<string, CopyFacts>;
  ledgerFile: string;
  pendingPath: string;
  firstPassPath: string;
  /** `<state root>/retired-test-chats`. */
  asideDir: string;
  /** The user's own chats, which a test chat is compared against. */
  realChats: string;
  /** Worktrees the queue's chats made. */
  queueMade: Set<string>;
  now: { t: number };
  /** The platform the sandbox rule reads (§chat.worktrees/retirement): Linux unless the test says macOS. */
  platform: NodeJS.Platform;
  ledger(): RemovedWorktree[];
  pass(): Promise<PassResult>;
  record(path: string, branch: string): void;
}

/** The repository's own ledger names this folder, so it's proved this repository's: what a chat's record alone can't do for its branch. */
const provedOurs = (w: World, path: string, branch: string, tip = "") =>
  w.deps.appendLedger([{ v: 1, path, branch, commonDir: canonical(join(w.fx.project, ".git")), tip, merged: "ancestor", branchDeleted: !tip, at: 1, retired: true, ...(tip ? { pinned: true as const } : {}) }]);

/** A chat that holds nothing, overridden per case: idle an hour, with no workers and no TUI. */
const quietChat = (w: World, cwd: string | null, over: Partial<Chat> = {}): Chat => ({
  path: join(w.fx.state, `chat-${w.chats.length}.jsonl`),
  id: `chat-${w.chats.length}`,
  name: "a chat",
  cwd,
  tracking: [],
  archived: false,
  running: false,
  tui: false,
  workers: 0,
  sandbox: false,
  lastActiveAt: w.now.t - 60 * MIN,
  ...over,
});

function world(fo: ConstructorParameters<typeof Fixture>[0] = {}): World {
  const fx = new Fixture({ remote: false, ...fo });
  fixtures.push(fx);
  // An hour ahead: every folder a test makes is past the brand-new grace unless the test says otherwise.
  const now = { t: Date.now() + 60 * MIN };
  const ledgerFile = join(fx.state, "removed-worktrees.json");
  const pendingPath = join(fx.state, "retire-pending.json");
  const firstPassPath = join(fx.state, "retire-first-pass.json");
  const asideDir = join(fx.state, "retired-test-chats");
  const realChats = join(fx.state, "real-sessions");
  mkdirSync(realChats, { recursive: true });
  const queueMade = new Set<string>();
  const writes: World["writes"] = [];
  const hooks: WriteHook[] = [];
  const chats: Chat[] = [];
  const records: TreeRecord[] = [];
  const copies = new Map<string, CopyFacts>();
  const entries = new Map<string, { id: string; state: string }>();
  const through: Git = async (args, cwd) => {
    writes.push({ args, cwd });
    for (const h of hooks) await h(args, cwd, "before");
    const r = await realGit(args, cwd);
    for (const h of hooks) await h(args, cwd, "after");
    return r;
  };
  const targetOf = async (main: string) => ({ name: fx.target, oid: git(main, ["rev-parse", fx.target]) });
  const w = {
    fx, chats, records, entries, writes, hooks, copies, ledgerFile, pendingPath, firstPassPath, asideDir, realChats, queueMade, now, platform: "linux",
    procs: () => scanProcesses(),
    ledger: () => readLedger(ledgerFile),
    pass: () => retirePass(w.deps),
    record: (path: string, branch: string) => void records.push({ path, branch, base: git(fx.project, ["rev-list", "--max-parents=0", fx.target]), session: "s" }),
  } as unknown as World;
  w.deps = {
    allowed: () => ({ on: true }),
    repos: () => [fx.project],
    git: execGit,
    gitWrite: through,
    gitRemove: through,
    classify: (root, only) => classifyRepo(root, { git: execGit, withQueueMade: true, queueMade: async (p) => queueMade.has(p), ...(only ? { only } : {}) }),
    chats: async (paths, exclude): Promise<ChatFacts> => {
      const wanted = paths.map((p) => ({ path: p, canon: canonical(p) }));
      const uses = chats
        .filter((c) => c.path !== exclude)
        .map(({ tracking, ...c }): ChatUse => {
          const cwd = c.cwd ? canonical(c.cwd) : null;
          return { ...c, cwd, inside: cwd ? wanted.filter((x) => isWithin(cwd, x.canon)).map((x) => x.path) : [], tracks: wanted.filter((x) => tracking.map(canonical).includes(x.canon)).map((x) => x.path) };
        })
        .filter((u) => u.inside.length || u.tracks.length);
      return { uses, unreadable: [] };
    },
    records: async () => ({ records, unreadable: [] }),
    processes: () => w.procs(),
    alive: pidAlive,
    openEntry: (_root, branch) => entries.get(branch) ?? null,
    draftsUnproved: async (main, folder, branch) => {
      const tip = branch ? await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main }) : null;
      const target = await targetOf(main);
      return (await branchLeft({ root: main, folder, ...(branch ? { branch } : {}), head: tip?.code === 0 ? tip.stdout.trim() : target.oid, target })).drafts;
    },
    branchFinished: async (main, branch) => {
      const tip = await execGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: main });
      if (tip.code !== 0) return false;
      const left = await branchLeft({ root: main, branch, head: tip.stdout.trim(), target: await targetOf(main) });
      return !left.code.left && left.code.kind !== "unknown";
    },
    copies: { of: (p) => copies.get(p) ?? null, teardown: async (p) => void copies.delete(p) },
    ledger: () => readLedger(ledgerFile),
    appendLedger: (add) => appendLedger(add, ledgerFile),
    markLedger: (m, patch) => markLedger(m, patch, ledgerFile),
    removed: async () => {},
    now: () => now.t,
    // This suite is about what a removal may touch: every project in it deletes branches, except where a test says otherwise.
    deleteBranches: () => true,
    pendingFile: () => pendingPath,
    firstPassFile: () => firstPassPath,
    testChatsAside: () => asideDir,
    realChatsDir: () => realChats,
    platform: () => w.platform,
  };
  return w;
}

/** A finished branch: one commit, on the target by a real merge. Its folder holds what a finished folder holds. */
function finished(w: World, name: string): { branch: string; checkout: string; commit: string } {
  const b = w.fx.branch(name, { [`${name}.txt`]: `${name}\n` });
  git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
  mkdirSync(join(b.checkout, "node_modules/dep"), { recursive: true });
  writeFileSync(join(b.checkout, "node_modules/dep/index.js"), "// a dependency\n");
  return b;
}

/** Every file and link in a folder (contents and link targets), for comparing before and after. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = readFileSync(p, "latin1");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** All a retirer could change: the folder, every ref, git's list of worktrees, the ledger. */
function snapshot(w: World, dir: string, o: { pins?: "ignore" } = {}) {
  const refs = git(w.fx.project, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n");
  return {
    files: filesOf(dir),
    refs: o.pins === "ignore" ? refs.filter((r) => !r.startsWith("refs/sova/")) : refs,
    worktrees: git(w.fx.project, ["worktree", "list", "--porcelain"]),
    ledger: w.ledger().length,
  };
}

const retiredPaths = (r: PassResult): string[] => r.repos.flatMap((x) => x.retired.map((t) => t.path));
const heldOf = (r: PassResult, path: string) => r.repos.flatMap((x) => x.held).find((h) => h.path === path);
const waitingOf = (r: PassResult, path: string) => r.repos.flatMap((x) => x.waiting).find((h) => h.path === path);
const reasonOf = (r: PassResult, path: string): string => heldOf(r, path)?.reason ?? waitingOf(r, path)?.why ?? "";

const startIn = (cwd: string, stdio: StdioOptions = "ignore"): ChildProcess => {
  const c = spawn("sleep", ["300"], { cwd, stdio });
  children.push(c);
  return c;
};
const stop = async (c: ChildProcess): Promise<void> => {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const gone = new Promise((done) => c.once("exit", done));
  c.kill("SIGKILL");
  await gone;
};
const scanSees = (pid: number) => until(async () => (await scanProcesses()).find((p) => p.pid === pid), `pid ${pid} in the scan`);

// ---------------------------------------------------------------- a control

describe("the control", () => {
  test("a finished, unused branch does retire: folder and branch gone, pinned, in the ledger; the other tests' holds mean something because of this one", async () => {
    const w = world();
    const b = finished(w, "plain");
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), [b.checkout], JSON.stringify(r));
    assert.equal(existsSync(b.checkout), false, "the folder is gone");
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "", "the branch is gone");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit, "the pin holds the last commit");
    const led = w.ledger();
    assert.equal(led.length, 1);
    assert.equal(led[0]!.tip, b.commit);
    assert.equal(led[0]!.branch, b.branch);
    assert.equal(led[0]!.path, b.checkout);
    assert.equal(led[0]!.branchDeleted, true);
  });

  test("a branch with commits of its own is none of this: not retired, not held, not waiting", async () => {
    const w = world();
    const b = w.fx.branch("work", { "w.txt": "w\n" });
    const before = snapshot(w, b.checkout);
    const r = await w.pass();
    assert.ok(r.repos.length === 1 && !r.skipped, `the pass really ran: ${JSON.stringify(r)}`);
    assert.equal(heldOf(r, b.checkout), undefined);
    assert.equal(waitingOf(r, b.checkout), undefined);
    assert.deepEqual(retiredPaths(r), []);
    assert.deepEqual(snapshot(w, b.checkout), before);
  });

  test("the main checkout is never one, and neither is a worktree on the target's name", async () => {
    const w = world();
    const b = finished(w, "sidekick");
    const before = git(w.fx.project, ["rev-parse", w.fx.target]);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), [b.checkout]);
    assert.ok(existsSync(join(w.fx.project, ".git")));
    assert.equal(git(w.fx.project, ["rev-parse", w.fx.target]), before);
  });
});

// ---------------------------------------------------------------- what must hold

interface Hold {
  name: string;
  /** Make the condition true; returns the step that clears it. */
  make: (w: World, b: { branch: string; checkout: string; commit: string }) => Promise<() => void | Promise<void>> | (() => void | Promise<void>);
  /** What the reason must say. */
  says: RegExp;
  /** Which list: held, for what needs someone; waiting, for what clears by itself. */
  list: "held" | "waiting";
}

/** Ignored by the repository's own exclude file, so no commit changes for it. */
function ignoredFile(rel: string, name: string): Hold {
  return {
    name,
    says: /ignored file/,
    list: "held",
    make: (_w, b) => {
      const f = join(b.checkout, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, "only here\n");
      const abs = join(git(b.checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "info/exclude");
      mkdirSync(dirname(abs), { recursive: true });
      const was = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      writeFileSync(abs, `${was}${rel.split("/")[0]}\n`);
      return () => {
        rmSync(join(b.checkout, rel.split("/")[0]!), { recursive: true });
        writeFileSync(abs, was);
      };
    },
  };
}

const HOLDS: Hold[] = [
  {
    name: "an uncommitted edit",
    says: /README\.md|uncommitted/i,
    list: "held",
    make: (_w, b) => {
      const f = join(b.checkout, "README.md");
      const was = readFileSync(f, "utf8");
      writeFileSync(f, `${was}an edit that exists only here\n`);
      return () => writeFileSync(f, was);
    },
  },
  {
    name: "a staged new file",
    says: /staged\.txt|uncommitted/i,
    list: "held",
    make: (_w, b) => {
      writeFileSync(join(b.checkout, "staged.txt"), "only here\n");
      git(b.checkout, ["add", "staged.txt"]);
      return () => {
        git(b.checkout, ["rm", "-q", "--cached", "staged.txt"]);
        rmSync(join(b.checkout, "staged.txt"));
      };
    },
  },
  {
    name: "an untracked file",
    says: /notes\.md|untracked|uncommitted/i,
    list: "held",
    make: (_w, b) => {
      writeFileSync(join(b.checkout, "notes.md"), "only here\n");
      return () => rmSync(join(b.checkout, "notes.md"));
    },
  },
  ignoredFile("secrets.local", "an ignored file of no known kind"),
  ignoredFile(".env", "an ignored .env"),
  ignoredFile("dist.bak/old.js", "a folder named close to build output"),
  ignoredFile("node_modules.bak/x.js", "a folder named close to dependencies"),
  ignoredFile(".cachenotes", "a file named close to a cache"),
  {
    name: "a running process whose working directory is inside",
    says: /sleep/,
    list: "held",
    make: async (_w, b) => {
      const c = startIn(join(b.checkout, "node_modules"));
      await scanSees(c.pid!);
      return () => stop(c);
    },
  },
  {
    name: "a process elsewhere with a file open inside",
    says: /sleep/,
    list: "held",
    make: async (w, b) => {
      const fd = openSync(join(b.checkout, "README.md"), "r");
      const c = startIn(w.fx.state, [fd, "ignore", "ignore"]);
      closeSync(fd);
      await scanSees(c.pid!);
      return () => stop(c);
    },
  },
  {
    name: "a chat running in it",
    says: /running/,
    list: "waiting",
    make: (w, b) => {
      const c = quietChat(w, b.checkout, { running: true });
      w.chats.push(c);
      return () => void (c.running = false);
    },
  },
  {
    name: "a chat in it idle 9 minutes",
    says: /10 minutes/,
    list: "waiting",
    make: (w, b) => {
      const c = quietChat(w, b.checkout, { lastActiveAt: w.now.t - 9 * MIN });
      w.chats.push(c);
      return () => void (w.now.t += 2 * MIN);
    },
  },
  {
    name: "a chat elsewhere tracking it, running",
    says: /running/,
    list: "waiting",
    make: (w, b) => {
      const c = quietChat(w, w.fx.project, { tracking: [b.checkout], running: true });
      w.chats.push(c);
      return () => void (c.running = false);
    },
  },
  {
    name: "a chat with workers",
    says: /worker/,
    list: "waiting",
    make: (w, b) => {
      const c = quietChat(w, join(b.checkout, "node_modules"), { workers: 1 });
      w.chats.push(c);
      return () => void (c.workers = 0);
    },
  },
  {
    name: "a chat open in a TUI",
    says: /TUI/,
    list: "waiting",
    make: (w, b) => {
      const c = quietChat(w, b.checkout, { tui: true });
      w.chats.push(c);
      return () => void (c.tui = false);
    },
  },
  {
    name: "on macOS, a chat with its sandbox on",
    says: /sandbox/,
    list: "held",
    make: (w, b) => {
      w.platform = "darwin";
      const c = quietChat(w, b.checkout, { sandbox: true });
      w.chats.push(c);
      return () => void (c.sandbox = false);
    },
  },
  ...(["queued", "checking", "conflict", "needs-fix", "request-review", "requested"] as const).map((state): Hold => ({
    name: `a queue entry ${state}`,
    says: new RegExp(state),
    list: "waiting",
    make: (w, b) => {
      w.entries.set(b.branch, { id: "mq_x", state });
      return () => void w.entries.delete(b.branch);
    },
  })),
  {
    name: "a locked worktree",
    says: /Locked/,
    list: "held",
    make: (_w, b) => {
      git(b.checkout, ["worktree", "lock", "--reason", "a person said so", b.checkout]);
      return () => void git(b.checkout, ["worktree", "unlock", b.checkout]);
    },
  },
  {
    name: "a live record under its own .agent naming a process still alive",
    says: /live session/,
    list: "held",
    make: async (w, b) => {
      const c = startIn(w.fx.state);
      const dir = join(b.checkout, ".agent/sessions/live");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "s.json"), JSON.stringify({ pid: c.pid, sessionFile: "x" }));
      return () => stop(c);
    },
  },
  {
    name: "a test copy with an active share link",
    says: /share link/,
    list: "held",
    make: (w, b) => {
      w.copies.set(b.checkout, { id: "copy", shareLink: true, ownRun: false });
      return () => void w.copies.delete(b.checkout);
    },
  },
];

describe("every hold: nothing touched, then it retires once the reason clears", () => {
  for (const hold of HOLDS) {
    test(hold.name, async () => {
      const w = world();
      const b = finished(w, "held");
      const clear = await hold.make(w, b);
      const before = snapshot(w, b.checkout);
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), [], "nothing retires");
      const row = hold.list === "held" ? heldOf(r, b.checkout)?.reason : waitingOf(r, b.checkout)?.why;
      assert.match(row ?? `(not on the ${hold.list} list: ${JSON.stringify(r)})`, hold.says);
      assert.deepEqual(snapshot(w, b.checkout), before, "nothing changed: not a file, not a ref, not git's list, not the ledger");
      assert.deepEqual(w.writes.filter((x) => isRemove(x.args) || isPin(x.args) || deletesBranch(x.args)).map((x) => x.args.join(" ")), [], "no removal or pin was sent");
      await clear();
      const again = await w.pass();
      assert.deepEqual(retiredPaths(again), [b.checkout], `after the reason cleared: ${reasonOf(again, b.checkout)}`);
      assert.equal(existsSync(b.checkout), false);
    });
  }

  test("an unproved draft: held, the draft kept", async () => {
    const w = world();
    await w.fx.withSpec();
    const b = finished(w, "drafted");
    w.fx.draft(b.checkout, "drafted");
    const before = snapshot(w, b.checkout);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.match(reasonOf(r, b.checkout), /draft/i);
    assert.deepEqual(snapshot(w, b.checkout), before);
    assert.ok(existsSync(join(b.checkout, ".sova/spec/drafts/drafted")));
  });

  test("a draft folder half-written, with no record of what it is: it isn't read as no draft", async () => {
    const w = world();
    await w.fx.withSpec();
    const b = finished(w, "halfdraft");
    mkdirSync(join(b.checkout, ".sova/spec/drafts/half/spec"), { recursive: true });
    writeFileSync(join(b.checkout, ".sova/spec/drafts/half/spec/notes.md"), "only here\n");
    await w.pass();
    assert.equal(readFileSync(join(b.checkout, ".sova/spec/drafts/half/spec/notes.md"), "utf8"), "only here\n");
  });

  test("a drafts folder that can't be read: it isn't read as no draft", async () => {
    const w = world();
    await w.fx.withSpec();
    const b = finished(w, "lockeddraft");
    w.fx.draft(b.checkout, "lockeddraft");
    const dir = join(b.checkout, ".sova/spec/drafts");
    chmodSync(dir, 0o000);
    try {
      assert.deepEqual(retiredPaths(await w.pass()), []);
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.ok(existsSync(join(dir, "lockeddraft")));
  });

  test("a nested worktree under an ignored throwaway folder: its folder would go with this one", async () => {
    const w = world();
    const b = finished(w, "outer");
    const nested = join(b.checkout, "node_modules/.nested");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/nested", nested, w.fx.target]);
    w.fx.commitIn(nested, { "real.txt": "real\n" }, "real work in a nested tree");
    writeFileSync(join(nested, "uncommitted.txt"), "only here\n");
    const r = await w.pass();
    assert.equal(readFileSync(join(nested, "uncommitted.txt"), "utf8"), "only here\n", "the nested tree's files are still there");
    assert.deepEqual(retiredPaths(r).filter((p) => p === b.checkout), []);
    assert.notEqual(reasonOf(r, b.checkout), "", "and it says why");
  });

  test("a folder next door with a longer name holds nothing, and neither does a chat in it", async () => {
    const w = world();
    const b = finished(w, "near");
    const c = finished(w, "near-er");
    w.chats.push(quietChat(w, c.checkout, { running: true }));
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), [b.checkout], `near-er's chat is in ${c.checkout}, not in ${b.checkout}`);
    assert.ok(existsSync(c.checkout));
  });

  test("a running archived chat still holds; quiet, it doesn't", async () => {
    const w = world();
    const b = finished(w, "archived");
    const c = quietChat(w, b.checkout, { archived: true, running: true });
    w.chats.push(c);
    assert.deepEqual(retiredPaths(await w.pass()), [], "running holds, archived or not");
    c.running = false;
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
  });

  test("a brand-new folder waits, however finished it looks: its creator may not have recorded it yet", async () => {
    const w = world();
    const b = finished(w, "fresh");
    w.now.t = Date.now();
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.ok(existsSync(b.checkout));
  });

  test("Sova's target branch in a linked worktree is never retired, even with nothing left", async () => {
    const w = world();
    const dev = w.fx.worktreeOf("main-line");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "main", dev, w.fx.target]);
    w.fx.commitIn(dev, { "d.txt": "d\n" }, "on main");
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", "main"]);
    await w.pass();
    assert.ok(existsSync(dev), "a branch named main is where others land");
    assert.ok(git(w.fx.project, ["branch", "--list", "main"]).includes("main"));
  });
});

describe("a registered test copy", () => {
  test("no share link, a quiet chat: stopped first, then all of it asked again, then gone", async () => {
    const w = world();
    const b = finished(w, "copied");
    w.copies.set(b.checkout, { id: "copy", shareLink: false, ownRun: false });
    const order: string[] = [];
    w.deps.copies.teardown = async (p) => {
      order.push("teardown");
      w.copies.delete(p);
    };
    w.hooks.push((args, _c, phase) => void (phase === "before" && isRemove(args) && order.push("remove")));
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.deepEqual(order, ["teardown", "remove"]);
  });

  test("its chat under 10 minutes quiet: the copy isn't stopped", async () => {
    const w = world();
    const b = finished(w, "copied2");
    w.copies.set(b.checkout, { id: "copy", shareLink: false, ownRun: false });
    w.chats.push(quietChat(w, b.checkout, { lastActiveAt: w.now.t - 5 * MIN }));
    let stopped = 0;
    w.deps.copies.teardown = async () => void stopped++;
    await w.pass();
    assert.equal(stopped, 0);
    assert.ok(existsSync(b.checkout));
  });

  test("a teardown that fails holds it, and a process it left behind holds it", async () => {
    const w = world();
    const b = finished(w, "copied3");
    w.copies.set(b.checkout, { id: "copy", shareLink: false, ownRun: false });
    w.deps.copies.teardown = async () => {
      throw new Error("the unit wouldn't stop");
    };
    const r = await w.pass();
    assert.match(reasonOf(r, b.checkout), /wouldn't stop|couldn't be stopped/);
    assert.ok(existsSync(b.checkout));
    const c = startIn(b.checkout);
    await scanSees(c.pid!);
    w.deps.copies.teardown = async (p) => void w.copies.delete(p);
    const r2 = await w.pass();
    assert.deepEqual(retiredPaths(r2), []);
    assert.ok(existsSync(b.checkout), "the copy's process outlived its teardown");
    await stop(c);
  });

  test("a copy started by hand is a plain process: nothing stops it, and it holds", async () => {
    const w = world();
    const b = finished(w, "byhand");
    const c = startIn(b.checkout);
    await scanSees(c.pid!);
    const r = await w.pass();
    assert.match(reasonOf(r, b.checkout), /sleep/);
    assert.equal(c.exitCode, null);
    assert.equal(c.signalCode, null);
    await stop(c);
  });
});

// ---------------------------------------------------------------- checked again right before

describe("checked again right before anything is removed", () => {
  test("a chat that wakes after the first look stops the removal", async () => {
    const w = world();
    const b = finished(w, "woke");
    const c = quietChat(w, b.checkout);
    w.chats.push(c);
    let reads = 0;
    const real = w.deps.chats;
    w.deps.chats = async (p, e) => {
      if (++reads === 2) c.running = true;
      return real(p, e);
    };
    const before = snapshot(w, b.checkout, { pins: "ignore" });
    const r = await w.pass();
    assert.ok(reads >= 2, "the chats were read again");
    assert.deepEqual(retiredPaths(r), []);
    assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before);
  });

  test("a process that starts after the first look stops the removal", async () => {
    const w = world();
    const b = finished(w, "started");
    let reads = 0;
    w.procs = async () => {
      if (++reads === 2) await scanSees(startIn(b.checkout).pid!);
      return scanProcesses();
    };
    const before = snapshot(w, b.checkout, { pins: "ignore" });
    const r = await w.pass();
    assert.ok(reads >= 2, "the processes were read again");
    assert.deepEqual(retiredPaths(r), []);
    assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before);
  });

  test("a commit after the first look: the head that was finished isn't the head that's there", async () => {
    const w = world();
    const b = finished(w, "moved-early");
    let reads = 0;
    w.procs = async () => {
      if (++reads === 1) w.fx.commitIn(b.checkout, { "late.txt": "late\n" }, "late work");
      return scanProcesses();
    };
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.ok(existsSync(join(b.checkout, "late.txt")));
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch));
  });

  test("a file written after the first look: git itself refuses, and it's held, not forced", async () => {
    const w = world();
    const b = finished(w, "late-file");
    w.hooks.push((args, _c, phase) => {
      if (phase === "before" && isRemove(args)) writeFileSync(join(b.checkout, "late.txt"), "only here\n");
    });
    const r = await w.pass();
    assert.equal(readFileSync(join(b.checkout, "late.txt"), "utf8"), "only here\n");
    assert.deepEqual(retiredPaths(r), []);
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch));
  });
});

// ---------------------------------------------------------------- failing closed

describe("what can't be read holds", () => {
  /** Each pass really reaches the point it sabotages: the control retires the same tree with the sabotage undone. */
  const holdsWhen = (name: string, sabotage: (w: World) => void, expectReason?: RegExp) =>
    test(name, async () => {
      const w = world();
      const b = finished(w, "unread");
      const good = { ...w.deps };
      sabotage(w);
      const before = snapshot(w, b.checkout, { pins: "ignore" });
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), []);
      if (expectReason) assert.match(reasonOf(r, b.checkout) || (r.skipped ?? ""), expectReason);
      assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before);
      w.deps = good;
      w.procs = () => scanProcesses();
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout], "with the sabotage undone it retires");
    });

  holdsWhen("processes can't be read: the reader says so", (w) => {
    w.procs = async () => [{ pid: 0, command: "lsof", paths: [], unreadable: "Its processes couldn't be read" }];
  }, /couldn't be read/);
  holdsWhen("processes can't be read: the reader throws", (w) => {
    w.procs = async () => {
      throw new Error("no /proc");
    };
  }, /no \/proc/);
  holdsWhen("chats can't be read: one file", (w) => {
    w.deps.chats = async () => ({ uses: [], unreadable: ["some-chat.jsonl"] });
  }, /couldn't be read/);
  holdsWhen("chats can't be read: the reader throws", (w) => {
    w.deps.chats = async () => {
      throw new Error("no index");
    };
  }, /no index/);
  holdsWhen("records can't be read", (w) => {
    w.deps.records = async () => {
      throw new Error("no sessions folder");
    };
  }, /no sessions folder/);
  holdsWhen("the shared answer is unknown (git failed)", (w) => {
    w.deps.classify = (root, only) => classifyRepo(root, { git: execGit, left: async () => ({ nothingLeft: false, whole: "unknown", codeOnly: "unknown", code: { kind: "unknown", left: true, error: "git failed" }, drafts: [] }), ...(only ? { only } : {}) });
  }, /git failed/);
  holdsWhen("the shared answer throws", (w) => {
    w.deps.classify = (root, only) => classifyRepo(root, { git: execGit, left: async () => { throw new Error("boom"); }, ...(only ? { only } : {}) });
  });
  holdsWhen("git status fails", (w) => {
    const real = w.deps.git;
    const failing: GitRunner = async (args, opts) => (args.includes("status") ? { code: 128, stdout: "", stderr: "fatal: can't read" } : real(args, opts));
    w.deps.git = failing;
  });
  holdsWhen("the queue can't say whether an entry is open", (w) => {
    w.deps.openEntry = () => {
      throw new Error("the queue isn't loaded");
    };
  }, /the queue isn't loaded/);
  holdsWhen("the copies can't be read", (w) => {
    w.deps.copies = { ...w.deps.copies, of: () => { throw new Error("no registry"); } };
  }, /no registry/);

  test("scanProcesses never reads an unreadable process table as no processes", { skip: process.platform !== "linux" && "the /proc scan is Linux's" }, async () => {
    // A scan that sees nothing at all can't be true on a running machine.
    const seen = await scanProcesses();
    assert.ok(seen.some((p) => p.pid === process.ppid), "the scan sees the parent process");
  });
});

// ---------------------------------------------------------------- a test copy of Sova

describe("a hermetic server never retires anything", () => {
  const gate = (env: Record<string, string | undefined>, o: { agentDir: string; home: string }) => retirementAllowed(env as NodeJS.ProcessEnv, o);
  const REAL = { agentDir: "/home/u/.pi/agent", home: "/home/u" };

  test("the real one is on: the control for every other answer here", () => assert.equal(gate({}, REAL).on, true));
  test("an agent dir inside a checkout is off", () => assert.equal(gate({}, { agentDir: "/w/sova-x/.agent", home: "/home/u" }).on, false));
  test("a temp agent dir is off", () => assert.equal(gate({}, { agentDir: "/tmp/x/agent", home: "/home/u" }).on, false));
  test("SOVA_RETIRE=off is off", () => assert.equal(gate({ SOVA_RETIRE: "off" }, REAL).on, false));
  test("the test runner's switch is off", () => assert.equal(gate({ SOVA_GIT_MAINTENANCE: "off" }, REAL).on, false));
  test("a path that only ends the same way is off", () => {
    assert.equal(gate({}, { agentDir: "/home/u/sova/.pi/agent", home: "/home/u" }).on, false);
    assert.equal(gate({}, { agentDir: "/x/.pi/agent", home: "/home/u" }).on, false);
  });
  test("an unset agent dir or home is off", () => {
    assert.equal(gate({}, { agentDir: "", home: "/home/u" }).on, false);
    assert.equal(gate({}, { agentDir: REAL.agentDir, home: "" }).on, false);
  });
  test("this very test process, with no injected gate, is off", () => assert.equal(retirementAllowed().on, false));

  test("off, a pass reads and writes nothing", async () => {
    const w = world();
    const b = finished(w, "offcase");
    w.deps.allowed = () => ({ on: false, why: "a test copy", offFor: "test" });
    let asked = 0;
    w.deps.classify = async () => {
      asked++;
      return null;
    };
    const before = snapshot(w, b.checkout);
    const r = await w.pass();
    assert.equal(r.off, "a test copy");
    assert.equal(asked, 0);
    assert.deepEqual(snapshot(w, b.checkout), before);
    assert.deepEqual(w.writes, []);
    assert.equal(existsSync(w.pendingPath), false, "not even its report");
  });

  test("a gate that throws retires nothing", async () => {
    const w = world();
    const b = finished(w, "offcase");
    w.deps.allowed = () => {
      throw new Error("?");
    };
    const before = snapshot(w, b.checkout);
    await w.pass().catch(() => null);
    assert.deepEqual(snapshot(w, b.checkout), before);
  });
});

// ---------------------------------------------------------------- pins

describe("a pin precedes every branch delete", () => {
  test("in the order sent, across several branches, each delete after its own commit's pin", async () => {
    const w = world();
    const bs = ["p1", "p2", "p3", "p4", "p5"].map((n) => finished(w, n));
    const pinned = new Set<string>();
    const deletes: string[] = [];
    const wrong: string[] = [];
    w.hooks.push((args, _cwd, phase) => {
      if (phase !== "before") return;
      if (isPin(args)) pinned.add(verbOf(args)[1]!.slice("refs/sova/retired/".length));
      const del = deletesBranch(args);
      if (!del) return;
      deletes.push(del);
      // Recorded and asserted after the pass: a throw in here is one tree's failure to the retirer, which holds it.
      const b = bs.find((x) => x.branch === del);
      if (!b) wrong.push(`a delete of a branch this test didn't finish: ${del}`);
      else if (!pinned.has(b.commit)) wrong.push(`${del} deleted before its pin was sent`);
      else if (git(w.fx.project, ["rev-parse", "-q", "--verify", `refs/sova/retired/${b.commit}`], { allowFail: true }) !== b.commit) wrong.push(`${del}'s pin isn't there`);
    });
    await w.pass();
    assert.deepEqual(wrong, []);
    assert.deepEqual([...deletes].sort(), bs.map((b) => b.branch).sort(), "every branch went by a delete this test saw");
    for (const b of bs) assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
  });

  test("the pin is no branch: no branch list shows it", async () => {
    const w = world();
    const b = finished(w, "unseen");
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.ok(!git(w.fx.project, ["branch", "--all"]).includes("retired"));
    assert.ok(!git(w.fx.project, ["for-each-ref", "refs/heads", "refs/remotes", "refs/tags"]).includes("retired"));
  });

  test("pinning fails: no folder or branch goes", async () => {
    const w = world();
    const b = finished(w, "nopin");
    w.hooks.length = 0;
    const real = w.deps.gitWrite;
    w.deps.gitWrite = async (args, cwd) => (isPin(args) ? { code: 1, stdout: "", stderr: "fatal: no" } : real(args, cwd));
    const before = snapshot(w, b.checkout);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.match(reasonOf(r, b.checkout), /pinned/);
    assert.deepEqual(snapshot(w, b.checkout), before);
  });

  test("every pin and the full list are in place before the first folder goes", async () => {
    const w = world();
    const bs = ["q1", "q2", "q3", "q4", "q5"].map((n) => finished(w, n));
    let checked = false;
    const wrong: string[] = [];
    let list: [string, string][] = [];
    w.hooks.push((args, _cwd, phase) => {
      if (checked || phase !== "before" || !isRemove(args)) return;
      checked = true;
      // Read here, asserted after: a throw in here is one tree's failure to the retirer, which holds it.
      for (const b of bs) if (git(w.fx.project, ["rev-parse", "-q", "--verify", `refs/sova/retired/${b.commit}`], { allowFail: true }) !== b.commit) wrong.push(`${b.branch} has no pin yet`);
      const file = JSON.parse(readFileSync(w.pendingPath, "utf8")) as { firstPass?: { list?: { branch: string; tip: string }[] } };
      list = (file.firstPass?.list ?? []).map((x) => [x.branch, x.tip]);
    });
    await w.pass();
    assert.ok(checked, "a folder went");
    assert.deepEqual(wrong, []);
    assert.deepEqual(list.sort(), bs.map((b) => [b.branch, b.commit]).sort(), "the first pass's list was on disk");
  });

  test("a leftover whose branch is still there: the branch goes, pinned first, on this path too", async () => {
    const w = world();
    const b = finished(w, "leftbranch");
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    mkdirSync(join(b.checkout, "node_modules"), { recursive: true });
    writeFileSync(join(b.checkout, "node_modules/a.js"), "x\n");
    provedOurs(w, b.checkout, b.branch, b.commit);
    w.record(b.checkout, b.branch);
    const order: string[] = [];
    w.hooks.push((args, _c, phase) => {
      if (phase !== "before") return;
      if (isPin(args)) order.push("pin");
      if (deletesBranch(args)) order.push("delete");
    });
    await w.pass();
    assert.equal(existsSync(b.checkout), false);
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
    assert.equal(order[0], "pin", "pinned before the folder's delete, and again by the branch's own step");
    assert.ok(order.indexOf("delete") > 0, `and the branch's delete after it: ${order.join(", ")}`);
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit);
  });

  test("a restore works after git gc --prune=now with every reflog expired, on a commit nothing but the pin keeps", async () => {
    const w = world();
    const only = w.fx.branch("onlypin", { "squashed.txt": "s\n" });
    git(w.fx.project, ["merge", "-q", "--squash", only.branch]);
    git(w.fx.project, ["commit", "-q", "-m", "squash of onlypin"]);
    assert.notEqual(spawnSync("git", ["merge-base", "--is-ancestor", only.commit, w.fx.target], { cwd: w.fx.project }).status, 0, "the target doesn't hold that commit by ancestry");
    const r0 = await w.pass();
    assert.deepEqual(retiredPaths(r0), [only.checkout], reasonOf(r0, only.checkout));
    git(w.fx.project, ["reflog", "expire", "--expire=now", "--all"]);
    git(w.fx.project, ["gc", "-q", "--prune=now"]);
    assert.equal(git(w.fx.project, ["cat-file", "-t", only.commit]), "commit", "the pin kept the commit through gc");
    const e = w.ledger().find((x) => x.branch === only.branch)!;
    const back = await restoreRetired(w.deps, { root: w.fx.project, path: e.path, branch: e.branch, tip: e.tip });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(git(only.checkout, ["rev-parse", "HEAD"]), only.commit);
    assert.equal(git(only.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]), only.branch);
    assert.equal(readFileSync(join(only.checkout, "squashed.txt"), "utf8"), "s\n");
  });

  test("the control for the one above: with no pin, the same gc does drop such a commit", () => {
    const w = world();
    const only = w.fx.branch("nopinhere", { "squashed.txt": "s\n" });
    git(w.fx.project, ["worktree", "remove", "--force", only.checkout]);
    git(w.fx.project, ["branch", "-D", only.branch]);
    git(w.fx.project, ["reflog", "expire", "--expire=now", "--all"]);
    git(w.fx.project, ["gc", "-q", "--prune=now"]);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", only.commit], { cwd: w.fx.project }).status, 0, "gc really prunes here");
  });
});

// ---------------------------------------------------------------- restore

describe("restore", () => {
  async function retired(name: string) {
    const w = world();
    const b = finished(w, name);
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    return { w, b, req: { root: w.fx.project, path: b.checkout, branch: b.branch, tip: b.commit } };
  }

  test("a branch already there refuses, naming it, with nothing changed", async () => {
    const { w, b, req } = await retired("rb");
    git(w.fx.project, ["branch", b.branch, w.fx.target]);
    const refs = git(w.fx.project, ["for-each-ref"]);
    const r = await restoreRetired(w.deps, req);
    assert.equal(r.ok, false);
    assert.ok((r as { error: string }).error.includes(b.branch));
    assert.equal(git(w.fx.project, ["for-each-ref"]), refs);
    assert.equal(existsSync(b.checkout), false);
  });

  test("a folder already there refuses, naming it, and its files stay", async () => {
    const { w, b, req } = await retired("rf");
    mkdirSync(b.checkout, { recursive: true });
    writeFileSync(join(b.checkout, "mine.txt"), "mine\n");
    const refs = git(w.fx.project, ["for-each-ref"]);
    const r = await restoreRetired(w.deps, req);
    assert.equal(r.ok, false);
    assert.ok((r as { error: string }).error.includes(b.checkout));
    assert.equal(readFileSync(join(b.checkout, "mine.txt"), "utf8"), "mine\n");
    assert.equal(git(w.fx.project, ["for-each-ref"]), refs);
  });

  test("an empty folder already there refuses too: git would take it, the promise doesn't", async () => {
    const { w, b, req } = await retired("rempty");
    mkdirSync(b.checkout, { recursive: true });
    const r = await restoreRetired(w.deps, req);
    assert.equal(r.ok, false);
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
  });

  test("a restored branch doesn't retire at the next wake-up: it waits 7 days, then goes", async () => {
    const { w, b, req } = await retired("rw");
    assert.equal((await restoreRetired(w.deps, req)).ok, true);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.match(reasonOf(r, b.checkout), /restored/i);
    assert.ok(existsSync(b.checkout));
    w.now.t += 8 * DAY;
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout], "after the wait it goes");
  });

  test("a restore of a retirement Sova never recorded refuses, and asks git nothing it could act on", async () => {
    const { w, b } = await retired("rg");
    const r = await restoreRetired(w.deps, { root: w.fx.project, path: b.checkout, branch: b.branch, tip: "1".repeat(40) });
    assert.equal(r.ok, false);
    assert.equal(existsSync(b.checkout), false);
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
  });
});

// ---------------------------------------------------------------- a chat comes back

describe("a message brings a retired chat's folder back", () => {
  async function retiredChat(name: string, over: Partial<Chat> = {}) {
    const w = world();
    const b = finished(w, name);
    const chat = quietChat(w, b.checkout, over);
    w.chats.push(chat);
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    return { w, b, chat };
  }

  test("at the same place, on the same branch name, fresh from the newest target, told in Sova's words, from a folder inside it too", async () => {
    const { w, b } = await retiredChat("backme");
    const newest = w.fx.moveTargetOutside({ "newer.txt": "n\n" });
    const r = await bringBack(w.deps, join(b.checkout, "src"));
    assert.equal(r.state, "back", JSON.stringify(r));
    const back = r as Extract<typeof r, { state: "back" }>;
    assert.equal(back.path, b.checkout);
    assert.equal(back.branch, b.branch);
    assert.equal(back.target, w.fx.target);
    assert.equal(git(b.checkout, ["rev-parse", "HEAD"]), newest, "fresh from the newest target, not the old tip");
    assert.equal(git(b.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]), b.branch);
    assert.ok(newest.startsWith(back.sha));
    assert.equal(back.line, `Your worktree was retired after ${b.branch} landed. It's back at ${b.checkout}, on ${b.branch}, fresh from ${w.fx.target} at ${back.sha}.`);
  });

  test("one deleted by hand doesn't come back: only the ledger's", async () => {
    const w = world();
    const b = finished(w, "byhand");
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    git(w.fx.project, ["branch", "-D", b.branch]);
    assert.equal((await bringBack(w.deps, b.checkout)).state, "none");
    assert.equal(existsSync(b.checkout), false);
  });

  test("the branch name in use by then: failed, why, and nothing moved", async () => {
    const { w, b } = await retiredChat("nameused");
    git(w.fx.project, ["branch", b.branch, w.fx.target]);
    const refs = git(w.fx.project, ["for-each-ref"]);
    const r = await bringBack(w.deps, b.checkout);
    assert.equal(r.state, "failed");
    assert.ok((r as { reason: string }).reason.includes(b.branch));
    assert.ok((r as { line: string }).line.includes("home folder"));
    assert.equal(existsSync(b.checkout), false);
    assert.equal(git(w.fx.project, ["for-each-ref"]), refs);
  });

  test("the folder in use by then: failed, and what's there stays", async () => {
    const { w, b } = await retiredChat("folderused");
    mkdirSync(b.checkout, { recursive: true });
    writeFileSync(join(b.checkout, "mine.txt"), "mine\n");
    const r = await bringBack(w.deps, b.checkout);
    assert.equal(r.state, "failed");
    assert.equal(readFileSync(join(b.checkout, "mine.txt"), "utf8"), "mine\n");
  });

  test("an empty folder in the way, the chat's own place: failed, as any folder in use", async () => {
    const { w, b } = await retiredChat("emptyused");
    mkdirSync(b.checkout, { recursive: true });
    assert.equal((await bringBack(w.deps, b.checkout)).state, "failed");
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
  });

  test("a chat already back: asking again changes nothing", async () => {
    const { w, b } = await retiredChat("twice");
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
    const refs = git(w.fx.project, ["for-each-ref"]);
    writeFileSync(join(b.checkout, "progress.txt"), "work after coming back\n");
    assert.equal((await bringBack(w.deps, b.checkout)).state, "none");
    assert.equal(readFileSync(join(b.checkout, "progress.txt"), "utf8"), "work after coming back\n");
    assert.equal(git(w.fx.project, ["for-each-ref"]), refs);
  });

  test("two messages at once: one folder, one answer", async () => {
    const { w, b } = await retiredChat("both");
    const [x, y] = await Promise.all([bringBack(w.deps, b.checkout), bringBack(w.deps, b.checkout)]);
    assert.equal(x.state, "back");
    assert.deepEqual(y, x);
    assert.equal(w.writes.filter((c) => verbOf(c.args)[0] === "worktree" && verbOf(c.args)[1] === "add").length, 1);
  });

  test("the folder that came back, finished again, retires again: both pins stay, and it can come back a second time", async () => {
    const { w, b } = await retiredChat("loop");
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
    const c2 = w.fx.commitIn(b.checkout, { "again.txt": "again\n" }, "new work after coming back");
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit);
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${c2}`]), c2);
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
  });

  test("what came back is empty: it doesn't retire while its chat is busy, or at the next wake-up with that chat quiet a while", async () => {
    const { w, b } = await retiredChat("backempty");
    w.fx.moveTargetOutside({ "x.txt": "x\n" });
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
    w.chats[0]!.lastActiveAt = w.now.t - 11 * MIN;
    assert.deepEqual(retiredPaths(await w.pass()), [], "the chat that was just told it's back may be about to work there");
    assert.ok(existsSync(b.checkout));
  });
});

// ---------------------------------------------------------------- empty worktrees

describe("a worktree with no commits of its own", () => {
  const empty = (w: World, name: string) => {
    const checkout = w.fx.worktreeOf(name);
    git(w.fx.project, ["worktree", "add", "-q", "-b", `feat/${name}`, checkout, w.fx.target]);
    return checkout;
  };

  test("with a live chat it waits 7 days: at 6 it stays, at 8 it goes", async () => {
    const w = world();
    const p = empty(w, "e1");
    w.chats.push(quietChat(w, p, { lastActiveAt: w.now.t - 6 * DAY }));
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.ok(existsSync(p));
    w.chats[0]!.lastActiveAt = w.now.t - 8 * DAY;
    assert.deepEqual(retiredPaths(await w.pass()), [p]);
    assert.equal(w.ledger()[0]!.merged, "empty");
  });
  test("with no live chat it goes", async () => {
    const w = world();
    const p = empty(w, "e2");
    assert.deepEqual(retiredPaths(await w.pass()), [p]);
  });
  test("an archived chat isn't a live one", async () => {
    const w = world();
    const p = empty(w, "e3");
    w.chats.push(quietChat(w, p, { archived: true, lastActiveAt: w.now.t - 11 * MIN }));
    assert.deepEqual(retiredPaths(await w.pass()), [p]);
  });
  test("an untracked file holds it, however old", async () => {
    const w = world();
    const p = empty(w, "e4");
    writeFileSync(join(p, "only.txt"), "only here\n");
    const before = snapshot(w, p);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.deepEqual(snapshot(w, p), before);
  });
});

// ---------------------------------------------------------------- archive's way in

describe("archive's removal goes through the same rule", () => {
  test("another chat running holds; the archived chat itself doesn't", async () => {
    const w = world();
    const b = finished(w, "arch");
    const mine = quietChat(w, b.checkout, { running: false });
    w.chats.push(mine);
    const other = quietChat(w, b.checkout, { running: true });
    w.chats.push(other);
    const held = await retireNow(w.fx.project, b.checkout, mine.path, w.deps);
    assert.notEqual(held.state, "retired");
    assert.ok(existsSync(b.checkout));
    other.running = false;
    const done = await retireNow(w.fx.project, b.checkout, mine.path, w.deps);
    assert.equal(done.state, "retired", JSON.stringify(done));
    assert.equal(existsSync(b.checkout), false);
  });
  test("a branch with work isn't archive's to take", async () => {
    const w = world();
    const b = w.fx.branch("archwork", { "w.txt": "w\n" });
    const r = await retireNow(w.fx.project, b.checkout, "x", w.deps);
    assert.notEqual(r.state, "retired");
    assert.ok(existsSync(join(b.checkout, "w.txt")));
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch));
  });
});

// ---------------------------------------------------------------- the branch that moves

describe("a branch moved between check and delete", () => {
  test("stays, at the new commit, the reason in the ledger's branchDeleted; the old commit is pinned", async () => {
    const w = world();
    const b = finished(w, "racer");
    let newer = "";
    w.hooks.push((args, _cwd, phase) => {
      if (phase !== "after" || !isRemove(args) || newer) return;
      newer = git(w.fx.project, ["commit-tree", `${b.commit}^{tree}`, "-p", b.commit, "-m", "a commit in the gap"]);
      git(w.fx.project, ["update-ref", `refs/heads/${b.branch}`, newer]);
    });
    const r = await w.pass();
    assert.ok(newer, "the removal ran, so the gap happened");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/heads/${b.branch}`]), newer, "the branch stays at its new commit");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit);
    assert.equal(r.repos[0]!.retired.find((t) => t.path === b.checkout)?.branchDeleted, false);
    assert.equal(w.ledger().find((e) => e.path === b.checkout)!.branchDeleted, false);
    await w.pass();
    assert.equal(git(w.fx.project, ["rev-parse", `refs/heads/${b.branch}`]), newer, "and a later pass leaves it: it moved since");
  });

  test("moved to a commit the target already has, which git's -d would take: it still stays", async () => {
    const w = world();
    const b = finished(w, "racer3");
    const onTarget = w.fx.moveTargetOutside({ "t.txt": "t\n" });
    let moved = false;
    w.hooks.push((args, _cwd, phase) => {
      if (phase !== "after" || !isRemove(args) || moved) return;
      moved = true;
      git(w.fx.project, ["update-ref", `refs/heads/${b.branch}`, onTarget]);
    });
    await w.pass();
    assert.ok(moved);
    assert.equal(git(w.fx.project, ["rev-parse", `refs/heads/${b.branch}`]), onTarget, "a branch that moved in between stays");
  });

  test("the branch checked out somewhere else by then: stays", async () => {
    const w = world();
    const b = finished(w, "racer2");
    const elsewhere = join(w.fx.root, "elsewhere");
    w.hooks.push((args, _cwd, phase) => {
      if (phase === "after" && isRemove(args) && !existsSync(elsewhere)) git(w.fx.project, ["worktree", "add", "-q", elsewhere, b.branch]);
    });
    await w.pass();
    assert.ok(existsSync(join(elsewhere, ".git")));
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch), "another folder has it");
  });
});

// ---------------------------------------------------------------- a delete that stops part way

describe("a delete that stops part way", () => {
  /** A writer refilling the folder as git deletes it, as a running test copy does: git's list loses it, files stay. */
  const refillWith = (w: World, b: { checkout: string }, rel: string, text: string) =>
    w.hooks.push((args, _cwd, phase) => {
      if (phase !== "after" || !isRemove(args)) return;
      const f = join(b.checkout, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    });

  test("a recreated .agent, all throwaway: finished under the leftover proof", async () => {
    const w = world();
    const b = finished(w, "refilled");
    refillWith(w, b, ".agent/sessions/x.jsonl", "{}\n");
    const r = await w.pass();
    assert.equal(existsSync(b.checkout), false, `the partial delete is finished: ${JSON.stringify(r)}`);
    assert.equal(w.ledger().length, 1);
    assert.equal(r.repos[0]!.retired[0]!.finished, true);
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
  });

  test("a recreated .agent with a live record naming a live process: held, what remains named, the branch kept", async () => {
    const w = world();
    const b = finished(w, "refilled-live");
    const c = startIn(w.fx.state);
    refillWith(w, b, ".agent/sessions/live/s.json", JSON.stringify({ pid: c.pid }));
    const r = await w.pass();
    assert.ok(existsSync(join(b.checkout, ".agent/sessions/live/s.json")), "a live writer's files are never pulled out from under it");
    assert.match(heldOf(r, b.checkout)?.reason ?? "", /\.agent/);
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch), "the branch stays until the folder's done");
    w.hooks.length = 0;
    await stop(c);
    await w.pass();
    assert.equal(existsSync(b.checkout), false, "once it's no longer live, the next pass finishes it");
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "", "and its branch");
  });

  test("an unknown file written in the gap: held, never deleted", async () => {
    const w = world();
    const b = finished(w, "refilled-unique");
    refillWith(w, b, "notes-from-the-gap.md", "only here\n");
    const r = await w.pass();
    assert.equal(readFileSync(join(b.checkout, "notes-from-the-gap.md"), "utf8"), "only here\n");
    assert.match(heldOf(r, b.checkout)?.reason ?? "", /notes-from-the-gap/);
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch));
    w.hooks.length = 0;
    await w.pass();
    assert.equal(readFileSync(join(b.checkout, "notes-from-the-gap.md"), "utf8"), "only here\n", "and every later pass holds it too");
  });

  test("a chat quiet in it doesn't stop the proof: finished, and its next message brings the folder back", async () => {
    const w = world();
    const b = finished(w, "refilled-chat");
    w.chats.push(quietChat(w, b.checkout));
    refillWith(w, b, ".agent/sessions/x.jsonl", "{}\n");
    const r = await w.pass();
    assert.equal(existsSync(b.checkout), false, JSON.stringify(r));
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
  });

  test("held, no chat runs there: an open goes home and a message moves one still open; once the folder's gone, bring-back", async () => {
    const w = world();
    const b = finished(w, "refilled-held");
    refillWith(w, b, "notes-from-the-gap.md", "only here\n");
    const r = await w.pass();
    assert.ok(heldOf(r, b.checkout));
    assert.equal(w.ledger().at(-1)?.partial, true);
    const ledger = () => w.ledger();
    assert.equal(inHeldPartialFolder(join(b.checkout), ledger), true, "an open goes to the home folder");
    assert.equal(retiredFallbackFacts(b.checkout, ledger), undefined, "and no banner promises a message brings it back");

    const open = { sessionId: "lee-open", cwd: b.checkout, cwdFallback: null };
    assert.equal(needsBringBack(open, ledger), true);
    assert.equal(needsBringBack({ ...open, running: true }, ledger), false, "never pulled out from under a turn");
    assert.equal(needsBringBack({ ...open, cwd: w.fx.parent, cwdFallback: { original: b.checkout, cwd: w.fx.parent } }, ledger), false, "already home");
    let reopened = 0;
    assert.equal((await bringBackForChat({ mirror: open, reopenHere: async () => void reopened++ }, w.deps)).state, "failed");
    assert.equal(reopened, 1);
    assert.match(takeRetireLines("lee-open") ?? "", /home folder/);
    assert.ok(existsSync(join(b.checkout, "notes-from-the-gap.md")), "and nothing was deleted");
    assert.equal((await bringBack(w.deps, b.checkout)).state, "none", "nothing comes back on top of it");

    // A folder with a live .git again isn't what the delete left.
    git(w.fx.project, ["worktree", "add", "-q", "--detach", join(w.fx.parent, ".worktrees", "other-live")]);
    rmSync(b.checkout, { recursive: true });
    assert.equal(inHeldPartialFolder(b.checkout, ledger), false);
    assert.deepEqual(retiredFallbackFacts(b.checkout, ledger), { branch: b.branch, target: "master" }, "gone: the banner says a message brings it back");
    w.hooks.length = 0;
    await w.pass();
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "", "its branch finishes once the folder's gone");
    assert.equal(w.ledger().at(-1)?.branchDeleted, true);
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
  });

  test("an older partial entry never deletes a branch when something newer speaks for its path", async () => {
    const w = world();
    const b = finished(w, "refilled-old");
    refillWith(w, b, "notes-from-the-gap.md", "only here\n");
    await w.pass();
    const old = w.ledger().at(-1)!;
    rmSync(b.checkout, { recursive: true });
    w.hooks.length = 0;
    const { partial: _partial, retired: _retired, ...byHand } = old;
    appendLedger([{ ...byHand, at: old.at + 1, branchDeleted: true }], w.ledgerFile);
    await w.pass();
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch));
  });

  test("Remove Worktree shares the rule: a quiet chat doesn't stop finishing the folder it was asked to remove, a running one does", async () => {
    const w = world();
    setRealRetireDeps(w.deps);
    try {
      const record = (b: { checkout: string; branch: string }) => ({ path: b.checkout, branch: b.branch, base: git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target]), target: w.fx.target });
      const quiet = finished(w, "remove-quiet");
      w.chats.push(quietChat(w, quiet.checkout));
      refillWith(w, quiet, ".agent/sessions/x.jsonl", "{}\n");
      await removeWorktree(record(quiet), w.fx.project, w.deps.gitWrite);
      assert.equal(existsSync(quiet.checkout), false);
      w.hooks.length = 0;
      const busy = finished(w, "remove-busy");
      w.chats.push(quietChat(w, busy.checkout, { running: true }));
      refillWith(w, busy, ".agent/sessions/x.jsonl", "{}\n");
      await assert.rejects(removeWorktree(record(busy), w.fx.project, w.deps.gitWrite), /running/);
      assert.ok(existsSync(join(busy.checkout, ".agent/sessions/x.jsonl")));
    } finally {
      setRealRetireDeps(null);
    }
  });

  test("git's own delete failing outright, no partial: refused, as it was", async () => {
    const w = world();
    const b = finished(w, "refused");
    w.deps.gitRemove = async () => ({ code: 128, stdout: "", stderr: "fatal: no" });
    const before = snapshot(w, b.checkout, { pins: "ignore" });
    const r = await w.pass();
    assert.match(heldOf(r, b.checkout)?.reason ?? "", /Git refused/);
    assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before);
    assert.equal(w.ledger().length, 0);
  });
});

// ---------------------------------------------------------------- leftover folders

describe("a leftover folder", () => {
  /** A folder left behind: named by a chat's record, inside the worktrees location, nothing in git's list, no .git, branch gone. */
  function leftover(w: World, name: string, files: Record<string, string> = { "node_modules/a.js": "x\n" }, o: { record?: boolean } = {}): string {
    const b = w.fx.branch(name, { [`${name}.txt`]: `${name}\n` });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    const keep = join(w.fx.root, `keep-${name}`);
    mkdirSync(keep);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(keep, rel)), { recursive: true });
      writeFileSync(join(keep, rel), text);
    }
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    git(w.fx.project, ["branch", "-D", b.branch]);
    renameSync(keep, b.checkout);
    if (o.record !== false) w.record(b.checkout, b.branch);
    return b.checkout;
  }

  test("the control: throwaway files only, in the location, on record: it goes, and the ledger says leftover", async () => {
    const w = world();
    const p = leftover(w, "lc", { "node_modules/a.js": "x\n", ".agent/sessions/s.jsonl": "{}\n" });
    const r = await w.pass();
    assert.ok(r.repos.some((x) => x.leftovers.includes(p)), JSON.stringify(r.repos.map((x) => x.held)));
    assert.equal(existsSync(p), false);
    assert.equal(w.ledger().at(-1)!.merged, "leftover");
  });

  test("a copy of a tracked file, by content, is no hold; the same name with other bytes is", async () => {
    const w = world();
    const same = leftover(w, "ls", { "README.md": "# demo\n" });
    const other = leftover(w, "lo", { "README.md": "# demo, with an edit only here\n" });
    const r = await w.pass();
    assert.equal(existsSync(same), false);
    assert.equal(readFileSync(join(other, "README.md"), "utf8"), "# demo, with an edit only here\n");
    assert.match(heldOf(r, other)?.reason ?? "", /README\.md/);
  });

  test("no record: never touched, not even named", async () => {
    const w = world();
    const p = leftover(w, "ln", undefined, { record: false });
    const before = filesOf(p);
    const r = await w.pass();
    assert.deepEqual(filesOf(p), before);
    assert.ok(!JSON.stringify(r).includes(p), "a folder no record names isn't Sova's to mention");
  });

  test("a folder of patch files beside the worktrees, on no record: never touched", async () => {
    const w = world();
    const p = join(w.fx.parent, ".worktrees", "delegate-mode-series");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "0001.patch"), "a patch\n");
    await w.pass();
    assert.equal(readFileSync(join(p, "0001.patch"), "utf8"), "a patch\n");
  });

  test("on record but outside the worktrees location: never touched", async () => {
    const w = world();
    const p = join(w.fx.root, "elsewhere", "demo-out");
    mkdirSync(join(p, "node_modules"), { recursive: true });
    writeFileSync(join(p, "node_modules/a.js"), "x\n");
    w.record(p, "feat/gone");
    const before = filesOf(p);
    await w.pass();
    assert.deepEqual(filesOf(p), before);
  });

  test("on record, a path that climbs out of the location by ..: never touched", async () => {
    const w = world();
    const p = join(w.fx.root, "climbed");
    mkdirSync(join(p, "node_modules"), { recursive: true });
    writeFileSync(join(p, "node_modules/a.js"), "x\n");
    mkdirSync(join(w.fx.parent, ".worktrees"), { recursive: true });
    w.record(`${join(w.fx.parent, ".worktrees")}/../../climbed`, "feat/gone");
    const before = filesOf(p);
    await w.pass();
    assert.deepEqual(filesOf(p), before);
  });

  test("on record, the worktrees location itself or something deep inside a folder there: never touched", async () => {
    const w = world();
    const loc = join(w.fx.parent, ".worktrees");
    const deep = join(loc, "demo-x", "sub");
    mkdirSync(join(deep, "node_modules"), { recursive: true });
    writeFileSync(join(deep, "node_modules/a.js"), "x\n");
    w.record(loc, "feat/gone");
    w.record(deep, "feat/gone");
    await w.pass();
    assert.equal(readFileSync(join(deep, "node_modules/a.js"), "utf8"), "x\n");
  });

  test("the folder itself a symlink: neither it nor what it points at is touched", async () => {
    const w = world();
    const outside = join(w.fx.root, "outside-dir");
    mkdirSync(join(outside, "node_modules"), { recursive: true });
    writeFileSync(join(outside, "node_modules/a.js"), "x\n");
    const link = join(w.fx.parent, ".worktrees", "demo-linked");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);
    w.record(link, "feat/gone");
    await w.pass();
    assert.ok(lstatSync(link).isSymbolicLink(), "the link stays");
    assert.equal(readFileSync(join(outside, "node_modules/a.js"), "utf8"), "x\n");
  });

  test("the folder a symlink to another folder in the location: the real folder is untouched", async () => {
    const w = world();
    const real = leftover(w, "linktarget", undefined, { record: false });
    const link = join(w.fx.parent, ".worktrees", "demo-pointer");
    symlinkSync(real, link);
    w.record(link, "feat/gone");
    await w.pass();
    assert.ok(existsSync(join(real, "node_modules/a.js")));
    assert.ok(lstatSync(link).isSymbolicLink());
  });

  for (const rel of ["node_modules/escape", ".agent/escape", "escape"]) {
    test(`a symlink inside at ${rel} pointing out: what it points at is never deleted, and the link isn't followed`, async () => {
      const w = world();
      const p = leftover(w, `esc-${rel.replace(/\W/g, "")}`);
      const outside = join(w.fx.root, `outside-${rel.replace(/\W/g, "")}`);
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "precious.txt"), "precious\n");
      mkdirSync(dirname(join(p, rel)), { recursive: true });
      symlinkSync(outside, join(p, rel));
      await w.pass();
      assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "precious\n");
      assert.equal(existsSync(p), false, "the leftover itself went: links are deleted, not followed");
    });
  }

  test("a process with its cwd in the folder a symlink inside points at doesn't confuse it; one inside does", async () => {
    const w = world();
    const p = leftover(w, "lproc");
    const c = startIn(join(p, "node_modules"));
    await scanSees(c.pid!);
    const before = filesOf(p);
    const r = await w.pass();
    assert.deepEqual(filesOf(p), before);
    assert.match(reasonOf(r, p), /sleep/);
    await stop(c);
    await w.pass();
    assert.equal(existsSync(p), false, "the reason cleared");
  });

  test("git still registers it: not a leftover", async () => {
    const w = world();
    const b = finished(w, "lreg");
    writeFileSync(join(b.checkout, "only.txt"), "only\n");
    w.record(b.checkout, b.branch);
    const r = await w.pass();
    assert.ok(!r.repos.some((x) => x.leftovers.includes(b.checkout)));
    assert.ok(existsSync(join(b.checkout, "only.txt")));
  });

  test("it holds a .git of its own: not a leftover", async () => {
    const w = world();
    const p = leftover(w, "lgit");
    git(p, ["init", "-q"]);
    const r = await w.pass();
    assert.ok(existsSync(join(p, ".git/HEAD")), "a repository of its own is someone's work");
    assert.ok(!r.repos.some((x) => x.leftovers.includes(p)));
  });

  test("a live worktree of another clone with the same history sits there: not ours", async () => {
    const w = world();
    const clone = join(w.fx.root, "other-clone");
    git(w.fx.root, ["clone", "-q", w.fx.project, clone]);
    const theirs = join(w.fx.parent, ".worktrees", "demo-theirs");
    git(clone, ["worktree", "add", "-q", "-b", "feat/theirs", theirs, "HEAD"]);
    writeFileSync(join(theirs, "unsaved.txt"), "only here\n");
    w.record(theirs, "feat/theirs");
    await w.pass();
    assert.equal(readFileSync(join(theirs, "unsaved.txt"), "utf8"), "only here\n");
  });

  test("its branch still has work: not a leftover", async () => {
    const w = world();
    const p = leftover(w, "lbr");
    const side = join(w.fx.root, "lbr-side");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/lbr", side, w.fx.target]);
    w.fx.commitIn(side, { "work.txt": "work only on this branch\n" }, "work");
    git(w.fx.project, ["worktree", "remove", side]);
    const r = await w.pass();
    assert.ok(existsSync(p), "the branch name has a commit the target lacks");
    assert.match(reasonOf(r, p), /something to land/);
  });

  test("a quiet chat's folder in it: it goes, the branch goes, and that chat's next message brings it back", async () => {
    const w = world();
    const p = leftover(w, "lchat");
    provedOurs(w, p, "feat/lchat", git(w.fx.project, ["rev-parse", w.fx.target]));
    w.chats.push(quietChat(w, p));
    await w.pass();
    assert.equal(existsSync(p), false, "having a folder there isn't using it");
    const back = await bringBack(w.deps, p);
    assert.equal(back.state, "back", JSON.stringify(back));
    assert.ok(existsSync(join(p, ".git")));
  });

  // The review's check: what most real leftovers are.
  test("only tracked copies and an archived chat idle past 10 minutes: retirePass removes it, and the chat's next message brings it back", async () => {
    const w = world();
    const tracked = readFileSync(join(w.fx.project, "README.md"), "utf8");
    const p = leftover(w, "larchived", { "README.md": tracked, "node_modules/a.js": "x\n" });
    provedOurs(w, p, "feat/larchived", git(w.fx.project, ["rev-parse", w.fx.target]));
    const chat = quietChat(w, p, { archived: true, lastActiveAt: w.now.t - 11 * MIN });
    w.chats.push(chat);
    const r = await w.pass();
    assert.ok(r.repos[0]!.leftovers.includes(p), JSON.stringify(r));
    assert.equal(existsSync(p), false);
    assert.equal(w.ledger().at(-1)?.merged, "leftover");
    const mirror = { sessionId: "lee-archived", cwd: w.fx.parent, cwdFallback: { original: p, cwd: w.fx.parent } };
    assert.equal(needsBringBack(mirror, () => w.ledger()), true, "the message gate asks");
    let reopened = 0;
    const got = await bringBackForChat({ mirror, reopenHere: async () => void reopened++ }, w.deps);
    assert.equal(got.state, "back", JSON.stringify(got));
    assert.equal(reopened, 1, "it reopens in its folder");
    assert.equal(readFileSync(join(p, "README.md"), "utf8"), tracked);
    assert.equal(git(p, ["rev-parse", "HEAD"]), git(w.fx.project, ["rev-parse", w.fx.target]), "fresh from the target");
    assert.match(takeRetireLines("lee-archived") ?? "", /It's back at/);
  });

  test("its branch still there at a finished commit: pinned, and gone with the folder", async () => {
    const w = world();
    const b = finished(w, "lbranch");
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    mkdirSync(b.checkout);
    provedOurs(w, b.checkout, b.branch, b.commit);
    w.record(b.checkout, b.branch);
    w.chats.push(quietChat(w, b.checkout, { archived: true }));
    const tip = git(w.fx.project, ["rev-parse", b.branch]);
    await w.pass();
    assert.equal(existsSync(b.checkout), false);
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${tip}`]), tip);
    const e = w.ledger().at(-1)!;
    assert.equal(e.branchDeleted, true, "the ledger says the branch went, as a later wake-up would read it");
    assert.equal(e.pinned, true);
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
  });

  test("a stop right after the delete still records it, so the chat comes back", async () => {
    const w = world();
    const p = leftover(w, "lstop");
    provedOurs(w, p, "feat/lstop", git(w.fx.project, ["rev-parse", w.fx.target]));
    w.chats.push(quietChat(w, p));
    const append = w.deps.appendLedger;
    w.deps.appendLedger = () => { throw new Error("stopped here"); };
    await w.pass();
    assert.equal(existsSync(p), false);
    assert.equal(w.ledger().filter((e) => e.path === p && e.merged === "leftover").length, 0, "the stop came first");
    w.deps.appendLedger = append;
    await w.pass();
    assert.equal(w.ledger().at(-1)?.path, p, "read back by the next wake-up");
    assert.equal((await bringBack(w.deps, p)).state, "back");
  });

  // Each alone: an archived chat doesn't soften any of them, and the reason names it.
  const holds: [string, (w: World, p: string) => void, RegExp][] = [
    ["a running chat", (w, p) => void w.chats.push(quietChat(w, p, { running: true, archived: true })), /running/],
    ["a chat open in a TUI", (w, p) => void w.chats.push(quietChat(w, p, { tui: true, archived: true })), /TUI/],
    ["a chat with workers", (w, p) => void w.chats.push(quietChat(w, p, { workers: 1, archived: true })), /workers/],
    ["a chat active 9 minutes ago", (w, p) => void w.chats.push(quietChat(w, p, { lastActiveAt: w.now.t - 9 * MIN, archived: true })), /last 10 minutes/],
    ["a chat elsewhere tracking it, running", (w, p) => void w.chats.push(quietChat(w, w.fx.project, { tracking: [p], running: true })), /running/],
    ["on macOS, a chat with its sandbox on, long idle", (w, p) => {
      w.platform = "darwin";
      w.chats.push(quietChat(w, p, { sandbox: true, archived: true }));
    }, /sandbox/],
    ["a chat file that can't be read", (w) => {
      const chats = w.deps.chats;
      w.deps.chats = async (a, b) => ({ ...(await chats(a, b)), unreadable: ["/x.jsonl"] });
    }, /couldn't be read/],
    ["a unique file, with a quiet chat", (w, p) => {
      w.chats.push(quietChat(w, p, { archived: true }));
      writeFileSync(join(p, "mine.txt"), "only here\n");
    }, /mine\.txt/],
  ];
  for (const [name, arrange, reason] of holds)
    test(`held: ${name}`, async () => {
      const w = world();
      const p = leftover(w, "lhold");
      arrange(w, p);
      const before = filesOf(p);
      const r = await w.pass();
      assert.deepEqual(filesOf(p), before);
      assert.match(reasonOf(r, p), reason);
      assert.equal(w.ledger().length, 0);
    });

  test("held: a live process inside, with a quiet chat", async () => {
    const w = world();
    const p = leftover(w, "lproc");
    w.chats.push(quietChat(w, p, { archived: true }));
    const c = startIn(p);
    const before = filesOf(p);
    const r = await w.pass();
    assert.deepEqual(filesOf(p), before);
    assert.match(reasonOf(r, p), /process/);
    await stop(c);
    await w.pass();
    assert.equal(existsSync(p), false, "and it goes once the process has");
  });

  test("held: an open queue entry for its branch", async () => {
    const w = world();
    const b = finished(w, "lentry");
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    mkdirSync(b.checkout);
    w.record(b.checkout, b.branch);
    w.entries.set(b.branch, { id: "mq_1", state: "checking" });
    const r = await w.pass();
    assert.ok(existsSync(b.checkout));
    assert.match(reasonOf(r, b.checkout), /queue entry/);
  });

  test("a live record in it naming a live process: not touched", async () => {
    const w = world();
    const c = startIn(w.fx.root);
    const p = leftover(w, "llive", { ".agent/sessions/live/s.json": JSON.stringify({ pid: c.pid }) });
    const before = filesOf(p);
    await w.pass();
    assert.deepEqual(filesOf(p), before);
  });

  test("a spec draft not proved landed is no throwaway", async () => {
    const w = world();
    const p = leftover(w, "ldraft", { ".sova/spec/drafts/x/draft.json": "{}\n", ".sova/spec/drafts/x/spec/manifest.json": "{}\n" });
    const before = filesOf(p);
    const r = await w.pass();
    assert.deepEqual(filesOf(p), before);
    assert.ok(!r.repos.some((x) => x.leftovers.includes(p)));
  });

  test("a file of no known kind is held, named in words", async () => {
    const w = world();
    const p = leftover(w, "lwhy", { "thesis.txt": "only here\n" });
    const r = await w.pass();
    assert.match(reasonOf(r, p), /thesis\.txt/);
    assert.equal(readFileSync(join(p, "thesis.txt"), "utf8"), "only here\n");
  });

  test("a recreated .agent alone in a folder a ledger entry names: it goes", async () => {
    const w = world();
    const b = finished(w, "lagent");
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    mkdirSync(join(b.checkout, ".agent/sessions"), { recursive: true });
    writeFileSync(join(b.checkout, ".agent/sessions/x.jsonl"), "{}\n");
    await w.pass();
    assert.equal(existsSync(b.checkout), false);
  });
});

// ---------------------------------------------------------------- locks and restarts

describe("two passes at once", () => {
  test("each tree goes once: one ledger line each, no second removal", async () => {
    const w = world();
    const bs = ["c1", "c2", "c3"].map((n) => finished(w, n));
    await Promise.all([w.pass(), w.pass(), w.pass()]);
    assert.deepEqual(w.ledger().map((e) => e.branch).sort(), bs.map((b) => b.branch).sort());
    assert.equal(w.writes.filter((x) => isRemove(x.args)).length, bs.length, "one removal per tree");
  });

  test("a pass and archive's removal at once: one removal, one ledger line", async () => {
    const w = world();
    const b = finished(w, "racing");
    await Promise.all([w.pass(), retireNow(w.fx.project, b.checkout, "x", w.deps)]);
    assert.equal(w.ledger().filter((e) => e.path === b.checkout).length, 1);
    assert.equal(w.writes.filter((x) => isRemove(x.args)).length, 1);
  });

  test("archive's removal while this process's pass holds the lock: it's told so, and the pass keeps the lock to the end", async () => {
    const w = world();
    const a = finished(w, "lockheld");
    const lock = join(git(w.fx.project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "sova-retire.lock");
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    let inRemove = false;
    const real = w.deps.gitRemove;
    w.deps.gitRemove = async (args, cwd) => {
      inRemove = true;
      await held;
      return real(args, cwd);
    };
    const pass = w.pass();
    await until(() => inRemove, "the pass to reach its removal");
    const other = finished(w, "lockother");
    const r = await retireNow(w.fx.project, other.checkout, "x", w.deps);
    assert.equal(r.state, "kept", JSON.stringify(r));
    assert.ok(existsSync(other.checkout));
    assert.ok(existsSync(lock), "being turned away didn't drop the pass's lock");
    release();
    await pass;
    assert.equal(existsSync(lock), false, "the pass dropped it when done");
  });

  test("a lock another live process holds: this pass does nothing to that repository", async () => {
    const w = world();
    const b = finished(w, "foreign");
    const c = startIn(w.fx.state);
    const lock = join(git(w.fx.project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "sova-retire.lock");
    writeFileSync(lock, String(c.pid));
    const before = snapshot(w, b.checkout);
    await w.pass();
    assert.deepEqual(snapshot(w, b.checkout), before);
    await stop(c);
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout], "its owner died: the lock is taken over");
    assert.equal(existsSync(lock), false, "and dropped");
  });

  test("a lock holding rubbish keeps the repository held rather than guessing", async () => {
    const w = world();
    const b = finished(w, "rubbish");
    const lock = join(git(w.fx.project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "sova-retire.lock");
    writeFileSync(lock, "not a pid");
    await w.pass();
    assert.ok(existsSync(b.checkout));
  });

  test("never more than 3 removals at a time", async () => {
    const w = world();
    for (const n of ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]) finished(w, n);
    let flying = 0;
    let most = 0;
    const real = w.deps.gitRemove;
    // The first three removals wait, so a pool of one is caught, and a fourth running meanwhile is seen.
    let seen = 0;
    let openUp = () => {};
    const three = new Promise<void>((done) => (openUp = done));
    w.deps.gitRemove = async (args, cwd) => {
      most = Math.max(most, ++flying);
      if (++seen === 3) setTimeout(openUp, 1500); // long enough for a fourth to start, had the limit let it: the absence a limit promises.
      if (seen <= 3) await Promise.race([three, new Promise((r) => setTimeout(r, 15_000))]);
      const r = await real(args, cwd);
      flying--;
      return r;
    };
    await w.pass();
    assert.equal(w.ledger().length, 7);
    assert.ok(most <= 3, `${most} at once`);
    assert.ok(most > 1, "and they did overlap, so the count means something");
  });

  test("a held lock on the branch's ref: git refuses the delete, nothing's forced, a later pass finishes", async () => {
    const w = world();
    const b = finished(w, "reflock");
    const lock = join(git(w.fx.project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "refs/heads", `${b.branch}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    await w.pass();
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit);
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch), "git refused; it isn't forced");
    rmSync(lock);
    await w.pass();
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "", "the branch goes on a later pass, reading git again");
  });
});

describe("a restart in the middle of a pass", () => {
  /** A pass cut at one write, as a stop would, then a new pass with nothing remembered but the disk. */
  const cutAt = async (w: World, when: (args: readonly string[]) => boolean) => {
    const write = w.deps.gitWrite;
    const remove = w.deps.gitRemove;
    const cut = (real: Git): Git => async (args, cwd) => {
      if (when(args)) throw new Error("stopped");
      return real(args, cwd);
    };
    w.deps.gitWrite = cut(write);
    w.deps.gitRemove = cut(remove);
    await w.pass().catch(() => null);
    w.deps.gitWrite = write;
    w.deps.gitRemove = remove;
  };

  test("stopped before the folder went: the next pass retires it as any other", async () => {
    const w = world();
    const b = finished(w, "rs1");
    await cutAt(w, isRemove);
    assert.ok(existsSync(b.checkout));
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
    assert.equal(w.ledger().filter((e) => e.path === b.checkout).length, 1);
  });

  test("stopped after the folder went, before the branch: the branch still goes, pinned, with one ledger line, and a chat can come back", async () => {
    const w = world();
    const b = finished(w, "rs2");
    await cutAt(w, (a) => !!deletesBranch(a));
    assert.equal(existsSync(b.checkout), false);
    await w.pass();
    assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit);
    assert.equal(w.ledger().filter((e) => e.path === b.checkout).length, 1);
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
  });

  test("a stale lock from the process that stopped doesn't stop the next pass", async () => {
    const w = world();
    const b = finished(w, "rs3");
    const dead = spawnSync("true").pid;
    writeFileSync(join(git(w.fx.project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "sova-retire.lock"), String(dead));
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
  });

  test("a saved list that's corrupt or lost loses nothing: the reading decides", async () => {
    const w = world();
    const b = finished(w, "rs4");
    const c = quietChat(w, b.checkout, { running: true });
    w.chats.push(c);
    await w.pass();
    assert.ok(existsSync(w.pendingPath), "the wait is reported to disk");
    assert.match(readFileSync(w.pendingPath, "utf8"), /running/);
    writeFileSync(w.pendingPath, "{not json");
    assert.deepEqual(retiredPaths(await w.pass()), []);
    rmSync(w.pendingPath);
    c.running = false;
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
  });

  test("a saved list that names a branch with work never makes it go", async () => {
    const w = world();
    const b = w.fx.branch("rs5", { "w.txt": "w\n" });
    writeFileSync(w.pendingPath, JSON.stringify({ v: 1, repos: { x: { main: w.fx.project, held: [], waiting: [{ path: b.checkout, branch: b.branch, why: "waiting" }] } } }));
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.ok(existsSync(b.checkout));
  });
});

// ---------------------------------------------------------------- a test copy's own folder

describe("a test copy stops itself when its folder disappears", () => {
  const fixture = join(import.meta.dirname, "own-folder-guard.integration.fixture.ts");
  const start = (checkout: string) => {
    const c = spawn(process.execPath, [fixture], { env: { ...process.env, PI_CODING_AGENT_DIR: join(checkout, ".agent") }, stdio: "ignore" });
    children.push(c);
    return c;
  };
  const exited = (c: ChildProcess) => until(() => c.exitCode !== null || c.signalCode !== null, "the copy to stop");

  test("deleted while it runs: it stops, and the folder stays gone", async () => {
    const w = world();
    const checkout = w.fx.worktreeOf("hermetic");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/hermetic", checkout, w.fx.target]);
    const c = start(checkout);
    await until(() => existsSync(join(checkout, ".agent/sessions/writer.jsonl")), "the writer writing");
    git(w.fx.project, ["worktree", "remove", "--force", "--force", checkout]);
    rmSync(checkout, { recursive: true, force: true });
    await exited(c);
    rmSync(checkout, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 100)); // the writer wrote every 20 ms, so 100 ms holds several writes had it lived
    assert.equal(existsSync(checkout), false, "nothing refilled it");
  });

  test("the folder already gone when it starts: it stops without creating it", async () => {
    const w = world();
    const checkout = w.fx.worktreeOf("hermetic-gone");
    const c = start(checkout);
    await exited(c);
    assert.equal(existsSync(checkout), false);
  });

  test("the control: its folder there, it keeps running", async () => {
    const w = world();
    const checkout = w.fx.worktreeOf("hermetic-stays");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/hermetic-stays", checkout, w.fx.target]);
    const c = start(checkout);
    await until(() => existsSync(join(checkout, ".agent/sessions/writer.jsonl")), "the writer writing");
    await new Promise((r) => setTimeout(r, 1500)); // past the guard's 1 s check, so a guard that stops everything has shown itself
    assert.equal(c.exitCode, null);
    assert.equal(c.signalCode, null);
    await stop(c);
  });
});

// ---------------------------------------------------------------- the proof, each condition alone

// A partial delete reaches the proof with no list before it, so each of its conditions has to stand by itself: the pass
// above can't show that, because the candidates' own filter catches some of the same folders first.
describe("the leftover proof: each condition alone stops it", () => {
  function fixture() {
    const w = world();
    const loc = join(w.fx.parent, ".worktrees");
    const path = join(loc, "demo-proof");
    mkdirSync(join(path, "node_modules"), { recursive: true });
    writeFileSync(join(path, "node_modules/a.js"), "x\n");
    const input: LeftoverInput = {
      path,
      main: w.fx.project,
      recorded: true,
      branchFinished: async () => true,
      draftsUnproved: async () => [],
      processes: [],
      chats: [],
      now: 100 * MIN,
      alive: () => false,
      git: realGit,
    };
    return { w, loc, path, input };
  }

  test("the control: every proof holds", async () => {
    assert.equal(await leftoverRefusal(fixture().input), null);
  });
  test("no record", async () => {
    const { input } = fixture();
    assert.match((await leftoverRefusal({ ...input, recorded: false })) ?? "", /record/);
  });
  test("a symlink, even to a folder that would pass", async () => {
    const { input, loc, path } = fixture();
    const link = join(loc, "demo-link");
    symlinkSync(path, link);
    assert.match((await leftoverRefusal({ ...input, path: link })) ?? "", /symlink/);
  });
  test("a plain file", async () => {
    const { input, loc } = fixture();
    const file = join(loc, "demo-file");
    writeFileSync(file, "x");
    assert.match((await leftoverRefusal({ ...input, path: file })) ?? "", /folder/);
  });
  test("outside the location, and deeper inside it", async () => {
    const { w, input, path } = fixture();
    const out = join(w.fx.root, "demo-outside");
    mkdirSync(out);
    assert.match((await leftoverRefusal({ ...input, path: out })) ?? "", /location/);
    assert.match((await leftoverRefusal({ ...input, path: join(path, "node_modules") })) ?? "", /location/);
  });
  test("a .git folder, and a .git file pointing at a live admin folder", async () => {
    const { w, input, path } = fixture();
    git(path, ["init", "-q"]);
    assert.match((await leftoverRefusal(input)) ?? "", /\.git/);
    rmSync(join(path, ".git"), { recursive: true });
    const live = join(w.fx.root, "worktrees", "x");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(path, ".git"), `gitdir: ${live}\n`);
    assert.match((await leftoverRefusal(input)) ?? "", /\.git/);
    writeFileSync(join(path, ".git"), `gitdir: ${join(w.fx.root, "worktrees", "gone")}\n`);
    assert.equal(await leftoverRefusal(input), null, "a pointer to an admin folder that's gone holds nothing: a partial delete leaves it");
  });
  test("git still lists it", async () => {
    const { w, input, loc } = fixture();
    const p = join(loc, "demo-listed");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/listed", p, w.fx.target]);
    rmSync(join(p, ".git"));
    assert.match((await leftoverRefusal({ ...input, path: p })) ?? "", /lists/);
  });
  test("its branch has something left, or asking throws", async () => {
    const { w, input } = fixture();
    git(w.fx.project, ["branch", "feat/some", w.fx.target]);
    assert.equal(await leftoverRefusal({ ...input, branch: "feat/some" }), null);
    assert.match((await leftoverRefusal({ ...input, branch: "feat/some", branchFinished: async () => false })) ?? "", /something to land/);
    assert.match((await leftoverRefusal({ ...input, branch: "feat/some", branchFinished: async () => { throw new Error("?"); } })) ?? "", /something to land/);
  });
  test("processes: unreadable, a cwd inside, an open file inside by another path to it", async () => {
    const { w, input, path } = fixture();
    assert.match((await leftoverRefusal({ ...input, processes: [{ pid: 0, command: "x", paths: [], unreadable: "can't read" }] })) ?? "", /can't read/);
    assert.match((await leftoverRefusal({ ...input, processes: [{ pid: 9, command: "sleep", paths: [join(path, "node_modules")] }] })) ?? "", /sleep/);
    const link = join(w.fx.root, "via");
    symlinkSync(path, link);
    assert.match((await leftoverRefusal({ ...input, processes: [{ pid: 9, command: "cat", paths: [join(link, "node_modules/a.js")] }] })) ?? "", /cat/);
    assert.equal(await leftoverRefusal({ ...input, processes: [{ pid: 9, command: "next", paths: [`${path}-er`] }] }), null, "a longer name next door isn't inside");
  });
  test("a live record under its .agent; a dead one is throwaway", async () => {
    const { input: base, path } = fixture();
    const input: LeftoverInput = { ...base, finished: { heldByRealChat: async () => false, recordingElsewhere: async () => false } };
    mkdirSync(join(path, ".agent/sessions/live"), { recursive: true });
    writeFileSync(join(path, ".agent/sessions/live/s.json"), JSON.stringify({ pid: 4242 }));
    assert.equal(await leftoverRefusal(input), null, "its process is gone");
    assert.match((await leftoverRefusal({ ...input, alive: () => true })) ?? "", /4242/);
  });
  test("a chat's folder inside: only one using it now refuses", async () => {
    const { input, path } = fixture();
    const quiet: LeftoverChat = { name: "c", cwd: join(path, "node_modules"), tracks: [], running: false, tui: false, workers: 0, sandbox: false, lastActiveAt: input.now - 10 * MIN };
    assert.equal(await leftoverRefusal({ ...input, chats: [quiet] }), null, "quiet for exactly 10 minutes: its next message brings the folder back");
    const refuses: [Partial<LeftoverChat>, RegExp][] = [
      [{ running: true }, /running/],
      [{ tui: true }, /TUI/],
      [{ workers: 1 }, /workers/],
      [{ lastActiveAt: input.now - 10 * MIN + 1 }, /10 minutes/],
      [{ cwd: null, tracks: [path], running: true }, /running/],
    ];
    for (const [over, why] of refuses) assert.match((await leftoverRefusal({ ...input, chats: [{ ...quiet, ...over }] })) ?? "", why);
    assert.equal(await leftoverRefusal({ ...input, chats: [{ ...quiet, cwd: `${path}-er`, running: true }] }), null, "a longer name next door isn't inside");
  });
  test("a draft not proved landed, or asking throws", async () => {
    const { input, path } = fixture();
    mkdirSync(join(path, ".sova/spec/drafts/x"), { recursive: true });
    writeFileSync(join(path, ".sova/spec/drafts/x/draft.json"), "{}\n");
    assert.equal(await leftoverRefusal(input), null, "proved: it goes with the folder");
    assert.match((await leftoverRefusal({ ...input, draftsUnproved: async () => ["x"] })) ?? "", /draft/);
    assert.match((await leftoverRefusal({ ...input, draftsUnproved: async () => { throw new Error("?"); } })) ?? "", /draft/);
  });
  test("a file git doesn't have, by content", async () => {
    const { input, path } = fixture();
    writeFileSync(join(path, "README.md"), "# demo\n");
    assert.equal(await leftoverRefusal(input), null, "a copy of what git has");
    writeFileSync(join(path, "README.md"), "# demo, edited\n");
    assert.match((await leftoverRefusal(input)) ?? "", /README\.md/);
  });
  test("a symlink inside isn't followed for its content, and doesn't count as the folder's", async () => {
    const { w, input, path } = fixture();
    const outside = join(w.fx.root, "outside.txt");
    writeFileSync(outside, "only out here\n");
    symlinkSync(outside, join(path, "pointer"));
    assert.equal(await leftoverRefusal(input), null);
  });
});

describe("who can be a leftover: found from records and the ledger, and only those", () => {
  const repoOf = async (w: World) => (await classifyRepo(w.fx.project, { git: execGit, only: [] }))!;
  const rec = (w: World, path: string, base = git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target])): TreeRecord => ({ path, branch: "feat/x", base, session: "s" });

  test("a record inside the location: yes; outside, deeper, itself, or one with another repository's base: no", async () => {
    const w = world();
    const loc = join(w.fx.parent, ".worktrees");
    const inside = join(loc, "demo-in");
    const deep = join(inside, "sub");
    const outside = join(w.fx.root, "demo-out");
    const foreign = join(loc, "other-in");
    for (const p of [deep, outside, foreign]) mkdirSync(p, { recursive: true });
    const found = await leftoverCandidates(w.deps, await repoOf(w), [rec(w, inside), rec(w, deep), rec(w, outside), rec(w, loc), rec(w, foreign, "1".repeat(40))]);
    assert.deepEqual(found.map((x) => x.path), [inside]);
  });
  test("a folder in the location on no record: no, however finished it looks", async () => {
    const w = world();
    mkdirSync(join(w.fx.parent, ".worktrees", "demo-none", "node_modules"), { recursive: true });
    assert.deepEqual(await leftoverCandidates(w.deps, await repoOf(w), []), []);
  });
  test("a folder git lists: no", async () => {
    const w = world();
    const b = w.fx.branch("listed", { "l.txt": "l\n" });
    assert.deepEqual(await leftoverCandidates(w.deps, await repoOf(w), [rec(w, b.checkout)]), []);
  });
  test("a ledger entry of this repository names it: yes; of another: no", async () => {
    const w = world();
    const repo = await repoOf(w);
    const p = join(w.fx.parent, ".worktrees", "demo-led");
    const q = join(w.fx.parent, ".worktrees", "demo-other");
    mkdirSync(p, { recursive: true });
    mkdirSync(q, { recursive: true });
    const entry = (path: string, commonDir: string): RemovedWorktree => ({ v: 1, path, branch: "feat/x", commonDir, tip: "a".repeat(40), merged: "ancestor", branchDeleted: true, at: 1 });
    w.deps.appendLedger([entry(p, repo.commonDir), entry(q, "/somewhere/else/.git")]);
    assert.deepEqual((await leftoverCandidates(w.deps, repo, [])).map((x) => x.path), [p]);
  });
});

// ---------------------------------------------------------------- killed in the middle

describe("a process killed in the middle of a pass, for real", () => {
  const child = join(import.meta.dirname, "worktree-retire-kill.integration.fixture.ts");
  for (const at of ["after-pin", "before-remove", "after-remove", "before-branch-delete"]) {
    test(`SIGKILL ${at}: nothing is lost, the lock doesn't stick, and the next pass finishes with one ledger line`, async () => {
      const w = world();
      const b = finished(w, "killed");
      const c = spawn(process.execPath, [child, w.fx.project, w.fx.target, w.fx.state, at], { stdio: "ignore" });
      children.push(c);
      await until(() => c.exitCode !== null || c.signalCode !== null, "the child to stop");
      assert.equal(c.signalCode, "SIGKILL", "it died where the test said, not by finishing");
      assert.equal(git(w.fx.project, ["cat-file", "-t", b.commit]), "commit");
      w.now.t += 2 * MIN;
      await w.pass();
      assert.equal(existsSync(b.checkout), false, "the folder went");
      assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "", "and the branch");
      assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit, "pinned");
      assert.equal(w.ledger().filter((e) => e.path === b.checkout).length, 1, "one line");
      assert.equal((await bringBack(w.deps, b.checkout)).state, "back", "and a chat can still come back");
    });
  }
});

// ---------------------------------------------------------------- the operator's two decisions

describe("sova_archive with worktrees: remove, on a test copy of Sova", () => {
  // The runner names its whole throwaway home as test data, and each fixture lives in it. A hermetic server's real
  // worktrees don't, so this says "this repository is outside" the only way it can be true here.
  const named = { home: process.env.SOVA_TEST_HOME, data: process.env.SOVA_TEST_DATA };
  before(() => {
    delete process.env.SOVA_TEST_HOME;
    delete process.env.SOVA_TEST_DATA;
    assert.equal(retirementAllowed().on, false, "still a test copy with those gone");
  });
  after(() => {
    if (named.home !== undefined) process.env.SOVA_TEST_HOME = named.home;
    if (named.data !== undefined) process.env.SOVA_TEST_DATA = named.data;
  });

  /** The real tool, the real refusal, the real removal: this test process is a test copy, as a hermetic server is. */
  function archiveTool(w: World, session: { id: string; cwd: string }, trees: { path: string; branch: string }[]) {
    const path = join(w.fx.state, `${session.id}.jsonl`);
    const base = git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target]);
    const entries = [{ type: "custom", customType: "worktrees", data: { version: 1, trees: trees.map((t) => ({ ...t, base, baseBranch: w.fx.target, status: "active", session: session.id, how: "created", at: 1 })) } }];
    writeFileSync(path, [{ type: "session", version: 3, id: session.id, timestamp: "", cwd: session.cwd }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const summary = { id: session.id, path, title: "One", cwd: session.cwd, busy: false, live: null } as unknown as SessionSummary;
    configureCleanup({ summary: async () => summary, sessionFiles: async () => [path], readBranch: async () => entries });
    const archived: string[] = [];
    const host = {
      request: async (_path: string, init?: RequestInit) => {
        archived.push(String(JSON.parse(String(init?.body)).path));
        return Response.json({ ok: true });
      },
      overseerId: () => "ov",
      confirmed: () => null,
      caps: () => DEFAULT_CAPS,
      session: async (ref: string) => (ref === session.id ? summary : null),
      attended: () => true,
      worktrees: archiveWorktrees(async () => entries),
    } as unknown as OverseerToolHost;
    const tool = overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_archive")!;
    const call = () => tool.execute("tc", { sessions: [session.id], worktrees: "remove" }, undefined, undefined, undefined as never).then((r) => (r.content[0] as { text: string }).text, (e: Error) => `ERROR: ${e.message}`);
    return { call, archived, path };
  }

  test("a finished worktree in a repository outside its test data: kept, said so, and the session still archives", async () => {
    const w = world();
    const b = finished(w, "outside");
    const t = archiveTool(w, { id: "s1", cwd: w.fx.project }, [{ path: b.checkout, branch: b.branch }]);
    const before = snapshot(w, b.checkout);
    const out = await t.call();
    assert.deepEqual(t.archived, [t.path], "the session is archived");
    assert.match(out, /archived/);
    assert.match(out, /kept, this is a test copy of Sova/);
    assert.ok(out.includes(b.checkout), "it names the worktree");
    assert.deepEqual(snapshot(w, b.checkout), before, "nothing of the worktree or its branch moved");
  });

  test("the same with uncommitted work in it: the kept worktree can't stop the archive, and the work stays", async () => {
    const w = world();
    const b = finished(w, "outside-dirty");
    writeFileSync(join(b.checkout, "wip.txt"), "only here\n");
    const t = archiveTool(w, { id: "s2", cwd: w.fx.project }, [{ path: b.checkout, branch: b.branch }]);
    const out = await t.call();
    assert.deepEqual(t.archived, [t.path]);
    assert.match(out, /kept, this is a test copy of Sova/);
    assert.equal(readFileSync(join(b.checkout, "wip.txt"), "utf8"), "only here\n");
  });

  test("a worktree whose folder is in its test data but whose repository isn't: kept", async () => {
    const w = world();
    const b = finished(w, "half-outside");
    const t = archiveTool(w, { id: "s3", cwd: w.fx.project }, [{ path: b.checkout, branch: b.branch }]);
    process.env.SOVA_TEST_DATA = b.checkout;
    try {
      assert.match(await t.call(), /kept, this is a test copy of Sova/);
      assert.ok(existsSync(b.checkout));
    } finally {
      delete process.env.SOVA_TEST_DATA;
    }
  });

  test("the control: folder and repository both in its test data, it does remove", async () => {
    const w = world();
    const b = finished(w, "inside");
    const t = archiveTool(w, { id: "s4", cwd: w.fx.project }, [{ path: b.checkout, branch: b.branch }]);
    process.env.SOVA_TEST_DATA = w.fx.root;
    try {
      const out = await t.call();
      assert.match(out, /removed/, out);
      assert.equal(existsSync(b.checkout), false);
    } finally {
      delete process.env.SOVA_TEST_DATA;
    }
  });
});

describe("an install on a PI_CODING_AGENT_DIR of its own", () => {
  /** A place that is no temp dir, no checkout and no `~/.pi/agent`, read with no test signal: what such an install sees. */
  const asInstall = (w: World) => retirementAllowed({}, { agentDir: join(w.fx.root, "srv", "agent"), home: join(w.fx.root, "home"), tmp: join(w.fx.root, "os-tmp"), codeRoot: join(w.fx.root, "installed") });

  test("retirement stays off and touches nothing, and it says so for this install", async () => {
    const w = world();
    const gate = asInstall(w);
    assert.equal(gate.on, false);
    assert.equal(!gate.on && gate.offFor, "install");
    const b = finished(w, "installcase");
    w.deps.allowed = () => gate;
    const before = snapshot(w, b.checkout);
    const r = await w.pass();
    assert.match(r.off ?? "", /off for this install/i);
    assert.deepEqual(snapshot(w, b.checkout), before);
    assert.deepEqual(w.writes, []);
    const view = retirementViewOf(w.fx.project, { gate, ledger: [], pending: { v: 1, repos: {} } as never });
    assert.match(view.off ?? "", /off for this install/i, "the status says so");
    assert.equal(view.offFor, "install");
  });

  test("its service never starts: no wake-up runs a pass, no lock is taken", async () => {
    const w = world();
    const b = finished(w, "installservice");
    w.deps.allowed = () => asInstall(w);
    let asked = 0;
    const real = w.deps.classify;
    w.deps.classify = (root, only) => {
      asked++;
      return real(root, only);
    };
    const lockFile = join(w.fx.state, "machine.lock");
    const service = startWorktreeRetirer({ deps: w.deps, startDelayMs: 0, lockFile });
    assert.match(service.off ?? "", /off for this install/i);
    service.wake("a landing");
    await new Promise((r) => setTimeout(r, 50)); // past the 0 ms start delay a running service would have used
    service.stop();
    assert.equal(asked, 0);
    assert.equal(existsSync(lockFile), false);
    assert.ok(existsSync(b.checkout));
  });

  test("per-row removal still works there: a project page's Remove Worktree isn't the service", async () => {
    const w = world();
    const b = finished(w, "installrow");
    w.deps.allowed = () => asInstall(w);
    await removeWorktree({ path: b.checkout, branch: b.branch, base: git(w.fx.project, ["rev-list", "--max-parents=0", w.fx.target]), target: w.fx.target }, w.fx.project);
    assert.equal(existsSync(b.checkout), false);
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit, "pinned, as any removal is");
    // Its refusal holds there too.
    const c = finished(w, "installrow2");
    writeFileSync(join(c.checkout, "wip.txt"), "only here\n");
    await assert.rejects(removeWorktree({ path: c.checkout, branch: c.branch, base: b.commit, target: w.fx.target }, w.fx.project), /uncommitted/);
    assert.ok(existsSync(join(c.checkout, "wip.txt")));
  });
});

// ---------------------------------------------------------------- Remove on a Worktrees row

describe("Remove on a Worktrees row", () => {
  const facts = (w: World, agentDir: string) => ({ agentDir, home: join(w.fx.root, "home"), tmp: join(w.fx.root, "os-tmp"), codeRoot: join(w.fx.root, "installed") });
  const INSTALL = (w: World) => retirementAllowed({}, facts(w, join(w.fx.root, "srv", "agent")));

  for (const hold of HOLDS) {
    test(`on an install, ${hold.name} still holds, nothing touched, and the reason clearing lets it go`, async () => {
      const w = world();
      const b = finished(w, "rowheld");
      const clear = await hold.make(w, b);
      const before = snapshot(w, b.checkout);
      const r = await removeFinished(b.checkout, w.deps, INSTALL(w));
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(!r.ok ? r.error : "", /Nothing was removed/);
      assert.match(!r.ok ? r.error : "", hold.says);
      assert.deepEqual(snapshot(w, b.checkout), before);
      await clear();
      const again = await removeFinished(b.checkout, w.deps, INSTALL(w));
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal(existsSync(b.checkout), false);
    });
  }

  test("on an install, a tree with something left is refused: a real commit, an unproved draft, a merge of an unlanded branch", async () => {
    const w = world();
    await w.fx.withSpec();
    const work = w.fx.branch("rowwork", { "w.txt": "w\n" });
    const drafted = finished(w, "rowdraft");
    w.fx.draft(drafted.checkout, "rowdraft");
    const other = w.fx.branch("rowunlanded", { "u.txt": "u\n" });
    const taker = finished(w, "rowtaker");
    git(taker.checkout, ["merge", "-q", "--no-ff", "--no-edit", other.branch]);
    for (const b of [work, drafted, taker]) {
      const before = snapshot(w, b.checkout);
      const r = await removeFinished(b.checkout, w.deps, INSTALL(w));
      assert.equal(r.ok, false, `${b.branch}: ${JSON.stringify(r)}`);
      assert.deepEqual(snapshot(w, b.checkout), before, b.branch);
    }
  });

  test("on an install, what isn't a worktree of the repository is refused: the main checkout, a folder inside a tree, a link to one, a way round by .., a leftover, nowhere", async () => {
    const w = world();
    const b = finished(w, "rowpaths");
    const link = join(w.fx.parent, ".worktrees", "demo-rowlink");
    symlinkSync(b.checkout, link);
    const stray = join(w.fx.parent, ".worktrees", "demo-stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "notes.md"), "only here\n");
    const before = snapshot(w, b.checkout);
    const main = filesOf(w.fx.project);
    for (const path of [w.fx.project, join(b.checkout, "node_modules"), link, `${b.checkout}/../demo-rowpaths`, stray, join(w.fx.root, "nowhere"), "/", w.fx.parent]) {
      const r = await removeFinished(path, w.deps, INSTALL(w));
      assert.equal(r.ok, false, `${path}: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(snapshot(w, b.checkout), before);
    assert.deepEqual(filesOf(w.fx.project), main);
    assert.equal(readFileSync(join(stray, "notes.md"), "utf8"), "only here\n");
  });

  test("the real install, a test server and SOVA_RETIRE=off each refuse, with nothing read that could act", async () => {
    const w = world();
    const b = finished(w, "rowgates");
    const real = retirementAllowed({}, { agentDir: join(w.fx.root, "home", ".pi", "agent"), home: join(w.fx.root, "home"), tmp: join(w.fx.root, "os-tmp"), codeRoot: join(w.fx.root, "installed") });
    assert.equal(real.on, true, "the control: this really reads as the real install");
    const off = retirementAllowed({ SOVA_RETIRE: "off" }, facts(w, join(w.fx.root, "home", ".pi", "agent")));
    const test_ = retirementAllowed({ SOVA_TEST_HOME: w.fx.root }, facts(w, join(w.fx.root, "srv", "agent")));
    const before = snapshot(w, b.checkout);
    for (const gate of [real, off, test_]) {
      const r = await removeFinished(b.checkout, w.deps, gate);
      assert.equal(r.ok, false);
      assert.deepEqual(snapshot(w, b.checkout), before);
    }
    assert.deepEqual(w.writes, []);
  });

  test("the route on a real test server: 409, and a finished worktree of a repository outside it stays; bad bodies are 400", { timeout: 120_000 }, async () => {
    const w = world();
    const b = finished(w, "rowroute");
    const before = snapshot(w, b.checkout);
    const server = await startHermeticServer();
    try {
      const post = (body: unknown) => fetch(`${server.base}/api/worktrees/remove`, { method: "POST", headers: { "content-type": "application/json", "x-sova-token": server.token }, body: JSON.stringify(body) });
      const res = await post({ path: b.checkout });
      assert.equal(res.status, 409, await res.clone().text());
      assert.match(((await res.json()) as { error: string }).error, /Nothing was removed/);
      assert.deepEqual(snapshot(w, b.checkout), before);
      assert.equal((await post({ path: "relative/path" })).status, 400);
      assert.equal((await post({ path: 7 })).status, 400);
      assert.equal((await post({})).status, 400);
      assert.deepEqual(snapshot(w, b.checkout), before);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------- the one keep rule

/** Ignore `pattern` by the repository's own exclude file, so no commit changes for it. */
function excluded(b: { checkout: string }, pattern: string): void {
  const abs = join(git(b.checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "info/exclude");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${existsSync(abs) ? readFileSync(abs, "utf8") : ""}${pattern}\n`);
}

function put(dir: string, rel: string, bytes: string | Buffer): void {
  const f = join(dir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, bytes);
}

describe("the one keep rule (§chat.worktrees/leftovers): retirement adds nothing to it and takes nothing from it", () => {
  // A hand-written table, not the rule read back: each row is what the rule's sentence says of that file.
  const GOES: [string, string][] = [
    ["sub/node_modules/x/i.js", "node_modules"],
    ["sub/__pycache__/x.cpython.pyc", "__pycache__"],
    ["dist/a.js", "dist"],
    ["dist-web/a.js", "dist-web"],
    ["build/a.o", "build"],
    ["out/a", "out"],
    ["target/a", "target"],
    ["coverage/a", "coverage"],
    [".cache/a", ".cache"],
    [".turbo/a", ".turbo"],
    [".vite/a", ".vite"],
    [".next/a", ".next"],
    ["tmp/a", "/tmp"],
    [".DS_Store", ".DS_Store"],
    ["a.tsbuildinfo", "*.tsbuildinfo"],
    ["a.pyc", "*.pyc"],
    ["run.log", "*.log"],
  ];
  const HOLDS_FOR: [string, string][] = [
    ["secrets.local", "secrets.local"],
    [".env", ".env"],
    ["dist.bak/old.js", "dist.bak"],
    ["node_modules.bak/x.js", "node_modules.bak"],
    [".cachenotes", ".cachenotes"],
    ["sub/tmp/a", "tmp"], // tmp counts only at the top of the tree.
    ["notes/build.txt", "notes"],
    ["a.sqlite", "*.sqlite"],
  ];

  for (const [rel, pattern] of GOES)
    test(`${rel}: let go`, async () => {
      const w = world();
      const b = finished(w, "keepgo");
      excluded(b, pattern);
      put(b.checkout, rel, "rebuildable\n");
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    });

  for (const [rel, pattern] of HOLDS_FOR)
    test(`${rel}: held, named, nothing touched, and it goes once the file has`, async () => {
      const w = world();
      const b = finished(w, "keephold");
      excluded(b, pattern);
      put(b.checkout, rel, "only here\n");
      assert.notEqual(leftoversReason(await leftovers(b.checkout)), null, "the control: master's one rule keeps this");
      const before = snapshot(w, b.checkout);
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), []);
      assert.match(heldOf(r, b.checkout)?.reason ?? "", new RegExp(rel.split("/")[0]!.replaceAll(".", "\\.")));
      assert.deepEqual(snapshot(w, b.checkout), before);
      rmSync(join(b.checkout, rel.split("/")[0]!), { recursive: true });
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    });

  test("a file git lists by itself is judged by itself: an ignored build/.env in a tracked build/ is work", async () => {
    const w = world();
    const b = w.fx.branch("trackedbuild", { "build/keep.txt": "tracked\n" });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    excluded(b, ".env");
    put(b.checkout, "build/.env", "only here\n");
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.equal(readFileSync(join(b.checkout, "build/.env"), "utf8"), "only here\n");
  });

  test("a nested repository inside a rebuildable folder: the folder goes with it, so it holds", async () => {
    const w = world();
    const b = finished(w, "nestgit");
    const inner = join(b.checkout, "build/inner");
    excluded(b, "build");
    mkdirSync(inner, { recursive: true });
    git(inner, ["init", "-q"]);
    put(inner, "unsaved.txt", "only here\n");
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.equal(readFileSync(join(inner, "unsaved.txt"), "utf8"), "only here\n");
  });

  test("more than the read can count: a failed read of the files holds", async () => {
    const w = world();
    const b = finished(w, "ignoredfail");
    const real = w.deps.git;
    const failing: GitRunner = async (args, opts) => (args.includes("--ignored") || args.includes("ls-files") ? { code: 128, stdout: "", stderr: "fatal: can't list" } : real(args, opts));
    w.deps.git = failing;
    const before = snapshot(w, b.checkout, { pins: "ignore" });
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before);
  });
});

// ---------------------------------------------------------------- what a test copy left (q14)

describe("what a test copy left: finished or empty trees only", () => {
  const CHAT = '{"type":"session"}\n{"type":"user","text":"made in a test copy"}\n';
  /** A finished tree whose ignored .agent holds a test chat. */
  function withTestChat(w: World, name: string, text = CHAT) {
    const b = finished(w, name);
    excluded(b, ".agent");
    put(b.checkout, ".agent/sessions/--x--/a.jsonl", text);
    return b;
  }
  const aside = (w: World, b: { checkout: string }) => join(w.asideDir, basename(b.checkout), "sessions/--x--/a.jsonl");

  test("a test chat that differs from the real ones is moved aside first, read back, and the folder then goes", async () => {
    const w = world();
    const b = withTestChat(w, "tchat");
    let movedFirst: string | null = null;
    w.hooks.push((args, _c, phase) => {
      if (phase === "before" && isRemove(args)) movedFirst = existsSync(aside(w, b)) ? readFileSync(aside(w, b), "utf8") : "(not moved)";
    });
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.equal(movedFirst, CHAT, "moved, whole, before the folder goes");
    assert.equal(readFileSync(aside(w, b), "utf8"), CHAT, "and kept");
  });

  test("a test chat a real chat holds all of, the same file or one continuing it, isn't kept twice", async () => {
    const w = world();
    const b = withTestChat(w, "tchat2");
    put(w.realChats, "--y--/copied.jsonl", `${CHAT}{"type":"user","text":"later"}\n`);
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.equal(existsSync(aside(w, b)), false, "the real chat already has every byte");
  });

  test("the same length with other bytes differs: moved aside, not taken for a copy", async () => {
    const w = world();
    const b = withTestChat(w, "tchat3");
    put(w.realChats, "--y--/copied.jsonl", CHAT.replace("made", "MADE"));
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.equal(readFileSync(aside(w, b), "utf8"), CHAT);
  });

  test("a test chat that can't be moved keeps the folder, with nothing removed", async () => {
    const w = world();
    const b = withTestChat(w, "tchat4");
    // A file where the kept place must be a folder, so no move can succeed. A permission bit can't stop root.
    writeFileSync(w.asideDir, "in the way\n");
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.equal(readFileSync(join(b.checkout, ".agent/sessions/--x--/a.jsonl"), "utf8"), CHAT);
    assert.deepEqual(w.writes.filter((x) => isRemove(x.args)).map((x) => x.args.join(" ")), [], "no removal was sent");
    rmSync(w.asideDir);
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout], "and it goes once one can");
  });

  test("a real-chats folder that can't be listed for the comparison keeps the folder: a doubt about whether it's a copy", { skip: process.getuid?.() === 0 && "root reads every folder" }, async () => {
    const w = world();
    const b = withTestChat(w, "tchat5");
    const locked = join(w.realChats, "--z--");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), [], "it can't tell, so it holds");
      assert.equal(readFileSync(join(b.checkout, ".agent/sessions/--x--/a.jsonl"), "utf8"), CHAT);
      assert.match(reasonOf(r, b.checkout), /\.agent|sessions/);
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout], "and it goes once it can tell");
  });

  test("a second test copy's chat of the same folder name doesn't overwrite the first's kept chat", async () => {
    const w = world();
    const b = withTestChat(w, "tchat6");
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.equal(readFileSync(aside(w, b), "utf8"), CHAT);
    // The folder comes back, makes a new chat under the same name, retires again.
    assert.equal((await bringBack(w.deps, b.checkout)).state, "back");
    const c2 = w.fx.commitIn(b.checkout, { "again.txt": "again\n" }, "more work");
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    assert.ok(c2);
    excluded(b, ".agent");
    const later = `${CHAT}{"type":"user","text":"another run"}\n`;
    put(b.checkout, ".agent/sessions/--x--/a.jsonl", later.replace("made", "unmade"));
    w.now.t += DAY;
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    const kept = filesOf(join(w.asideDir, basename(b.checkout)));
    assert.ok(Object.values(kept).includes(CHAT), `the first run's chat still kept: ${Object.keys(kept).join(", ")}`);
    assert.ok(Object.values(kept).includes(later.replace("made", "unmade")), "and so is the second's");
  });

  test("login copies and the rest of .agent go for good: nothing of them is kept aside", async () => {
    const w = world();
    const b = finished(w, "tlogin");
    excluded(b, ".agent");
    put(b.checkout, ".agent/auth.json", '{"fake":"k"}\n');
    put(b.checkout, ".agent/claude-accounts/x/creds", "fake\n");
    put(b.checkout, ".agent/sova/usage.json", "{}\n");
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    assert.deepEqual(filesOf(w.asideDir), {}, "no login copy is carried out of the folder");
  });

  test("an .agent git doesn't ignore is uncommitted work, not a test copy's leavings", async () => {
    const w = world();
    const b = w.fx.branch("tnotignored", { ".gitignore": "node_modules/\n" });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    assert.notEqual(spawnSync("git", ["check-ignore", "-q", ".agent/x"], { cwd: b.checkout }).status, 0, "the control: git doesn't ignore it here");
    mkdirSync(join(b.checkout, "node_modules"), { recursive: true });
    put(b.checkout, ".agent/sessions/--x--/a.jsonl", CHAT);
    const before = snapshot(w, b.checkout);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.deepEqual(snapshot(w, b.checkout), before);
  });

  test("an .agent below the top isn't one: nested/.agent keeps the tree", async () => {
    const w = world();
    const b = finished(w, "tnested");
    excluded(b, "nested");
    put(b.checkout, "nested/.agent/sessions/a.jsonl", CHAT);
    const before = snapshot(w, b.checkout);
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.deepEqual(snapshot(w, b.checkout), before);
  });

  test("a tree with work is none of this: its test chats stay where they are", async () => {
    const w = world();
    const b = w.fx.branch("twork", { "w.txt": "w\n" });
    excluded(b, ".agent");
    put(b.checkout, ".agent/sessions/--x--/a.jsonl", CHAT);
    const before = snapshot(w, b.checkout);
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.deepEqual(snapshot(w, b.checkout), before);
    assert.deepEqual(filesOf(w.asideDir), {});
  });

  describe("recordings", () => {
    const VIDEO = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 7, 7, 7]);
    const recorded = (w: World, name: string, rel = "demo.mp4", bytes: Buffer = VIDEO) => {
      const b = finished(w, name);
      excluded(b, "*.mp4");
      put(b.checkout, rel, bytes);
      return b;
    };

    test("the last copy holds its folder, naming it; nothing touched; and it goes once the recording is elsewhere", async () => {
      const w = world();
      const b = recorded(w, "rec1");
      const before = snapshot(w, b.checkout);
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), []);
      assert.match(heldOf(r, b.checkout)?.reason ?? "", /demo\.mp4/);
      assert.deepEqual(snapshot(w, b.checkout), before);
      put(w.fx.project, "copy-of-demo.mp4", VIDEO);
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    });

    test("the same bytes in git: goes", async () => {
      const w = world();
      w.fx.moveTargetOutside({ "docs/demo.mp4": VIDEO.toString("latin1") });
      git(w.fx.project, ["merge", "-q", "--ff-only", w.fx.target], { allowFail: true });
      const b = recorded(w, "rec2", "demo.mp4", Buffer.from(VIDEO.toString("latin1"), "utf8"));
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    });

    test("the same name with other bytes elsewhere isn't a copy: held", async () => {
      const w = world();
      const b = recorded(w, "rec3");
      put(w.fx.project, "demo.mp4", Buffer.from([9, 9, 9]));
      const before = snapshot(w, b.checkout);
      assert.deepEqual(retiredPaths(await w.pass()), []);
      assert.deepEqual(snapshot(w, b.checkout), before);
    });

    test("the same length with other bytes elsewhere isn't a copy: held", async () => {
      const w = world();
      const b = recorded(w, "rec4");
      put(w.fx.project, "other.mp4", Buffer.from(VIDEO.map((x) => x ^ 1)));
      assert.deepEqual(retiredPaths(await w.pass()), []);
      assert.ok(existsSync(join(b.checkout, "demo.mp4")));
    });

    test("the only two copies in two finished folders, however the pass orders them: one folder goes, the other holds the last copy", async () => {
      for (let i = 0; i < 4; i++) {
        const w = world();
        const a = recorded(w, `recA${i}`);
        const b = recorded(w, `recB${i}`);
        // The first removal waits for a second, so a folder that was decided but not gone yet is what the other's check meets; a retirer that counted it as staying is caught.
        const real = w.deps.gitRemove;
        let held = 0;
        w.deps.gitRemove = async (args, cwd) => {
          if (++held === 1) await until(() => held > 1, "a second removal", 1500).catch(() => undefined);
          return real(args, cwd);
        };
        const r = await w.pass();
        const survivors = [a, b].filter((x) => existsSync(join(x.checkout, "demo.mp4")));
        assert.equal(survivors.length, 1, `exactly the last copy stays, round ${i}: ${JSON.stringify(r)}`);
        assert.equal(retiredPaths(r).length, 1, "and one folder went");
        assert.equal(readFileSync(join(survivors[0]!.checkout, "demo.mp4")).equals(VIDEO), true);
      }
    });

    test("a copy in a folder with its own hold counts as elsewhere: that folder isn't going", async () => {
      const w = world();
      const a = recorded(w, "recH");
      const held = recorded(w, "recK");
      put(held.checkout, "wip.txt", "only here\n");
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), [a.checkout]);
      assert.equal(readFileSync(join(held.checkout, "demo.mp4")).equals(VIDEO), true);
    });

    test("a symlink named like a recording is a link: the folder goes, and the file it points at stays", async () => {
      const w = world();
      const b = finished(w, "recL");
      excluded(b, "*.mp4");
      const out = join(w.fx.root, "real.mp4");
      writeFileSync(out, VIDEO);
      symlinkSync(out, join(b.checkout, "demo.mp4"));
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
      assert.equal(readFileSync(out).equals(VIDEO), true);
    });

    test("a recording that can't be read holds", { skip: process.getuid?.() === 0 && "root reads every file" }, async () => {
      const w = world();
      const b = recorded(w, "recU");
      chmodSync(join(b.checkout, "demo.mp4"), 0o000);
      try {
        assert.deepEqual(retiredPaths(await w.pass()), []);
      } finally {
        chmodSync(join(b.checkout, "demo.mp4"), 0o644);
      }
      assert.ok(existsSync(join(b.checkout, "demo.mp4")));
    });
  });
});

// ---------------------------------------------------------------- the decided rules

describe("the sandbox, by platform", () => {
  test("Linux: an idle chat with its sandbox on doesn't hold", async () => {
    const w = world();
    const b = finished(w, "sbl");
    w.chats.push(quietChat(w, b.checkout, { sandbox: true }));
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
  });
  test("Linux: a running command holds anyway", async () => {
    const w = world();
    const b = finished(w, "sbr");
    w.chats.push(quietChat(w, b.checkout, { sandbox: true }));
    const c = startIn(b.checkout);
    await scanSees(c.pid!);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.match(reasonOf(r, b.checkout), /sleep/);
    await stop(c);
  });
  test("macOS: the same idle chat holds, and so does one tracking it from elsewhere", async () => {
    for (const asTracker of [false, true]) {
      const w = world();
      w.platform = "darwin";
      const b = finished(w, "sbm");
      w.chats.push(asTracker ? quietChat(w, w.fx.project, { sandbox: true, tracking: [b.checkout] }) : quietChat(w, b.checkout, { sandbox: true }));
      const before = snapshot(w, b.checkout);
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), []);
      assert.match(heldOf(r, b.checkout)?.reason ?? "", /sandbox/);
      assert.deepEqual(snapshot(w, b.checkout), before);
    }
  });
  test("an unknown platform holds as macOS does: a missing root is proved only on Linux", async () => {
    const w = world();
    w.platform = "freebsd";
    const b = finished(w, "sbf");
    w.chats.push(quietChat(w, b.checkout, { sandbox: true }));
    assert.deepEqual(retiredPaths(await w.pass()), []);
  });
});

describe("what holds is asked before what only waits", () => {
  test("a busy chat and an uncommitted file: held, for the file", async () => {
    const w = world();
    const b = finished(w, "order");
    w.chats.push(quietChat(w, b.checkout, { running: true }));
    writeFileSync(join(b.checkout, "wip.txt"), "only here\n");
    const r = await w.pass();
    assert.match(heldOf(r, b.checkout)?.reason ?? "(not held)", /wip\.txt/);
    assert.equal(waitingOf(r, b.checkout), undefined);
  });
});

describe("never retired, whatever they read", () => {
  const onName = (w: World, name: string) => {
    const dev = w.fx.worktreeOf(name.replaceAll("/", "-"));
    git(w.fx.project, ["worktree", "add", "-q", "-b", name, dev, w.fx.target]);
    w.fx.commitIn(dev, { [`${name.replaceAll("/", "-")}.txt`]: "d\n" }, `on ${name}`);
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", name]);
    return dev;
  };
  const stays = async (w: World, dev: string, name: string) => {
    const before = snapshot(w, dev);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.equal(heldOf(r, dev), undefined, "on neither list");
    assert.equal(waitingOf(r, dev), undefined, "on neither list");
    assert.deepEqual(snapshot(w, dev), before);
    assert.ok(git(w.fx.project, ["branch", "--list", name]).includes(name));
  };

  for (const name of ["main", "master"])
    test(`a linked worktree on ${name}, on a project that lands elsewhere`, async () => {
      const w = world({ target: "develop" });
      w.deps.targetOf = async () => "develop";
      await stays(w, onName(w, name), name);
    });

  test("the branch origin/HEAD names", async () => {
    const w = world({ remote: true });
    const dev = onName(w, "trunk");
    git(w.fx.project, ["push", "-q", "origin", "trunk"]);
    git(w.fx.project, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    await stays(w, dev, "trunk");
  });

  test("the branch its project lands on, named by the project only", async () => {
    const w = world({ target: "develop" });
    const dev = onName(w, "release-line");
    w.deps.targetOf = async () => "release-line";
    await stays(w, dev, "release-line");
  });

  test("a tree on no branch, at a commit the target has", async () => {
    const w = world();
    const dev = w.fx.worktreeOf("detached");
    git(w.fx.project, ["worktree", "add", "-q", "--detach", dev, w.fx.target]);
    const before = snapshot(w, dev);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.deepEqual(snapshot(w, dev), before);
  });

  test("the main checkout on a feature branch, however finished", async () => {
    const w = world();
    git(w.fx.project, ["checkout", "-q", "-b", "feat/inmain"]);
    await stays(w, w.fx.project, "feat/inmain");
    assert.ok(existsSync(join(w.fx.project, ".git")));
  });
});

describe("a registered test copy that holds its folder", () => {
  test("a copy a conformance run made", async () => {
    const w = world();
    const b = finished(w, "conform");
    w.copies.set(b.checkout, { id: "c", shareLink: false, ownRun: true });
    let stopped = 0;
    w.deps.copies.teardown = async () => void stopped++;
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.equal(stopped, 0, "never stopped");
    assert.ok(existsSync(b.checkout));
  });
  test("a copy on a branch with no commits of its own, which may be someone trying the main branch", async () => {
    const w = world();
    const p = w.fx.worktreeOf("trying");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/trying", p, w.fx.target]);
    w.copies.set(p, { id: "c", shareLink: false, ownRun: false });
    let stopped = 0;
    w.deps.copies.teardown = async () => void stopped++;
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.equal(stopped, 0);
    assert.ok(existsSync(p));
  });
});

describe("the lock", () => {
  test("a lock another live process holds: nothing removed, and the pass says the lock looks taken", async () => {
    const w = world();
    const b = finished(w, "lockline");
    const c = startIn(w.fx.state);
    writeFileSync(retireFiles.repoLockFile(join(w.fx.project, ".git")), String(c.pid));
    const before = snapshot(w, b.checkout);
    const r = await w.pass();
    assert.deepEqual(snapshot(w, b.checkout), before);
    assert.ok(r.repos.some((x) => x.repo === w.fx.project && x.lockTaken), `the lock-taken line: ${JSON.stringify(r)}`);
    await stop(c);
  });
});

describe("the first pass's report", () => {
  const report = (w: World) => JSON.parse(readFileSync(w.firstPassPath, "utf8")) as { groups: Record<string, { path: string }[]> };

  test("every worktree and leftover folder in exactly one group; the first pass really retires, with no off step", async () => {
    const w = world();
    const gone = finished(w, "rg-gone");
    const held = finished(w, "rg-held");
    writeFileSync(join(held.checkout, "wip.txt"), "only here\n");
    const waiting = finished(w, "rg-wait");
    w.chats.push(quietChat(w, waiting.checkout, { running: true }));
    const work = w.fx.branch("rg-work", { "w.txt": "w\n" });
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), [gone.checkout], "no staged first pass: what's finished goes now");
    const g = report(w).groups;
    const has = (name: string, p: string) => (g[name] ?? []).some((x) => x.path === p);
    assert.ok(has("retired", gone.checkout), JSON.stringify(g));
    assert.ok(has("held", held.checkout));
    assert.ok(has("waiting", waiting.checkout));
    assert.ok(has("hasWork", work.checkout));
    const all = Object.values(g).flat().map((x) => x.path).sort();
    assert.deepEqual(all, [gone.checkout, held.checkout, waiting.checkout, work.checkout].sort(), "each in exactly one group");
  });

  test("the queue's own go in a group of their own, retired or held", async () => {
    const w = world();
    const own = finished(w, "resolve-mq_1");
    const ownHeld = finished(w, "resolve-mq_2");
    writeFileSync(join(ownHeld.checkout, "wip.txt"), "only here\n");
    w.queueMade.add(own.checkout);
    w.queueMade.add(ownHeld.checkout);
    const plain = finished(w, "rg-plain");
    await w.pass();
    const g = report(w).groups;
    const of = (name: string) => (g[name] ?? []).map((x) => x.path);
    assert.deepEqual(of("queueOwn").sort(), [own.checkout, ownHeld.checkout].sort(), JSON.stringify(g));
    assert.deepEqual(of("retired"), [plain.checkout], "and in no other group");
    assert.deepEqual(of("held"), []);
  });

  test("a merge thread's branch that looks unmerged, every commit but a merge on the target, retires: folder, branch and a restorable last commit", async () => {
    const w = world();
    const landed = w.fx.branch("landed-part", { "p.txt": "p\n" });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", landed.branch]);
    const own = w.fx.branch("resolve-mq_3", { "conflict.txt": "resolved\n" });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", own.branch]);
    w.fx.moveTargetOutside({ "later.txt": "later\n" });
    git(own.checkout, ["merge", "-q", "--no-ff", "--no-edit", "-m", "a merge of its own", w.fx.target]);
    w.queueMade.add(own.checkout);
    const tip = git(own.checkout, ["rev-parse", "HEAD"]);
    const r = await w.pass();
    assert.equal(existsSync(own.checkout), false, JSON.stringify(r));
    assert.equal(git(w.fx.project, ["branch", "--list", own.branch]), "");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${tip}`]), tip);
  });

  test("a branch of a queue chat's with a commit of its own the target lacks stays", async () => {
    const w = world();
    const own = w.fx.branch("resolve-mq_4", { "own.txt": "real work\n" });
    w.queueMade.add(own.checkout);
    const before = snapshot(w, own.checkout);
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.deepEqual(snapshot(w, own.checkout), before);
  });
});

describe("the service's gate reads the real install, and only it", () => {
  const facts = (root: string, agentDir: string) => ({ agentDir, home: join(root, "home"), tmp: join(root, "os-tmp") });
  test("code running from a linked worktree is a test copy, on the real agent dir too", () => {
    const w = world();
    const code = join(w.fx.root, "code");
    mkdirSync(code);
    writeFileSync(join(code, ".git"), "gitdir: x\n");
    const g = retirementAllowed({}, { ...facts(w.fx.root, join(w.fx.root, "home/.pi/agent")), codeRoot: code });
    assert.equal(g.on, false);
    assert.equal(!g.on && g.offFor, "test");
  });
  test("code running from the main checkout, on the real agent dir, is on: the control", () => {
    const w = world();
    const code = join(w.fx.root, "code");
    mkdirSync(join(code, ".git"), { recursive: true });
    assert.equal(retirementAllowed({}, { ...facts(w.fx.root, join(w.fx.root, "home/.pi/agent")), codeRoot: code }).on, true);
  });
  test("SOVA_RETIRE=on turns nothing on anywhere it's off", () => {
    const w = world();
    assert.equal(retirementAllowed({ SOVA_RETIRE: "on" }, facts(w.fx.root, join(w.fx.root, "srv/agent"))).on, false);
    assert.equal(retirementAllowed({ SOVA_RETIRE: "on", SOVA_TEST_HOME: "x" }, facts(w.fx.root, join(w.fx.root, "home/.pi/agent"))).on, false);
  });
});

// ---------------------------------------------------------------- attacks: what a careless retirer would delete

describe("attacks", () => {
  /** A project that lands on `develop`: the classifier asks its one seam for the declared target, as the real wiring does. */
  // The seam is the module's, so a project-that-lands-elsewhere case must not leak into the next test: with develop declared, master-based repos read as no target at all.
  const noTargetSeam = () => configureCleanup({ summary: async () => null, sessionFiles: async () => [], readBranch: async () => [] });
  afterEach(noTargetSeam);
  const onDevelop = () => {
    const w = world({ target: "develop" });
    configureCleanup({ summary: async () => null, sessionFiles: async () => [], readBranch: async () => [], targetOf: async () => "develop" });
    return w;
  };

  test("the control for a project that lands elsewhere: a finished branch does retire there", async () => {
    const w = onDevelop();
    const b = finished(w, "dev-control");
    assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
  });

  for (const name of ["main", "master"])
    test(`a linked worktree on ${name}, in a project landing on develop, really classified: on neither list`, async () => {
      const w = onDevelop();
      const dev = w.fx.worktreeOf(name);
      git(w.fx.project, ["worktree", "add", "-q", "-b", name, dev, w.fx.target]);
      w.fx.commitIn(dev, { [`${name}.txt`]: "d\n" }, `on ${name}`);
      git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", name]);
      const before = snapshot(w, dev);
      const r = await w.pass();
      assert.deepEqual(retiredPaths(r), []);
      assert.equal(heldOf(r, dev), undefined);
      assert.equal(waitingOf(r, dev), undefined);
      assert.deepEqual(snapshot(w, dev), before);
    });

  for (const branch of ["main", "release-1.0"])
    test(`a leftover folder whose record names a protected branch (${branch}): that branch is never deleted`, async () => {
      const w = world();
      git(w.fx.project, ["branch", branch, w.fx.target]);
      if (branch !== "main") {
        git(w.fx.project, ["config", "remote.origin.url", "x"]);
        git(w.fx.project, ["update-ref", `refs/remotes/origin/${branch}`, w.fx.target]);
        git(w.fx.project, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
      }
      const p = join(w.fx.parent, ".worktrees", "demo-stale");
      mkdirSync(join(p, "node_modules"), { recursive: true });
      w.record(p, branch);
      await w.pass();
      assert.ok(git(w.fx.project, ["branch", "--list", branch]).includes(branch), `${branch} still exists`);
    });

  test("a ledger entry naming a protected branch: finishing it never deletes that branch", async () => {
    const w = world();
    git(w.fx.project, ["branch", "main", w.fx.target]);
    const tip = git(w.fx.project, ["rev-parse", "main"]);
    w.deps.appendLedger([{ v: 1, path: join(w.fx.parent, ".worktrees", "demo-old"), branch: "main", commonDir: canonical(join(w.fx.project, ".git")), tip, merged: "ancestor", branchDeleted: false, at: 1, retired: true, pinned: true }]);
    await w.pass();
    assert.ok(git(w.fx.project, ["branch", "--list", "main"]).includes("main"));
  });

  test("an empty worktree holding a spec draft: the draft isn't read as nothing", async () => {
    const w = world();
    await w.fx.withSpec();
    const p = w.fx.worktreeOf("emptydraft");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/emptydraft", p, w.fx.target]);
    w.fx.draft(p, "emptydraft");
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.ok(existsSync(join(p, ".sova/spec/drafts/emptydraft")));
  });

  test("a recording whose blob git has but no ref reaches isn't in git: gc would drop it", async () => {
    const w = world();
    const b = finished(w, "dangling");
    excluded(b, "*.mp4");
    const bytes = Buffer.from("a recording nothing else has");
    put(b.checkout, "demo.mp4", bytes);
    git(b.checkout, ["hash-object", "-w", "demo.mp4"]); // what `git add` then `git reset` leaves.
    await w.pass();
    git(w.fx.project, ["reflog", "expire", "--expire=now", "--all"]);
    git(w.fx.project, ["gc", "-q", "--prune=now"]);
    const oid = spawnSync("git", ["hash-object", "--stdin"], { cwd: w.fx.project, input: bytes, encoding: "utf8" }).stdout.trim();
    const stillThere = existsSync(join(b.checkout, "demo.mp4")) || spawnSync("git", ["cat-file", "-e", oid], { cwd: w.fx.project }).status === 0;
    assert.ok(stillThere, "the last copy of those bytes is gone");
  });

  test("a leftover file whose blob git has but no ref reaches isn't in git, by content", async () => {
    const w = world();
    const p = join(w.fx.parent, ".worktrees", "demo-dangle");
    put(p, "notes.txt", "only here\n");
    w.record(p, "feat/gone");
    spawnSync("git", ["hash-object", "-w", join(p, "notes.txt")], { cwd: w.fx.project });
    await w.pass();
    assert.ok(existsSync(join(p, "notes.txt")), "a dangling object doesn't outlive gc");
  });

  test("a tree whose .git file was deleted, with unique work in it: not read as gone, nothing deleted", async () => {
    const w = world();
    const b = finished(w, "brokenlink");
    writeFileSync(join(b.checkout, "only.txt"), "only here\n");
    rmSync(join(b.checkout, ".git"));
    await w.pass();
    assert.equal(readFileSync(join(b.checkout, "only.txt"), "utf8"), "only here\n");
  });

  test("a saved report that can't be written: nothing goes unrecorded", async () => {
    const w = world();
    const b = finished(w, "noreport");
    const blocked = join(w.fx.state, "not-a-dir");
    writeFileSync(blocked, "x");
    w.deps.pendingFile = () => join(blocked, "retire-pending.json");
    w.deps.firstPassFile = () => join(blocked, "retire-first-pass.json");
    const before = snapshot(w, b.checkout, { pins: "ignore" });
    await w.pass().catch(() => null);
    assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before);
  });

  test("a scratch copy, on a branch and finished: never retired, and no copy of a recording counts in one", async () => {
    const w = world();
    const b = finished(w, "scratched");
    const id = readFileSync(join(b.checkout, ".git"), "utf8").trim().split("/").pop()!;
    writeFileSync(join(w.fx.project, ".git/worktrees", id, "sova-scratch-copy"), JSON.stringify({ root: w.fx.project, entry: "mq_1" }));
    excluded(b, "*.mp4");
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
    put(b.checkout, "demo.mp4", bytes);
    const other = finished(w, "scratch-other");
    put(other.checkout, "demo.mp4", bytes);
    const r = await w.pass();
    assert.ok(existsSync(b.checkout), "the queue removes its own");
    assert.deepEqual(retiredPaths(r), [], `the copy in a scratch copy doesn't count: ${JSON.stringify(r)}`);
    assert.ok(existsSync(join(other.checkout, "demo.mp4")));
  });

  test("the last copy counted as elsewhere inside another folder's rebuildable output: after both go, the bytes must survive", async () => {
    const w = world();
    const bytes = Buffer.from([8, 8, 8, 8, 1]);
    const a = finished(w, "rebA");
    excluded(a, "*.mp4");
    excluded(a, "build");
    put(a.checkout, "demo.mp4", bytes);
    const b = finished(w, "rebB");
    put(b.checkout, "build/demo.mp4", bytes);
    await w.pass();
    w.now.t += 60 * MIN;
    await w.pass();
    assert.ok([a, b].some((x) => existsSync(join(x.checkout, "demo.mp4")) || existsSync(join(x.checkout, "build/demo.mp4"))), "the last copy went with build output");
  });

  describe("the real chat reader", () => {
    function readerWorld(summary: (p: string) => Promise<SessionSummary | null>) {
      const w = world();
      const b = finished(w, "realreader");
      const file = join(w.fx.state, "chat.jsonl");
      writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "c1", timestamp: "", cwd: b.checkout })}\n`);
      utimesSync(file, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
      configureCleanup({ summary, sessionFiles: async () => [file], readBranch: async () => [] });
      w.deps.chats = (paths, exclude) => chatUses(paths, exclude);
      return { w, b };
    }
    const summaryWith = (over: Partial<SessionSummary>) => async () => ({ id: "c1", path: "x", title: "t", cwd: "/", busy: false, live: null, ...over }) as unknown as SessionSummary;

    test("the control: a quiet chat doesn't hold", async () => {
      const { w, b } = readerWorld(summaryWith({}));
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout]);
    });
    for (const [name, over] of [
      ["busy", { busy: true }],
      ["waiting on an answer it asked for", { activity: { state: "needs-input" } }],
      ["working", { activity: { state: "working" } }],
      ["open in a TUI", { live: { pid: 1 } }],
      ["holding workers", { workers: { total: 1, working: 0 } }],
    ] as [string, Partial<SessionSummary>][])
      test(`${name}: holds, through the real reader`, async () => {
        const { w, b } = readerWorld(summaryWith(over));
        const before = snapshot(w, b.checkout, { pins: "ignore" });
        assert.deepEqual(retiredPaths(await w.pass()), []);
        assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before);
      });
    test("a chat whose summary can't be read counts against it: a doubt isn't quiet", async () => {
      const { w, b } = readerWorld(async () => null);
      assert.deepEqual(retiredPaths(await w.pass()), [], "summary unknown read as a quiet chat");
      assert.ok(existsSync(b.checkout));
    });
    test("a summary that throws holds", async () => {
      const { w, b } = readerWorld(async () => {
        throw new Error("no index");
      });
      await w.pass();
      assert.ok(existsSync(b.checkout));
    });
  });
});

// ---------------------------------------------------------------- what the mutation pass found unproved

describe("what a broken copy showed nothing else proved", () => {
  /** The module's seam, for a project landing on `develop`. */
  const onDevelop = () => configureCleanup({ summary: async () => null, sessionFiles: async () => [], readBranch: async () => [], targetOf: async () => "develop" });
  afterEach(() => configureCleanup({ summary: async () => null, sessionFiles: async () => [], readBranch: async () => [] }));

  test("a branch moved in the gap git's own delete can't check: the commit in the delete itself refuses it", async () => {
    const w = world();
    const b = w.fx.branch("squashed-late", { "s.txt": "s\n" });
    git(w.fx.project, ["merge", "-q", "--squash", b.branch]);
    git(w.fx.project, ["commit", "-q", "-m", "squash"]);
    let moved = "";
    w.hooks.push((args, _cwd, phase) => {
      const a = verbOf(args);
      if (phase !== "before" || a[0] !== "update-ref" || a[1] !== "-d" || moved) return;
      moved = git(w.fx.project, ["commit-tree", `${b.commit}^{tree}`, "-p", b.commit, "-m", "a commit in the gap"]);
      git(w.fx.project, ["update-ref", `refs/heads/${b.branch}`, moved]);
    });
    await w.pass();
    assert.ok(moved, "the delete was reached");
    assert.equal(git(w.fx.project, ["rev-parse", `refs/heads/${b.branch}`]), moved, "the branch stays at the commit made in the gap");
  });

  test("git exiting 0 while the tree is still listed: not removed, and nothing follows", async () => {
    const w = world();
    const b = finished(w, "lied");
    w.deps.gitRemove = async () => ({ code: 0, stdout: "", stderr: "" });
    const before = snapshot(w, b.checkout, { pins: "ignore" });
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before, "the branch stays, and no ledger line says it went");
  });

  test("a leftover folder with another registered worktree inside: not deleted through it", async () => {
    const w = world();
    const p = join(w.fx.parent, ".worktrees", "demo-holder");
    mkdirSync(p, { recursive: true });
    const inner = join(p, "inner");
    git(w.fx.project, ["worktree", "add", "-q", "-b", "feat/inner", inner, w.fx.target]);
    writeFileSync(join(inner, "only.txt"), "only here\n");
    w.record(p, "feat/gone");
    const r = await w.pass();
    assert.equal(readFileSync(join(inner, "only.txt"), "utf8"), "only here\n");
    assert.match(reasonOf(r, p), /inside it/);
  });

  test("on Linux an idle chat with its sandbox on doesn't keep a leftover either", async () => {
    const w = world();
    const p = join(w.fx.parent, ".worktrees", "demo-sandboxed");
    put(p, "node_modules/a.js", "x\n");
    w.record(p, "feat/gone");
    w.chats.push(quietChat(w, p, { sandbox: true }));
    await w.pass();
    assert.equal(existsSync(p), false);
  });

  test("tmp counts only at the top: a tmp git lists itself deep in a tracked folder keeps the tree", async () => {
    const w = world();
    const b = w.fx.branch("deeptmp", { "sub/keep.txt": "tracked\n" });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    excluded(b, "tmp");
    put(b.checkout, "sub/tmp/a", "only here\n");
    assert.match(git(b.checkout, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]), /^sub\/tmp\/$/m, "the control: git lists that folder itself");
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.equal(readFileSync(join(b.checkout, "sub/tmp/a"), "utf8"), "only here\n");
  });

  test("an .agent below the top, listed by git itself, isn't a test copy's: it keeps the tree", async () => {
    const w = world();
    const b = w.fx.branch("deepagent", { "sub/keep.txt": "tracked\n" });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    excluded(b, ".agent");
    put(b.checkout, "sub/.agent/sessions/a.jsonl", "only here\n");
    assert.match(git(b.checkout, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]), /^sub\/\.agent\/$/m, "the control: git lists that folder itself");
    assert.deepEqual(retiredPaths(await w.pass()), []);
    assert.equal(readFileSync(join(b.checkout, "sub/.agent/sessions/a.jsonl"), "utf8"), "only here\n");
  });

  test("a leftover whose last commit can't be pinned: neither the folder nor the branch goes", async () => {
    const w = world();
    const b = finished(w, "lnopin");
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    put(b.checkout, "node_modules/a.js", "x\n");
    provedOurs(w, b.checkout, b.branch, b.commit);
    w.record(b.checkout, b.branch);
    const real = w.deps.gitWrite;
    w.deps.gitWrite = async (args, cwd) => (isPin(args) ? { code: 1, stdout: "", stderr: "fatal: no" } : real(args, cwd));
    await w.pass();
    assert.ok(existsSync(join(b.checkout, "node_modules/a.js")), "the folder stays");
    assert.ok(git(w.fx.project, ["branch", "--list", b.branch]).includes(b.branch), "and the branch");
  });

  test("the branch its project lands on, with the main checkout on another branch: on neither list", async () => {
    const w = world({ target: "develop" });
    onDevelop();
    const dev = w.fx.worktreeOf("develop-line");
    git(w.fx.project, ["checkout", "-q", "-b", "elsewhere"]);
    git(w.fx.project, ["worktree", "add", "-q", dev, "develop"]);
    const before = snapshot(w, dev);
    const r = await w.pass();
    assert.deepEqual(retiredPaths(r), []);
    assert.equal(heldOf(r, dev), undefined);
    assert.equal(waitingOf(r, dev), undefined);
    assert.deepEqual(snapshot(w, dev), before);
  });

  test("a message to a chat whose ledger entry names a protected branch: that branch is left alone", async () => {
    const w = world();
    git(w.fx.project, ["branch", "main", w.fx.target]);
    const path = join(w.fx.parent, ".worktrees", "demo-prot");
    const tip = git(w.fx.project, ["rev-parse", "main"]);
    w.deps.appendLedger([{ v: 1, path, branch: "main", commonDir: canonical(join(w.fx.project, ".git")), tip, merged: "ancestor", branchDeleted: false, at: 1, retired: true, pinned: true }]);
    const r = await bringBack(w.deps, path);
    assert.equal(r.state, "failed", JSON.stringify(r));
    assert.ok(git(w.fx.project, ["branch", "--list", "main"]).includes("main"));
  });
});

// ---------------------------------------------------------------- an edit git has been told not to look at

describe("an edit hidden from git status", () => {
  for (const flag of ["--skip-worktree", "--assume-unchanged"])
    test(`${flag} on a landed branch: retireTree holds for its files, and the edit survives`, async () => {
      const w = world();
      const b = finished(w, "hidden");
      const f = join(b.checkout, "README.md");
      const was = readFileSync(f, "utf8");
      git(b.checkout, ["update-index", flag, "README.md"]);
      writeFileSync(f, `${was}an edit only here\n`);
      assert.equal(git(b.checkout, ["status", "--porcelain"]), "", "the control: git status really doesn't show it, so it can't be what holds");
      const before = snapshot(w, b.checkout, { pins: "ignore" });
      const r = await retireTree(w.deps, w.fx.project, b.checkout);
      assert.equal(r.state, "held", JSON.stringify(r));
      assert.equal(r.state === "held" && r.row.kind, "files", JSON.stringify(r));
      assert.equal(readFileSync(f, "utf8"), `${was}an edit only here\n`, "the edit survives");
      assert.deepEqual(snapshot(w, b.checkout, { pins: "ignore" }), before, "nothing else changed");
      git(b.checkout, ["update-index", flag.replace("--", "--no-"), "README.md"]);
      writeFileSync(f, was);
      assert.deepEqual(retiredPaths(await w.pass()), [b.checkout], "the flag was the reason: cleared, it goes");
    });
});

describe("a drafts folder only the proof can clear", () => {
  test("a dot-folder under drafts: the proof never names it, so a finished tree holds, with the note kept", async () => {
    const w = world();
    await w.fx.withSpec();
    const b = finished(w, "dotdraft");
    put(b.checkout, ".sova/spec/drafts/.old/note.md", "only here\n");
    const r = await retireTree(w.deps, w.fx.project, b.checkout);
    assert.equal(r.state, "held", JSON.stringify(r));
    assert.equal(readFileSync(join(b.checkout, ".sova/spec/drafts/.old/note.md"), "utf8"), "only here\n");
  });

  // The classifier and the proof read at different moments: a draft whose proof fails by the time it's asked must not go on the classifier's word.
  for (const [name, say] of [
    ["the proof names it unproved", async () => ["provedraft"]],
    ["the proof can't be read", async () => { throw new Error("no answer"); }],
  ] as [string, () => Promise<string[]>][])
    test(`the classifier saw nothing left, but ${name} right before the removal: held, the draft kept`, async () => {
      const w = world();
      await w.fx.withSpec();
      const b = w.fx.branch("provedraft", { "e.txt": "e\n" });
      w.fx.draft(b.checkout, "provedraft");
      w.deps.draftsUnproved = say;
      w.deps.classify = (root, only) => classifyRepo(root, { git: execGit, withQueueMade: true, left: async (o) => ({ ...(await branchLeft(o)), drafts: [], whole: "nothing", codeOnly: "nothing", nothingLeft: true }), ...(only ? { only } : {}) });
      git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
      const r = await retireTree(w.deps, w.fx.project, b.checkout);
      assert.equal(r.state, "held", JSON.stringify(r));
      assert.equal(r.state === "held" && r.row.kind, "drafts", JSON.stringify(r));
      assert.ok(existsSync(join(b.checkout, ".sova/spec/drafts/provedraft/draft.json")));
    });

  test("the control: a draft the queue landed, proved by the same reading, goes with the folder", async () => {
    const w = world();
    await w.fx.withSpec();
    const b = w.fx.branch("provedraft", { "e.txt": "e\n" });
    w.fx.draft(b.checkout, "provedraft");
    const draftJson = join(b.checkout, ".sova/spec/drafts/provedraft/draft.json");
    const drafts = w.deps.draftsUnproved;
    // Stands in for the shared proof, which tests elsewhere pin (landed-branch-agreement): only the reading of this file is at issue.
    w.deps.draftsUnproved = async (main, folder, branch) => (existsSync(draftJson) ? [] : drafts(main, folder, branch));
    w.deps.classify = (root, only) => classifyRepo(root, { git: execGit, withQueueMade: true, left: async (o) => ({ ...(await branchLeft(o)), drafts: [], whole: "nothing", codeOnly: "nothing", nothingLeft: true }), ...(only ? { only } : {}) });
    git(w.fx.project, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    const r = await retireTree(w.deps, w.fx.project, b.checkout);
    assert.equal(r.state, "retired", JSON.stringify(r));
    assert.equal(existsSync(b.checkout), false);
  });
});

// ---------------------------------------------------------------- the first pass's report

type ReportRow = { path: string; branch?: string; reason?: string; [k: string]: unknown };
type Groups = Record<string, ReportRow[]>;
const reportOf = (w: World) => JSON.parse(readFileSync(w.firstPassPath, "utf8")) as { done?: boolean; list: { path: string; branch: string }[]; groups: Groups; repos: Record<string, Groups> };
/** Everywhere a path is placed, in every repository of the report: a count over one repository can't see it placed twice. */
const placedIn = (w: World, path: string) => {
  const r = reportOf(w);
  const inRepos = Object.entries(r.repos ?? {}).flatMap(([repo, groups]) => Object.entries(groups).flatMap(([group, rows]) => rows.filter((x) => x.path === path).map((x) => ({ repo, group, reason: x.reason }))));
  const inGroups = Object.entries(r.groups).flatMap(([group, rows]) => rows.filter((x) => x.path === path).map(() => group));
  assert.deepEqual([...inGroups].sort(), inRepos.map((x) => x.group).sort(), "the report's two views of it agree");
  return inRepos;
};

describe("a repository with the same history as another", () => {
  /** A copy of the project sharing its history, as `cp -a` makes one. */
  const sibling = (w: World, name = "demo-old") => {
    const sib = join(w.fx.parent, name);
    cpSync(w.fx.project, sib, { recursive: true, verbatimSymlinks: true });
    return sib;
  };
  /** A repository sharing nothing with the project: the control. */
  const unrelated = (w: World) => {
    const other = join(w.fx.parent, "demo-other");
    mkdirSync(other, { recursive: true });
    git(other, ["init", "-q", "-b", "master"]);
    writeFileSync(join(other, "a.txt"), "another project\n");
    git(other, ["add", "a.txt"]);
    git(other, ["commit", "-q", "-m", "first of another project"]);
    return other;
  };
  const inBothOrders = (name: string, body: (first: (w: World, b: string) => void) => Promise<void>) => {
    for (const [order, list] of [["the owner first", (w: World, o: string) => [w.fx.project, o]], ["the other first", (w: World, o: string) => [o, w.fx.project]]] as const)
      test(`${name} (${order})`, () => body((w, other) => (w.deps.repos = () => list(w, other))));
  };

  // Both spellings of the copy: which repository's path sorts first decides who could claim a doubt, so a copy that sorts first must be the one to skip it.
  for (const [what, make] of [["a copy with the same history", sibling], ["a copy with the same history, sorting before its owner", (w: World) => sibling(w, "0-demo")], ["the control, a repository with no shared history", unrelated]] as const) {
    inBothOrders(`${what}: a live worktree with work of its own lands in its owner's group only`, async (setRepos) => {
      const w = world();
      const other = make(w);
      const b = w.fx.branch("feat", { "w.txt": "work\n" });
      w.record(b.checkout, b.branch);
      setRepos(w, other);
      const before = snapshot(w, b.checkout);
      await w.pass();
      assert.deepEqual(snapshot(w, b.checkout), before, "nothing of it changed");
      assert.deepEqual(placedIn(w, b.checkout).map((x) => [x.repo, x.group]), [[w.fx.project, "hasWork"]], JSON.stringify(placedIn(w, b.checkout)));
      assert.ok(!placedIn(w, b.checkout).some((x) => /\.git/.test(x.reason ?? "")), "and never as something left behind holding a .git");
    });

    inBothOrders(`${what}: a finished worktree retires, once, and only its owner reports it`, async (setRepos) => {
      const w = world();
      const other = make(w);
      const b = finished(w, "done");
      w.record(b.checkout, b.branch);
      setRepos(w, other);
      await w.pass();
      assert.deepEqual(placedIn(w, b.checkout).map((x) => [x.repo, x.group]), [[w.fx.project, "retired"]], JSON.stringify(placedIn(w, b.checkout)));
      assert.equal(existsSync(b.checkout), false);
      assert.equal(w.ledger().filter((e) => e.path === b.checkout).length, 1);
    });
  }

  inBothOrders("a folder with no .git, on a record two repositories could both own: a doubt holds or skips, and removes nothing", async (setRepos) => {
    const w = world();
    const other = sibling(w);
    const p = join(w.fx.parent, ".worktrees", "demo-left");
    put(p, "node_modules/a.js", "x\n");
    w.record(p, "feat/gone");
    setRepos(w, other);
    const before = filesOf(p);
    await w.pass();
    assert.deepEqual(filesOf(p), before, "the folder stays, every file");
    assert.equal(w.ledger().filter((e) => e.path === p).length, 0, "no removal recorded");
    const places = placedIn(w, p);
    assert.deepEqual(places.map((x) => x.group), ["held"], `one repository holds it, the other skips it: ${JSON.stringify(places)}`);
    const row = reportOf(w).repos[places[0]!.repo]!.held!.find((x) => x.path === p)!;
    assert.equal(row.branch, undefined, "with no branch: it may mean something else in either");
    assert.match(places[0]!.reason ?? "", /shares this one's history/);
  });

  inBothOrders("a same-named branch of the other repository's: the record isn't that repository's, so that branch and its commit stay", async (setRepos) => {
    const w = world();
    const other = sibling(w);
    const b = finished(w, "same");
    // The copy's own branch of that name: its own commit, on its own target, so it reads as finished to it.
    git(other, ["checkout", "-q", "-b", b.branch]);
    writeFileSync(join(other, "own.txt"), "the copy's own work\n");
    git(other, ["add", "own.txt"]);
    git(other, ["commit", "-q", "-m", "the copy's own commit"]);
    git(other, ["checkout", "-q", w.fx.target]);
    git(other, ["merge", "-q", "--no-ff", "--no-edit", b.branch]);
    const ownCommit = git(other, ["rev-parse", b.branch]);
    assert.notEqual(ownCommit, b.commit);
    git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
    put(b.checkout, "node_modules/a.js", "x\n");
    w.record(b.checkout, b.branch);
    setRepos(w, other);
    const before = filesOf(b.checkout);
    await w.pass();
    assert.equal(git(other, ["rev-parse", b.branch]), ownCommit, "its branch stays at its commit");
    assert.equal(git(other, ["cat-file", "-t", ownCommit]), "commit");
    assert.deepEqual(filesOf(b.checkout), before, "and with two possible owners the folder isn't anyone's to delete");
    assert.equal(git(w.fx.project, ["rev-parse", b.branch]), b.commit, "the project's own branch stays too");
    assert.equal(w.ledger().filter((e) => e.path === b.checkout).length, 0);
  });

  describe("a leftover with no .git that only a chat's record names", () => {
    const left = (w: World, name: string) => {
      const b = finished(w, name);
      git(w.fx.project, ["worktree", "remove", "--force", b.checkout]);
      put(b.checkout, "node_modules/a.js", "x\n");
      return b;
    };

    test("the folder goes, but no branch of that name is touched, even with one repository able to own it and the setting on", async () => {
      const w = world();
      const other = unrelated(w);
      const b = left(w, "recordonly");
      w.record(b.checkout, b.branch);
      w.deps.repos = () => [other, w.fx.project];
      const before = git(w.fx.project, ["for-each-ref", "refs/heads"]);
      await w.pass();
      assert.equal(existsSync(b.checkout), false, "the folder goes");
      assert.equal(git(w.fx.project, ["for-each-ref", "refs/heads"]), before, "every branch stays where it was");
      assert.deepEqual(w.writes.filter((x) => deletesBranch(x.args)).map((x) => x.args.join(" ")), [], "no delete was sent");
      assert.equal(w.ledger().at(-1)!.tip, "", "and the ledger records no last commit for it, so nothing later treats that branch as this folder's");
    });

    test("its chat's next message doesn't attach to that branch: the branch is left where it was", async () => {
      const w = world();
      const b = left(w, "recordchat");
      w.record(b.checkout, b.branch);
      await w.pass();
      const r = await bringBack(w.deps, b.checkout);
      assert.deepEqual(w.writes.filter((x) => verbOf(x.args)[0] === "worktree" && verbOf(x.args)[1] === "add" && !x.args.includes("-b")).map((x) => x.args.join(" ")), [], `no folder comes back on a branch it never proved: ${JSON.stringify(r)}`);
      assert.equal(git(w.fx.project, ["rev-parse", b.branch]), b.commit, "the same-named branch didn't move");
    });

    test("that removal's ledger line isn't evidence later: the same folder left again doesn't take the branch either", async () => {
      const w = world();
      const b = left(w, "relic");
      w.record(b.checkout, b.branch);
      await w.pass();
      assert.equal(git(w.fx.project, ["rev-parse", b.branch]), b.commit, "the control: the first removal left it");
      put(b.checkout, "node_modules/b.js", "again\n");
      await w.pass();
      assert.equal(existsSync(b.checkout), false, "the folder goes again");
      assert.equal(git(w.fx.project, ["rev-parse", b.branch]), b.commit, "and the branch still stays");
    });

    test("the control: the same leftover, proved this repository's by its own ledger entry, does lose its branch with the setting on", async () => {
      const w = world();
      const other = unrelated(w);
      const b = left(w, "proved");
      provedOurs(w, b.checkout, b.branch, b.commit);
      w.record(b.checkout, b.branch);
      w.deps.repos = () => [other, w.fx.project];
      await w.pass();
      assert.equal(existsSync(b.checkout), false);
      assert.equal(git(w.fx.project, ["branch", "--list", b.branch]), "", "so the rule above can't pass by never deleting");
      assert.equal(git(w.fx.project, ["rev-parse", `refs/sova/retired/${b.commit}`]), b.commit);
    });
  });
});

describe("a restart in the middle of the first pass", () => {
  const child = join(import.meta.dirname, "worktree-retire-kill.integration.fixture.ts");
  /** Three finished trees (each with what the report lists), one holding work, one with commits of its own. */
  function setup() {
    const w = world();
    const gone = ["alpha", "bravo", "charlie"].map((n) => {
      const b = finished(w, n);
      excluded(b, ".agent");
      put(b.checkout, ".agent/auth.json", "{}\n");
      return b;
    });
    const held = finished(w, "held");
    writeFileSync(join(held.checkout, "wip.txt"), "only here\n");
    const work = w.fx.branch("work", { "w.txt": "w\n" });
    return { w, gone, held, work };
  }
  /** A real process, killed by SIGKILL right after the nth removal is recorded. */
  const killedAfter = async (w: World, n: number) => {
    const c = spawn(process.execPath, [child, w.fx.project, w.fx.target, w.fx.state, `after-ledger-${n}`], { stdio: "ignore" });
    children.push(c);
    await until(() => c.exitCode !== null || c.signalCode !== null, "the child to stop");
    assert.equal(c.signalCode, "SIGKILL", "it died where the test said, not by finishing");
  };
  /** The report with what changes between two equal worlds taken out: their temp roots, and each commit's hash. */
  const comparable = (w: World) => {
    const r = reportOf(w);
    const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "tip" ? undefined : typeof x === "string" ? x.replaceAll(w.fx.root, "<root>") : x)));
    const sorted = (rows: ReportRow[]) => [...rows].sort((a, b) => a.path.localeCompare(b.path));
    return { groups: Object.fromEntries(Object.entries(r.groups).map(([k, rows]) => [k, clean(sorted(rows))])), repos: Object.keys(r.repos).length, listed: clean([...r.list].map((x) => x.path).sort()) };
  };
  const unbroken = async () => {
    const { w } = setup();
    await w.pass();
    return comparable(w);
  };
  const eachInOneGroup = (w: World, paths: readonly string[]) => {
    for (const p of paths) assert.equal(placedIn(w, p).length, 1, `${p}: ${JSON.stringify(placedIn(w, p))}`);
  };

  for (const n of [1, 2])
    test(`stopped right after removal ${n} of 3 is recorded: the report matches an uninterrupted pass, each tree in one group, what went listed`, async () => {
      const want = await unbroken();
      const { w, gone, held, work } = setup();
      await killedAfter(w, n);
      assert.ok(w.ledger().length >= n, "the removal really was recorded before the stop");
      await w.pass();
      assert.deepEqual(comparable(w), want);
      eachInOneGroup(w, [...gone.map((b) => b.checkout), held.checkout, work.checkout]);
      const retired = reportOf(w).groups.retired!;
      assert.deepEqual(retired.map((x) => x.path).sort(), gone.map((b) => b.checkout).sort());
      for (const row of retired) assert.ok(JSON.stringify(row.testCopy ?? {}).includes("auth.json"), `what went from ${row.path} is listed: ${JSON.stringify(row)}`);
    });

  test("stopped between two repositories: the report over both matches an uninterrupted pass", async () => {
    const twoRepos = () => {
      const { w, gone } = setup();
      const other = join(w.fx.parent, "demo-other");
      mkdirSync(other, { recursive: true });
      git(other, ["init", "-q", "-b", "master"]);
      writeFileSync(join(other, "a.txt"), "another project\n");
      git(other, ["add", "a.txt"]);
      git(other, ["commit", "-q", "-m", "first"]);
      const otherTree = join(w.fx.parent, ".worktrees", "demo-other-x");
      git(other, ["worktree", "add", "-q", "-b", "feat/x", otherTree]);
      writeFileSync(join(otherTree, "x.txt"), "x\n");
      git(otherTree, ["add", "x.txt"]);
      git(otherTree, ["commit", "-q", "-m", "x"]);
      git(other, ["merge", "-q", "--no-ff", "--no-edit", "feat/x"]);
      w.deps.repos = () => [w.fx.project, other];
      return { w, gone, other, otherTree };
    };
    const base = twoRepos();
    await base.w.pass();
    const want = comparable(base.w);
    const { w, gone, other, otherTree } = twoRepos();
    // A kill after every removal of the first repository is recorded: its report isn't written, and the second is yet to be read.
    const c = spawn(process.execPath, [child, w.fx.project, w.fx.target, w.fx.state, "after-ledger-3", other], { stdio: "ignore" });
    children.push(c);
    await until(() => c.exitCode !== null || c.signalCode !== null, "the child to stop");
    assert.equal(c.signalCode, "SIGKILL", "it died where the test said");
    await w.pass();
    assert.deepEqual(comparable(w), want);
    eachInOneGroup(w, [...gone.map((b) => b.checkout), otherTree]);
  });

  test("stopped twice in a row: the report still matches", async () => {
    const want = await unbroken();
    const { w, gone, held, work } = setup();
    await killedAfter(w, 1);
    await killedAfter(w, 1);
    await w.pass();
    assert.deepEqual(comparable(w), want);
    eachInOneGroup(w, [...gone.map((b) => b.checkout), held.checkout, work.checkout]);
  });
});

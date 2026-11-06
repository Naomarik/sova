/**
 * Tests only: a real project repository (main checkout on its target, a bare origin, branch worktrees) and a stand-in
 * run that makes REAL merge commits with git (merge-tree + commit-tree, nothing written to any work tree), so the
 * queue's own logic (line, landing, push, recovery, guards) runs on real git. The run's verdict is scripted per call.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeEntry, MergeQueueView } from "../../../shared/merge-queue";
import type { ProjectDef } from "../../../shared/project-contract";
import { NO_BACKGROUND_CLEANUP } from "../../git-no-background";
import { scratchRoot } from "../../test-scratch";
import type { RunInput, RunMerge, RunOutcome, ThreadEvent } from "../contract";
import type { MergeNoticeKind } from "../notices";
import { MergeQueues, type ProjectQueue, type QueueDeps } from "../queue";

const IDENT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };

/**
 * Git as the kit runs it: starting no background cleanup, as the server's own commits don't. A `git commit` otherwise
 * starts `git maintenance run --auto --detach`, whose repack (Git 2.54: `repack -d --cruft --write-midx`, once a commit
 * leaves enough loose objects) runs on under the test's next writes and reads in the same object store and can lose
 * objects outright (fsck: missing commit), so the queue's reads fail for good ("bad object").
 */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...NO_BACKGROUND_CLEANUP, ...args], { cwd, env: { ...process.env, ...IDENT }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function tryGit(cwd: string, ...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: sh(cwd, ...args) };
  } catch (err) {
    return { code: (err as { status?: number }).status ?? 1, out: String((err as { stdout?: string }).stdout ?? "") };
  }
}

export interface Repo {
  scratch: string;
  root: string;
  origin: string;
  state: string;
  target: string;
  /** A branch worktree with one commit writing `file` = `text`. Returns its path and head. */
  branch(name: string, files: Record<string, string>, opts?: { message?: string }): { path: string; head: string };
  commitOn(path: string, files: Record<string, string>, message?: string): string;
  head(ref?: string): string;
  done(): void;
}

export function makeRepo(opts: { target?: string; prefix?: string } = {}): Repo {
  const scratch = scratchRoot(opts.prefix ?? "mq-unit-");
  const target = opts.target ?? "master";
  const root = join(scratch, "proj");
  const origin = join(scratch, "origin.git");
  const state = join(scratch, "state");
  mkdirSync(root, { recursive: true });
  mkdirSync(state, { recursive: true });
  sh(scratch, "init", "-q", "--bare", "-b", target, origin);
  sh(root, "init", "-q", "-b", target);
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "list.txt"), "alpha\nbeta\n");
  sh(root, "add", ".");
  sh(root, "commit", "-q", "-m", "base");
  sh(root, "remote", "add", "origin", origin);
  sh(root, "push", "-q", "origin", target);
  const commitOn = (path: string, files: Record<string, string>, message = "change") => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(join(path, f, ".."), { recursive: true });
      writeFileSync(join(path, f), t);
    }
    sh(path, "add", "-A");
    sh(path, "commit", "-q", "-m", message);
    return sh(path, "rev-parse", "HEAD");
  };
  return {
    scratch,
    root,
    origin,
    state,
    target,
    branch(name, files, o = {}) {
      const path = join(scratch, ".worktrees", `proj-${name.replace(/\//g, "-")}`);
      sh(root, "worktree", "add", "-q", "-b", name, path, target);
      const head = commitOn(path, files, o.message ?? `work on ${name}`);
      return { path, head };
    },
    commitOn,
    head: (ref = target) => sh(root, "rev-parse", ref),
    done: () => rmSync(scratch, { recursive: true, force: true }),
  };
}

/** A real merge of `commit` onto `base` in the object store: the merge commit, or the conflicted files. */
export function realMerge(root: string, base: string, commit: string): { tip: string } | { conflict: string[] } {
  const r = tryGit(root, "merge-tree", "--write-tree", "--name-only", "--no-messages", base, commit);
  const lines = r.out.split("\n").filter(Boolean);
  if (r.code === 1) return { conflict: lines.slice(1) };
  if (r.code !== 0) throw new Error(`merge-tree failed: ${r.out}`);
  const tip = sh(root, "commit-tree", lines[0]!, "-p", base, "-p", commit, "-m", "Merge");
  return { tip };
}

export type Script = (input: RunInput, merged: { tip: string } | { conflict: string[] }) => Partial<RunOutcome> | Promise<Partial<RunOutcome>>;

/** The stand-in run: merges for real, then answers what `script` says (default: passed). Records every input. */
interface StandIn {
  run: RunMerge;
  inputs: RunInput[];
  script: Script | null;
  set(s: Script | null): void;
}
export function standInRun(): StandIn {
  const kit: StandIn = {
    inputs: [] as RunInput[],
    script: null as Script | null,
    set(s: Script | null) {
      kit.script = s;
    },
    run: (async (input, hooks) => {
      kit.inputs.push(input);
      hooks.step({ id: "copy", kind: "copy", label: "Copy", result: "passed", ms: 1, log: "logs/01-copy.log" });
      const merged = input.resolution ? { tip: input.resolution } : realMerge(input.project.root, input.base, input.commit);
      const extra: Partial<RunOutcome> = kit.script ? await kit.script(input, merged) : {};
      if (input.signal.aborted) return { verdict: "void", notes: [], checks: [] };
      if ("conflict" in merged && !extra.verdict) return { verdict: "conflict", conflict: { files: merged.conflict }, notes: [], checks: [] };
      const tip = "tip" in merged ? merged.tip : undefined;
      return { verdict: "passed", ...(tip ? { tip, mergeSha: tip } : {}), notes: [], checks: [], ...extra };
    }) as RunMerge,
  };
  return kit;
}

/** Waits on the signal (a run that only ends when voided). */
export const untilAborted = (input: RunInput): Promise<Partial<RunOutcome>> =>
  new Promise((done) => {
    if (input.signal.aborted) return done({ verdict: "void" });
    input.signal.addEventListener("abort", () => done({ verdict: "void" }));
  });

export async function until<T>(f: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const DEF = { version: 1, merge: { checks: [{ id: "unit", label: "Unit tests", run: ["true"], timeout: 60, rerun: false, requires: [] }, { id: "statecharts", label: "Statecharts", run: ["true"], timeout: 60, rerun: false, requires: [] }] } } as unknown as ProjectDef;

export interface Kit {
  repo: Repo;
  queues: MergeQueues;
  run: ReturnType<typeof standInRun>;
  notices: { kind: MergeNoticeKind; branch: string; session?: string }[];
  thread: ThreadEvent[];
  views: MergeQueueView[];
  q(): Promise<ProjectQueue>;
  entry(id: string): Promise<MergeEntry>;
  done(): Promise<void>;
}

export function makeKit(o: { repo?: Repo; deps?: Partial<QueueDeps>; threadAnswers?: boolean; checks?: "declared" | "test-command" | "none" | "unset" } = {}): Kit {
  const repo = o.repo ?? makeRepo();
  const run = standInRun();
  const notices: Kit["notices"] = [];
  const thread: ThreadEvent[] = [];
  const views: MergeQueueView[] = [];
  const queues = new MergeQueues({
    base: join(repo.state, "merge-queue"),
    runMerge: run.run,
    checksOf: () => o.checks ?? "declared",
    definitionAt: async () => ({ def: DEF, error: null }),
    // "approved" raises the chat's card (cards.test.ts); the notices here are what reaches the chat after it.
    notify: (kind, e) => void (kind !== "approved" && notices.push({ kind, branch: e.branch, ...(e.session ? { session: e.session } : {}) })),
    thread: (ev) => {
      thread.push(ev);
      return o.threadAnswers ?? false;
    },
    publish: (v) => views.push(v),
    draftsHash: () => undefined,
    retryDelayMs: 40,
    watchMs: 25,
    conflictWaitMs: 60_000,
    legacyNames: { root: repo.root, file: join(repo.state, "merge-round.json") },
    log: () => {},
    ...o.deps,
  });
  // Pushes are held without a names file: the plain cases have one.
  writeFileSync(join(repo.state, "merge-round.json"), JSON.stringify({ v: 1, privateNames: [] }));
  const kit: Kit = {
    repo,
    queues,
    run,
    notices,
    thread,
    views,
    q: () => queues.get(repo.root),
    async entry(id) {
      const e = (await kit.q()).entry(id);
      if (!e) throw new Error(`no entry ${id}`);
      return e;
    },
    async done() {
      await queues.stop();
      if (!o.repo) repo.done();
    },
  };
  return kit;
}

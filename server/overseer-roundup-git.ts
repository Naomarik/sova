import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionReadiness, SessionSummary } from "../shared/protocol";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";
import { canonical } from "../pi-config/extensions/worktrees/state.ts";
import { cut } from "./session-guards";

/**
 * The roundup's own git reads (§app.overseer/roundup): squash landings and a session's launch
 * worktree, which merge readiness doesn't track. Every read is read-only (no optional locks, no
 * fsmonitor) and goes through an injected `git`, so tests stub it.
 */

export interface RoundupIO {
  git: Git;
  exists(path: string): boolean;
  /** The last `max` bytes of a file as text ("" when it can't be read). */
  readTail(path: string, max: number): Promise<string>;
}

export const realRoundupIO: RoundupIO = {
  git: runGit,
  exists: existsSync,
  async readTail(path, max) {
    try {
      const { size } = await stat(path);
      const fh = await open(path, "r");
      try {
        const len = Math.min(size, max);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, size - len);
        return buf.toString("utf8", 0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return "";
    }
  },
};

/** How much of a transcript the lost-work check reads (its newest part). */
export const TRANSCRIPT_SCAN = 8 * 1024 * 1024;
/** Commit ids it tries at most (the newest named). */
const MAX_TOKENS = 2000;
/** How far either side of a branch's name the named-commits check looks for commit ids. */
const NEAR_BRANCH = 300;
/** Main-branch subjects the no-record check reads. */
const SUBJECTS = 5000;

/** Sessions whose git the roundup reads at once. */
const POOL = 8;

/** Flags every roundup git call starts with: read-only, and paths taken literally (a file name from
    `git status` is never pathspec magic or a glob). */
export const RO = ["-c", "core.fsmonitor=false", "--no-optional-locks", "--literal-pathspecs"];

/** Thrown by a stopped reader's io: the roundup's deadline passed, so no new read starts. */
class Halted extends Error {}
const unlessHalted = (e: unknown): null => {
  if (e instanceof Halted) throw e;
  return null;
};

async function out(io: RoundupIO, args: string[], cwd: string): Promise<string | null> {
  const r = await io.git([...RO, ...args], cwd).catch((e) => {
    if (e instanceof Halted) throw e;
    return null;
  });
  return r && r.code === 0 ? r.stdout : null;
}
const lines = (s: string | null) => (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** A repository's main branch as the roundup reads it: once per (repository, main commit). */
export interface RepoView {
  top: string;
  main: string;
  mainSha: string;
  /** Trees of the main branch's commits of the last 30 days. */
  trees: Set<string>;
  /** Subjects of its last SUBJECTS commits. */
  subjects: Subject[];
}

/** A local branch: tip and tree. */
type Refs = Map<string, { sha: string; tree: string }>;

/** A launch worktree's folder, repository and name (§app.project-overseer/coding-worktrees). */
export interface LaunchPlace {
  top: string;
  name: string;
  folder: string;
}

/** `<parent>/.worktrees/<repo>-<name>[/…]` with `<parent>/<repo>` a git checkout (the longest such
    repo name), or null. */
export function launchPlaceOf(cwd: string, exists: (p: string) => boolean): LaunchPlace | null {
  const at = cwd.indexOf("/.worktrees/");
  if (at < 0) return null;
  const parent = cwd.slice(0, at);
  const folderName = cwd.slice(at + "/.worktrees/".length).split("/")[0];
  if (!folderName) return null;
  const parts = folderName.split("-");
  for (let i = parts.length - 1; i >= 1; i--) {
    const repo = parts.slice(0, i).join("-");
    if (exists(join(parent, repo, ".git"))) return { top: join(parent, repo), name: parts.slice(i).join("-"), folder: join(parent, ".worktrees", folderName) };
  }
  return null;
}

/** A main-branch commit's subject. */
export interface Subject {
  sha: string;
  s: string;
}

/** The main commits whose subject names `branch` as a whole word (bounded by the start or end, a
    space, a quote, a parenthesis, `@` or `:`; `refs/heads/` allowed before it), newest first, each
    with the tip prefix written after it as `<branch> @ <sha>`, if any. */
export function subjectsNaming(subjects: readonly Subject[], branch: string): { sha: string; tip?: string }[] {
  const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[\\s'"()@:])(?:refs/heads/)?${esc}(?=$|[\\s'"()@:])(?:\\s*@\\s*([0-9a-f]{7,40})\\b)?`);
  const out: { sha: string; tip?: string }[] = [];
  for (const x of subjects) {
    const m = re.exec(x.s);
    if (m) out.push({ sha: x.sha, ...(m[1] ? { tip: m[1] } : {}) });
  }
  return out;
}

/** Whether a main subject names `branch` (for a branch that no longer exists: it landed). */
export const subjectRecordsMerge = (subjects: readonly (Subject | string)[], branch: string): boolean =>
  subjectsNaming(subjects.map((x) => (typeof x === "string" ? { sha: "", s: x } : x)), branch).length > 0;

/** What main's subjects say of a branch: with no tip (the branch is gone) any naming has landed; with
    one, only `<branch> @ <tip prefix>` has, and the name alone is the newest commit naming it. */
export function nameCheck(subjects: readonly Subject[], branch: string, tip?: string): "landed" | { named: string } | null {
  const hits = subjectsNaming(subjects, branch);
  if (!hits.length) return null;
  if (!tip || hits.some((h) => h.tip && tip.startsWith(h.tip))) return "landed";
  return { named: hits[0]!.sha.slice(0, 8) };
}

/** The paths in `git status --porcelain=v1 -z` output (a rename's or copy's destination). */
export function dirtyPaths(z: string): string[] {
  const parts = z.split("\0");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return out;
}

const numstatLines = (s: string | null) =>
  lines(s).reduce((n, l) => {
    const [a, d] = l.split("\t");
    return n + (/^\d+$/.test(a ?? "") ? Number(a) : 0) + (/^\d+$/.test(d ?? "") ? Number(d) : 0);
  }, 0);

/** Most uncommitted files a superseded check names. */
const MAX_FILES = 500;

/** Files in `git status --porcelain=v1 -z` output (a rename's or copy's source path not counted). */
export function dirtyCount(z: string): number {
  const parts = z.split("\0");
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    n++;
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return n;
}

/** One merge-relevant fact the roundup adds or takes away, per session. */
export interface LaunchRow {
  bucket: "lost" | "at-risk" | "built" | "uncommitted" | "unconfirmed";
  branch: string;
  text: string;
  /** For a Lost row: what names the branch in another session's messages (its 6 hex digits, and a
      word of its name). */
  find?: { hex: string; words: string[] };
}

/** An uncommitted-only worktree against main: "main" when its files are mostly on main already. */
export type Superseded = "main" | { hedge?: string };

export interface GitFacts {
  /** Tracked worktree rows whose content is on the main branch: `${path}\0${branch}`. */
  landed: Set<string>;
  /** Rows the roundup adds for a session's launch worktree, by session path. */
  launch: Map<string, LaunchRow>;
  /** Launch worktrees found landed (counted with `landed`). */
  launchLanded: number;
  /** Sessions whose git read didn't finish in time. */
  unfinished: Set<string>;
  /** Tracked rows whose branch main's subjects name without its tip: the newest such main commit. */
  named: Map<string, string>;
  /** Tracked uncommitted-only rows against main. */
  uncommitted: Map<string, Superseded>;
  /** Launch worktrees with uncommitted files mostly on main (counted with tracked ones). */
  launchMostly: number;
  /** Sessions whose launch worktree has nothing outstanding (merged, landed, or nothing of its own). */
  launchSettled: Set<string>;
  /** Branches a session's final ask names that are on main: `${session path}\0${branch}`. */
  onMain: Set<string>;
  /** Gone tracked branches whose commits the transcript names beside them are all on main, with main's name. */
  namedOnMain: Map<string, string>;
}

export const landedKey = (path: string, branch: string) => `${canonicalLoose(path)}\0${branch}`;

function canonicalLoose(p: string): string {
  try {
    return canonical(p);
  } catch {
    return p;
  }
}

/** The roundup's git reader. Repository views are kept per (repository, main commit). */
export class RoundupGit {
  private views = new Map<string, RepoView>();
  constructor(private io: RoundupIO = realRoundupIO) {}

  /** This reader over an io that throws Halted once `stopped()` says so, sharing its views. */
  private stoppable(stopped: () => boolean): RoundupGit {
    const io = this.io;
    const check = () => {
      if (stopped()) throw new Halted();
    };
    const g = new RoundupGit({
      git: async (args, cwd) => (check(), io.git(args, cwd)),
      exists: (p) => io.exists(p),
      readTail: async (p, max) => (check(), io.readTail(p, max)),
    });
    g.views = this.views;
    return g;
  }

  /** The main branch (the root checkout's) and its trees and subjects, or null when git can't say. */
  async view(top: string): Promise<RepoView | null> {
    const main = lines(await out(this.io, ["symbolic-ref", "--quiet", "--short", "HEAD"], top))[0];
    if (!main) return null;
    const mainSha = lines(await out(this.io, ["rev-parse", "--verify", "--quiet", `refs/heads/${main}^{commit}`], top))[0];
    if (!mainSha) return null;
    const key = `${top}\0${mainSha}`;
    const hit = this.views.get(key);
    if (hit) return hit;
    const trees = new Set(lines(await out(this.io, ["log", "--since=30.days", "--format=%T", mainSha], top)));
    const subjects = lines(await out(this.io, ["log", "-n", String(SUBJECTS), "--format=%H%x09%s", mainSha], top)).map((l) => {
      const i = l.indexOf("\t");
      return { sha: l.slice(0, i), s: l.slice(i + 1) };
    });
    const v: RepoView = { top, main, mainSha, trees, subjects };
    for (const k of this.views.keys()) if (k.startsWith(`${top}\0`)) this.views.delete(k);
    this.views.set(key, v);
    return v;
  }

  async refs(top: string): Promise<Refs> {
    const m: Refs = new Map();
    for (const l of lines(await out(this.io, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(tree)", "refs/heads"], top))) {
      const [name, sha, tree] = l.split("\t");
      if (name && sha && tree) m.set(name, { sha, tree });
    }
    return m;
  }

  /** Commits of local branches whose tree is on main (a squash landing) and which aren't on main
      themselves: a branch inside one of them has landed. */
  async landedCommits(v: RepoView, refs: Refs): Promise<Set<string>> {
    const set = new Set<string>();
    for (const [, r] of refs) {
      if (!v.trees.has(r.tree) || r.sha === v.mainSha) continue;
      const anc = await this.io.git([...RO, "merge-base", "--is-ancestor", r.sha, v.mainSha], v.top).catch(unlessHalted);
      if (!anc || anc.code === 0) continue;
      for (const c of lines(await out(this.io, ["rev-list", "-n", "10000", r.sha, `^${v.mainSha}`], v.top))) set.add(c);
    }
    return set;
  }

  /** The newest commit a transcript names that git has and main lacks, with what the Lost row says;
      "merged" when every commit it names is on main; null when it names none git has. */
  async lostCommit(v: RepoView, transcript: string, landed: Set<string>): Promise<{ sha: string; at: number; subject: string; past: number } | "merged" | "landed" | null> {
    const seen = new Set<string>();
    const all = transcript.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
    const tokens: string[] = [];
    for (let i = all.length - 1; i >= 0 && tokens.length < MAX_TOKENS; i--) {
      const t = all[i]!;
      if (seen.has(t) || !/[a-f]/.test(t) || !/\d/.test(t)) continue;
      seen.add(t);
      tokens.push(t);
    }
    if (!tokens.length) return null;
    const found = new Map<string, { at: number; tree: string; subject: string }>();
    for (const l of lines(await out(this.io, ["log", "--no-walk", "--ignore-missing", "--format=%H%x09%ct%x09%T%x09%s", ...tokens, "--"], v.top))) {
      const [sha, ct, tree, ...subject] = l.split("\t");
      if (sha && ct && tree) found.set(sha, { at: Number(ct) * 1000, tree, subject: subject.join("\t") });
    }
    if (!found.size) return null;
    const offMain = new Set(lines(await out(this.io, ["rev-list", ...found.keys(), `^${v.mainSha}`, "--"], v.top)).filter((c) => found.has(c)));
    if (!offMain.size) return "merged";
    const [sha, c] = [...offMain].map((s) => [s, found.get(s)!] as const).sort((a, b) => b[1].at - a[1].at)[0]!;
    if (v.trees.has(c.tree) || landed.has(sha)) return "landed";
    if (lines(await out(this.io, ["for-each-ref", "--count=1", "--contains", sha, "--format=%(refname)"], v.top)).length) return "landed";
    const past = Number(lines(await out(this.io, ["rev-list", "--count", `${v.mainSha}..${sha}`], v.top))[0]) || 0;
    return { sha, at: c.at, subject: c.subject, past };
  }

  /**
   * The roundup's git facts for a page: which tracked worktrees have landed on their main branch,
   * and each launch worktree's row. Stops at `deadline`; the sessions not done are `unfinished`.
   */
  async facts(
    page: readonly SessionSummary[],
    reading: (s: SessionSummary) => SessionReadiness | undefined | null,
    covers: (s: SessionSummary) => boolean,
    deadline: number,
    clock: () => number = Date.now,
    /** Branches the session's final ask names, to check against main. */
    askBranches: (s: SessionSummary) => readonly string[] = () => [],
  ): Promise<GitFacts> {
    let settled = false;
    const stopped = () => settled || clock() >= deadline;
    // Past the deadline no new read starts: every read goes through an io that refuses then.
    const self = this.stoppable(stopped);
    return self.factsUntil(page, reading, covers, deadline, clock, askBranches, stopped, () => (settled = true));
  }

  private async factsUntil(
    page: readonly SessionSummary[],
    reading: (s: SessionSummary) => SessionReadiness | undefined | null,
    covers: (s: SessionSummary) => boolean,
    deadline: number,
    clock: () => number,
    askBranches: (s: SessionSummary) => readonly string[],
    stopped: () => boolean,
    settle: () => void,
  ): Promise<GitFacts> {
    const facts: GitFacts = { landed: new Set(), launch: new Map(), launchLanded: 0, unfinished: new Set(), named: new Map(), uncommitted: new Map(), launchMostly: 0, launchSettled: new Set(), onMain: new Set(), namedOnMain: new Map() };
    const views = new Map<string, Promise<{ v: RepoView; refs: Refs; landed: Promise<Set<string>> } | null>>();
    const repo = (top: string) => {
      let p = views.get(top);
      if (!p) {
        p = (async () => {
          const v = await this.view(top);
          if (!v) return null;
          const refs = await this.refs(top);
          return { v, refs, landed: this.landedCommits(v, refs) };
        })().catch((e) => {
          if (e instanceof Halted) throw e;
          return null;
        });
        views.set(top, p);
      }
      return p;
    };
    const one = async (s: SessionSummary) => {
      const r = reading(s);
      let tail: Promise<string> | undefined;
      const transcript = () => (tail ??= this.io.readTail(s.path, TRANSCRIPT_SCAN));
      // Tracked rows: squash landings.
      for (const t of r?.trees ?? []) {
        const place = launchPlaceOf(t.path, this.io.exists);
        if (!place) continue;
        const removedNoRecord = t.state === "removed" && t.why === "no record of a merge";
        const ready = t.state === "ready" || t.state === "waiting-approval";
        const unmerged = !t.merged && !t.noCommits && (ready || t.state === "in-progress" || t.state === "blocked" || t.state === "stale" || (t.state === "removed" && t.why === "not merged"));
        const dirtyOnly = !!t.noCommits && (t.dirtyCount ?? 0) > 0;
        if (!removedNoRecord && !unmerged && !dirtyOnly) continue;
        const rp = await repo(place.top);
        if (!rp) continue;
        const key = landedKey(t.path, t.branch);
        if (dirtyOnly) {
          const sup = await this.superseded(t.path, rp.v);
          if (sup) facts.uncommitted.set(key, sup);
          continue;
        }
        const tip = rp.refs.get(t.branch);
        if (tip && (rp.v.trees.has(tip.tree) || (await rp.landed).has(tip.sha))) {
          facts.landed.add(key);
          continue;
        }
        // Main's subjects: a gone branch named there landed; a kept one only with its own tip.
        const nc = nameCheck(rp.v.subjects, t.branch, removedNoRecord ? undefined : tip?.sha);
        if (nc === "landed") facts.landed.add(key);
        else if (nc && !ready) facts.named.set(key, `${rp.v.main} names it in ${nc.named}`);
        else if (!nc && !tip && (removedNoRecord || (t.state === "in-progress" && t.why === "worktree folder gone")) && (await this.namedCommitsOnMain(rp.v, await transcript(), t.branch, await rp.landed))) facts.namedOnMain.set(key, rp.v.main);
      }
      // The branches its final ask names: on main when git has them there, or main's subjects say so.
      const asked = askBranches(s);
      const home = launchPlaceOf(s.cwd, this.io.exists) ?? (r?.trees ?? []).map((t) => launchPlaceOf(t.path, this.io.exists)).find((x) => x);
      if (asked.length && home) {
        const rp = await repo(home.top);
        if (rp) for (const b of asked) if (await this.branchOnMain(rp.v, rp.refs, await rp.landed, b)) facts.onMain.add(`${s.path}\0${b}`);
      }
      // The session's own launch worktree, when readiness tracks none at its folder.
      const place = launchPlaceOf(s.cwd, this.io.exists);
      if (!place) return;
      const folder = canonicalLoose(place.folder);
      if ((r?.trees ?? []).some((t) => canonicalLoose(t.path) === folder)) return;
      const rp = await repo(place.top);
      if (!rp) return;
      const row = await this.launchRow(place, s, rp.v, rp.refs, rp.landed);
      if (row === "landed") facts.launchLanded++;
      else if (row === "mostly") facts.launchMostly++;
      else if (row) facts.launch.set(s.path, row);
      if (row === "landed" || row === null) facts.launchSettled.add(s.path);
    };
    const need = page.filter((s) => covers(s) && (launchPlaceOf(s.cwd, this.io.exists) || (reading(s)?.trees.length ?? 0) > 0 || askBranches(s).length > 0));
    const pending = new Set(need.map((s) => s.path));
    // At most POOL sessions read at once.
    let next = 0;
    const worker = async () => {
      while (next < need.length && !stopped()) {
        const s = need[next++]!;
        // A session cut off by the deadline stays unfinished.
        if (await one(s).then(() => true, (e) => !(e instanceof Halted))) pending.delete(s.path);
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(POOL, need.length) }, worker));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((done) => (timer = setTimeout(done, Math.max(0, deadline - clock()))))]);
    clearTimeout(timer);
    settle();
    for (const p of pending) facts.unfinished.add(p);
    return facts;
  }

  /** Whether the commit ids a transcript names within NEAR_BRANCH characters of `branch` (less any
      that begins a worktree record's `"base"`) that git has are at least one and all on main: an
      ancestor of it, their tree on it, or landed. */
  async namedCommitsOnMain(v: RepoView, transcript: string, branch: string, landed: Set<string>): Promise<boolean> {
    const bases = [...transcript.matchAll(/"base"\s*:\s*"([0-9a-f]{7,40})"/g)].map((m) => m[1]!);
    const tokens = new Set<string>();
    const edge = /[A-Za-z0-9_/-]/;
    for (let i = transcript.lastIndexOf(branch); i >= 0 && tokens.size < MAX_TOKENS; i = i > 0 ? transcript.lastIndexOf(branch, i - 1) : -1) {
      if (edge.test(transcript[i - 1] ?? "") || edge.test(transcript[i + branch.length] ?? "")) continue;
      const near = transcript.slice(Math.max(0, i - NEAR_BRANCH), i + branch.length + NEAR_BRANCH);
      for (const t of near.match(/\b[0-9a-f]{7,40}\b/g) ?? []) {
        if (!/[a-f]/.test(t) || !/\d/.test(t) || bases.some((b) => b.startsWith(t))) continue;
        tokens.add(t);
      }
    }
    if (!tokens.size) return false;
    const found = new Map<string, string>();
    for (const l of lines(await out(this.io, ["log", "--no-walk", "--ignore-missing", "--format=%H%x09%T", ...tokens, "--"], v.top))) {
      const [sha, tree] = l.split("\t");
      if (sha && tree) found.set(sha, tree);
    }
    if (!found.size) return false;
    const off = await out(this.io, ["rev-list", ...found.keys(), `^${v.mainSha}`, "--"], v.top);
    if (off === null) return false;
    return lines(off).every((c) => !found.has(c) || v.trees.has(found.get(c)!) || landed.has(c));
  }

  /** Whether a branch is on main: its tip an ancestor of main, its tree or tip landed, or main's
      subjects say so (a gone branch named there, a kept one with its tip). */
  async branchOnMain(v: RepoView, refs: Refs, landed: Set<string>, branch: string): Promise<boolean> {
    const tip = refs.get(branch);
    if (!tip) return nameCheck(v.subjects, branch) === "landed";
    if (v.trees.has(tip.tree) || landed.has(tip.sha)) return true;
    const anc = await this.io.git([...RO, "merge-base", "--is-ancestor", tip.sha, v.mainSha], v.top).catch(unlessHalted);
    if (anc?.code === 0) return true;
    return nameCheck(v.subjects, branch, tip.sha) === "landed";
  }

  /** An uncommitted-only worktree against main (§app.overseer/roundup): "main" when its files differ
      from main by fewer than half the lines they differ from its own commit; else the hedge when main
      changed some of them since that commit. Null when git can't say. */
  async superseded(folder: string, v: RepoView): Promise<Superseded | null> {
    if (!this.io.exists(folder)) return null;
    const tip = lines(await out(this.io, ["rev-parse", "HEAD"], folder))[0];
    const st = await out(this.io, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], folder);
    if (!tip || st === null) return null;
    const all = dirtyPaths(st);
    if (!all.length) return null;
    const files = all.slice(0, MAX_FILES);
    const vsMain = numstatLines(await out(this.io, ["diff", "--numstat", v.mainSha, "--", ...files], folder));
    const vsTip = numstatLines(await out(this.io, ["diff", "--numstat", "HEAD", "--", ...files], folder));
    if (vsTip > 0 && vsMain * 2 < vsTip) return "main";
    const k = lines(await out(this.io, ["diff", "--name-only", tip, v.mainSha, "--", ...files], folder)).length;
    if (!k) return {};
    const m = Number(lines(await out(this.io, ["rev-list", "--count", `${tip}..${v.mainSha}`, "--", ...files], folder))[0]) || 0;
    return { hedge: `${v.main} changed ${k} of ${all.length} files since (${m} commit${m === 1 ? "" : "s"}): may be superseded` };
  }

  private async launchRow(place: LaunchPlace, s: SessionSummary, v: RepoView, refs: Refs, landedP: Promise<Set<string>>): Promise<LaunchRow | "landed" | "mostly" | null> {
    const notOnMain = `not on ${v.main}`;
    if (this.io.exists(place.folder)) {
      const branch = lines(await out(this.io, ["symbolic-ref", "--quiet", "--short", "HEAD"], place.folder))[0] ?? "(detached)";
      const [head, tree] = lines(await out(this.io, ["rev-parse", "HEAD", "HEAD^{tree}"], place.folder));
      const ahead = Number(lines(await out(this.io, ["rev-list", "--count", `${v.mainSha}..HEAD`], place.folder))[0]) || 0;
      const st = await out(this.io, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], place.folder);
      const dirty = st === null ? 0 : dirtyCount(st);
      const files = `${dirty} uncommitted file${dirty === 1 ? "" : "s"}`;
      if (ahead > 0) {
        if (head && tree && (v.trees.has(tree) || (await landedP).has(head))) return "landed";
        const nc = nameCheck(v.subjects, branch, head);
        if (nc === "landed") return "landed";
        if (nc) return { bucket: "unconfirmed", branch, text: `${branch} (${v.main} names it in ${nc.named})` };
        return { bucket: "built", branch, text: `${branch} ${ahead} commit${ahead === 1 ? "" : "s"} ${notOnMain}${dirty ? `, ${files}` : ""}` };
      }
      if (dirty > 0) {
        const sup = await this.superseded(place.folder, v);
        if (sup === "main") return "mostly";
        return { bucket: "uncommitted", branch, text: `${branch} ${files}, no commits${sup?.hedge ? `; ${sup.hedge}` : ""}` };
      }
      return null;
    }
    for (const b of [`sova/${place.name}`, `feat/${place.name}`]) {
      const tip = refs.get(b);
      if (!tip) continue;
      const n = Number(lines(await out(this.io, ["rev-list", "--count", `${v.mainSha}..${tip.sha}`], v.top))[0]) || 0;
      if (n === 0) return null;
      if (v.trees.has(tip.tree) || (await landedP).has(tip.sha)) return "landed";
      const nc = nameCheck(v.subjects, b, tip.sha);
      if (nc === "landed") return "landed";
      if (nc) return { bucket: "unconfirmed", branch: b, text: `${b} (${v.main} names it in ${nc.named})` };
      return { bucket: "at-risk", branch: b, text: `${b}: folder gone, branch keeps ${n} commit${n === 1 ? "" : "s"} ${notOnMain}` };
    }
    const branch = `sova/${place.name}`;
    if (nameCheck(v.subjects, branch) === "landed" || nameCheck(v.subjects, `feat/${place.name}`) === "landed") return "landed";
    if (!/-[0-9a-f]{6}$/.test(place.name)) return { bucket: "unconfirmed", branch, text: branch };
    const lost = await this.lostCommit(v, await this.io.readTail(s.path, TRANSCRIPT_SCAN), await landedP);
    if (lost === "merged") return null;
    if (lost === "landed") return "landed";
    if (!lost) return { bucket: "unconfirmed", branch, text: `${branch} (folder and branch gone; no commit of it found)` };
    const sha8 = lost.sha.slice(0, 8);
    const hex = place.name.slice(-6);
    return {
      bucket: "lost",
      branch,
      find: { hex, words: place.name.slice(0, -7).split("-").filter((w) => w.length >= 3 && !/^\d+$/.test(w)) },
      text: `branch ${branch} and its worktree are gone; newest commit ${sha8} (${new Date(lost.at).toISOString().slice(0, 10)}, '${cut(lost.subject, 60)}') is on no branch and ${notOnMain}, ${lost.past} commit${lost.past === 1 ? "" : "s"} past ${v.main}; recover with \`git branch ${place.name} ${sha8}\` before gc prunes it`,
    };
  }
}

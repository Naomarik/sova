import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { CONTRACT_FILE, DefinitionError, parseDefinition, remoteOf as remoteName, type ProjectDef } from "../../shared/project-contract";
import { statusArgs } from "./guard";
import { ManifestError, parseReleaseManifest, RELEASE_MANIFEST_FILE } from "../../shared/release";
import {
  setupChanges,
  setupMapOf,
  type NamesState,
  type SetupFacts,
  type SetupHistoryAnswer,
  type SetupMap,
  type SetupMapAnswer,
  type SetupRelease,
  type SetupReview,
  type SetupVersion,
} from "../../shared/merge-queue-setup-map";

/**
 * The queue screen's Setup, Proposal and Setup history views (§app.merge-queue/explainer): the setup in force, read
 * from the main branch as Git has it; the Setup chat's proposal, read LIVE from that chat's own working copy (its
 * uncommitted edits too, so the Proposal view moves while the chat writes); and the versions the main branch has had.
 *
 *   GET /api/merge-queue/projects/:project/setup-map       → SetupMapAnswer
 *   GET /api/merge-queue/projects/:project/setup-history   → SetupHistoryAnswer  (?limit=1…50, default 20)
 *
 * Read-only. The working copy is the one Sova recorded for the project's Setup chat; no path comes from the request,
 * and every file read stays inside it.
 */

export type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The project's Setup chat as Sova records it (server/projects/setup-chat.ts). */
export interface SetupChatFacts {
  session: string;
  path?: string;
  worktree?: string;
  branch?: string;
  state: "idle" | "working" | "waiting" | "proposed";
}

export interface SetupMapDeps {
  git: Git;
  /** A registered project's main checkout, by id; null: none. */
  rootOf(projectId: string): Promise<string | null>;
  /** The branch the queue lands on. */
  targetOf(root: string): Promise<string>;
  /** Where the private names interview stands for this project (the queue's names file). */
  namesOf(root: string): Promise<NamesState | null>;
  setupChat(projectId: string): Promise<SetupChatFacts | null>;
  /** The review kit's declaration in a folder (server/merge-queue/review-kit.ts readKitDecl); absent: none read. */
  kitDecl?(dir: string): Promise<{ decl: Omit<SetupReview, "kit" | "fixes" | "problem">; problems: string[] }>;
}

/** The remote a push goes to: the definition's named one when it declares one, else `origin`, when the project has it. */
async function remoteOf(git: Git, root: string, def: ProjectDef | null): Promise<string | null> {
  const want = remoteName(def);
  const r = await git(["remote"], root);
  return r.code === 0 && r.stdout.split("\n").map((l) => l.trim()).includes(want) ? want : null;
}

const parse = (text: string): { def: ProjectDef | null; problem?: string } => {
  try {
    return { def: parseDefinition(text) };
  } catch (err) {
    return { def: null, problem: err instanceof DefinitionError ? err.message : String(err) };
  }
};

/** A file under `dir` (relative, never leaving it), or null. */
function readInside(dir: string, rel: string): string | null {
  const base = resolve(dir);
  const file = resolve(base, rel);
  if (file !== base && !file.startsWith(base + sep)) return null;
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

const releaseSteps = (text: string | null, dir: string): { steps: SetupRelease["steps"]; problem?: string } => {
  if (text === null) return { steps: [], problem: `${dir}/${RELEASE_MANIFEST_FILE} is missing` };
  try {
    return { steps: parseReleaseManifest(text).steps.map((s) => ({ id: s.id, label: s.label, phase: s.phase, ...(s.held ? { held: true as const } : {}), ...(s.artifact ? { artifact: true as const } : {}), ...(s.about ? { about: s.about } : {}), ...(s.minutes ? { minutes: s.minutes } : {}) })) };
  } catch (err) {
    return { steps: [], problem: `${dir}/${RELEASE_MANIFEST_FILE}: ${err instanceof ManifestError ? err.message : String(err)}` };
  }
};

/** The review kit's declaration in a folder on disk (null: no kit there). */
async function reviewIn(deps: SetupMapDeps, folder: string, kit: string | undefined): Promise<SetupFacts["review"]> {
  if (!kit) return undefined;
  const dir = resolve(folder, kit);
  if (!dir.startsWith(resolve(folder) + sep) || !existsSync(dir)) return { problem: `the review kit ${kit} is missing` };
  if (!deps.kitDecl) return {};
  const r = await deps.kitDecl(dir).catch(() => ({ decl: {}, problems: ["the kit's declaration couldn't be read"] }));
  return { ...r.decl, ...(r.problems.length ? { problem: r.problems.join("; ") } : {}) };
}

/** The setup at a commit of `root`, as Git has it (the main branch's, and each Setup history version). */
async function mapAtCommit(deps: SetupMapDeps, root: string, commit: string, names: NamesState | null, remote: string | null, of: SetupMap["of"], target: string): Promise<SetupMap> {
  const shown = await deps.git(["show", `${commit}:${CONTRACT_FILE}`], root);
  const { def, problem } = shown.code === 0 ? parse(shown.stdout) : { def: null, problem: undefined };
  const kit = def?.merge?.review;
  let review: SetupFacts["review"] = undefined;
  if (kit) {
    const pj = await deps.git(["show", `${commit}:${kit.replace(/\/+$/, "")}/playbook.json`], root);
    review = pj.code === 0 ? {} : { problem: `the review kit ${kit} is missing` };
    // The kit's own declaration is read from the main checkout's folder (the queue reads the merged copy's at run time).
    if (pj.code === 0 && of === "main") review = (await reviewIn(deps, root, kit)) ?? {};
  }
  let release: SetupFacts["release"] = null;
  if (def?.release) {
    const dir = def.release.playbook.replace(/\/+$/, "");
    const m = await deps.git(["show", `${commit}:${dir}/${RELEASE_MANIFEST_FILE}`], root);
    release = releaseSteps(m.code === 0 ? m.stdout : null, dir);
  }
  return setupMapOf(def, { of, target, commit, remote, names, review: review ?? null, release, ...(problem ? { problem } : {}) });
}

/**
 * The project file Confirm would land: the chat's copy merged onto the target's newest one, as Git merges the branch.
 * A chat whose branch forked before the target's later setup edits would otherwise seem to undo them. Its copy as is
 * when the branch is up to date, or when the merge would conflict (the merge thread judges that one at landing).
 */
async function mergedText(deps: SetupMapDeps, wt: string, text: string, main: { commit: string; text: string } | null): Promise<string> {
  if (!main) return text;
  const mb = await deps.git(["merge-base", main.commit, "HEAD"], wt);
  const base = mb.code === 0 ? mb.stdout.trim() : "";
  if (!base || base === main.commit) return text;
  const at = await deps.git(["show", `${base}:${CONTRACT_FILE}`], wt);
  const baseText = at.code === 0 ? at.stdout : "";
  if (baseText === main.text) return text;
  if (baseText === text) return main.text;
  const dir = mkdtempSync(join(tmpdir(), "sova-setup-merge-"));
  try {
    const [ours, old, theirs] = ["main", "base", "chat"].map((n) => join(dir, n));
    writeFileSync(ours!, main.text);
    writeFileSync(old!, baseText);
    writeFileSync(theirs!, text);
    const r = await deps.git(["merge-file", "-p", ours!, old!, theirs!], dir);
    return r.code === 0 ? r.stdout : text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The Setup chat's working copy as it is on disk now: its definition, kit and release playbook, merged onto `main`. */
async function mapOfWorktree(deps: SetupMapDeps, chat: SetupChatFacts, root: string, names: NamesState | null, target: string, main: { commit: string; text: string } | null): Promise<SetupMap | null> {
  const wt = chat.worktree;
  if (!wt || !existsSync(wt)) return null;
  const own = readInside(wt, CONTRACT_FILE);
  if (own === null) return null;
  const text = await mergedText(deps, wt, own, main);
  const { def, problem } = parse(text);
  const head = await deps.git(["rev-parse", "HEAD"], wt);
  const status = await deps.git(statusArgs("--porcelain"), wt);
  const dirty = status.code === 0 && status.stdout.trim() !== "";
  const remote = await remoteOf(deps.git, root, def);
  let release: SetupFacts["release"] = null;
  if (def?.release) {
    const dir = def.release.playbook.replace(/\/+$/, "");
    // The chat's playbook, or the target's when the chat's branch predates it.
    const own = readInside(wt, `${dir}/${RELEASE_MANIFEST_FILE}`);
    const atMain = own === null && main ? await deps.git(["show", `${main.commit}:${dir}/${RELEASE_MANIFEST_FILE}`], root) : null;
    release = releaseSteps(own ?? (atMain?.code === 0 ? atMain.stdout : null), dir);
  }
  const kit = def?.merge?.review;
  const ownKit = await reviewIn(deps, wt, kit);
  const review = ownKit?.problem && kit && main && existsSync(resolve(root, kit)) ? await reviewIn(deps, root, kit) : ownKit;
  return setupMapOf(def, {
    of: "proposal",
    target,
    commit: head.code === 0 ? head.stdout.trim() : null,
    dirty,
    ...(chat.branch ? { branch: chat.branch } : {}),
    remote,
    names,
    review: review ?? null,
    release,
    ...(problem ? { problem } : {}),
  });
}

export async function readSetupMap(projectId: string, deps: SetupMapDeps): Promise<SetupMapAnswer | null> {
  const root = await deps.rootOf(projectId);
  if (!root) return null;
  const target = await deps.targetOf(root);
  const names = await deps.namesOf(root);
  const head = await deps.git(["rev-parse", "--verify", "--quiet", `${target}^{commit}`], root);
  const commit = head.code === 0 ? head.stdout.trim() : null;
  const shown = commit ? await deps.git(["show", `${commit}:${CONTRACT_FILE}`], root) : null;
  const remote = await remoteOf(deps.git, root, shown?.code === 0 ? parse(shown.stdout).def : null);
  const main = commit ? await mapAtCommit(deps, root, commit, names, remote, "main", target) : setupMapOf(null, { of: "main", target, commit: null, remote, names });
  const chat = await deps.setupChat(projectId);
  const mainText = commit && shown?.code === 0 ? { commit, text: shown.stdout } : null;
  let proposal = chat ? await mapOfWorktree(deps, chat, root, names, target, mainText) : null;
  // A working copy that changes nothing proposes nothing.
  if (proposal && proposal.hash === main.hash && !proposal.problem) proposal = null;
  const history = await readSetupHistory(projectId, deps, 50).catch(() => null);
  const current = history?.versions[0];
  return {
    main,
    proposal,
    chat: chat ? { session: chat.session, ...(chat.path ? { path: chat.path } : {}), state: chat.state, ...(chat.branch ? { branch: chat.branch } : {}) } : null,
    changes: proposal ? setupChanges(main, proposal) : [],
    ...(current && current.hash === main.hash ? { version: { n: current.n, at: current.at, earlier: current.n - 1 } } : {}),
  };
}

const HISTORY_SCAN = 200;

/** The main branch's setup versions, newest first: each commit to the definition that changed what the queue does. */
export async function readSetupHistory(projectId: string, deps: SetupMapDeps, limit = 20): Promise<SetupHistoryAnswer | null> {
  const root = await deps.rootOf(projectId);
  if (!root) return null;
  const target = await deps.targetOf(root);
  const log = await deps.git(["log", `-n${HISTORY_SCAN}`, "--format=%H%x09%cI%x09%s", target, "--", CONTRACT_FILE], root);
  if (log.code !== 0) return { versions: [], more: false };
  const commits = log.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, at, ...s] = l.split("\t");
      return { sha: sha!, at: at!, subject: s.join("\t") };
    })
    .reverse();
  const names = await deps.namesOf(root);
  const remote = await remoteOf(deps.git, root, null);
  const versions: SetupVersion[] = [];
  let prev: SetupMap | null = null;
  for (const c of commits) {
    const map = await mapAtCommit(deps, root, c.sha, names, remote, "main", target);
    if (prev && map.hash === prev.hash) continue;
    if (!prev && map.checksFrom === "unset" && !map.release) {
      prev = map;
      continue;
    }
    versions.push({ n: versions.length + 1, commit: c.sha, at: c.at, subject: c.subject, hash: map.hash, changes: prev ? setupChanges(prev, map) : [] });
    prev = map;
  }
  versions.reverse();
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  return { versions: versions.slice(0, n), more: versions.length > n || log.stdout.split("\n").filter(Boolean).length >= HISTORY_SCAN };
}

export function registerSetupMapRoutes(app: Hono<any>, deps: SetupMapDeps): void {
  const none = (id: string) => ({ error: { code: "not-found", message: `no project ${id}` } });
  app.get("/api/merge-queue/projects/:project/setup-map", async (c) => {
    const id = c.req.param("project");
    const a = await readSetupMap(id, deps);
    return a ? c.json(a) : c.json(none(id), 404);
  });
  app.get("/api/merge-queue/projects/:project/setup-history", async (c) => {
    const id = c.req.param("project");
    const limit = Number(c.req.query("limit") ?? 20);
    const a = await readSetupHistory(id, deps, Number.isFinite(limit) ? limit : 20);
    return a ? c.json(a) : c.json(none(id), 404);
  });
}

/** The live wiring: projects by id, the queue's target and names file, the Setup chat's record. */
export function registerLiveSetupMapRoutes(app: Hono<any>): void {
  registerSetupMapRoutes(app, {
    git: async (args, cwd) => (await import("../project-services/engine")).realGit(args, cwd),
    async rootOf(id) {
      const { listProjects } = await import("../projects/spaces");
      try {
        return listProjects().find((p) => p.id === id)?.root ?? null;
      } catch {
        return null;
      }
    },
    async targetOf(root) {
      const { servedRule } = await import("./served");
      const t = await (await servedRule()).servedTarget(root).catch(() => null);
      if (t) return t;
      const { realGit } = await import("../project-services/engine");
      const r = await realGit(["symbolic-ref", "--short", "HEAD"], root);
      return r.code === 0 ? r.stdout.trim() : "HEAD";
    },
    async namesOf(root) {
      const { mergeQueues } = await import("./wire");
      const qs = mergeQueues();
      const pending = qs?.peek(root);
      const q = pending ? await pending.catch(() => null) : null;
      if (!q) return null;
      const f = q.store.namesFileOf();
      if (!f.exists) return "unanswered";
      try {
        const raw = JSON.parse(readFileSync(f.file, "utf8")) as { privateNames?: unknown[] };
        return Array.isArray(raw.privateNames) && raw.privateNames.length === 0 ? "none" : "answered";
      } catch {
        return "unanswered";
      }
    },
    async setupChat(id) {
      const { setupRecordOf } = await import("../projects/setup-chat");
      const cur = setupRecordOf(id).current;
      if (!cur) return null;
      let state: SetupChatFacts["state"] = "idle";
      try {
        const { runLive } = await import("../projects/playbook-review");
        const now = await runLive(cur.path);
        state = now?.working ? "working" : now?.questions ? "waiting" : "idle";
      } catch {}
      return { session: cur.sessionId, path: cur.path, ...(cur.worktree ? { worktree: cur.worktree } : {}), ...(cur.branch ? { branch: cur.branch } : {}), state };
    },
    // The review kit's own reader (review-kit.ts), loaded by name so this file needs nothing of it at build time.
    async kitDecl(dir) {
      const mod: string = "./review-kit";
      const kit = (await import(mod).catch(() => null)) as { readKitDecl?: NonNullable<SetupMapDeps["kitDecl"]> } | null;
      return kit?.readKitDecl ? kit.readKitDecl(dir) : { decl: {}, problems: [] };
    },
  });
}

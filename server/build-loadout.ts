import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createSessionFile } from "./harness/pi/state";
import { readAlignScan } from "./align-state";
import { acquireChat, isSessionBusy, setOpeningChoice } from "./chat-manager";
import { noteBuildMerged } from "./build-merged";
import { mergeMode } from "./mode-state";
import { OrgError } from "./org-error";
import { workingSubagents } from "./live";
import { hostOf, isOrgHostOpen, onOrgChange, onOrgHostOpened, openEngineIds, type Effect, type OrgHostApi } from "./org-engine";
import type { Envelope } from "./org-envelope";
import { canonicalPath } from "./paths";
import { projectOf } from "./project-overseer-store";
import { buildSid, engineOf, projectHost } from "./projects/spaces";
import type { ProjectCodingMode } from "../shared/project-overseer";
import { cutWorktree, gitRootOf, mergeBack, readWorktree, removeWorktree, uncommitted, worktreePathOf, type GitRoot, type WorktreeReading, type WorktreeRecord } from "./project-worktrees";
import { teardownCopyOf } from "./project-services/checkout-teardown";
import { mainMoved } from "./project-services/on-merge";
import { runGit } from "../pi-config/extensions/worktrees/git.ts";
import { markSeen } from "./seen";
import { cleanSessionTitle, readSessionTitles } from "./session-titles";
import { getSessionSummary, indexedSessionPaths } from "./sessions-index";
import { validateNewSessionCwd } from "./targets";
import { addWebSession } from "./web-sessions";
import { markOwned } from "./write-guard";

/**
 * A project's coding sessions (builds) on the build statechart (`build/<p>/<sid>`, design §3.8;
 * §app.project-overseer/coding-worktrees, /new-coding-session): the statechart owns each one's setup, turn,
 * worktree, branch and merge; this module runs its effects (the worktree and session file, the mode,
 * the first prompt, a prompt, Merge Branch, Remove Worktree), gives it the runtime's and git's facts,
 * and reads its rows back in the shape the pages and routes use. Nothing here is written to a file
 * of its own: the session file and worktree folder are this host's, found by id and by branch.
 */

export { buildSid };

export type BuildKind = "coding" | "operator-coding";

/** A build as the pages read it: the statechart's data, with this host's session file. */
export interface BuildRow {
  sessionId: string;
  kind: BuildKind;
  createdAt: string;
  /** The session file on this host, when it is here. */
  path?: string;
  /** Its worktree (`path` resolved on this host by `withWorktreePath`). */
  worktree?: Omit<WorktreeRecord, "path"> & { path?: string };
  /** The operator's Merge Branch, as recorded (a merge git can't show any more). */
  merged?: { at: string; commit: string };
  /** When Remove Worktree removed it. */
  removed?: string;
  /** Remove Worktree deleted the branch too, which it does only for a merged one. */
  branchDeleted?: boolean;
  /** Why it runs in the root itself (a tail: "it isn't a Git repository."). */
  inRoot?: string;
  /** Its title when it started (the one given, else the prompt's first line). */
  title?: string;
  /** An `operator-coding` build the global Overseer started for the operator (§app.overseer/org-attribution). */
  via?: "overseer";
  /** The Project verbs playbook's run (statechart kind `onboard`, §app.project-runtime/onboard), with who started it. */
  onboard?: { startedBy: "overseer" | "operator" };
  gap?: string;
  item?: string;
  decisions?: string[];
  /** The runtime's facts as the statechart last heard them. */
  turn: "idle" | "working" | "failed";
  workers: number;
  /** Setup: not started (the sentence), its mode not set, its first prompt refused. */
  notStarted?: string;
  modeNotSet?: boolean;
  promptError?: string;
  configuration: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isoOf = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === "string" ? v : "");

/** Session files made here since the index last looked (the index finds them later). */
const fresh = new Map<string, string>();

/** Tests: builds started at a state (org-test-fixtures.seedBuild), whose effects touch no git and no file. */
interface Seeded {
  worktreePath?: string;
  made: Record<string, unknown>;
  merge?: Record<string, unknown>;
  remove?: Record<string, unknown>;
}
const seeded = new Map<string, Seeded>();
export function seedBuildEffectsForTest(sessionId: string, s: Seeded & { path?: string }): void {
  seeded.set(sessionId, s);
  if (s.path) fresh.set(sessionId, s.path);
}

/** A build's session file on this host, or null (another host's, or gone). */
export function buildSessionPath(sessionId: string): string | null {
  const p = indexedSessionPaths().get(sessionId) ?? fresh.get(sessionId);
  return p && existsSync(p) ? p : null;
}

function rowOf(configuration: string[], d: Record<string, unknown>): BuildRow {
  const sessionId = str(d.sessionId);
  const path = buildSessionPath(sessionId);
  const merged = isObj(d.merged) && typeof d.merged.commit === "string" ? { at: isoOf(d.merged.at), commit: d.merged.commit } : undefined;
  return {
    sessionId,
    kind: d.kind === "operator-coding" ? "operator-coding" : "coding",
    createdAt: isoOf(d.createdAt),
    ...(path ? { path } : {}),
    ...(typeof d.branch === "string" && d.branch ? { worktree: { branch: d.branch, base: str(d.base), target: str(d.target), ...(seeded.get(sessionId)?.worktreePath ? { path: seeded.get(sessionId)!.worktreePath } : {}) } } : {}),
    ...(merged ? { merged } : {}),
    ...(d.removedAt != null ? { removed: isoOf(d.removedAt) } : {}),
    ...(d.branchDeleted === true ? { branchDeleted: true } : {}),
    ...(typeof d.inRoot === "string" && d.inRoot ? { inRoot: d.inRoot } : {}),
    ...(typeof d.title === "string" && d.title ? { title: d.title } : {}),
    ...(d.via === "overseer" ? { via: "overseer" as const } : {}),
    ...(d.kind === "onboard" ? { onboard: { startedBy: d.startedBy === "overseer" ? ("overseer" as const) : ("operator" as const) } } : {}),
    ...(typeof d.gap === "string" && d.gap ? { gap: d.gap } : {}),
    ...(typeof d.item === "string" && d.item ? { item: d.item } : {}),
    ...(Array.isArray(d.decisions) && d.decisions.length ? { decisions: d.decisions as string[] } : {}),
    turn: d.turn === "working" || d.turn === "failed" ? d.turn : "idle",
    workers: typeof d.workers === "number" ? d.workers : 0,
    ...(typeof d.notStarted === "string" && d.notStarted ? { notStarted: d.notStarted } : {}),
    ...(d.modeNotSet != null && d.modeNotSet !== false ? { modeNotSet: true } : {}),
    ...(typeof d.promptError === "string" && d.promptError ? { promptError: d.promptError } : {}),
    configuration,
  };
}

/** The project's builds, oldest first; a build whose worktree could not be made is none (nothing started). */
export function readBuilds(projectId: string): BuildRow[] {
  if (!engineOf(projectId)) return [];
  return projectHost(projectId)
    .sessions("build")
    .filter((s) => s.data.projectId === projectId && !s.configuration.includes("not-started") && s.running)
    .map((s) => rowOf(s.configuration, s.data))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every build an engine holds, with its project. */
export function readEngineBuilds(engine: string): (BuildRow & { projectId: string })[] {
  if (!isOrgHostOpen(engine)) return [];
  return hostOf(engine)
    .sessions("build")
    .filter((s) => !s.configuration.includes("not-started") && s.running)
    .map((s) => ({ ...rowOf(s.configuration, s.data), projectId: str(s.data.projectId) }));
}

/** One build of the project, or null. */
export function readBuild(projectId: string, sessionId: string): BuildRow | null {
  if (!engineOf(projectId)) return null;
  const host = projectHost(projectId);
  const sid = buildSid(projectId, sessionId);
  const d = host.data(sid);
  return d ? rowOf(host.configuration(sid) ?? [], d) : null;
}

/** Its worktree folder on this host: beside the repository's top, named after its branch (as cutWorktree made it). */
export async function withWorktreePath(row: BuildRow, root: string): Promise<(BuildRow & { worktree: WorktreeRecord }) | null> {
  if (!row.worktree) return null;
  if (row.worktree.path) return row as BuildRow & { worktree: WorktreeRecord };
  const repo = await gitRootOf(root);
  const top = "reason" in repo ? root : repo.top;
  return { ...row, worktree: { ...row.worktree, path: worktreePathOf(top, row.worktree.branch) } };
}

// ---- starting one ------------------------------------------------------------------------------------

/** A fresh session id for a build the host starts (the statechart's own drive names its own). */
export const newBuildSessionId = (): string => randomUUID();

const waiters = new Set<{ engine: string; sid: string; done: () => void }>();

const setupEnded = (host: Pick<OrgHostApi, "configuration">, sid: string): boolean => {
  const c = host.configuration(sid);
  return !c || c.includes("ready") || c.includes("not-started");
};

onOrgChange((engine, change) => {
  for (const w of waiters) {
    if (w.engine !== engine || !change.sessions.includes(w.sid)) continue;
    if (setupEnded(hostOf(engine), w.sid)) {
      waiters.delete(w);
      w.done();
    }
  }
});

/** Until the build's setup has ended (ready, or not started): its worktree, session file, mode and first prompt. */
export function buildSetupEnded(projectId: string, sid: string, ms = 120_000): Promise<void> {
  const engine = engineOf(projectId);
  if (!engine || setupEnded(hostOf(engine), sid)) return Promise.resolve();
  return new Promise((done, fail) => {
    const w = {
      engine,
      sid,
      done: () => {
        clearTimeout(t);
        done();
      },
    };
    const t = setTimeout(() => {
      waiters.delete(w);
      fail(new Error("The coding session's setup did not finish."));
    }, ms);
    t.unref?.();
    waiters.add(w);
  });
}

/** A web session's file with a given id, in `cwd`, as POST /api/sessions writes one (its cwd checked the same way). */
async function makeSessionFile(cwd: string, sessionId: string): Promise<string> {
  const cwdError = await validateNewSessionCwd(cwd);
  if (cwdError) throw new Error(cwdError);
  const path = canonicalPath(createSessionFile({ cwd: resolve(cwd), id: sessionId }).path);
  markOwned(path);
  addWebSession(sessionId);
  markSeen(sessionId);
  return path;
}
let sessionMaker = makeSessionFile;
/** Tests: where a build's session file is made (a stub runtime's), or null for the real one. */
export function setBuildSessionMakerForTest(fn: ((cwd: string, sessionId: string) => Promise<string>) | null): void {
  sessionMaker = fn ?? makeSessionFile;
}

/** A new session file with the build's id, in `cwd` (as POST /api/sessions makes one), opened on its model and thinking. */
async function createBuildSession(cwd: string, sessionId: string, d: Record<string, unknown>): Promise<string> {
  const have = buildSessionPath(sessionId);
  if (have) return have;
  const path = await sessionMaker(cwd, sessionId);
  fresh.set(sessionId, path);
  let choice = { model: typeof d.model === "string" && d.model ? d.model : null, thinking: typeof d.thinking === "string" && d.thinking ? d.thinking : null };
  // A build the item statechart started itself (L3) names no model: the project's coding model, as Start coding gives it.
  if (!choice.model) {
    const def = await (await import("./project-overseer")).buildDefaults(str(d.projectId));
    choice = { model: def.model, thinking: choice.thinking ?? def.thinking };
  }
  // Opened on its model and thinking from the start (its file never records the default first);
  // set again only when the open didn't take them (a model without auth, an unknown level).
  setOpeningChoice(path, choice);
  const chat = await acquireChat(path);
  const cur = chat.session.model ? `${chat.session.model.provider}/${chat.session.model.id}` : null;
  if (choice.model && choice.model !== cur) {
    await chat.setModelRef(choice.model);
    if (choice.thinking) chat.setThinking(choice.thinking);
  }
  return path;
}

// ---- the statechart's effects -----------------------------------------------------------------------------

/** `customType` of the note a coding session started with no prompt gets: its worktree paragraph. */
export const CODING_WORKTREE_NOTE = "sova-coding-worktree";

/**
 * Set a coding session's mode and pin it (§app.project-overseer/tools, Modes): the mode extension's
 * own handler (applyMode), then the `mode` entry Sova writes itself, so the session keeps this mode
 * whatever mode.json says later. Throws when either can't be done: the caller then sends no prompt.
 * Returns when the switch applies (a running turn finishes in the old mode).
 */
export async function applyCodingMode(path: string, mode: ProjectCodingMode): Promise<"now" | "after-turn"> {
  const chat = await acquireChat(path);
  const plan = await chat.applyMode(mergeMode(chat.modeState, { mode: mode.mode, minorModes: mode.minorModes as never }));
  if (plan !== "command")
    throw new OrgError(plan === "unsupported" ? "the mode extension is not loaded in it" : "it is open in another writer (a terminal, or a process Sova doesn't know)", 409);
  if (!chat.pinMode()) throw new OrgError("its mode entry could not be written", 409);
  return chat.session.isStreaming ? "after-turn" : "now";
}

function sessionOf(host: OrgHostApi, e: Effect): { d: Record<string, unknown>; projectId: string; sessionId: string } {
  const d = host.data(e.sessionId) ?? {};
  return { d, projectId: str(d.projectId), sessionId: str(d.sessionId) };
}

function pathOrThrow(sessionId: string): string {
  const path = buildSessionPath(sessionId);
  if (!path) throw new Error("On another host: its worktree is there.");
  return path;
}

/** The worktree's slug: its given title, else the prompt's first words (as the session starts). */
/** The branch's name: a title given, else the prompt's first 8 words (as master). A build's own title that is not just its
    prompt's first line was given too (the item statechart's "Build §gap/…"). */
const slugTitle = (sessionId: string, d: Record<string, unknown>): string => {
  const prompt = str(d.prompt);
  const given = str(d.title) && str(d.title) !== cleanSessionTitle((prompt.split("\n")[0] ?? "").slice(0, 80)) ? str(d.title) : "";
  return readSessionTitles()[sessionId] || given || prompt.split(/\s+/).slice(0, 8).join(" ") || str(d.title);
};

export function registerBuildEffects(host: OrgHostApi, engine: string): void {
  host.effects.register("make-worktree", async (e) => {
    const { d, projectId, sessionId } = sessionOf(host, e);
    const seed = seeded.get(sessionId);
    if (seed) return seed.made;
    const project = projectOf(projectId);
    const folder = typeof d.folder === "string" && d.folder ? d.folder : project.root;
    const repo = await gitRootOf(project.root);
    if ("reason" in repo) {
      await createBuildSession(folder, sessionId, d);
      return { inRoot: repo.reason };
    }
    const cut = await cutWorktree(repo as GitRoot, folder, slugTitle(sessionId, d));
    try {
      await createBuildSession(cut.cwd, sessionId, d);
    } catch (err) {
      // Nothing runs in it: the worktree goes again (it holds nothing).
      await removeWorktree(cut.worktree, project.root).catch(() => {});
      throw err;
    }
    return { branch: cut.worktree.branch, base: cut.worktree.base, target: cut.worktree.target };
  });

  host.effects.register("set-mode", async (e) => {
    const { projectId, sessionId } = sessionOf(host, e);
    if (seeded.has(sessionId)) return {};
    try {
      // F20: a build started with no mode named (a statechart's own drive): the project's, as Start coding gives it.
      const mode = (e.mode as ProjectCodingMode | null | undefined) ?? (await (await import("./project-overseer")).buildDefaults(projectId)).mode;
      await applyCodingMode(pathOrThrow(sessionId), mode);
    } catch (err) {
      // The session stays, listed and counted; its first turn never runs in a mode it wasn't given.
      console.warn(`[build] ${sessionId}: mode not set: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    return {};
  });

  host.effects.register("first-prompt", async (e) => {
    const { sessionId } = sessionOf(host, e);
    if (seeded.has(sessionId)) return {};
    const r = await (await import("./session-prompt")).promptSession(pathOrThrow(sessionId), str(e.prompt));
    if (!r.ok) throw new Error(r.error);
    return {};
  });

  // New Coding Session: nothing is sent (the operator writes the first message); the commit paragraph goes in first, as a note.
  host.effects.register("worktree-note", async (e) => {
    const { sessionId } = sessionOf(host, e);
    if (seeded.has(sessionId)) return {};
    if (!(await (await acquireChat(pathOrThrow(sessionId))).appendNote(CODING_WORKTREE_NOTE, str(e.text)))) console.warn(`[build] ${sessionId}: its worktree note could not be written`);
    return {};
  });

  // sova_send: its mode first when asked (mid-turn, after the running turn), then the text. A build's own
  // session, or (`session`, the project statechart's act) a coding session in the project root that is no build.
  host.effects.register("prompt", async (e) => {
    const overseer = await import("./session-prompt");
    const path = typeof e.session === "string" ? await overseer.pathOfId(e.session) : pathOrThrow(sessionOf(host, e).sessionId);
    if (!path) throw new Error("That session is not on this host.");
    let modeApplies: "now" | "after-turn" | undefined;
    if (e.mode) modeApplies = await applyCodingMode(path, e.mode as ProjectCodingMode);
    const r = await overseer.promptSession(path, str(e.text));
    if (!r.ok) throw new Error(r.error);
    return { queued: r.queued, ...(modeApplies ? { modeApplies } : {}) };
  });

  host.effects.register("merge", async (e) => {
    const { d, projectId, sessionId } = sessionOf(host, e);
    const seed = seeded.get(sessionId)?.merge;
    if (seed) return seed;
    const root = projectOf(projectId).root;
    const row = await withWorktreePath(rowOf(host.configuration(e.sessionId) ?? [], d), root);
    if (!row) throw new Error("It runs in the project root.");
    // Its title as the page shows it: a rename, the one it started with, the listing's (its first message), its branch.
    const path = buildSessionPath(sessionId);
    const listed = path ? (await getSessionSummary(path).catch(() => null))?.title : undefined;
    const title = readSessionTitles()[sessionId] || str(d.title) || (listed && listed !== "Untitled" ? listed : "") || row.worktree.branch;
    const m = await mergeBack(row.worktree, root, title);
    noteBuildMerged(sessionId, true);
    // Main moved: its copy's onMerge services reload now, never holding up the merge (§app.project-services/on-merge).
    void mainMoved(root, undefined, { merged: true }).catch((err) => console.warn(`[on-merge] ${root}: ${err instanceof Error ? err.message : String(err)}`));
    return { commit: m.sha };
  });

  host.effects.register("remove-worktree", async (e) => {
    const { d, projectId, sessionId } = sessionOf(host, e);
    const seed = seeded.get(sessionId)?.remove;
    if (seed) return seed;
    const root = projectOf(projectId).root;
    const row = await withWorktreePath(rowOf(host.configuration(e.sessionId) ?? [], d), root);
    if (!row) throw new Error("It runs in the project root.");
    // Its running copy goes first, with its links (§app.project-overseer/coding-worktrees); a teardown that fails removes
    // nothing. A worktree with uncommitted changes is refused by removeWorktree before its copy is touched.
    if (!existsSync(row.worktree.path) || !(await uncommitted(runGit, row.worktree.path)).length) await teardownCopyOf(row.worktree.path);
    const out = await removeWorktree(row.worktree, root);
    return { branchDeleted: out.branchDeleted };
  });

  // After a restart no turn runs: every build whose statechart still says one hears it ended, cold ones included (a
  // build not resumed yet would keep "working" forever: F-049/F-050's twin for coding sessions).
  void (async () => {
    for (const s of host.sessions("build")) {
      if (s.running && s.data.turn === "working") await host.act(s.id, "turn/ended", {}, SYSTEM);
    }
  })().catch((err) => console.warn(`[build] ${engine}: resuming turns: ${err instanceof Error ? err.message : String(err)}`));
}
onOrgHostOpened(registerBuildEffects);

const SYSTEM = { by: "system" } as unknown as Envelope;

// ---- facts ---------------------------------------------------------------------------------------------

/** The build a session file is, in any open engine: its engine, project and statechart id. */
export function buildOfSession(sessionId: string): { engine: string; projectId: string; sid: string } | null {
  for (const engine of openEngineIds()) {
    for (const s of hostOf(engine).sessions("build")) {
      if (s.data.sessionId === sessionId) return { engine, projectId: str(s.data.projectId), sid: s.id };
    }
  }
  return null;
}

/** The runtime's facts now (working, its workers) to the build's statechart, before an act that checks them. */
export async function syncBuildTurn(projectId: string, sid: string, path: string | null): Promise<void> {
  const host = projectHost(projectId);
  const d = host.data(sid);
  if (!d || !path) return;
  const working = isSessionBusy(path);
  const workers = workingSubagents(path);
  if (working && d.turn !== "working") await host.act(sid, "turn/started", {}, SYSTEM);
  if (!working && d.turn === "working") {
    await probeAtTurnEnd(projectId, sid, str(d.sessionId));
    await host.act(sid, "turn/ended", { questions: await openQuestionsAt(path) }, SYSTEM);
  }
  if (workers !== (typeof d.workers === "number" ? d.workers : 0)) await host.act(sid, "workers/changed", { n: workers }, SYSTEM);
}

/** The build a hosted session file is, with its engine (fresh ones first, then the index). */
function buildOfPath(path: string): { engine: string; projectId: string; sid: string } | null {
  const want = canonicalPath(path);
  for (const [id, p] of [...fresh, ...indexedSessionPaths()]) if (canonicalPath(p) === want) return buildOfSession(id);
  return null;
}

/** A build's turn started (agent_start, F21): its statechart says working from now, so the Pipeline shows it and the
    at-once cap counts it while the turn runs. */
export async function noteBuildStarted(path: string): Promise<void> {
  const hit = buildOfPath(path);
  if (!hit) return;
  const host = hostOf(hit.engine);
  if (host.data(hit.sid)?.turn !== "working") await host.act(hit.sid, "turn/started", {}, SYSTEM);
}

/** Every build of the project on this host: its runtime's facts now (working, workers) to its statechart, before an act
    that counts them (the at-once coding cap, F21). */
export async function syncProjectBuilds(projectId: string): Promise<void> {
  if (!engineOf(projectId)) return;
  for (const s of projectHost(projectId).sessions("build")) {
    if (s.data.projectId !== projectId || !s.running) continue;
    await syncBuildTurn(projectId, s.id, buildSessionPath(str(s.data.sessionId)));
  }
}

/** Git's facts about a build's branch just before its turn's end is heard, so what the turn committed counts: a verb
    playbook's run that committed ends proposed, never "no change" for want of a read since (§app.project-runtime/onboard). */
async function probeAtTurnEnd(projectId: string, sid: string, sessionId: string): Promise<void> {
  try {
    const row = readBuild(projectId, sessionId);
    const wt = row ? await withWorktreePath(row, projectOf(projectId).root) : null;
    if (wt) await probeBuild(projectId, sid, wt, await readWorktree(wt.worktree, projectOf(projectId).root));
  } catch (err) {
    console.warn(`[build] ${sessionId}: not probed at its turn's end: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The open alignment questions a session waits on the operator for (§chat.alignment/session-mark), at a turn's end:
    a verb playbook's run that asks waits (§app.project-runtime/onboard). 0 when none, or the file can't be read. */
async function openQuestionsAt(path: string): Promise<number> {
  try {
    return (await readAlignScan(path, statSync(path).size, null)).summary?.openQuestions ?? 0;
  } catch {
    return 0;
  }
}

/** A build's turn ended (agent_settled): the statechart hears the turn (and its end), so the overseer is told of its own. */
export async function noteBuildSettled(path: string, failed: boolean): Promise<void> {
  const want = canonicalPath(path);
  for (const [id, p] of [...fresh, ...indexedSessionPaths()]) {
    if (canonicalPath(p) !== want) continue;
    const hit = buildOfSession(id);
    if (!hit) return;
    const host = hostOf(hit.engine);
    if (host.data(hit.sid)?.turn !== "working") await host.act(hit.sid, "turn/started", {}, SYSTEM);
    await probeAtTurnEnd(hit.projectId, hit.sid, id);
    await host.act(hit.sid, "turn/ended", { failed, questions: await openQuestionsAt(p) }, SYSTEM);
    return;
  }
}

/** Git's facts about a build's worktree and branch (the page's read) to its statechart. */
export async function probeBuild(projectId: string, sid: string, row: BuildRow, w: WorktreeReading): Promise<void> {
  const tree = row.removed ? "removed" : w.state === "missing" ? "missing" : "open";
  const branch = !w.branch ? undefined : w.merged ? "merged" : row.merged && w.unmerged > 0 ? "new-since-merge" : w.ahead > 0 ? "unmerged" : "no-commits";
  const payload: Record<string, unknown> = { tree, ahead: w.ahead, dirty: w.dirty, branchGone: !w.branch, ...(branch ? { branch } : {}), ...(w.error ? { error: w.error } : {}) };
  await projectHost(projectId).act(sid, "git/probe", payload, SYSTEM);
}

/** Tests: forget the session files made here. */
export function resetBuildsForTest(): void {
  fresh.clear();
  seeded.clear();
  waiters.clear();
}


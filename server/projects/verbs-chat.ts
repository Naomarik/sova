import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VerbsChatOpened, VerbsChatStatus, VerbsChatView } from "../../shared/project-runtime";
import { isArchived } from "../archived-sessions";
import { canonicalPath } from "../paths";
import type { Envelope } from "../org-envelope";
import { OrgError } from "../org-error";
import { stateRoot } from "../state-root";
import { branchStateOf } from "./setup-chat";
import { projectArchived, readProject } from "./spaces";

/**
 * The project's standing Project verbs chat (§app.project-runtime/onboard): at most one open per project, kept as the
 * Setup chat is (server/projects/setup-chat.ts). Set Up with a Chat / Change Setup… start it when there is none and
 * otherwise open it, sending nothing; each message the operator types in it is a refinement. It keeps one worktree and
 * branch for its life (after a merge it carries on there); only once its worktree was removed or its build retired is
 * it no longer the project's chat, and the next start is a new chat on a new branch, told the earlier chats' paths.
 *
 * Start Fresh (the operator's alone, from the chat's head) archives it: with commits beyond the target, a new chat
 * carries on in the same worktree and branch, the proposal staying the old run's (`run`: its build, which the registry
 * watches); with none, the empty worktree and branch go and a new run starts. An overseer's start while the chat is
 * open and idle is delivered to it as its next message, never archiving it.
 *
 * The record is `<state>/verbs-chats.json`: per project, its current chat and the earlier ones.
 */

export interface VerbsCurrent {
  sessionId: string;
  path: string;
  startedAt: string;
  /** The verb playbook run (its build's session) whose branch and proposal this chat carries: its own, or after a Start
      Fresh with commits, the earlier one's. */
  run: string;
  branch?: string;
  worktree?: string;
  target?: string;
}

export interface VerbsHistoryItem extends VerbsCurrent {
  endedAt: string;
  why: "fresh" | "ended";
}

interface ProjectRecord {
  current?: VerbsCurrent;
  history: VerbsHistoryItem[];
}

const HISTORY_MAX = 20;
const recordFile = (): string => join(stateRoot(), "verbs-chats.json");

let cache: { mtimeMs: number; all: Record<string, ProjectRecord> } | null = null;

function readAll(): Record<string, ProjectRecord> {
  try {
    const mtimeMs = statSync(recordFile()).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.all;
    const raw = JSON.parse(readFileSync(recordFile(), "utf8")) as Record<string, ProjectRecord>;
    const all = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    cache = { mtimeMs, all };
    return all;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, ProjectRecord>): void {
  const file = recordFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cache = null;
}

export function verbsRecordOf(projectId: string): ProjectRecord {
  const r = readAll()[projectId];
  return { ...(r?.current ? { current: r.current } : {}), history: Array.isArray(r?.history) ? r.history : [] };
}

function saveRecord(projectId: string, r: ProjectRecord): void {
  const all = { ...readAll() };
  all[projectId] = { ...(r.current ? { current: r.current } : {}), history: r.history.slice(-HISTORY_MAX) };
  writeAll(all);
}

/** The build session a carry-on chat stands in for (a chat Start Fresh started in an earlier run's worktree): its
    turns are that run's turns, so the registry hears them. Null for any other session file. */
export function verbsRunOfPath(path: string): string | null {
  const want = canonicalPath(path);
  for (const r of Object.values(readAll())) {
    const c = r?.current;
    if (c && c.run !== c.sessionId && c.path && canonicalPath(c.path) === want) return c.run;
  }
  return null;
}

/** The carry-on chat that stands in for a run's build session, or null (none, or the run's own chat). */
export function verbsChatPathOfRun(run: string): string | null {
  for (const r of Object.values(readAll())) {
    const c = r?.current;
    if (c && c.run === run && c.sessionId !== run && c.path) return c.path;
  }
  return null;
}

/** The project's current chat as recorded (open or not), for the registry's reads. */
export const verbsCurrentOf = (projectId: string): VerbsCurrent | null => verbsRecordOf(projectId).current ?? null;

// ---- the sentences ----------------------------------------------------------------------------------------

export const NO_VERBS_CHAT = "There is no open Project verbs chat to start fresh.";
export const VERBS_STILL_WORKING = "The Project verbs chat is working: wait for its turn to end (or stop it), then Start Fresh.";
export const VERBS_DIRTY = "The Project verbs chat's worktree has edits not committed: commit or discard them in that chat, then Start Fresh.";
export const ALREADY_RUNNING = (title: string) => `The Project verbs playbook is already running: "${title}".`;
export const WAITS_ANSWERS = (title: string) => `The Project verbs chat waits on the user's answers in "${title}": a start reaches it once they are answered.`;
export const PROPOSAL_WAITS = (branch: string) => `The Project verbs chat's proposal on ${branch} waits on the user's review: a start reaches it once it is merged.`;

// ---- what it needs from the server --------------------------------------------------------------------------

/** The playbook's first message and model for a start (onboard.ts onboardStart), or why it can't start. */
export interface VerbsPrompt {
  prompt: string;
  title: string;
  model: string;
  thinking: string;
  invalid?: string;
}

/** The live ones are in runtime-routes.ts / runtime.ts; tests stand them in. */
export interface VerbsDeps {
  /** The playbook's turn, `context` after it (the earlier chats, carrying on), `why` as its note. */
  prompt: (projectId: string, input: { why?: string; context?: string; model?: string; thinking?: string }) => Promise<VerbsPrompt>;
  /** A new run (the project's `verbs/onboard`: a build of kind onboard on its own worktree and branch). */
  startRun: (projectId: string, input: { why?: string; context?: string; model?: string; thinking?: string }, envelope?: Envelope) => Promise<{ sessionId: string; path: string; worktree?: { path: string; branch: string }; target?: string; notPrompted?: string; held?: { id: string; until: number } }>;
  /** A plain chat in `cwd` on the run's mode, sent `text` (carrying on in an earlier run's folder). */
  startChat: (projectId: string, run: string, cwd: string, text: string, title: string, model?: { model: string; thinking?: string }) => Promise<{ id: string; path: string }>;
  archive: (path: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The chat's turn now: working, and the alignment questions it waits on the operator for. */
  live: (path: string) => Promise<{ working: boolean; questions: number }>;
  /** The worktree has edits not committed. */
  dirty: (worktree: string) => Promise<boolean>;
  /** The chat's next message (an overseer's start). */
  deliver: (path: string, text: string) => Promise<void>;
  /** Remove a run's empty (or merged) worktree and its branch: nothing beyond the target is lost. */
  removeEmpty: (projectId: string, sessionId: string, branch: string) => Promise<void>;
  /** The run's build can't go on: unknown here, retired or its worktree removed. */
  buildGone: (projectId: string, run: string) => boolean;
  /** An open onboard build the record doesn't know (a run from before the standing chat). */
  adoptable: (projectId: string) => Promise<Omit<VerbsCurrent, "startedAt"> | null>;
  /** Who the next turn of the run's chat is from (an overseer's start and its why): the registry's playbook region
      follows the run again with it once that turn starts (runtime.ts reattachVerbsRun). */
  expectTurn: (projectId: string, run: string, by: { startedBy: "operator" | "overseer"; why?: string }) => void;
  /** An overseer may start the playbook now under `envelope` (its power, the unattended rule), else why not. */
  overseerMay?: (projectId: string, envelope: Envelope) => string | null;
  now?: () => number;
}

const iso = (deps: Pick<VerbsDeps, "now">) => new Date(deps.now?.() ?? Date.now()).toISOString();

/** Whether the recorded chat is still the project's Project verbs chat. */
function stillOpen(projectId: string, c: VerbsCurrent | undefined, deps: Pick<VerbsDeps, "buildGone">): boolean {
  return !!c && !!c.path && existsSync(c.path) && !isArchived(c.sessionId) && (!c.worktree || existsSync(c.worktree)) && !deps.buildGone(projectId, c.run);
}

/** The project's open Project verbs chat: the recorded one while it is open (else it joins the history), else an
    open onboard build adopted as it. */
export async function currentChat(projectId: string, deps: Pick<VerbsDeps, "buildGone" | "adoptable" | "now">): Promise<VerbsCurrent | null> {
  const rec = verbsRecordOf(projectId);
  if (rec.current && stillOpen(projectId, rec.current, deps)) return rec.current;
  if (rec.current) {
    rec.history.push({ ...rec.current, endedAt: iso(deps), why: "ended" });
    delete rec.current;
    saveRecord(projectId, rec);
  }
  const a = await deps.adoptable(projectId);
  if (!a) return null;
  const current: VerbsCurrent = { ...a, startedAt: iso(deps) };
  saveRecord(projectId, { current, history: verbsRecordOf(projectId).history });
  return current;
}

/** The earlier chats, for a new chat's first message (its memory). Pure. */
export function earlierChats(history: readonly VerbsHistoryItem[]): string {
  if (!history.length) return "";
  const out = ["## Earlier Project verbs chats", "Read them before you change anything: what they learned and decided is yours to keep."];
  for (const h of [...history].reverse()) out.push(`- ${h.path} (started ${h.startedAt}, ${h.why === "fresh" ? "closed by Start Fresh" : "ended"} ${h.endedAt}${h.branch ? `, branch ${h.branch}` : ""})`);
  return out.join("\n");
}

/** The carry-on block: the folder and branch the new chat works in, and the chat it replaces. Pure. */
export function carryOnText(old: Pick<VerbsCurrent, "path" | "branch" | "worktree">): string {
  return ["## Carrying on", `The earlier Project verbs chat (${old.path}) was closed. Its branch holds commits not merged: you work in the same folder${old.worktree ? ` (${old.worktree})` : ""}${old.branch ? ` on its branch ${old.branch}` : ""}, and its proposal is yours. Read that branch's commits and the earlier chat before you change anything.`].join("\n");
}

const joinBlocks = (...b: string[]) => b.filter(Boolean).join("\n\n");

/** The branch's commits beyond the target, when its folder is still there; null when it can't be read. */
async function aheadOf(root: string, c: Pick<VerbsCurrent, "branch" | "worktree" | "target">): Promise<number | null> {
  if (!c.branch || !c.worktree || !existsSync(c.worktree)) return null;
  const st = await branchStateOf(root, c.branch, c.target || "main");
  return st ? st.ahead : null;
}

/**
 * A new chat in place of `old` (the chat just closed, or the last one that ended): with its branch holding commits
 * beyond the target and its build going on, a plain chat carries on in that worktree and branch (the proposal stays
 * the old run's); otherwise the old empty worktree and branch go and a new run starts. Told the earlier chats' paths.
 */
async function replace(projectId: string, old: VerbsCurrent | undefined, input: { why?: string; model?: string; thinking?: string }, deps: VerbsDeps, envelope?: Envelope): Promise<OverseerVerbsStart> {
  const p = readProject(projectId);
  const history = verbsRecordOf(projectId).history;
  const earlier = earlierChats(history);
  const ahead = old && !deps.buildGone(projectId, old.run) ? await aheadOf(p.root, old) : null;
  if (old && ahead !== null && ahead > 0) {
    const start = await deps.prompt(projectId, { ...input, context: joinBlocks(carryOnText(old), earlier, input.why ? `## The user's note\n${input.why}` : "") });
    if (start.invalid) throw new OrgError(start.invalid, 409);
    const made = await deps.startChat(projectId, old.run, old.worktree!, start.prompt, start.title, { model: start.model, thinking: start.thinking });
    const current: VerbsCurrent = { sessionId: made.id, path: made.path, startedAt: iso(deps), run: old.run, ...(old.branch ? { branch: old.branch } : {}), worktree: old.worktree!, ...(old.target ? { target: old.target } : {}) };
    saveRecord(projectId, { current, history: verbsRecordOf(projectId).history });
    return { sessionId: made.id, path: made.path, reopened: false, worktree: { path: old.worktree!, branch: old.branch ?? "" } };
  }
  // Nothing beyond the target (or merged): the empty worktree and branch go, nothing is lost.
  if (old?.branch && ahead === 0) await deps.removeEmpty(projectId, old.run, old.branch).catch(() => undefined);
  const made = await deps.startRun(projectId, { ...input, ...(earlier ? { context: joinBlocks(earlier, `## The user's note\n${input.why?.trim() || "None."}`) } : {}) }, envelope);
  // Held (an unattended overseer's start waits so the operator can cancel it): nothing is recorded until it starts.
  if (made.held || !made.sessionId || !made.path) return { sessionId: made.sessionId ?? "", path: made.path ?? "", reopened: false, ...(made.held ? { held: made.held } : {}) };
  const current: VerbsCurrent = { sessionId: made.sessionId, path: made.path, startedAt: iso(deps), run: made.sessionId, ...(made.worktree ? { branch: made.worktree.branch, worktree: made.worktree.path } : {}), ...(made.target ? { target: made.target } : {}) };
  saveRecord(projectId, { current, history: verbsRecordOf(projectId).history });
  return { sessionId: made.sessionId, path: made.path, reopened: false, ...(made.worktree ? { worktree: made.worktree } : {}), ...(made.notPrompted ? { notPrompted: made.notPrompted } : {}) };
}

const archivedWhy = (projectId: string): string | null => {
  const p = readProject(projectId);
  return projectArchived(projectId) ? `${p.name || p.id} is archived. Unarchive it first.` : null;
};

/** Set Up with a Chat / Change Setup… (POST /api/projects/:pid/verbs/onboard): opens the open chat, sending nothing;
    with none, starts one (carrying on the last chat's kept branch and proposal, when there is one). */
export async function openVerbsChat(projectId: string, input: { why?: string; model?: string; thinking?: string }, deps: VerbsDeps, envelope?: Envelope): Promise<VerbsChatOpened> {
  const no = archivedWhy(projectId);
  if (no) throw new OrgError(no, 409);
  const cur = await currentChat(projectId, deps);
  if (cur) return { sessionId: cur.sessionId, path: cur.path, reopened: true, ...(cur.worktree && cur.branch ? { worktree: { path: cur.worktree, branch: cur.branch } } : {}) };
  return replace(projectId, verbsRecordOf(projectId).history.at(-1), input, deps, envelope);
}

/** Start Fresh (POST /api/projects/:pid/verbs/chat/fresh), the operator's own press: refused while the chat works or
    its worktree has edits not committed; else it is archived and replaced. */
export async function freshVerbsChat(projectId: string, input: { model?: string; thinking?: string }, deps: VerbsDeps, envelope?: Envelope): Promise<VerbsChatOpened> {
  const no = archivedWhy(projectId);
  if (no) throw new OrgError(no, 409);
  const cur = await currentChat(projectId, deps);
  if (!cur) throw new OrgError(NO_VERBS_CHAT, 409);
  if ((await deps.live(cur.path)).working) throw new OrgError(VERBS_STILL_WORKING, 409);
  if (cur.worktree && existsSync(cur.worktree) && (await deps.dirty(cur.worktree))) throw new OrgError(VERBS_DIRTY, 409);
  // The replacement must be able to start (the press's own refusal: the host's, no model) before the open chat goes:
  // a refused start leaves it open, never no chat at all.
  const can = await deps.prompt(projectId, input);
  if (can.invalid) throw new OrgError(can.invalid, 409);
  const a = await deps.archive(cur.path);
  if (!a.ok) throw new OrgError(`The Project verbs chat couldn't be archived: ${a.error}`, 409);
  const rec = verbsRecordOf(projectId);
  rec.history.push({ ...cur, endedAt: iso(deps), why: "fresh" });
  delete rec.current;
  saveRecord(projectId, rec);
  return replace(projectId, cur, input, deps, envelope);
}

/** What an overseer's start did: a new chat, or its turn delivered to the open one. */
export type OverseerVerbsStart = VerbsChatOpened & { delivered?: true; held?: { id: string; until: number } };

/**
 * An overseer's start (`sova_project_verbs onboard`): with the chat open and idle, the playbook's turn plus the why is
 * its next message (the registry follows it again), never archiving it; refused while it works, waits on the user's
 * answers or holds a proposal not merged. With none open, a new chat as a press would start it.
 */
export async function overseerVerbsStart(projectId: string, why: string, deps: VerbsDeps, envelope: Envelope): Promise<OverseerVerbsStart> {
  const cur = await currentChat(projectId, deps);
  if (!cur) return replace(projectId, verbsRecordOf(projectId).history.at(-1), why ? { why } : {}, deps, envelope);
  const no = archivedWhy(projectId) ?? deps.overseerMay?.(projectId, envelope) ?? null;
  if (no) throw new OrgError(no, 409);
  const live = await deps.live(cur.path);
  const title = titleOf(projectId);
  if (live.working) throw new OrgError(ALREADY_RUNNING(title), 409);
  if (live.questions > 0) throw new OrgError(WAITS_ANSWERS(title), 409);
  const ahead = await aheadOf(readProject(projectId).root, cur);
  if (ahead && ahead > 0) throw new OrgError(PROPOSAL_WAITS(cur.branch ?? "its branch"), 409);
  const start = await deps.prompt(projectId, why ? { why } : {});
  if (start.invalid) throw new OrgError(start.invalid, 409);
  deps.expectTurn(projectId, cur.run, { startedBy: envelope.by === "overseer" || envelope.via === "overseer" ? "overseer" : "operator", ...(why ? { why } : {}) });
  await deps.deliver(cur.path, start.prompt);
  return { sessionId: cur.sessionId, path: cur.path, reopened: true, delivered: true, ...(cur.worktree && cur.branch ? { worktree: { path: cur.worktree, branch: cur.branch } } : {}) };
}

/** The chat's title, as every run's: "Project verbs: {project}". */
export const titleOf = (projectId: string): string => {
  const p = readProject(projectId);
  return `Project verbs: ${p.name || p.id}`;
};

/** The chat as its head reads it (GET /api/projects/:pid/verbs/chat). */
export async function readVerbsChat(projectId: string, deps: Pick<VerbsDeps, "buildGone" | "adoptable" | "live" | "dirty" | "now">): Promise<VerbsChatStatus> {
  readProject(projectId); // an unknown project: its 404
  const cur = await currentChat(projectId, deps);
  const history = verbsRecordOf(projectId).history.map((h) => ({ sessionId: h.sessionId, path: h.path, startedAt: h.startedAt, endedAt: h.endedAt, why: h.why, ...(h.branch ? { branch: h.branch } : {}) }));
  if (!cur) return { chat: null, history };
  const [live, ahead, dirty] = await Promise.all([deps.live(cur.path), aheadOf(readProject(projectId).root, cur), cur.worktree && existsSync(cur.worktree) ? deps.dirty(cur.worktree) : Promise.resolve(false)]);
  const chat: VerbsChatView = { sessionId: cur.sessionId, path: cur.path, title: titleOf(projectId), startedAt: cur.startedAt, ...(cur.branch ? { branch: cur.branch } : {}), working: live.working, ahead: ahead ?? 0, dirty };
  return { chat, history };
}

/** Tests: the record file. */
export const verbsRecordFileForTest = recordFile;

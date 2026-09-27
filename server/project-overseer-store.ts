import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY,
  PROJECT_OVERSEER_ENTRY,
  type ProjectOverseerMarkerData,
  type Autonomy,
  type ProjectOverseerCaps,
  type ProjectOverseerPatch,
  type ProjectOverseerSettings,
} from "../shared/project-overseer";
import type { OrgProject, Person } from "../shared/orgs";
import type { OverseerState } from "../shared/protocol";
import { EXTRA_PROMPT_MAX, HISTORY_MAX, readOverseerState, writeAtomic, writeOverseerState } from "./overseer-store";
import { orgDir, OrgError, orgOfSessionPath, readProjects } from "./orgs";
import { checkCodingModePatch, parseCodingMode } from "./project-coding-mode";
import type { WorktreeRecord } from "./project-worktrees";
import { stateRoot } from "./state-root";

/**
 * The project overseer's files (§app.project-overseer/identity): per project, in the org's
 * workspace repo, under `projects/<projectId>/overseer/`, so they move with the org and are
 * committed with it — settings, state, notes, actions, ideas, to-dos, and the sessions it started
 * with what their coding sessions spent (`started.json`, so the token budget survives a move).
 * Only the per-turn counters and the watch loop's timing (pending reasons, last run, runs per day)
 * are host-local: a restore starts them fresh. The stores are the Overseer's own
 * (server/overseer-store.ts, overseer-ideas.ts, overseer-todos.ts), called with these paths.
 */

export interface ProjectOverseerPaths {
  orgId: string;
  projectId: string;
  /** `<workspace>/projects/<pid>/overseer`. */
  dir: string;
  settings: string;
  state: string;
  notes: string;
  actions: string;
  ideas: string;
  todos: string;
  /** The sessions it started, and what its coding sessions spent. */
  started: string;
  /** Host-local: TurnLimits counters. */
  turn: string;
  /** Host-local: the watch loop's memo. */
  memo: string;
}

const SAFE_ID = /^[a-z0-9_]{1,40}$/;

export function projectOverseerPaths(orgId: string, projectId: string, workspace = orgDir(orgId)): ProjectOverseerPaths {
  // Both ids become path segments: never anything but the store's own id shape.
  if (!SAFE_ID.test(orgId) || !SAFE_ID.test(projectId)) throw new OrgError("Unknown project", 404);
  const dir = join(workspace, "projects", projectId, "overseer");
  const local = join(stateRoot(), "project-overseers", `${orgId}-${projectId}`);
  return {
    orgId,
    projectId,
    dir,
    settings: join(dir, "overseer.json"),
    state: join(dir, "state.json"),
    notes: join(dir, "notes.md"),
    actions: join(dir, "actions.jsonl"),
    ideas: join(dir, "ideas"),
    todos: join(dir, "todos.json"),
    started: join(dir, "started.json"),
    turn: join(local, "turn.json"),
    memo: join(local, "watch.json"),
  };
}

/** The project, or a 404. */
export function projectOf(orgId: string, projectId: string): OrgProject {
  const p = readProjects(orgId).find((x) => x.id === projectId);
  if (!p) throw new OrgError("Unknown project", 404);
  return p;
}

// ---- settings --------------------------------------------------------------------------------

export const DEFAULT_PO_CAPS: ProjectOverseerCaps = {
  gatherPerTurn: 3,
  gatheringsOpen: 5,
  promotePerTurn: 20,
  createPerTurn: 2,
  promptsPerTurn: 5,
  codingRunning: 2,
  unattendedPerDay: 12,
};
export const DEFAULT_TOKEN_BUDGET = 2_000_000;
const CAP_MAX = 1000;
const BUDGET_MAX = 1_000_000_000;

export function defaultPoSettings(): ProjectOverseerSettings {
  return { version: 1, autonomy: DEFAULT_AUTONOMY, model: null, thinking: null, codingModel: null, codingThinking: null, codingMode: null, gatheringModel: null, gatheringThinking: null, caps: { ...DEFAULT_PO_CAPS }, tokenBudget: DEFAULT_TOKEN_BUDGET, watch: true, extraSystemPrompt: "" };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCap = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= CAP_MAX;
const isAutonomy = (v: unknown): v is Autonomy => typeof v === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(v);

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Tolerant: every bad field falls back to its default, so a hand-edited file never breaks it. */
export function parsePoSettings(raw: unknown): ProjectOverseerSettings {
  const d = defaultPoSettings();
  if (!isObj(raw)) return d;
  const caps = { ...d.caps };
  if (isObj(raw.caps)) for (const k of Object.keys(caps) as (keyof ProjectOverseerCaps)[]) if (isCap(raw.caps[k])) caps[k] = raw.caps[k] as number;
  return {
    version: 1,
    autonomy: isAutonomy(raw.autonomy) ? raw.autonomy : d.autonomy,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
    thinking: typeof raw.thinking === "string" && raw.thinking.trim() ? raw.thinking.trim() : null,
    codingModel: typeof raw.codingModel === "string" && raw.codingModel.trim() ? raw.codingModel.trim() : null,
    codingThinking: typeof raw.codingThinking === "string" && raw.codingThinking.trim() ? raw.codingThinking.trim() : null,
    codingMode: parseCodingMode(raw.codingMode),
    gatheringModel: typeof raw.gatheringModel === "string" && raw.gatheringModel.trim() ? raw.gatheringModel.trim() : null,
    gatheringThinking: typeof raw.gatheringThinking === "string" && raw.gatheringThinking.trim() ? raw.gatheringThinking.trim() : null,
    caps,
    tokenBudget: typeof raw.tokenBudget === "number" && Number.isInteger(raw.tokenBudget) && raw.tokenBudget >= 0 && raw.tokenBudget <= BUDGET_MAX ? raw.tokenBudget : d.tokenBudget,
    watch: typeof raw.watch === "boolean" ? raw.watch : d.watch,
    extraSystemPrompt: typeof raw.extraSystemPrompt === "string" ? raw.extraSystemPrompt.slice(0, EXTRA_PROMPT_MAX) : "",
  };
}

export const readPoSettings = (p: ProjectOverseerPaths): ProjectOverseerSettings => parsePoSettings(readJson(p.settings));

export function writePoSettings(p: ProjectOverseerPaths, s: ProjectOverseerSettings): ProjectOverseerSettings {
  writeAtomic(p.settings, `${JSON.stringify(s, null, 2)}\n`);
  return s;
}

/** A PATCH: strict (the first problem is the answer, as a sentence), then merged and written. */
export function patchPoSettings(p: ProjectOverseerPaths, body: unknown): ProjectOverseerSettings {
  if (!isObj(body)) throw new OrgError("Expected a JSON object body");
  const patch = body as ProjectOverseerPatch;
  const next = readPoSettings(p);
  if (patch.autonomy !== undefined) {
    if (!isAutonomy(patch.autonomy)) throw new OrgError(`autonomy must be one of ${AUTONOMY_LEVELS.join(", ")}`);
    next.autonomy = patch.autonomy;
  }
  for (const k of ["model", "thinking", "codingModel", "codingThinking", "gatheringModel", "gatheringThinking"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") throw new OrgError(`${k} must be a string or null`);
    next[k] = typeof v === "string" && v.trim() ? v.trim() : null;
  }
  if (patch.codingMode !== undefined) {
    const m = checkCodingModePatch(patch.codingMode);
    if (m && "error" in m) throw new OrgError(m.error);
    next.codingMode = m;
  }
  if (patch.tokenBudget !== undefined) {
    if (typeof patch.tokenBudget !== "number" || !Number.isInteger(patch.tokenBudget) || patch.tokenBudget < 0 || patch.tokenBudget > BUDGET_MAX)
      throw new OrgError(`tokenBudget must be a whole number from 0 to ${BUDGET_MAX}`);
    next.tokenBudget = patch.tokenBudget;
  }
  if (patch.watch !== undefined) {
    if (typeof patch.watch !== "boolean") throw new OrgError("watch must be true or false");
    next.watch = patch.watch;
  }
  if (patch.extraSystemPrompt !== undefined) {
    if (typeof patch.extraSystemPrompt !== "string" || patch.extraSystemPrompt.length > EXTRA_PROMPT_MAX)
      throw new OrgError(`extraSystemPrompt must be text of at most ${EXTRA_PROMPT_MAX} characters`);
    next.extraSystemPrompt = patch.extraSystemPrompt;
  }
  if (patch.caps !== undefined) {
    if (!isObj(patch.caps)) throw new OrgError("caps must be an object");
    for (const [k, v] of Object.entries(patch.caps)) {
      if (!(k in next.caps)) throw new OrgError(`Unknown cap: ${k}`);
      if (!isCap(v)) throw new OrgError(`caps.${k} must be a whole number from 0 to ${CAP_MAX}`);
      next.caps[k as keyof ProjectOverseerCaps] = v;
    }
  }
  return writePoSettings(p, next);
}

// ---- autonomy in force ------------------------------------------------------------------------

export const EMPTY_ROSTER_REASON = "The roster has no active people yet, so the overseer only proposes (L0).";
export const PAUSED_REASON = "Paused at L0: this organization was attached on this host. Set its level to resume.";

/**
 * The level in force: the setting, but L0 while the overseer is paused by an attach on this host
 * (`pausedSince`, until the operator sets its level here), and L0 while the org has no active
 * roster person (nobody to gather from).
 */
export function effectiveAutonomy(
  settings: Pick<ProjectOverseerSettings, "autonomy">,
  roster: Pick<Person, "status">[],
  pausedSince: string | null = null,
): { autonomy: Autonomy; reason?: string } {
  if (pausedSince) return { autonomy: "L0", reason: PAUSED_REASON };
  if (!roster.some((p) => p.status === "active")) return { autonomy: "L0", reason: EMPTY_ROSTER_REASON };
  return { autonomy: settings.autonomy };
}

export const levelAtLeast = (have: Autonomy, need: Autonomy): boolean => AUTONOMY_LEVELS.indexOf(have) >= AUTONOMY_LEVELS.indexOf(need);

// ---- state: current conversation + history ------------------------------------------------------

export const readPoState = (p: ProjectOverseerPaths): OverseerState | null => readOverseerState(p.state);
export const writePoState = (p: ProjectOverseerPaths, s: OverseerState): void => writeOverseerState(s, p.state);
export const isPoId = (p: ProjectOverseerPaths, id: string | undefined, state = readPoState(p)): boolean =>
  !!id && !!state && (state.current === id || state.history.includes(id));
export { HISTORY_MAX };

// ---- the watch memo (host-local) ------------------------------------------------------------------

export interface WatchMemo {
  version: 1;
  /** Reasons noted since the last look. */
  pending: string[];
  /** ISO of the last unattended run it started. */
  lastRunAt: string | null;
  lastRun: { at: string; reasons: string[]; outcome: "started" | "skipped"; detail?: string } | null;
  /** Unattended runs per local day, `YYYY-MM-DD` → count (the last few days only). */
  perDay: Record<string, number>;
}

export function readMemo(p: ProjectOverseerPaths): WatchMemo {
  const raw = readJson(p.memo);
  const m: WatchMemo = { version: 1, pending: [], lastRunAt: null, lastRun: null, perDay: {} };
  if (!isObj(raw)) return m;
  if (Array.isArray(raw.pending)) m.pending = raw.pending.filter((x): x is string => typeof x === "string").slice(-50);
  if (typeof raw.lastRunAt === "string") m.lastRunAt = raw.lastRunAt;
  if (isObj(raw.lastRun) && typeof raw.lastRun.at === "string") m.lastRun = raw.lastRun as WatchMemo["lastRun"];
  if (isObj(raw.perDay)) for (const [k, v] of Object.entries(raw.perDay)) if (typeof v === "number") m.perDay[k] = v;
  return m;
}

export function writeMemo(p: ProjectOverseerPaths, m: WatchMemo): void {
  // The first write of the memo also moves a legacy `started` list out of it into the repo.
  migrateStarted(p);
  const days = Object.keys(m.perDay).sort().slice(-7);
  const { version, pending, lastRunAt, lastRun } = m;
  writeAtomic(p.memo, `${JSON.stringify({ version, pending, lastRunAt, lastRun, perDay: Object.fromEntries(days.map((d) => [d, m.perDay[d]])) }, null, 2)}\n`);
}

// ---- the sessions it started (in the repo) ----------------------------------------------------------

export interface StartedRow {
  sessionId: string;
  /** `coding`: started by the overseer (its token budget and caps count these, and only these);
      `operator-coding`: started by the operator's Start coding session on an item — organizational
      (listed under the project), never counted against the overseer. An older Sova ignores it. */
  kind: "gathering" | "offer" | "coding" | "operator-coding";
  createdAt: string;
  /** A coding session's file on the host that started it (coding sessions are not in the repo). */
  path?: string;
  /** A coding session's spend (input + output + cache tokens) when last counted from its file, so
      the token budget still counts it on a host that doesn't have the file. */
  tokens?: number;
  /** A coding session's own git worktree (§app.project-overseer/coding-worktrees). `path` is
      host-local (the host that started it); the branch is in the client repo. */
  worktree?: WorktreeRecord;
  /** The operator's Merge Branch: when, and the target's commit after it. */
  merged?: { at: string; commit: string };
  /** When the operator's Remove Worktree ran (ISO). */
  removed?: string;
  /** Remove Worktree deleted the branch too, which it does only for a merged one. */
  branchDeleted?: boolean;
  /** Why a coding session runs in the root itself (a tail: "it isn't a Git repository."). */
  inRoot?: string;
}

function parseWorktree(v: unknown): WorktreeRecord | undefined {
  if (!isObj(v)) return undefined;
  const { path, branch, base, target } = v;
  if (typeof path !== "string" || !path || typeof branch !== "string" || !branch || typeof base !== "string" || typeof target !== "string") return undefined;
  return { path, branch, base, target };
}

const STARTED_MAX = 200;

function parseStarted(v: unknown): StartedRow[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is StartedRow => isObj(s) && typeof s.sessionId === "string" && typeof s.kind === "string")
    .map((s) => ({
      sessionId: s.sessionId,
      kind: s.kind,
      createdAt: typeof s.createdAt === "string" ? s.createdAt : "",
      ...(typeof s.path === "string" && s.path ? { path: s.path } : {}),
      ...(typeof s.tokens === "number" && Number.isFinite(s.tokens) && s.tokens >= 0 ? { tokens: s.tokens } : {}),
      ...(parseWorktree(s.worktree) ? { worktree: parseWorktree(s.worktree) } : {}),
      ...(isObj(s.merged) && typeof s.merged.at === "string" && typeof s.merged.commit === "string" ? { merged: { at: s.merged.at, commit: s.merged.commit } } : {}),
      ...(typeof s.removed === "string" && s.removed ? { removed: s.removed } : {}),
      ...(s.branchDeleted === true ? { branchDeleted: true } : {}),
      ...(typeof s.inRoot === "string" && s.inRoot ? { inRoot: s.inRoot } : {}),
    }))
    .slice(-STARTED_MAX);
}

/** Before the list moved into the repo it lived in the host-local memo (`watch.json` `started`). */
const legacyStarted = (p: ProjectOverseerPaths): unknown => {
  const raw = readJson(p.memo);
  return isObj(raw) ? raw.started : undefined;
};

/** The sessions it started, oldest first: `started.json`, or the legacy memo's list while that file is absent. */
export function readStarted(p: ProjectOverseerPaths): StartedRow[] {
  const raw = readJson(p.started);
  if (isObj(raw)) return parseStarted(raw.sessions);
  return existsSync(p.started) ? [] : parseStarted(legacyStarted(p));
}

export function writeStarted(p: ProjectOverseerPaths, rows: StartedRow[]): void {
  writeAtomic(p.started, `${JSON.stringify({ version: 1, sessions: rows.slice(-STARTED_MAX) }, null, 2)}\n`);
  dropLegacyStarted(p);
}

/** Move a legacy memo list into `started.json` (once: only while that file is absent). */
function migrateStarted(p: ProjectOverseerPaths): void {
  if (existsSync(p.started)) return dropLegacyStarted(p);
  const legacy = parseStarted(legacyStarted(p));
  if (legacy.length) writeStarted(p, legacy);
}

function dropLegacyStarted(p: ProjectOverseerPaths): void {
  const raw = readJson(p.memo);
  if (!isObj(raw) || !("started" in raw)) return;
  const { started: _gone, ...rest } = raw;
  writeAtomic(p.memo, `${JSON.stringify(rest, null, 2)}\n`);
}

/** Record what the coding sessions spent, as just counted from their files; writes only on a change. */
export function recordTokens(p: ProjectOverseerPaths, counted: Map<string, number>): void {
  const rows = readStarted(p);
  let changed = false;
  for (const r of rows) {
    const t = counted.get(r.sessionId);
    if (t !== undefined && t !== r.tokens) {
      r.tokens = t;
      changed = true;
    }
  }
  if (changed) writeStarted(p, rows);
}

export const dayKey = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Record a session it started (the listing, the concurrency and token caps). */
export function noteStarted(p: ProjectOverseerPaths, sessionId: string, kind: StartedRow["kind"], now = new Date(), path?: string, extra: Pick<StartedRow, "worktree" | "inRoot"> = {}): void {
  const rows = readStarted(p);
  if (rows.some((s) => s.sessionId === sessionId)) return;
  writeStarted(p, [...rows, { sessionId, kind, createdAt: now.toISOString(), ...(path ? { path } : {}), ...extra }]);
}

/** Record the operator's merge or removal on a coding session's row; false when the row or its worktree is unknown. */
export function markStarted(p: ProjectOverseerPaths, sessionId: string, patch: Pick<StartedRow, "merged" | "removed" | "branchDeleted">): boolean {
  const rows = readStarted(p);
  const r = rows.find((x) => x.sessionId === sessionId);
  if (!r?.worktree) return false;
  Object.assign(r, patch);
  writeStarted(p, rows);
  return true;
}

// ---- which files are project overseers ------------------------------------------------------------

const markerMemo = new Map<string, { mtimeMs: number; data: ProjectOverseerMarkerData | null }>();

/** The marker's data from a file's first 16KB (the marker is line 2), cached per mtime. */
export function readPoMarker(path: string): ProjectOverseerMarkerData | null {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    markerMemo.delete(path);
    return null;
  }
  const hit = markerMemo.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  let data: ProjectOverseerMarkerData | null = null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(16 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes(PROJECT_OVERSEER_ENTRY)) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type === "custom" && e.customType === PROJECT_OVERSEER_ENTRY && typeof e.data?.orgId === "string" && typeof e.data?.projectId === "string") {
          data = { v: 1, orgId: e.data.orgId, projectId: e.data.projectId };
          break;
        }
      } catch {
        // torn line: keep looking
      }
    }
  } catch {
    data = null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
  if (markerMemo.size > 500) markerMemo.clear();
  markerMemo.set(path, { mtimeMs, data });
  return data;
}

/**
 * The project a session file is the overseer of, or null: it carries the marker, lives in THAT
 * org's workspace sessions dir, and the project's state knows its id (current or history). A copy
 * anywhere else, or a fork, is an ordinary session.
 */
export function projectOverseerOfPath(path: string, id = sessionIdOfFile(path)): { orgId: string; projectId: string } | null {
  const m = readPoMarker(path);
  if (!m) return null;
  const org = orgOfSessionPath(path);
  if (!org || org.orgId !== m.orgId) return null;
  try {
    const p = projectOverseerPaths(m.orgId, m.projectId, org.dir);
    return isPoId(p, id) ? { orgId: m.orgId, projectId: m.projectId } : null;
  } catch {
    return null;
  }
}

/** Session id from a session file name (`<ts>_<uuid>.jsonl`). */
export function sessionIdOfFile(path: string): string {
  const b = basename(path, ".jsonl");
  const i = b.indexOf("_");
  return i >= 0 ? b.slice(i + 1) : b;
}

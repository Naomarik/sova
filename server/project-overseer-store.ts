import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AT_ONCE_MAX,
  AUTONOMY_LEVELS,
  capProblem,
  CONFIRM_KINDS,
  confirmKindsProblem,
  DEFAULT_CONFIRM_KINDS,
  DEFAULT_AUTONOMY,
  DEFAULT_PO_CAPS,
  DEFAULT_HOLD_MIN,
  DEFAULT_SOON_LOOK_SEC,
  DEFAULT_WATCH_GAP_MIN,
  gapProblem,
  holdProblem,
  HOLD_MIN_MAX,
  isAtOnce,
  soonProblem,
  type HeldItem,
  PROJECT_OVERSEER_ENTRY,
  type ProjectOverseerMarkerData,
  type Autonomy,
  type LastRunOutcome,
  type ProjectOverseerCaps,
  type ProjectOverseerPatch,
  type ProjectOverseerSettings,
} from "../shared/project-overseer";
import type { OrgProject, Person } from "../shared/orgs";
import type { OverseerState } from "../shared/protocol";
import { setProjectSettingsSource } from "./org-engine";
import { EXTRA_PROMPT_MAX, HISTORY_MAX, readOverseerState, writeAtomic, writeOverseerState } from "./overseer-store";
import { orgDir, OrgError, orgOfSessionPath, readProjects } from "./orgs";
import { checkAbilitiesPatch, parseAbilities } from "./gathering-abilities";
import { checkCodingModePatch, parseCodingMode } from "./project-coding-mode";
import type { WorktreeRecord } from "./project-worktrees";
import { stateRoot } from "./state-root";

/**
 * The project overseer's files (§app.project-overseer/identity): per project, in the org's
 * workspace repo, under `projects/<projectId>/overseer/`, so they move with the org and are
 * committed with it — settings, state, notes, actions, ideas, to-dos, and the sessions it started
 * (`started.json`). What the project's sessions cost is in `projects/<projectId>/costs.json` and
 * `usage.jsonl` (server/project-costs.ts, §app.project-costs/ledger).
 * Only the counters (each message's and each day's) and the watch loop's timing (pending reasons,
 * last run, runs per day, held items) are host-local: a restore starts them fresh. The stores are the Overseer's own
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
  /** The sessions it started. */
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

export { DEFAULT_PO_CAPS };

export function defaultPoSettings(): ProjectOverseerSettings {
  return {
    version: 1,
    autonomy: DEFAULT_AUTONOMY,
    model: null,
    thinking: null,
    codingModel: null,
    codingThinking: null,
    codingMode: null,
    gatheringModel: null,
    gatheringThinking: null,
    gatheringAbilities: null,
    caps: { ...DEFAULT_PO_CAPS },
    watchGapMin: DEFAULT_WATCH_GAP_MIN,
    soonLookSec: DEFAULT_SOON_LOOK_SEC,
    watch: true,
    holdMin: DEFAULT_HOLD_MIN,
    confirmKinds: [...DEFAULT_CONFIRM_KINDS],
    extraSystemPrompt: "",
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
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
  if (isObj(raw.caps))
    for (const k of Object.keys(caps) as (keyof ProjectOverseerCaps)[]) {
      const v = raw.caps[k];
      // An at-once limit above its maximum still means "as many as allowed"; never Unlimited.
      if (isAtOnce(k) && typeof v === "number" && Number.isInteger(v) && v > AT_ONCE_MAX[k]) caps[k] = AT_ONCE_MAX[k];
      else if (capProblem(k, v) === null) Object.assign(caps, { [k]: v });
    }
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
    gatheringAbilities: parseAbilities(raw.gatheringAbilities),
    caps,
    watchGapMin: gapProblem(raw.watchGapMin) === null ? (raw.watchGapMin as number) : d.watchGapMin,
    soonLookSec: "soonLookSec" in raw && soonProblem(raw.soonLookSec) === null ? (raw.soonLookSec as number | null) : d.soonLookSec,
    watch: typeof raw.watch === "boolean" ? raw.watch : d.watch,
    // Over the maximum still means "as long as allowed"; any other bad value, the default.
    holdMin: typeof raw.holdMin === "number" && Number.isInteger(raw.holdMin) && raw.holdMin > HOLD_MIN_MAX ? HOLD_MIN_MAX : holdProblem(raw.holdMin) === null ? (raw.holdMin as number) : d.holdMin,
    // An unknown kind (a newer host's) is dropped; anything else unreadable, the default.
    confirmKinds: Array.isArray(raw.confirmKinds) ? CONFIRM_KINDS.filter((k) => (raw.confirmKinds as unknown[]).includes(k)) : [...d.confirmKinds],
    extraSystemPrompt: typeof raw.extraSystemPrompt === "string" ? raw.extraSystemPrompt.slice(0, EXTRA_PROMPT_MAX) : "",
  };
}

export const readPoSettings = (p: ProjectOverseerPaths): ProjectOverseerSettings => parsePoSettings(readJson(p.settings));

export function writePoSettings(p: ProjectOverseerPaths, s: ProjectOverseerSettings): ProjectOverseerSettings {
  writeAtomic(p.settings, `${JSON.stringify(s, null, 2)}\n`);
  return s;
}

/** pi's thinking ladder, lowest first (pi-ai's EXTENDED_THINKING_LEVELS). */
const LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The level pi runs a model at when asked for `level` (pi-ai's clampThinkingLevel, over the
    model's offered levels): itself when offered, else the next offered one up, else the next down. Pure. */
export function clampLevel(level: string, offered: string[]): string {
  if (offered.includes(level)) return level;
  const i = LADDER.indexOf(level);
  if (i === -1) return offered[0] ?? "off";
  for (let j = i; j < LADDER.length; j++) if (offered.includes(LADDER[j]!)) return LADDER[j]!;
  for (let j = i - 1; j >= 0; j--) if (offered.includes(LADDER[j]!)) return LADDER[j]!;
  return offered[0] ?? "off";
}

/** The three model/thinking pairs of the settings, each with the model it runs on. */
const PAIRS = [
  { thinking: "thinking", model: (s: ProjectOverseerSettings, d: string | null) => s.model ?? d },
  { thinking: "codingThinking", model: (s: ProjectOverseerSettings, d: string | null) => s.codingModel ?? s.model ?? d },
  { thinking: "gatheringThinking", model: (s: ProjectOverseerSettings, d: string | null) => s.gatheringModel ?? s.model ?? d },
] as const;

/**
 * Every stored thinking level the model it runs on offers (§app.project-overseer/identity): one
 * the PATCH names itself is refused with the levels offered; one a model change left behind is
 * brought to the level pi would run it at, and saved. A model not in `models` (unknown here, e.g.
 * a provider switched off) is not judged. Mutates `next`.
 */
export function fitThinking(next: ProjectOverseerSettings, patch: ProjectOverseerPatch, models: { ref: string; thinkingLevels: string[] }[], defaultModel: string | null): void {
  for (const pair of PAIRS) {
    const level = next[pair.thinking];
    const ref = pair.model(next, defaultModel);
    if (!level || !ref) continue;
    const offered = models.find((m) => m.ref === ref)?.thinkingLevels;
    if (!offered?.length || offered.includes(level)) continue;
    if (patch[pair.thinking] !== undefined) throw new OrgError(`${ref} offers thinking ${offered.join(", ")}.`);
    next[pair.thinking] = clampLevel(level, offered);
  }
}

/** A PATCH: strict (the first problem is the answer, as a sentence), then merged and written.
    `check` runs on the merged settings before anything is written (a throw writes nothing). */
export function patchPoSettings(p: ProjectOverseerPaths, body: unknown, check?: (next: ProjectOverseerSettings, patch: ProjectOverseerPatch) => void): ProjectOverseerSettings {
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
  if (patch.gatheringAbilities !== undefined) {
    const a = checkAbilitiesPatch(patch.gatheringAbilities);
    if (a && "error" in a) throw new OrgError(a.error);
    next.gatheringAbilities = a;
  }
  if (patch.watchGapMin !== undefined) {
    const why = gapProblem(patch.watchGapMin);
    if (why) throw new OrgError(why);
    next.watchGapMin = patch.watchGapMin;
  }
  if (patch.soonLookSec !== undefined) {
    const why = soonProblem(patch.soonLookSec);
    if (why) throw new OrgError(why);
    next.soonLookSec = patch.soonLookSec;
  }
  if (patch.watch !== undefined) {
    if (typeof patch.watch !== "boolean") throw new OrgError("watch must be true or false");
    next.watch = patch.watch;
  }
  if (patch.holdMin !== undefined) {
    const why = holdProblem(patch.holdMin);
    if (why) throw new OrgError(why);
    next.holdMin = patch.holdMin;
  }
  if (patch.confirmKinds !== undefined) {
    const why = confirmKindsProblem(patch.confirmKinds);
    if (why) throw new OrgError(why);
    next.confirmKinds = CONFIRM_KINDS.filter((k) => patch.confirmKinds!.includes(k));
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
      const why = capProblem(k as keyof ProjectOverseerCaps, v);
      if (why) throw new OrgError(why);
      next.caps = { ...next.caps, [k]: v };
    }
  }
  check?.(next, patch);
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
  /** The last unattended run: `started` while it runs, then how it ended (§app.project-overseer/watch-loop). */
  lastRun: { at: string; reasons: string[]; outcome: LastRunOutcome; detail?: string } | null;
  /** Unattended runs per local day, `YYYY-MM-DD` → count (the last few days only). */
  perDay: Record<string, number>;
  /** ISO time a look is due regardless of the 10-minute gap: set by an event that should be seen
      soon (a gathering session done, a coding session's turn over, the operator's promotion), about
      a minute after the first such event since the last look. Null: none waiting. */
  soonAt: string | null;
  /** What refusals held for later, one per key, at most HELD_MAX (§app.project-overseer/limits). */
  held: HeldItem[];
}

export const HELD_MAX = 10;

function parseHeld(v: unknown): HeldItem[] {
  if (!Array.isArray(v)) return [];
  const out: HeldItem[] = [];
  for (const h of v) {
    if (!isObj(h) || typeof h.key !== "string" || typeof h.what !== "string" || typeof h.why !== "string" || typeof h.since !== "string") continue;
    if (h.retryAt !== null && typeof h.retryAt !== "string") continue;
    // The coding token budget is gone (§app.project-overseer/limits): nothing can release its held item.
    if (h.key === "budget" || out.some((x) => x.key === h.key)) continue;
    out.push({ key: h.key, what: h.what, why: h.why, since: h.since, retryAt: h.retryAt });
  }
  return out.slice(-HELD_MAX);
}

/** Add or replace the held item with this key (the first refusal's time kept); at most HELD_MAX. */
export function holdItem(m: WatchMemo, h: HeldItem): WatchMemo {
  const prev = m.held.find((x) => x.key === h.key);
  const held = [...m.held.filter((x) => x.key !== h.key), { ...h, since: prev?.since ?? h.since }].slice(-HELD_MAX);
  return { ...m, held };
}

export function readMemo(p: ProjectOverseerPaths): WatchMemo {
  const raw = readJson(p.memo);
  const m: WatchMemo = { version: 1, pending: [], lastRunAt: null, lastRun: null, perDay: {}, soonAt: null, held: [] };
  if (!isObj(raw)) return m;
  if (Array.isArray(raw.pending)) m.pending = raw.pending.filter((x): x is string => typeof x === "string").slice(-50);
  if (typeof raw.lastRunAt === "string") m.lastRunAt = raw.lastRunAt;
  if (isObj(raw.lastRun) && typeof raw.lastRun.at === "string") m.lastRun = raw.lastRun as WatchMemo["lastRun"];
  if (isObj(raw.perDay)) for (const [k, v] of Object.entries(raw.perDay)) if (typeof v === "number") m.perDay[k] = v;
  if (typeof raw.soonAt === "string") m.soonAt = raw.soonAt;
  m.held = parseHeld(raw.held);
  return m;
}

export function writeMemo(p: ProjectOverseerPaths, m: WatchMemo): void {
  // The first write of the memo also moves a legacy `started` list out of it into the repo.
  migrateStarted(p);
  const days = Object.keys(m.perDay).sort().slice(-7);
  const { version, pending, lastRunAt, lastRun, soonAt } = m;
  writeAtomic(p.memo, `${JSON.stringify({ version, pending, lastRunAt, lastRun, perDay: Object.fromEntries(days.map((d) => [d, m.perDay[d]])), soonAt, held: parseHeld(m.held) }, null, 2)}\n`);
}

// ---- the sessions it started (in the repo) ----------------------------------------------------------

export interface StartedRow {
  sessionId: string;
  /** `coding`: started by the overseer (its caps count these, and only these);
      `operator-coding`: started by the operator's Start coding session on an item — organizational
      (listed under the project), never counted against the overseer. An older Sova ignores it. */
  kind: "gathering" | "offer" | "coding" | "operator-coding";
  createdAt: string;
  /** A coding session's file on the host that started it (coding sessions are not in the repo). */
  path?: string;
  /** Legacy, read only: a coding session's input + output + cache tokens as the removed token
      budget last counted them. No model or token kinds, so the project's cost shows them as
      unpriced when the session's file isn't on this host (server/project-costs.ts). */
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
  /** A coding session's title when it started, for a host without its file (§app.project-overseer/coding-worktrees). */
  title?: string;
  /** An `operator-coding` row the global Overseer started for the operator (§app.overseer/org-attribution). */
  via?: "overseer";
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
      ...(typeof s.title === "string" && s.title ? { title: s.title } : {}),
      ...(s.via === "overseer" ? { via: "overseer" as const } : {}),
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

/** The next local midnight after `d`: when a day's allowances and looks come back. */
export const nextMidnight = (d = new Date()): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

export const dayKey = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Record a session it started (the listing and the concurrency caps). */
export function noteStarted(p: ProjectOverseerPaths, sessionId: string, kind: StartedRow["kind"], now = new Date(), path?: string, extra: Pick<StartedRow, "worktree" | "inRoot" | "title" | "via"> = {}): void {
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

// The org engine stamps every act with its project's settings as read now.
setProjectSettingsSource({ read: (orgId, projectId, workspace) => readPoSettings(projectOverseerPaths(orgId, projectId, workspace)), defaults: defaultPoSettings });

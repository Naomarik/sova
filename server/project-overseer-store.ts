import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { lineEntry } from "./harness/pi/reader";
import { PROJECT_OVERSEER } from "./harness/state-kinds";
import { stateView } from "./harness/state-view";
import { canonicalPath } from "./paths";
import {
  AT_ONCE_MAX,
  AUTONOMY_LEVELS,
  capProblem,
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
import type { ProjectSummary } from "../shared/projects";
import {
  applyPowersPatch,
  type Brake,
  brakeOf,
  PAUSED_BRAKE_REASON,
  carryOver,
  derivedAutonomy,
  effectivePowers,
  type PowerMap,
  powersPatchProblem,
  readStoredPowers,
  stampedSettingsFile,
  type StoredPowers,
  WORK_KINDS,
} from "../shared/powers";
import type { OverseerState } from "../shared/protocol";
import { setProjectSettingsSource } from "./org-engine";
import { EXTRA_PROMPT_MAX, HISTORY_MAX, writeAtomic } from "./overseer-store";
import { OrgError } from "./org-error";
import { engineOf, projectDir, projectHost, projectSid, readProject, watchSid } from "./projects/spaces";
import { checkAbilitiesPatch, parseAbilities } from "./gathering-abilities";
import { stateRoot } from "./state-root";
import { parseOverseerMemory } from "./memory/settings";

/**
 * The project overseer's files (§app.project-overseer/identity): per project, in the org's
 * workspace repo, under `projects/<projectId>/overseer/`, so they move with the org and are
 * committed with it — settings, state, notes, actions, ideas and to-dos (the sessions it started are
 * the build and baton statecharts', server/build-loadout.ts). What the project's sessions cost is in `projects/<projectId>/costs.json` and
 * `usage.jsonl` (server/project-costs.ts, §app.project-costs/ledger).
 * Only the counters (each message's and each day's) and the watch loop's timing (pending reasons,
 * last run, runs per day, held items) are host-local: a restore starts them fresh. The stores are the Overseer's own
 * (server/overseer-store.ts, overseer-ideas.ts, overseer-todos.ts), called with these paths.
 */

export interface ProjectOverseerPaths {
  projectId: string;
  /** `<workspace>/projects/<pid>/overseer`. */
  dir: string;
  settings: string;
  notes: string;
  actions: string;
  ideas: string;
  todos: string;
}

const SAFE_ID = /^[a-z0-9_]{1,40}$/;

/** `workspace`: the engine's directory (default: the open engine that holds the project). */
export function projectOverseerPaths(projectId: string, workspace?: string): ProjectOverseerPaths {
  // The id becomes a path segment: never anything but the store's own id shape.
  if (!SAFE_ID.test(projectId)) throw new OrgError("Unknown project", 404);
  if (workspace !== undefined && !isAbsolute(workspace)) throw new Error(`projectOverseerPaths: the engine's directory must be absolute, not ${JSON.stringify(workspace)}`);
  const dir = join(workspace ?? projectDir(projectId), "projects", projectId, "overseer");
  return {
    projectId,
    dir,
    settings: join(dir, "overseer.json"),
    notes: join(dir, "notes.md"),
    actions: join(dir, "actions.jsonl"),
    ideas: join(dir, "ideas"),
    todos: join(dir, "todos.json"),
  };
}

/** The project, or a 404. */
export const projectOf = (projectId: string): ProjectSummary => readProject(projectId);

// ---- settings --------------------------------------------------------------------------------

export { DEFAULT_PO_CAPS };

export function defaultPoSettings(): ProjectOverseerSettings {
  // A new project: the overseer column carries over from L1, the Project Assistant's is all Off. No note: nothing carried over.
  const powers = { ...readStoredPowers({ autonomy: DEFAULT_AUTONOMY }), note: null };
  return {
    version: 1,
    autonomy: powers.derivedAutonomy,
    powers,
    model: null,
    thinking: null,
    codingModel: null,
    codingThinking: null,
    gatheringModel: null,
    gatheringThinking: null,
    gatheringAbilities: null,
    caps: { ...DEFAULT_PO_CAPS },
    watchGapMin: DEFAULT_WATCH_GAP_MIN,
    soonLookSec: DEFAULT_SOON_LOOK_SEC,
    watch: true,
    holdMin: DEFAULT_HOLD_MIN,
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
  // The powers (shared/powers.ts readStoredPowers: carry-over, an older Sova's re-derive, per-key defaults);
  // the level is always the one derived from them, never looser.
  const powers = readStoredPowers(raw);
  return {
    version: 1,
    autonomy: powers.derivedAutonomy,
    powers,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
    thinking: typeof raw.thinking === "string" && raw.thinking.trim() ? raw.thinking.trim() : null,
    codingModel: typeof raw.codingModel === "string" && raw.codingModel.trim() ? raw.codingModel.trim() : null,
    codingThinking: typeof raw.codingThinking === "string" && raw.codingThinking.trim() ? raw.codingThinking.trim() : null,
    gatheringModel: typeof raw.gatheringModel === "string" && raw.gatheringModel.trim() ? raw.gatheringModel.trim() : null,
    gatheringThinking: typeof raw.gatheringThinking === "string" && raw.gatheringThinking.trim() ? raw.gatheringThinking.trim() : null,
    gatheringAbilities: parseAbilities(raw.gatheringAbilities),
    caps,
    watchGapMin: gapProblem(raw.watchGapMin) === null ? (raw.watchGapMin as number) : d.watchGapMin,
    soonLookSec: "soonLookSec" in raw && soonProblem(raw.soonLookSec) === null ? (raw.soonLookSec as number | null) : d.soonLookSec,
    watch: typeof raw.watch === "boolean" ? raw.watch : d.watch,
    // Over the maximum still means "as long as allowed"; any other bad value, the default.
    holdMin: typeof raw.holdMin === "number" && Number.isInteger(raw.holdMin) && raw.holdMin > HOLD_MIN_MAX ? HOLD_MIN_MAX : holdProblem(raw.holdMin) === null ? (raw.holdMin as number) : d.holdMin,
    // confirmKinds / confirmKindsKnown: read and ignored (al_3 q2), never written again.
    extraSystemPrompt: typeof raw.extraSystemPrompt === "string" ? raw.extraSystemPrompt.slice(0, EXTRA_PROMPT_MAX) : "",
    // Its memory switch, kept only as saved (absent: no choice made, on by default).
    ...(parseOverseerMemory(raw.memory) ? { memory: parseOverseerMemory(raw.memory)! } : {}),
  };
}

export const readPoSettings = (p: ProjectOverseerPaths): ProjectOverseerSettings => parsePoSettings(readJson(p.settings));

/** The file as written: `autonomy` and `powers.derivedAutonomy` both the never-looser level of the
    overseer column (an older Sova reading only the level is never looser); no confirmKinds; `powers.stamp`. */
export function poSettingsFile(s: ProjectOverseerSettings): Record<string, unknown> {
  const level = derivedAutonomy(s.powers.overseer);
  const { confirmKinds: _gone, ...rest } = s;
  // Stamped last (shared/powers.ts powersStamp): a later save by an older Sova is told by the stamp moving.
  return stampedSettingsFile({ ...rest, autonomy: level, powers: { ...s.powers, derivedAutonomy: level } });
}

export function writePoSettings(p: ProjectOverseerPaths, s: ProjectOverseerSettings): ProjectOverseerSettings {
  const file = poSettingsFile(s);
  writeAtomic(p.settings, `${JSON.stringify(file, null, 2)}\n`);
  return parsePoSettings(file);
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

export const CODING_MODE_GONE = "Projects have no coding mode: coding sessions start in this computer's default mode. Save as default in a chat's mode menu changes it.";

/** A PATCH: strict (the first problem is the answer, as a sentence), then merged and written.
    `check` runs on the merged settings before anything is written (a throw writes nothing). */
export function patchPoSettings(p: ProjectOverseerPaths, body: unknown, check?: (next: ProjectOverseerSettings, patch: ProjectOverseerPatch) => void): ProjectOverseerSettings {
  if (!isObj(body)) throw new OrgError("Expected a JSON object body");
  const patch = body as ProjectOverseerPatch;
  const next = readPoSettings(p);
  // One release only: an old client's level sets the overseer column by the carry-over (the caller ends the pause).
  if (patch.autonomy !== undefined) {
    if (!isAutonomy(patch.autonomy)) throw new OrgError(`autonomy must be one of ${AUTONOMY_LEVELS.join(", ")}`);
    next.powers = { ...next.powers, overseer: carryOver(patch.autonomy) };
  }
  if (patch.powers !== undefined) {
    const why = powersPatchProblem(patch.powers);
    if (why) throw new OrgError(why);
    next.powers = applyPowersPatch(next.powers, patch.powers);
  }
  if (patch.powersNoteSeen !== undefined) {
    if (patch.powersNoteSeen !== true) throw new OrgError("powersNoteSeen must be true");
    if (next.powers.note) next.powers = { ...next.powers, note: { ...next.powers.note, seen: true } };
  }
  if (patch.resume !== undefined && patch.resume !== true) throw new OrgError("resume must be true");
  if (patch.assistantModels !== undefined) {
    const why = workModelsProblem(patch.assistantModels);
    if (why) throw new OrgError(why);
    const m = patch.assistantModels;
    const { assistantModels: _old, ...rest } = next.powers;
    next.powers = m === null || Object.keys(m).length === 0 ? rest : { ...rest, assistantModels: m };
  }
  next.autonomy = derivedAutonomy(next.powers.overseer);
  for (const k of ["model", "thinking", "codingModel", "codingThinking", "gatheringModel", "gatheringThinking"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") throw new OrgError(`${k} must be a string or null`);
    next[k] = typeof v === "string" && v.trim() ? v.trim() : null;
  }
  // Projects have no coding mode (§app.project-overseer/coding-mode): a patch naming one is refused, never ignored.
  if ((body as Record<string, unknown>).codingMode !== undefined) throw new OrgError(CODING_MODE_GONE);
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
  // confirmKinds: one release only, accepted and ignored (al_3 q2).
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

/** Why a WorkModels value can't be saved, or null. Pure. */
export function workModelsProblem(v: unknown): string | null {
  if (v === null) return null;
  if (!isObj(v)) return "assistantModels must be an object of reply, coding and gathering picks, or null.";
  for (const [k, x] of Object.entries(v)) {
    if (!(WORK_KINDS as readonly string[]).includes(k)) return `assistantModels has no kind of work "${k}": use ${WORK_KINDS.join(", ")}.`;
    if (x === null) continue;
    if (!isObj(x) || typeof x.model !== "string" || !x.model.trim()) return `assistantModels.${k} must be { model: "provider/model", thinking? } or null.`;
    if (x.thinking !== undefined && x.thinking !== null && typeof x.thinking !== "string") return `assistantModels.${k}.thinking must be a thinking level or null.`;
  }
  return null;
}

// ---- the powers in force ----------------------------------------------------------------------

/** Both columns after the brake, the brake, and the never-looser level of the overseer column in force (old clients). Pure. */
export function powersInForce(
  powers: StoredPowers,
  ceiling: { reason: string } | null,
  pausedSince: string | null = null,
): { overseer: PowerMap; assistant: PowerMap; brake: Brake | null; autonomy: Autonomy; reason?: string } {
  const brake = brakeOf({ paused: !!pausedSince, ceiling, emptyRosterResumed: !!powers.emptyRosterResumedAt });
  const overseer = effectivePowers(powers.overseer, brake);
  return { overseer, assistant: effectivePowers(powers.assistant, brake), brake, autonomy: derivedAutonomy(overseer), ...(brake ? { reason: brake.reason } : {}) };
}

// ---- autonomy in force (older readers) ------------------------------------------------------------

export const PAUSED_REASON = PAUSED_BRAKE_REASON;

/**
 * The level in force: L0 while the overseer is paused by an attach on this host (`pausedSince`, until
 * the operator sets its level here), then a contributed ceiling below the setting, then the setting.
 */
export function effectiveAutonomy(
  settings: Pick<ProjectOverseerSettings, "autonomy">,
  ceiling: { autonomy: Autonomy; reason: string } | null,
  pausedSince: string | null = null,
): { autonomy: Autonomy; reason?: string } {
  if (pausedSince) return { autonomy: "L0", reason: PAUSED_REASON };
  if (ceiling && !levelAtLeast(ceiling.autonomy, settings.autonomy)) return { autonomy: ceiling.autonomy, reason: ceiling.reason };
  return { autonomy: settings.autonomy };
}

export const levelAtLeast = (have: Autonomy, need: Autonomy): boolean => AUTONOMY_LEVELS.indexOf(have) >= AUTONOMY_LEVELS.indexOf(need);

// ---- state: current conversation + history ------------------------------------------------------

/** Its conversations, current and at most 20 earlier ones, newest first: the project statechart's overseer
    region (q1: no state.json). Null while it has none (or its org's engine is not open here). */
export function readPoState(p: Pick<ProjectOverseerPaths, "projectId">): OverseerState | null {
  if (!engineOf(p.projectId)) return null;
  const o = projectHost(p.projectId).data(projectSid(p.projectId))?.overseer as { id?: unknown; history?: unknown } | undefined;
  if (!o || typeof o.id !== "string" || !o.id) return null;
  return { version: 1, current: o.id, history: Array.isArray(o.history) ? o.history.filter((x): x is string => typeof x === "string") : [] };
}
export const isPoId = (p: ProjectOverseerPaths, id: string | undefined, state = readPoState(p)): boolean =>
  !!id && !!state && (state.current === id || state.history.includes(id));
export { HISTORY_MAX };

// ---- the watch loop, as the pages read it (host-local: its watch statechart) ------------------------------

/** The watch statechart's loop as the pages and tools read it (design §3.5; q1: no watch.json). */
export interface WatchMemo {
  version: 1;
  /** Reasons noted since the last look. */
  pending: string[];
  /** ISO of the last unattended run it started. */
  lastRunAt: string | null;
  /** The last unattended run: `started` while it runs, then how it ended (§app.project-overseer/watch-loop). */
  lastRun: { at: string; reasons: string[]; outcome: LastRunOutcome; detail?: string } | null;
  /** Unattended runs today, `YYYY-MM-DD` → count. */
  perDay: Record<string, number>;
  /** ISO time a look is due regardless of the gap: set by an event that should be seen soon (a
      gathering session done, a coding session's turn over, the operator's promotion), about a minute
      after the first such event since the last look. Null: none waiting. */
  soonAt: string | null;
  /** What refusals held for later, one per key, at most HELD_MAX (§app.project-overseer/limits). */
  held: HeldItem[];
}

export const HELD_MAX = 10;

const isoAt = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === "string" && v ? v : null);

/** The project's watch as it stands (an empty loop when its org's engine or watch isn't here). */
export function readMemo(p: Pick<ProjectOverseerPaths, "projectId">): WatchMemo {
  const m: WatchMemo = { version: 1, pending: [], lastRunAt: null, lastRun: null, perDay: {}, soonAt: null, held: [] };
  if (!engineOf(p.projectId)) return m;
  const d = projectHost(p.projectId).data(watchSid(p.projectId));
  if (!d) return m;
  if (Array.isArray(d.reasons)) m.pending = d.reasons.filter(isObj).map((r) => String(r.text ?? ""));
  m.lastRunAt = isoAt(d.lastRunAt);
  const run = d.lastRun;
  if (isObj(run) && isoAt(run.at))
    m.lastRun = {
      at: isoAt(run.at)!,
      reasons: Array.isArray(run.reasons) ? run.reasons.filter((x): x is string => typeof x === "string") : [],
      outcome: run.outcome as LastRunOutcome,
      ...(typeof run.detail === "string" ? { detail: run.detail } : {}),
    };
  const day = typeof d.day === "string" ? d.day : dayKey(new Date(typeof d.now === "number" ? d.now : Date.now()));
  if (typeof d.looksToday === "number") m.perDay[day] = d.looksToday;
  m.soonAt = isoAt(d.soonAt);
  if (Array.isArray(d.held))
    m.held = d.held.filter(isObj).map((h) => ({ key: String(h.key), what: String(h.what ?? ""), why: String(h.why ?? ""), since: isoAt(h.since) ?? "", retryAt: isoAt(h.retryAt) }));
  return m;
}

/** The next local midnight after `d`: when a day's allowances and looks come back. */
export const nextMidnight = (d = new Date()): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

export const dayKey = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ---- which files are project overseers ------------------------------------------------------------

const markerMemo = new Map<string, { mtimeMs: number; data: ProjectOverseerMarkerData | null }>();
/** Far above any install's session count: a listing asks for every file, and a memo smaller than that
    would read them all again on each rebuild. Past it, the paths asked for longest ago go first. */
export const MARKER_MEMO_MAX = 50_000;
/** The one buffer every marker read uses (reads are synchronous, so never shared mid-read). */
const markerBuf = Buffer.alloc(16 * 1024);

/** The marker's data from a file's first 16KB (the marker is line 2), cached per mtime: an unchanged file is never read again. */
export function readPoMarker(path: string): ProjectOverseerMarkerData | null {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    markerMemo.delete(path);
    return null;
  }
  const hit = markerMemo.get(path);
  if (hit && hit.mtimeMs === mtimeMs) {
    // Kept as the most recently asked for (a Map iterates in insertion order).
    markerMemo.delete(path);
    markerMemo.set(path, hit);
    return hit.data;
  }
  let data: ProjectOverseerMarkerData | null = null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const n = readSync(fd, markerBuf, 0, markerBuf.length, 0);
    for (const line of markerBuf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes(PROJECT_OVERSEER_ENTRY)) continue;
      // A torn line reads as nothing: keep looking. Any other key is ignored: the project id is the identity.
      const h = lineEntry(line);
      const marker = h ? stateView([h]).latest(PROJECT_OVERSEER)?.data : undefined;
      if (marker) {
        data = marker;
        break;
      }
    }
  } catch {
    data = null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
  markerMemo.delete(path);
  markerMemo.set(path, { mtimeMs, data });
  while (markerMemo.size > MARKER_MEMO_MAX) markerMemo.delete(markerMemo.keys().next().value!);
  return data;
}

/**
 * The project a session file is the overseer of, or null: it carries the marker, lives in the sessions
 * dir of the engine that holds that project, and the project's state knows its id (current or history).
 * A copy anywhere else, or a fork, is an ordinary session.
 */
export function projectOverseerOfPath(path: string, id = sessionIdOfFile(path)): { projectId: string } | null {
  const m = readPoMarker(path);
  if (!m) return null;
  try {
    if (dirname(canonicalPath(path)) !== canonicalPath(join(projectDir(m.projectId), "sessions"))) return null;
    return isPoId(projectOverseerPaths(m.projectId), id) ? { projectId: m.projectId } : null;
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

// Every engine stamps each act with its project's settings as read now.
setProjectSettingsSource({ read: (projectId, workspace) => readPoSettings(projectOverseerPaths(projectId, workspace)), defaults: defaultPoSettings });

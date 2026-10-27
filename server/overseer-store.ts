import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  OverseerAction,
  OverseerCaps,
  OverseerProactivity,
  OverseerQuickAction,
  OverseerSettings,
  OverseerState,
  WorkerChoice,
} from "../shared/protocol";
import { parseChoice } from "../pi-config/extensions/mode/delegate.ts";
import { canonicalClaudeId, latestClaude, resolveClaude } from "../pi-config/extensions/claude-code/catalog.ts";
import { type Redactor, serverRedactor } from "./overseer-redact";
import { stateRoot } from "./state-root";
import { sessionsChanged } from "./list-generation";

/**
 * The Overseer's Sova-owned files under the state root. Same store rules as web-sessions.ts:
 * atomic tmp+rename, re-read before every write, tolerant on read. Settings and state are split
 * on purpose, so a Settings save and a /clear never race on one file. Every path is read per call
 * (PI_CODING_AGENT_DIR is what the tests move), and every function takes its file as an optional
 * last argument for the same reason.
 */
export const overseerDir = () => join(stateRoot(), "overseer");
export const overseerSettingsFile = () => join(stateRoot(), "overseer.json");
export const overseerStateFile = () => join(stateRoot(), "overseer-state.json");
export const overseerNotesFile = () => join(stateRoot(), "overseer-notes.md");
export const overseerActionsFile = () => join(stateRoot(), "overseer-actions.jsonl");
/** The per-turn cap counters (server/overseer-tools.ts TurnLimits), so a restart keeps them. */
export const overseerTurnFile = () => join(stateRoot(), "overseer-turn.json");

/** How many previous Overseer files are kept (hidden, openable read-only). Older ones are deleted. */
export const HISTORY_MAX = 20;
/** Standing notes: what the prompt carries is capped, and so is what a save accepts. */
export const NOTES_MAX = 8000;
export const EXTRA_PROMPT_MAX = 8000;
const QUICK_ACTIONS_MAX = 12;
const CAP_MAX = 500;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PROACTIVITY: readonly OverseerProactivity[] = ["off", "badge", "brief"];

export const DEFAULT_CAPS: OverseerCaps = { createPerTurn: 5, promptsPerTurn: 10, archivesPerTurn: 50, concurrentSessions: 10, explorePerTurn: 2, linksPerTurn: 3, orgWritesPerTurn: 20, gatherPerTurn: 3 };

/** Claude Opus 5 by any spelling (its catalog id, a 1M variant, a pi ref), never Opus 5.5 (`claude-opus-5-5`). */
const isOpus5 = (model: string): boolean => resolveClaude(model)?.id === "claude-opus-5";

/** The exploratory agent sova_idea `explore` launches: the Claude catalog's current Opus through Claude Code. */
export const DEFAULT_EXPLORER: WorkerChoice = { backend: "claude-code", model: latestClaude("opus").id, effort: "medium" };

/** The settings file's version. 2: the quick actions moved off the old five (OLD_QUICK_ACTIONS). */
export const SETTINGS_VERSION = 2;

export const DEFAULT_QUICK_ACTIONS: OverseerQuickAction[] = [
  {
    id: "get-moving",
    label: "Get Things Moving",
    description: "Every session stuck on a next step, checked now, on one card. Nothing is sent until you apply.",
    prompt:
      "Get things moving. Find every session from the last few days that is stuck on a next step: waiting on my go-ahead, ready to land, a failed check, a finished plan not yet built, a merge conflict, or an error that stopped its turn. Check each one now: its last reply, its branch and merge state, its last check (passed or failed, before or after the newest commit), and its open questions with their recommendations. Drop anything that has merged or moved on, and rebuild the card if a session changes while you work. Then give me one card, one row per session, under a section for why it is stuck: what it is, why it's stuck, and the exact message your Go sends. Default each row to your recommendation, and default risky ones (conflicts, publishing, failures unrelated to the work) to Not Yet. A row with a real choice gets its own options. Sessions that only wait on their own questions go in a list under the card with your recommendations, not on the card. Send nothing until I apply.",
  },
  {
    id: "tidy",
    label: "Tidy Up",
    description: "Finished and stale sessions sorted onto one card to archive or keep. Nothing is archived until you apply.",
    prompt:
      "Tidy up. Look at every session started in Sova that isn't archived, and check each one now: its last reply, its branch and merge state, uncommitted changes, open questions, and whether anything is running in it. Sort them into sections. Done: the work merged, or the research or answer was delivered. Stale: it went nowhere (paused, no work done, idle with nothing built). Worth Keeping: unmerged work, uncommitted changes, open questions, or anything still running. Then give me one card, one row per session, under its section. Each row's note says what it was, what state it's in and why archiving fits, or, under Worth Keeping, what archiving would put at risk. Rows under Done and Stale default to Archive, rows under Worth Keeping to Keep. On a Done row whose work merged, offer Archive & Remove Worktree and default to it. Leave out sessions open in a terminal or working right now, and say how many you left out and why. Archive nothing until I apply.",
  },
];

/**
 * The five quick actions Sova shipped before version 2, exactly as they shipped. A version 1 file
 * whose list is exactly these, in this order, moves to DEFAULT_QUICK_ACTIONS once
 * (moveOldQuickActions); nothing compares with them after that.
 */
export const OLD_QUICK_ACTIONS: readonly OverseerQuickAction[] = [
  { id: "needs-me", label: "What Needs Me", description: "Sessions waiting on you, with links.", prompt: "What needs my attention? Link each session." },
  { id: "finished", label: "What Finished", description: "Work that finished since you last looked.", prompt: "What finished since I last looked, and what's the result?" },
  { id: "running", label: "What's Running", description: "Sessions, workers and teams running now.", prompt: "Summarise what's running now, including workers and teams." },
  { id: "tidy", label: "Tidy Up", description: "Archive finished and stale sessions, group loose ones.", prompt: "Archive finished and stale web sessions, group loose ones by project, and tell me what you did." },
  { id: "where-was-i", label: "Where Was I", description: "What you were last on, and the next step in each.", prompt: "What was I last working on, and what's the next step in each?" },
];

export function defaultSettings(): OverseerSettings {
  return {
    version: SETTINGS_VERSION,
    model: null,
    thinking: null,
    extraSystemPrompt: "",
    proactivity: "badge",
    quickActions: DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a })),
    caps: { ...DEFAULT_CAPS },
    explorer: { ...DEFAULT_EXPLORER },
  };
}

export function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  sessionsChanged(); // overseer and project-overseer state decide rows' special fields
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCap = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= CAP_MAX;

// ---- settings --------------------------------------------------------------------------------

/** A quick action as stored, or an error sentence. `strict` refuses what `tolerant` would drop. */
function parseQuickAction(raw: unknown, i: number): OverseerQuickAction | string {
  if (!isObj(raw)) return `quickActions[${i}] must be an object`;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!label || label.length > 40) return `quickActions[${i}].label must be 1–40 characters`;
  if (!prompt || prompt.length > 2000) return `quickActions[${i}].prompt must be 1–2000 characters`;
  if (description.length > 120) return `quickActions[${i}].description must be at most 120 characters`;
  const id = typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : `qa-${i}`;
  return { id, label, description, prompt };
}

/**
 * Parse settings. `strict` (a PUT): the first problem is the answer, as a sentence. Tolerant (a
 * read): every bad field falls back to its default, so a hand-edited file never breaks the Overseer.
 */
export function parseSettings(raw: unknown, strict: boolean): OverseerSettings | { error: string } {
  const d = defaultSettings();
  if (!isObj(raw)) return strict ? { error: "Expected a JSON object" } : d;
  const fail = (error: string) => (strict ? { error } : null);
  const out = d;
  if (raw.model !== undefined && raw.model !== null) {
    // An old Claude Code id reads as its catalog model (§app.claude-code-provider/legacy-ids).
    if (typeof raw.model === "string" && /^[^/\s]+\/\S+$/.test(raw.model.trim())) out.model = raw.model.trim().startsWith("claude-code-cli/") ? canonicalClaudeId(raw.model.trim()) : raw.model.trim();
    else {
      const e = fail('model must be "provider/model" or null');
      if (e) return e;
    }
  }
  if (raw.thinking !== undefined && raw.thinking !== null) {
    if (typeof raw.thinking === "string" && THINKING_LEVELS.includes(raw.thinking)) out.thinking = raw.thinking;
    else {
      const e = fail(`thinking must be one of ${THINKING_LEVELS.join(", ")}, or null`);
      if (e) return e;
    }
  }
  if (raw.extraSystemPrompt !== undefined) {
    if (typeof raw.extraSystemPrompt === "string" && raw.extraSystemPrompt.length <= EXTRA_PROMPT_MAX) out.extraSystemPrompt = raw.extraSystemPrompt;
    else {
      const e = fail(`extraSystemPrompt must be a string of at most ${EXTRA_PROMPT_MAX} characters`);
      if (e) return e;
    }
  }
  if (raw.proactivity !== undefined) {
    if (PROACTIVITY.includes(raw.proactivity as OverseerProactivity)) out.proactivity = raw.proactivity as OverseerProactivity;
    else {
      const e = fail('proactivity must be "off", "badge" or "brief"');
      if (e) return e;
    }
  }
  if (raw.quickActions !== undefined) {
    if (!Array.isArray(raw.quickActions) || raw.quickActions.length > QUICK_ACTIONS_MAX) {
      const e = fail(`quickActions must be a list of at most ${QUICK_ACTIONS_MAX}`);
      if (e) return e;
    } else {
      const list: OverseerQuickAction[] = [];
      const ids = new Set<string>();
      for (const [i, a] of raw.quickActions.entries()) {
        const qa = parseQuickAction(a, i);
        if (typeof qa === "string") {
          if (strict) return { error: qa };
          continue;
        }
        while (ids.has(qa.id)) qa.id = `${qa.id}-${i}`;
        ids.add(qa.id);
        list.push(qa);
      }
      out.quickActions = list;
    }
  }
  if (raw.caps !== undefined) {
    if (!isObj(raw.caps)) {
      const e = fail("caps must be an object");
      if (e) return e;
    } else {
      for (const key of Object.keys(DEFAULT_CAPS) as (keyof OverseerCaps)[]) {
        const v = raw.caps[key];
        if (v === undefined) continue;
        if (isCap(v)) out.caps[key] = v;
        else if (strict) return { error: `caps.${key} must be a whole number from 0 to ${CAP_MAX}` };
      }
    }
  }
  if (raw.explorer !== undefined) {
    const parsed = parseChoice(raw.explorer);
    // The user's rule: the explorer never runs Claude Opus 5.
    const opus = latestClaude("opus");
    const choice = "error" in parsed || !isOpus5(parsed.model) ? parsed : { error: `${parsed.model} is not allowed for the exploratory agent; use ${opus.id} (${opus.name})` };
    if (!("error" in choice)) out.explorer = choice;
    else if (strict) return { error: `explorer: ${choice.error}` };
  }
  if (raw.memory !== undefined) {
    const m = raw.memory;
    const ok = isObj(m) && typeof m.on === "boolean" && (m.type === "uniichat" || m.type === "zoomable");
    // A size an older file holds is kept as it is, and read by nothing: the size is Settings → Memory's.
    const size = ok && Number.isInteger(m.size) && (m.size as number) >= 8 && (m.size as number) <= 512 ? (m.size as number) : undefined;
    if (ok) out.memory = { on: m.on as boolean, type: m.type as "uniichat" | "zoomable", ...(size !== undefined ? { size } : {}) };
    else {
      const e = fail("memory must be { on, type }");
      if (e) return e;
    }
  }
  if (raw.autoResume !== undefined) {
    if (typeof raw.autoResume === "boolean") out.autoResume = raw.autoResume;
    else {
      const e = fail("autoResume must be true or false");
      if (e) return e;
    }
  }
  return out;
}

/** Whether a stored list is exactly the old five as shipped: same keys and values, same order. */
function isOldFive(list: unknown): boolean {
  if (!Array.isArray(list) || list.length !== OLD_QUICK_ACTIONS.length) return false;
  return list.every((raw, i) => {
    const old = OLD_QUICK_ACTIONS[i]!;
    if (!isObj(raw)) return false;
    const keys = Object.keys(raw).sort();
    return keys.join(",") === "description,id,label,prompt" && raw.id === old.id && raw.label === old.label && raw.description === old.description && raw.prompt === old.prompt;
  });
}

/**
 * The one-time move to version 2 (§app.overseer/quick-actions-move): a stored object older than
 * version 2 gets the new defaults in place of a list that is exactly the old five, any other list
 * kept as it is, and every other field as stored. Null when the file needs no move.
 */
export function moveOldQuickActions(raw: unknown): Record<string, unknown> | null {
  if (!isObj(raw)) return null;
  const v = raw.version;
  if (typeof v === "number" && v >= SETTINGS_VERSION) return null;
  const next: Record<string, unknown> = { ...raw, version: SETTINGS_VERSION };
  if (isOldFive(raw.quickActions)) next.quickActions = DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a }));
  return next;
}

export function readOverseerSettings(file = overseerSettingsFile()): OverseerSettings {
  let raw = readJson(file);
  const moved = moveOldQuickActions(raw);
  if (moved) {
    raw = moved;
    try {
      writeAtomic(file, `${JSON.stringify(moved, null, 2)}\n`);
    } catch (err) {
      // The move is read again next time; the settings it read still stand for this one.
      console.warn("[overseer] settings move to version 2 not written:", err instanceof Error ? err.message : String(err));
    }
  }
  const parsed = parseSettings(raw, false);
  return "error" in parsed ? defaultSettings() : parsed;
}

export function writeOverseerSettings(settings: OverseerSettings, file = overseerSettingsFile()): OverseerSettings {
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

/** Merge one or two fields into the stored settings (the composer's model/thinking write-back). */
export function patchOverseerSettings(patch: Partial<Pick<OverseerSettings, "model" | "thinking">>, file = overseerSettingsFile()): OverseerSettings {
  const next = { ...readOverseerSettings(file), ...patch };
  return writeOverseerSettings(next, file);
}

// ---- state (singleton pointer + history) -----------------------------------------------------

export function readOverseerState(file = overseerStateFile()): OverseerState | null {
  const raw = readJson(file);
  if (!isObj(raw) || typeof raw.current !== "string" || !raw.current) return null;
  const history = Array.isArray(raw.history) ? raw.history.filter((x): x is string => typeof x === "string" && x !== raw.current) : [];
  return { version: 1, current: raw.current, history: [...new Set(history)].slice(0, HISTORY_MAX) };
}

/**
 * Whether a session id is one of the Overseer's conversations: the current one or one in its
 * history. The marker alone doesn't make a file the Overseer's: a copy of a marked file (a fork,
 * such as the one /explain makes with `pi --fork`) carries it too, and is an ordinary session.
 */
export function isOverseerId(id: string | undefined, state = readOverseerState()): boolean {
  return !!id && !!state && (state.current === id || state.history.includes(id));
}

/**
 * Point `current` at `id`, pushing the previous current onto the front of history. Returns the new
 * state and the ids that fell off the end (to delete). Pure; the caller writes.
 */
export function rotateState(prev: OverseerState | null, id: string): { state: OverseerState; dropped: string[] } {
  const older = prev ? [prev.current, ...prev.history] : [];
  const history = [...new Set(older.filter((x) => x && x !== id))];
  return { state: { version: 1, current: id, history: history.slice(0, HISTORY_MAX) }, dropped: history.slice(HISTORY_MAX) };
}

export function writeOverseerState(state: OverseerState, file = overseerStateFile()): void {
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

// ---- standing notes --------------------------------------------------------------------------

export function readNotes(file = overseerNotesFile()): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function writeNotes(text: string, file = overseerNotesFile()): string {
  const t = text.length > NOTES_MAX ? text.slice(0, NOTES_MAX) : text;
  writeAtomic(file, t);
  return t;
}

// ---- audit log -------------------------------------------------------------------------------

/** Append one action line. Never throws: an audit write failing must not fail the action it records. */
export function logAction(action: OverseerAction, file = overseerActionsFile(), redactor: () => Redactor = serverRedactor): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // The tool wrapper already redacted the arguments; this holds for any other caller too.
    const r = redactor();
    action = { ...action, args: r.redactDeep(action.args), ...(action.error !== undefined ? { error: r.redact(action.error) } : {}) };
    let args = action.args;
    const json = JSON.stringify(args);
    if (json && json.length > 4000) args = { truncated: json.slice(0, 4000) };
    appendFileSync(file, `${JSON.stringify({ ...action, args })}\n`);
  } catch (err) {
    console.warn("[overseer] audit log write failed:", err instanceof Error ? err.message : String(err));
  }
}

/** A crash resume's decision, logged as a chat's is (`tool: "auto_resume"`): `why` when it was refused. */
export function logAutoResume(args: Record<string, unknown>, why?: string, file = overseerActionsFile()): void {
  logAction({ at: new Date().toISOString(), overseerId: readOverseerState()?.current ?? "", toolCallId: "", tool: "auto_resume", args, outcome: why ? "refused" : "ok", ...(why ? { error: why } : {}) }, file);
}

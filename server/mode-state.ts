// The mode extension's settings file (~/.pi/agent/mode.json), owned by pi-config's mode extension.
// The mode itself is per session; this file is the DEFAULT new sessions start from. We import
// exactly its two pure modules (state.ts, minor.ts: node:fs/node:path only) so validation, the
// minor-mode list and the restore rule have one source of truth. Nothing else from pi-config.
// See CLAUDE.md.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MINOR_DESCRIPTIONS, MINOR_MODES } from "../pi-config/extensions/mode/minor.ts";
import { isMode, loadState, normalizeState, restoreActive, saveState, type ModeState } from "../pi-config/extensions/mode/state.ts";
import type { ModeApplies, ModeInfo } from "../shared/protocol";

export type { ModeState };
export { MINOR_MODES };

export const MODE_FILE_NAME = "mode.json";
export const modeFile = () => join(getAgentDir(), MODE_FILE_NAME);

/** Copied from pi-config mode/palette.ts (not exported there; palette.ts imports the palette contract). */
const MODE_DESCRIPTIONS: Record<ModeState["mode"], string> = {
  normal: "Pi as usual",
  "claude-heavy": "Orchestrate: delegate coding and planning to Claude Code workers",
};

export function modeInfo(state: ModeState): ModeInfo {
  return {
    mode: state.mode,
    minorModes: [...state.minorModes],
    strict: state.strict,
    modes: (Object.keys(MODE_DESCRIPTIONS) as ModeState["mode"][]).map((id) => ({ id, description: MODE_DESCRIPTIONS[id] })),
    minors: MINOR_MODES.map((id) => ({ id, description: MINOR_DESCRIPTIONS[id] })),
  };
}

/** The two fields pi-web may change. */
export interface ModePatch {
  mode?: ModeState["mode"];
  minorModes?: ModeState["minorModes"];
}

/** Validate a POST /api/mode body. Unknown names are an error, not silently dropped. */
export function parseModePatch(body: unknown): ModePatch | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: "Expected JSON body { mode?, minorModes? }" };
  const b = body as Record<string, unknown>;
  const patch: ModePatch = {};
  if (b.mode !== undefined) {
    if (!isMode(b.mode)) return { error: `mode must be one of: ${Object.keys(MODE_DESCRIPTIONS).join(", ")}` };
    patch.mode = b.mode;
  }
  if (b.minorModes !== undefined) {
    if (!Array.isArray(b.minorModes)) return { error: "minorModes must be an array" };
    const unknown = b.minorModes.filter((m) => typeof m !== "string" || !(MINOR_MODES as readonly string[]).includes(m));
    if (unknown.length > 0) return { error: `Unknown minor mode: ${unknown.map(String).join(", ")} (known: ${MINOR_MODES.join(", ")})` };
    patch.minorModes = normalizeState({ minorModes: b.minorModes }).minorModes;
  }
  if (patch.mode === undefined && patch.minorModes === undefined) return { error: "Nothing to change: send mode and/or minorModes" };
  return patch;
}

/** Fresh file + our two fields. Every other field (strict, shortcuts, future ones we know) is kept. */
export function mergeMode(loaded: ModeState, patch: ModePatch): ModeState {
  return normalizeState({ ...loaded, ...patch });
}

export const readMode = (file = modeFile()): ModeState => loadState(file);

/** loadState → normalizeState({...loaded, patch}) → saveState (atomic). Returns what was written. */
export function writeMode(patch: ModePatch, file = modeFile()): ModeState {
  const next = mergeMode(loadState(file), patch);
  saveState(file, next);
  return next;
}

/** Write an already merged default again (atomic). No caller since the fan-out went; kept because
    it is the only way to write the whole file at once, e.g. to repair a field we don't patch. */
export const saveMode = (state: ModeState, file = modeFile()): void => saveState(file, state);

/** Identity of the two fields a switch carries: two states with the same key are the same switch.
    No caller since the mode.json watcher went (nothing compares file revisions now). */
export const modeKey = (s: Pick<ModeState, "mode" | "minorModes">) =>
  createHash("sha1").update(JSON.stringify([s.mode, s.minorModes])).digest("hex");

/** A session branch, as `sessionManager.getBranch()` returns it (structural, like restoreActive). */
export type BranchEntries = readonly { type: string; customType?: string; data?: unknown }[];

/**
 * One chat's own mode when it opens: the default from the file, overlaid with the newest `mode`
 * entry on its branch that carries an `active` snapshot. Same rule the extension runs in its own
 * session_start (restoreActive, imported from state.ts), so the server and the runtime agree —
 * including after a server restart. `version` and the shortcuts stay the file's.
 */
export function resolveChatMode(branch: BranchEntries, file = modeFile()): ModeState {
  const base = loadState(file);
  const active = restoreActive(branch);
  return active ? { ...base, mode: active.mode, strict: active.strict, minorModes: [...active.minorModes] } : base;
}

/**
 * How the chat a switch was sent to takes it:
 * - "skip": a foreign writer was seen; we never write it. It resolves its own mode when reopened.
 * - "unsupported": the mode extension's /mode command isn't loaded here (so nothing reads the
 *   mode); never prompt instead.
 * - "command": run the extension's own /mode handler (no reload: that would stop its workers).
 *   A never-prompted chat takes this path too — the marker entry it appends is a deliberate
 *   user write, and it is what pins this session's mode.
 */
export function modeApplyPlan(chat: { foreign: boolean; hasModeCommand: boolean; pristine: boolean; streaming: boolean }):
  "skip" | "unsupported" | "command" {
  if (chat.foreign) return "skip";
  if (!chat.hasModeCommand) return "unsupported";
  return "command";
}

/** What the chat's selector says about the last switch. */
export function appliesAfter(plan: ReturnType<typeof modeApplyPlan>, streaming: boolean): ModeApplies {
  if (plan === "skip" || plan === "unsupported") return "new-chats";
  return streaming ? "after-turn" : "now";
}

// The mode extension's settings file (~/.pi/agent/mode.json), owned by pi-config's mode extension.
// The mode itself is per session; this file is the DEFAULT new sessions start from. We import
// exactly its three pure modules (state.ts, minor.ts, and delegate.ts in server/delegate.ts:
// node:fs/node:path only) so validation, the mode and minor-mode lists, the legacy mode alias and
// the restore rule have one source of truth. Nothing else from pi-config. See CLAUDE.md.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MINOR_DESCRIPTIONS, MINOR_MODES } from "../pi-config/extensions/mode/minor.ts";
import {
  loadState,
  MODE_DESCRIPTIONS,
  MODES,
  normalizeState,
  parseMode,
  restoreActive,
  saveState,
  type ModeState,
} from "../pi-config/extensions/mode/state.ts";
import type { ModeApplies, ModeInfo } from "../shared/protocol";

export type { ModeState };
export { MINOR_MODES };

export const MODE_FILE_NAME = "mode.json";
export const modeFile = () => join(getAgentDir(), MODE_FILE_NAME);

export function modeInfo(state: ModeState): ModeInfo {
  return {
    mode: state.mode,
    minorModes: [...state.minorModes],
    strict: state.strict,
    modes: MODES.map((id) => ({ id, description: MODE_DESCRIPTIONS[id] })),
    minors: MINOR_MODES.map((id) => ({ id, description: MINOR_DESCRIPTIONS[id] })),
  };
}

/** The fields pi-web may change. A POST body only ever carries the first two (parseModePatch never
    reads `strict`); `strict` is written only by the save-as-default patch (defaultPatchOf). */
export interface ModePatch {
  mode?: ModeState["mode"];
  minorModes?: ModeState["minorModes"];
  strict?: ModeState["strict"];
}

/** What POST /api/mode was asked to do: change a chat's mode (or the default file, without a path),
    or make THIS chat's mode the default new sessions start from. */
export type ModeRequest = { kind: "patch"; patch: ModePatch } | { kind: "saveDefault" } | { error: string };

/** Validate a POST /api/mode body. Unknown names are an error, not silently dropped. A legacy mode
    name ("claude-heavy") is read as the mode it now names, and only the canonical one goes on. */
export function parseModePatch(body: unknown): ModePatch | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: "Expected JSON body { mode?, minorModes? }" };
  const b = body as Record<string, unknown>;
  const patch: ModePatch = {};
  if (b.mode !== undefined) {
    const mode = parseMode(b.mode);
    if (mode === undefined) return { error: `mode must be one of: ${MODES.join(", ")}` };
    patch.mode = mode;
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

/**
 * A whole POST /api/mode body, patch or instruction (server/index.ts).
 *
 * `{ saveDefault: true }` stands alone on purpose: it means "whatever this chat is on now", so a
 * body naming a mode as well is two intentions in one request, and one of them would silently win
 * over the other. The save path takes the chat's own state (ChatSession.saveModeDefault), never a
 * body's fields, so there is nothing for a mode field to mean here.
 */
export function parseModeRequest(body: unknown): ModeRequest {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (b?.saveDefault !== undefined) {
    if (b.saveDefault !== true) return { error: "saveDefault must be true" };
    if (b.mode !== undefined || b.minorModes !== undefined)
      return { error: "saveDefault saves this chat's own mode: send no mode or minorModes with it" };
    return { kind: "saveDefault" };
  }
  const patch = parseModePatch(body);
  return "error" in patch ? patch : { kind: "patch", patch };
}

/**
 * What `Save as default` writes for a chat on `state`: its major mode, strict flag and minor modes —
 * exactly the three fields `/mode default` writes in the TUI (saveDefault in
 * pi-config/extensions/mode/index.ts), and nothing else, so shortcuts and any other field in the
 * file are kept by writeMode's re-read. The minors are copied, never shared with the chat's state.
 */
export function defaultPatchOf(state: Pick<ModeState, "mode" | "strict" | "minorModes">): Required<ModePatch> {
  return { mode: state.mode, strict: state.strict, minorModes: [...state.minorModes] };
}

/** Fresh file + the patch's fields. Every field the patch doesn't carry (strict unless it does, shortcuts,
    future ones we know) is kept. */
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

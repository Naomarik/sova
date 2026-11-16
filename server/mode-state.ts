// The modes' default file (~/.pi/agent/mode.json), its format in pi-config/extensions/mode/state.ts.
// The mode itself is per session; this file is the DEFAULT new sessions start from. We import
// exactly its three pure modules (state.ts, minor.ts, and delegate.ts in server/delegate.ts:
// node:fs/node:path only) so validation, the mode and minor-mode lists and
// the restore rule have one source of truth. Nothing else from pi-config. See agents/modes/overview.md.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentRoot } from "./state-root";
import { MINOR_DESCRIPTIONS, MINOR_MODES } from "../pi-config/extensions/mode/minor.ts";
import {
  activeOf,
  defaultModeOf,
  loadState,
  MODE_ENTRY_TYPE,
  MODE_DESCRIPTIONS,
  MODES,
  modeSwitch,
  normalizeState,
  parseMode,
  restoreActive,
  saveState,
  withMinor,
  type ModeState,
} from "../pi-config/extensions/mode/state.ts";
import type { StateView } from "../shared/harness";
import type { ChatMemoryChoice, MemoryModeInfo, MemoryType, ModeApplies, ModeInfo, ProjectModeApproval } from "../shared/protocol";
import { parseApprovals, parseProjectModes } from "./project-mode-menu";
import { MEMORY_SIZES, MEMORY_TYPE_INFO } from "../shared/memory";
import { CREATE_NO_DEFAULT } from "../shared/profiles";
import { parseMemoryPatch } from "./memory/settings";
import { stateViewOf } from "./harness/pi/state";
import { MODE } from "./harness/state-kinds";

export type { ModeState };
export { MINOR_MODES };

export const MODE_FILE_NAME = "mode.json";
export const modeFile = () => join(agentRoot(), MODE_FILE_NAME);

/** The refusal when a chat didn't take Create: older code keeps its mode, and one open elsewhere takes no switch. */
export const CREATE_NOT_TAKEN = "This chat can't switch to Create: it runs older code or is open somewhere else. Reload it, then try again.";

/** The mode `/mode <name>` typed in a chat's composer names, else undefined: a typed switch is the menu's switch. */
export function typedMajorMode(text: string): ModeState["mode"] | undefined {
  const named = /^\/mode\s+(\S+)\s*$/.exec(text.trim());
  return named ? parseMode(named[1]) : undefined;
}

/** The modes only a chat can pick, for a page that reads a peer's chat through that host's GET /api/mode. */
export const chatOnlyModes = (): ModeInfo["chatModes"] => MODES.filter((id) => id === "create").map((id) => ({ id, description: MODE_DESCRIPTIONS[id] }));

/** The memory choice with what can be chosen (ModeInfo.memory). */
export function memoryModeInfo(choice: ChatMemoryChoice): MemoryModeInfo {
  return { type: choice.type, size: choice.size, types: [...MEMORY_TYPE_INFO], sizes: [...MEMORY_SIZES] };
}

/** Only in Create: the mode Save as Default saves (ModeInfo.saveMode). */
export const saveModeOf = (state: Pick<ModeState, "mode" | "lastMode">): { saveMode?: string } => (state.mode === "create" ? { saveMode: defaultModeOf(state) } : {});

/** `offersCreate`: the chat this describes offers Create (§chat.create-mode/where-offered); a default never does. */
export function modeInfo(state: ModeState, memory?: ChatMemoryChoice, offersCreate = false): ModeInfo {
  return {
    mode: state.mode,
    minorModes: [...state.minorModes],
    strict: state.strict,
    ...saveModeOf(state),
    modes: MODES.filter((id) => id !== "create" || offersCreate || state.mode === "create").map((id) => ({ id, description: MODE_DESCRIPTIONS[id] })),
    minors: MINOR_MODES.map((id) => ({ id, description: MINOR_DESCRIPTIONS[id] })),
    ...(memory ? { memory: memoryModeInfo(memory) } : {}),
  };
}

/** The fields Sova may change. A POST body only ever carries the first two (parseModePatch never
    reads `strict`); `strict` is written only by the save-as-default patch (defaultPatchOf). */
export interface ModePatch {
  mode?: ModeState["mode"];
  minorModes?: ModeState["minorModes"];
  strict?: ModeState["strict"];
  /** The memory type (§chat.memory/choice): a chat's own record, or with no path the saved default. Empty
      when a body sent only a size, which is ignored (the size is Settings'). */
  memory?: { type?: MemoryType };
  /** A chat's project minor modes, the whole on set (§chat.mode-menu/project-modes). Only with ?path=:
      the default never stores them. Kept apart from minorModes, which stays the closed built-in set. */
  projectModes?: string[];
  /** Approvals the user gave with this switch: the toolsHash each saw. */
  approve?: ProjectModeApproval[];
  /** Set by the route, never read from a body: the Overseer's own call, which counts as approval (q7). */
  approvedBy?: "overseer" | "user" | "caller";
}

/** What POST /api/mode was asked to do: change a chat's mode (or the default file, without a path),
    or make THIS chat's mode the default new sessions start from. */
export type ModeRequest = { kind: "patch"; patch: ModePatch } | { kind: "saveDefault" } | { kind: "approveHooks"; approvals: ProjectModeApproval[] } | { error: string };

/** Validate a POST /api/mode body. Unknown names are an error, not silently dropped. */
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
  if (b.memory !== undefined) {
    const memory = parseMemoryPatch(b.memory);
    if ("error" in memory) return memory;
    patch.memory = memory;
  }
  if (b.projectModes !== undefined) {
    const ids = parseProjectModes(b.projectModes);
    if ("error" in ids) return ids;
    patch.projectModes = ids;
  }
  if (b.approve !== undefined) {
    if (b.projectModes === undefined) return { error: "approve goes with projectModes" };
    const approve = parseApprovals(b.approve);
    if ("error" in approve) return approve;
    patch.approve = approve;
  }
  if (patch.mode === undefined && patch.minorModes === undefined && patch.memory === undefined && patch.projectModes === undefined)
    return { error: "Nothing to change: send mode, minorModes, projectModes and/or memory" };
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
    if (b.mode !== undefined || b.minorModes !== undefined || b.memory !== undefined || b.projectModes !== undefined || b.approve !== undefined)
      return { error: "saveDefault saves this chat's own mode: send no mode, minorModes, projectModes or memory with it" };
    return { kind: "saveDefault" };
  }
  // Your approval of project modes' hooks (§chat.mode-menu/project-mode-hooks) stands alone too: it switches nothing.
  if (b?.approveHooks !== undefined) {
    if (Object.keys(b).some((k) => k !== "approveHooks")) return { error: "approveHooks approves hooks only: send nothing else with it" };
    const approvals = parseApprovals(b.approveHooks);
    if ("error" in approvals) return { error: approvals.error.replace(/^approve /, "approveHooks ") };
    if (approvals.length === 0) return { error: "approveHooks names at least one { id, hash }" };
    return { kind: "approveHooks", approvals };
  }
  const patch = parseModePatch(body);
  return "error" in patch ? patch : { kind: "patch", patch };
}

/**
 * What `Save as default` writes for a chat on `state`: its major mode (in Create, its last normal or
 * Delegate choice, §chat.create-mode/per-chat-only), strict flag and minor modes —
 * exactly the three fields the mode default holds (state.ts saveState), and nothing else, so shortcuts and any other field in the
 * file are kept by writeMode's re-read. The minors are copied, never shared with the chat's state.
 */
export function defaultPatchOf(state: Pick<ModeState, "mode" | "lastMode" | "strict" | "minorModes">): Required<Pick<ModePatch, "mode" | "strict" | "minorModes">> {
  return { mode: defaultModeOf(state), strict: state.strict, minorModes: [...state.minorModes] };
}

/** Fresh file + the patch's fields. Every field the patch doesn't carry (strict unless it does, shortcuts,
    future ones we know) is kept. Also one chat's own state + a switch: only a chat's state can be in
    Create, which normalizeState (the file's reader) never keeps, and a switch to it turns align on
    (§chat.create-mode/minor-modes), in the same step. */
export function mergeMode(loaded: ModeState, patch: ModePatch): ModeState {
  const { memory: _memory, projectModes: _p, approve: _a, approvedBy: _b, ...modes } = patch;
  const merged = { ...normalizeState({ ...loaded, ...modes }), ...modeSwitch(loaded, patch.mode ?? loaded.mode) };
  return patch.mode === "create" && loaded.mode !== "create" ? withMinor(merged, "align", true) : merged;
}

export const readMode = (file = modeFile()): ModeState => loadState(file);

/** loadState → normalizeState({...loaded, patch}) → saveState (atomic). Returns what was written. */
export function writeMode(patch: ModePatch, file = modeFile()): ModeState {
  if (patch.mode === "create") throw new Error(CREATE_NO_DEFAULT); // Callers refuse first; the file can never hold it.
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
export const resolveChatMode = (branch: BranchEntries, file = modeFile()): ModeState => chatModeOf(stateViewOf(branch), file);

/** The same, from a view of the branch's state (its newest usable `mode` record). */
export function chatModeOf(state: StateView, file = modeFile()): ModeState {
  const base = loadState(file);
  const active = state.latest(MODE)?.data.active;
  return active ? { ...base, mode: active.mode, strict: active.strict, minorModes: [...active.minorModes], ...(active.lastMode ? { lastMode: active.lastMode } : {}) } : base;
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

/**
 * The `mode` entry that pins a session to `state`, in the extension's own shape (its legacy marker
 * plus the `active` snapshot restoreActive reads), or null when the branch's newest snapshot already
 * is `state`. The extension appends an entry only on a change, so a session whose mode equals the
 * default would otherwise follow every later change of mode.json; Sova writes this one itself for
 * the sessions it starts with a mode (a project's coding sessions, the Overseer's sova_create_session).
 * It never carries the extension's additive `head` (the minor modes the prompt was built with,
 * `restoreHead` in state.ts), and needs none: it is written only after the extension's own `/mode`
 * handler applied the same state (ChatSession.pinMode), so restoreHead skips it and reads the head
 * from the extension's entries; a session pinned before its first prompt builds its head from the
 * pinned modes.
 */
export function pinEntryFor(branch: BranchEntries, state: Pick<ModeState, "mode" | "lastMode" | "strict" | "minorModes">): { customType: string; data: { mode: ModeState["mode"]; active: ReturnType<typeof activeOf> } } | null {
  const have = restoreActive(branch);
  // The project modes the chat has on ride along unchanged: the pin is the newest entry restoreActive reads,
  // so leaving them out would turn them off. A pin never adds one (mode.json has none).
  const want = activeOf({ ...state, ...(have?.projectModes ? { projectModes: have.projectModes } : {}) });
  if (have && have.mode === want.mode && have.strict === want.strict && have.minorModes.join(",") === want.minorModes.join(",")) return null;
  return { customType: MODE_ENTRY_TYPE, data: { mode: want.mode, active: want } };
}

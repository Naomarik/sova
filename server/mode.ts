import type { ModeInfo } from "../shared/protocol";
import { modeInfo, readMode as readModeFile, writeMode, type ModePatch } from "./mode-state";
import { applyMemoryPatch, defaultMemoryChoice, saveDefaultMemoryChoice } from "./memory/settings";

// The DEFAULT for new sessions. The mode itself is per session: a chat's own
// switch goes through ChatSession.switchMode and reaches that chat only, and nothing here fans out
// or watches the file. Writing this changes no open chat, web or terminal; it is what a session
// with no mode entry of its own starts from.

/** POST /api/mode (no ?path=): merge into the fresh file, keeping the fields we don't own. */
export async function switchMode(patch: ModePatch): Promise<ModeInfo> {
  // The memory choice's default lives in the memory settings file (§chat.memory/settings), not mode.json.
  if (patch.memory) saveDefaultMemoryChoice(applyMemoryPatch(defaultMemoryChoice(), patch.memory));
  return modeInfo(patch.mode !== undefined || patch.minorModes !== undefined ? writeMode(patch) : readModeFile(), defaultMemoryChoice());
}

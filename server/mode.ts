import type { ModeInfo } from "../shared/protocol";
import { modeInfo, writeMode, type ModePatch } from "./mode-state";

// The DEFAULT for new sessions. The mode itself is per session (spec/04g-mode-menu.md §4g): a chat's own
// switch goes through ChatSession.switchMode and reaches that chat only, and nothing here fans out
// or watches the file. Writing this changes no open chat, web or terminal; it is what a session
// with no mode entry of its own starts from.

/** POST /api/mode (no ?path=): merge into the fresh file, keeping the fields we don't own. */
export async function switchMode(patch: ModePatch): Promise<ModeInfo> {
  return modeInfo(writeMode(patch));
}

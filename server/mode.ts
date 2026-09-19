import { watch } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModeInfo } from "../shared/protocol";
import { heldChats } from "./chat-manager";
import { MODE_FILE_NAME, modeInfo, modeKey, readMode, saveMode, writeMode, type ModePatch, type ModeState } from "./mode-state";

// The global mode switch: pi-web writes mode.json and brings every chat it holds along, so the
// next message in any open chat follows it (DESIGN_NOTES §4g). A TUI's own switch reaches us
// through the file watcher; TUIs don't watch the file, so ours reaches them on their /reload.

const DEBOUNCE_MS = 250;

/** The last state we applied to held chats (key: mode + minorModes) and the whole file we last saw. */
let appliedKey: string | null = null;
let seen: string | null = null;

async function applyToHeld(state: ModeState): Promise<void> {
  await Promise.all(heldChats().map((chat) => chat.applyMode(state).catch((err) => console.error("[mode] apply failed", err))));
}

/** POST /api/mode: merge into the fresh file, apply everywhere, keep our copy of the fields we don't own. */
export async function switchMode(patch: ModePatch): Promise<ModeInfo> {
  const next = writeMode(patch);
  appliedKey = modeKey(next);
  seen = JSON.stringify(next);
  await applyToHeld(next);
  // Each runtime's /mode handler saves its own view, which may carry a stale strict/shortcut.
  // `next` was merged from the file as it was just before; write it back if they changed it.
  if (JSON.stringify(readMode()) !== seen) saveMode(next);
  return modeInfo(next);
}

function onFileChange(): void {
  const state = readMode();
  const whole = JSON.stringify(state);
  if (whole === seen) return; // our own write, or nothing new
  seen = whole;
  const key = modeKey(state);
  if (key === appliedKey) {
    // Only a field we don't apply (strict) changed: refresh what the selectors show.
    for (const chat of heldChats()) chat.broadcast(chat.modeMessage(state));
    return;
  }
  appliedKey = key;
  void applyToHeld(state); // someone else (a TUI) switched: open web chats follow
}

/** Watch mode.json (the agent dir, filtered to that name, so atomic renames are seen). */
export function startModeWatcher(): void {
  const state = readMode();
  appliedKey = modeKey(state);
  seen = JSON.stringify(state);
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = watch(getAgentDir(), (_event, name) => {
      if (name !== MODE_FILE_NAME) return;
      clearTimeout(timer);
      timer = setTimeout(onFileChange, DEBOUNCE_MS);
    });
    watcher.on("error", (err) => console.warn("[mode] watcher stopped:", err.message));
    watcher.unref();
  } catch (err) {
    console.warn("[mode] can't watch mode.json; TUI switches reach web chats on reopen:", err instanceof Error ? err.message : err);
  }
}

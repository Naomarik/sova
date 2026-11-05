// What the mode menu's Save as default offers for this chat, kept current as its "mode" message and
// the files move (§chat.mode-menu/menu, §chat.create-mode/per-chat-only): a chat in Create saves its
// last normal or Delegate choice, so moving to Create never makes a saved default look unsaved.
import { createMemo } from "solid-js";
import type { ModeInfo } from "../../shared/protocol";
import type { SubagentProfilesInfo } from "../../shared/subagent-profiles";
import { footNote, isDefaultAll, savableMode, saveTitle, type ShownMode } from "./mode-menu";

export function createModeSave(input: {
  /** This chat's mode, or null before its "mode" message. */
  shown: () => ShownMode | null;
  defaultMode: () => Pick<ModeInfo, "mode" | "minorModes" | "strict"> | null;
  profiles: () => Pick<SubagentProfilesInfo, "current" | "default"> | null;
  /** Anything else a save writes that already matches (the memory type). */
  alsoSaved?: () => boolean;
}) {
  const savable = createMemo(() => {
    const s = input.shown();
    return s ? savableMode(s) : null;
  });
  const already = createMemo(() => isDefaultAll(input.defaultMode(), savable(), input.profiles()) && (input.alsoSaved?.() ?? true));
  const note = createMemo(() => footNote(input.shown()));
  const title = createMemo(() => saveTitle(savable(), already()));
  return { savable, already, note, title };
}

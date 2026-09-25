// Settings history, not conversation. The server keeps normalizing these entries — a model
// switch, a thinking-level change and the mode extension's three markers (mode, minor mode,
// strict mode) — into `info` items, and they must keep arriving: the Session pane's Changes
// disclosure (`timelineEntries` in lib/spend) and the Timeline's change markers read them. The
// thread renders nothing for them: a machine fact belongs next to the control that set it, not
// in the conversation, and a locally drawn row also reappeared after every reload once the
// persisted `model_change` came back.
import type { TranscriptItem } from "../../shared/protocol";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Whether an item is one of the three settings-change families the thread leaves out. */
export function isChangeRow(item: TranscriptItem): boolean {
  if (item.kind !== "info" || !isObj(item.raw)) return false;
  const { type, customType } = item.raw;
  return type === "model_change" || type === "thinking_level_change" || (type === "custom" && customType === "mode");
}

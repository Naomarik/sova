// Settings → General's Chats folder (§app.chat-homes/move-folder): the folder this computer keeps its chats in, read
// once and again while a move runs, and the words its row, its dialog and the chat list's warning say.
import { createSignal } from "solid-js";
import type { ChatsFolderInfo, ChatsFolderMove, ChatsFolderPreview } from "../../shared/chats-folder";
import { getChatsFolder } from "./api";
import { bytes } from "./mesh-details";

const [info, setInfo] = createSignal<ChatsFolderInfo | null>(null);
export const chatsFolderInfo = info;

let inFlight: Promise<ChatsFolderInfo | null> | null = null;
/** Read the folder again (the row, the dialog's progress, the chat list's warning share one answer). */
export function refreshChatsFolder(): Promise<ChatsFolderInfo | null> {
  inFlight ??= getChatsFolder()
    .then((i) => (setInfo(i), i))
    .catch(() => null)
    .finally(() => (inFlight = null));
  return inFlight;
}

const RUNNING = new Set(["stopping", "copying", "switching"]);
export const moveRunning = (m: ChatsFolderMove | undefined | null): boolean => !!m && RUNNING.has(m.phase);

const chats = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;
const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** "2 chats · 14 files · 1.2 MB. 120 GB free there." */
export function previewLine(p: ChatsFolderPreview): string {
  return `${chats(p.chats)} · ${files(p.files)} · ${bytes(p.bytes)}.${p.free !== null ? ` ${bytes(p.free)} free there.` : ""}`;
}

/** The progress line while a move runs. */
export function moveProgressLine(m: ChatsFolderMove): string {
  if (m.phase === "stopping") return "Stopping every chat…";
  if (m.phase === "switching") return "Checking the last changes and switching to the new folder…";
  return `Copying and checking · ${bytes(m.copiedBytes)} of ${bytes(m.bytes)}`;
}

/** How far the copy is, 0–100. */
export const moveFraction = (m: ChatsFolderMove): number => (m.bytes > 0 ? Math.min(100, Math.round((m.copiedBytes / m.bytes) * 100)) : m.phase === "switching" ? 100 : 0);

/** The live-sync warning, before Move Chats: still allowed. */
export const liveSyncWarning = (service: string): string =>
  `This folder is in ${service}. A sync service can copy a conversation while a chat is writing it and leave conflicting copies. You can still move here.`;

/** Whether the folder the marker names is missing (a disk not mounted, a folder moved by hand). */
export const folderMissing = (i: ChatsFolderInfo | null): boolean => !!i && !i.exists && i.source === "marker";

export const MISSING_TITLE = "Your chats folder is missing.";
export const missingBody = (path: string): string =>
  `${path} isn't there, so the chats kept in it aren't listed. Reconnect the disk or put the folder back; until then, new chats are kept the way they were before chat homes.`;

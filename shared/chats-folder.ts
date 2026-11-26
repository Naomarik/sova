// The Chats folder setting's wire shapes (Settings → General, "Chats · this computer"): where this computer keeps
// its chats' homes, and the move of every home to another folder (server/chat-homes/move-root.ts).

/** A move's phases: stopping (every chat process), copying (each file checked by sha256, the paths inside it naming the
    old folder rewritten), switching (the marker written, the server taking the new folder), then done; or cancelled, failed, or interrupted (the server
    stopped partway: the old folder is still in force, and Resume goes on from the files already checked). */
export type ChatsFolderMovePhase = "stopping" | "copying" | "switching" | "done" | "cancelled" | "failed" | "interrupted";

export interface ChatsFolderMove {
  id: string;
  from: string;
  to: string;
  phase: ChatsFolderMovePhase;
  startedAt: string;
  finishedAt?: string;
  /** Chats (homes and compressed chats) and bytes to copy, and how far the copy is. */
  chats: number;
  files: number;
  bytes: number;
  copiedFiles: number;
  copiedBytes: number;
  /** A failure's or an interruption's reason. */
  error?: string;
  /** The move made the new folder (a cancel removes it again). */
  made?: boolean;
}

export interface ChatsFolderInfo {
  /** The folder in force now (absolute). */
  path: string;
  /** "env": set by a variable (read-only here); "marker": chosen (or made the first time); "default": none chosen yet. */
  source: "env" | "marker" | "default";
  /** The variable, with source "env". */
  env?: string;
  /** Whether the folder is there (a marker naming a missing folder: a disk not mounted, a folder moved by hand). */
  exists: boolean;
  /** Why Change… isn't offered, when it isn't. */
  locked?: string;
  /** The latest move, when there was one. */
  move?: ChatsFolderMove;
  /** The folders the chats were in before, newest first (kept as they were: nothing is deleted). */
  movedFrom?: string[];
}

/** GET /api/chats-folder/preview?path=: what a move to that folder would do, or why it can't. */
export interface ChatsFolderPreview {
  /** The folder the chats would go to: the one chosen when it is empty or new, else a new `sova-chats` inside it. */
  target: string;
  chats: number;
  files: number;
  bytes: number;
  /** Free space where the target is. */
  free: number | null;
  /** The live-sync service the target is in (Dropbox, iCloud Drive, OneDrive, Google Drive, Syncthing), if any. */
  liveSync?: string;
  /** Why it can't move there now; the move is refused with the same words. */
  refusal?: string;
}

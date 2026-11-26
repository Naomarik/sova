// The Chats folder (§app.chat-homes/move-folder): where this computer keeps its chats, what a move to another folder
// would do, and the move itself, which only your click on this computer's page starts or cancels: a script, a chat, an
// extension's key or another computer is refused with where to click, and nothing is moved.
import type { CommandEntry } from "./types.ts";

const folder = { type: "path", description: "The folder to move every chat to (a new or empty one; one that holds files gets a sova-chats folder inside it)", in: "query", key: "path", required: true } as const;

export const CHATS_FOLDER_ENTRIES: CommandEntry[] = [
  {
    id: "chats-folder.get",
    label: "Show Chats Folder",
    summary: "The folder this computer keeps its chats in, whether a variable sets it, whether it is there, and the latest move.",
    effect: "looks",
    params: {},
    route: { method: "GET", path: "/api/chats-folder" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "full",
  },
  {
    id: "chats-folder.preview",
    label: "Preview Chats Folder Move",
    summary: "What moving every chat to a folder would copy (chats, files, size, free space there, a live-sync service it is in), or why it can't.",
    effect: "looks",
    params: { folder },
    route: { method: "GET", path: "/api/chats-folder/preview" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "full",
  },
  {
    id: "chats-folder.move",
    label: "Move Chats",
    summary: "Only your click in Settings → General moves your chats; anything else is refused and nothing is moved.",
    effect: "changes",
    params: { folder: { ...folder, in: "body" } },
    route: { method: "POST", path: "/api/chats-folder/move" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "full",
  },
  {
    id: "chats-folder.cancel",
    label: "Cancel Chats Folder Move",
    summary: "Only your click cancels a move, before it switches to the new folder; your chats stay where they were.",
    effect: "changes",
    params: {},
    route: { method: "POST", path: "/api/chats-folder/move/cancel" },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "full",
  },
];

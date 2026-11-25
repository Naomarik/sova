import type { DefaultNotApplied } from "../shared/protocol";

/**
 * Why a new chat isn't on this computer's default profile, by session path (server/default-start.ts
 * startOnDefault notes it). The chat runs in a process of its own, so the server adds it to the chat's
 * `profile` frames on their way to each pane (server/chat-handle-remote.ts), while the chat has no
 * message: its empty screen says so on any tab and after a reload. Kept in memory: it only matters
 * until the first message or a pick that takes, and a server restart drops it (the server's log keeps
 * the reason).
 */
const notes = new Map<string, DefaultNotApplied>();

/** Note it, or (null) spend it; true when a note was there and is gone now. */
export function noteDefaultNotApplied(path: string, note: DefaultNotApplied | null): boolean {
  if (note) {
    notes.set(path, note);
    return false;
  }
  return notes.delete(path);
}

export const defaultNotAppliedOf = (path: string): DefaultNotApplied | undefined => notes.get(path);

const PROFILE_FRAME = '{"type":"profile"';

/** A chat frame as it goes to a pane: a `profile` frame of an empty chat with its note, if it has one.
    A `profile` frame of a chat with a message spends the note. Every other frame is passed as it is. */
export function withDefaultNote(path: string, json: string): string {
  if (!json.startsWith(PROFILE_FRAME) || !notes.has(path)) return json;
  let msg: { locked?: unknown };
  try {
    msg = JSON.parse(json) as { locked?: unknown };
  } catch {
    return json;
  }
  if (msg.locked !== false) {
    notes.delete(path);
    return json;
  }
  return JSON.stringify({ ...msg, defaultNotApplied: notes.get(path) });
}

export const isProfileFrame = (json: string): boolean => json.startsWith(PROFILE_FRAME);

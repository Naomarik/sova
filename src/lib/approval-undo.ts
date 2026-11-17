import { createRoot, createSignal } from "solid-js";

/**
 * The Undo a group switch's press leaves (§chat.context-approval): one per folder, as the server keeps
 * one per folder (its latest group save). The line shows under the heading of the group that was
 * pressed, wherever that list is drawn, until the next change in that group or a newer group press in
 * the folder; Undo names its token. In this tab only.
 */
export interface UndoLine {
  /** The folder's save queue (lib/approval-overlay queueOf). */
  queue: string;
  /** Which group of which list: "setup:context", "card:skills:user"… */
  group: string;
  text: string;
  token: string;
}

const store = createRoot(() => {
  const [lines, setLines] = createSignal<Record<string, UndoLine>>({});
  return { lines, setLines };
});

/** The folder's Undo line for this group, or null. */
export const undoFor = (queue: string, group: string): UndoLine | null => {
  const u = store.lines()[queue];
  return u && u.group === group ? u : null;
};

/** A group press saved: its line replaces the folder's. */
export const setUndoLine = (u: UndoLine): void => void store.setLines((all) => ({ ...all, [u.queue]: u }));

/** A change in a group (any save into it), or the Undo used or gone: its line goes. A group press elsewhere
    in the folder replaces it through setUndoLine. */
export function dropUndo(queue: string, group?: string): void {
  const u = store.lines()[queue];
  if (!u || (group !== undefined && u.group !== group)) return;
  store.setLines((all) => {
    const next = { ...all };
    delete next[queue];
    return next;
  });
}

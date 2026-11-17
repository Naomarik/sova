import { createRoot, createSignal } from "solid-js";

/**
 * The Undo a group switch's press leaves (§chat.context-approval/group): one per group of a folder, as
 * the server keeps one per folder and group (its latest group save there). The line shows under the
 * heading of the group that was pressed, wherever that list is drawn, until the next change in that
 * group or a newer press of the same group; a press of another group in the folder leaves it. Undo
 * names its token. In this tab only.
 */
export interface UndoLine {
  /** The folder's save queue (lib/approval-overlay queueOf). */
  queue: string;
  /** Which group of which list, as its save names it to the server: "setup:skill", "card:context:user"… */
  group: string;
  text: string;
  token: string;
}

/** Every line, by folder and group. */
export type UndoLines = Readonly<Record<string, UndoLine>>;

/** A group's id, as its save names it (the server keeps one Undo per folder and id): the new chat's
    list has one group per kind, a project's card one per kind and source. */
export const setupGroup = (kind: "context" | "skill"): string => `setup:${kind}`;
export const cardGroup = (kind: "context" | "skill", source: string): string => `card:${kind}:${source}`;

const keyOf = (queue: string, group: string) => `${queue}\u0000${group}`;

/** The group's line in that folder, or null. Pure. */
export const lineFor = (lines: UndoLines, queue: string, group: string): UndoLine | null => lines[keyOf(queue, group)] ?? null;

/** A group press saved: its line replaces that group's own, and no other. Pure. */
export const withLine = (lines: UndoLines, u: UndoLine): UndoLines => ({ ...lines, [keyOf(u.queue, u.group)]: u });

/** A change in a group (any save into it), or its Undo used or gone: that group's line goes. Pure. */
export function withoutLine(lines: UndoLines, queue: string, group: string): UndoLines {
  const k = keyOf(queue, group);
  if (!(k in lines)) return lines;
  const next = { ...lines };
  delete next[k];
  return next;
}

const store = createRoot(() => {
  const [lines, setLines] = createSignal<UndoLines>({});
  return { lines, setLines };
});

/** The folder's Undo line for this group, or null. */
export const undoFor = (queue: string, group: string): UndoLine | null => lineFor(store.lines(), queue, group);

/** A group press saved: its line replaces its group's. */
export const setUndoLine = (u: UndoLine): void => void store.setLines((all) => withLine(all, u));

/** A change in a group, or its Undo used or gone: its line goes. */
export const dropUndo = (queue: string, group: string): void => void store.setLines((all) => withoutLine(all, queue, group));

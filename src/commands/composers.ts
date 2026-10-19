// The chat composers on screen, by session path, for the command palette's "This chat" rows
// (§app.command-palette/rows): what the slash menu would list there, and the composer's own way to
// put "/name " in its textarea. A composer registers while mounted; the palette only reads.
//
// Kept tiny and DOM-free: Composer is in the main bundle, the palette is not.

import type { SlashCommand } from "../../shared/protocol";

export interface ComposerHandle {
  /** The commands the slash menu lists here (already without the menu's hidden ones). */
  commands(): SlashCommand[];
  /** Why the composer takes nothing now, or null. */
  off(): string | null;
  /** Whether the draft holds anything (text or an attachment). */
  hasDraft(): boolean;
  /** Puts `/name ` in the textarea and focuses it; sends nothing. */
  insert(name: string): void;
}

const handles = new Map<string, ComposerHandle[]>();

/** Registers a mounted composer; returns the unregister (idempotent). */
export function registerComposer(path: string, handle: ComposerHandle): () => void {
  handles.set(path, [...(handles.get(path) ?? []), handle]);
  return () => {
    const rest = (handles.get(path) ?? []).filter((h) => h !== handle);
    if (rest.length) handles.set(path, rest);
    else handles.delete(path);
  };
}

/** The composer of `path` (the newest, when a session shows in two places), or null. */
export const composerOf = (path: string | null): ComposerHandle | null => (path ? (handles.get(path)?.at(-1) ?? null) : null);

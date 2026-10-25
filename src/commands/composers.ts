// The chat composers on screen, by session path, for the command palette's This chat and Slash
// commands rows (§app.command-palette/rows): what the slash menu would list there, the composer's
// own way to put "/name " in its textarea, and its file picker, Playbooks and Undo last turn. A
// composer registers while mounted; the palette only reads and asks.
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
  /** Opens the composer's file picker, synchronously: call it from the click (or key) itself, as
      a phone's browser opens a picker only from the gesture that asked for it. */
  attach(): void;
  /** A Sova chat holds it, so `playbooks()` opens the Playbooks dialog (a watch view can't). */
  canPlaybooks(): boolean;
  playbooks(): void;
  /** Why Undo last turn can't run: null when it can, "" when not yet with nothing to say;
      undefined where no Sova chat holds it (a watch view). */
  undoBlocked(): string | null | undefined;
  undo(): void;
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

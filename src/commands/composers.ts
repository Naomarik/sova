// The chat composers on screen, by session path: for the Commands dialog's This chat rows
// (§app.command-palette/rows: the composer's file picker and Playbooks, and why it takes nothing
// now) and for a character typed outside any text field (lib/type-anywhere). A composer registers
// while mounted; the others only read and ask.
//
// Kept tiny and DOM-free: Composer is in the main bundle, the Commands dialog is not.

export interface ComposerHandle {
  /** Why the composer takes nothing now, or null. */
  off(): string | null;
  /** Focuses the textarea, its caret where it was, for a character typed outside any text field
      (lib/type-anywhere), ending Focus if Focus hides it. False when it takes no typing (read-only,
      not on screen). */
  take(): boolean;
  /** Opens the composer's file picker, synchronously: call it from the click (or key) itself, as
      a phone's browser opens a picker only from the gesture that asked for it. */
  attach(): void;
  /** A Sova chat holds it, so `playbooks()` opens the Playbooks dialog (a watch view can't). */
  canPlaybooks(): boolean;
  playbooks(): void;
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

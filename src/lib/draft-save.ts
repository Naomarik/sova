// Debounced composer-draft writer: a burst of keystrokes costs one request per session.
// Timers are injectable so the tests drive time by hand instead of sleeping.

import type { UploadResult } from "../../shared/protocol";

/** One session's whole draft. Each save carries all of it, so the latest payload replaces any
    pending one and a text save can never drop the attachments (or the reverse). */
export interface DraftPayload {
  text: string;
  /** Files already uploaded into the session's attachments folder. */
  attachments: UploadResult[];
}

export type SaveDraft = (path: string, draft: DraftPayload) => void | Promise<void>;

export interface DraftSaverOptions {
  /** Quiet time after the last keystroke before the save goes out. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DraftSaver {
  /** Replaces the pending save for `path` (one per path) and restarts its timer. */
  schedule(path: string, draft: DraftPayload): void;
  /** Writes every pending save now. Safe with nothing pending. */
  flush(): void;
}

export const DRAFT_SAVE_DELAY_MS = 600;

export function createDraftSaver(save: SaveDraft, opts: DraftSaverOptions = {}): DraftSaver {
  const delayMs = opts.delayMs ?? DRAFT_SAVE_DELAY_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Map<string, { draft: DraftPayload; timer: unknown }>();

  // A failed save is only a missed convenience: the in-memory draft is still the authority, and
  // the next keystroke schedules another write. So nothing here may throw into the composer.
  const write = (path: string, draft: DraftPayload) => {
    try {
      void Promise.resolve(save(path, draft)).catch(() => {});
    } catch {
      // A synchronous throw is swallowed for the same reason.
    }
  };

  const fire = (path: string) => {
    const p = pending.get(path);
    if (!p) return;
    pending.delete(path);
    write(path, p.draft);
  };

  return {
    schedule(path, draft) {
      const prev = pending.get(path);
      if (prev) clearTimer(prev.timer);
      pending.set(path, { draft, timer: setTimer(() => fire(path), delayMs) });
    },
    flush() {
      for (const [path, p] of [...pending]) {
        clearTimer(p.timer);
        pending.delete(path);
        write(path, p.draft);
      }
    },
  };
}

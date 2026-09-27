/**
 * In-process baton events (§app/baton): what the project overseer's watch loop and the reconciler
 * listen to. Emitted synchronously after the registry and the transcript have the change; a
 * listener that throws is logged and never stops the emitter or the other listeners.
 */

/** `asked-operator`: the session's model handed the baton to the operator (`hand_to`), never the
    operator's own move; it follows that move's `handoff`. */
export type BatonEventType = "decision" | "handoff" | "offer" | "done" | "closed" | "wrapup" | "proposal" | "asked-operator";

export interface BatonEvent {
  type: BatonEventType;
  orgId: string;
  projectId: string;
  sessionId: string;
  /** The custom entry that records it, when there is one (a decision's `sova-baton-decision`). */
  entryId?: string;
  /** `asked-operator`: the question the model put to the operator. */
  question?: string;
}

const listeners = new Set<(e: BatonEvent) => void>();

/** Listen; returns the unsubscribe. */
export function onBatonEvent(fn: (e: BatonEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitBatonEvent(e: BatonEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(e);
    } catch (err) {
      console.warn(`[baton] event listener failed on ${e.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

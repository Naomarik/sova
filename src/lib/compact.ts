// The web /compact (§chat.slash-commands/compact): what the composer and the thread say around
// one. The command text itself is parsed by shared/compact.ts, the same reader the server uses.

/** The composer's reason while any compaction runs (§chat.composer/disabled-states). */
export const COMPACTING_REASON = "Compacting…";

/** Said without a round trip when /compact is sent mid-turn: pi's compact() would abort the turn.
    The server's own copy for the same refusal. */
export const COMPACT_STREAMING_REASON = "Stop the turn first, then compact.";

/**
 * What the composer's run controls show. A compaction is not a turn: nothing to steer, so the
 * placeholder and the button stay Send's (blocked() is what disables it). But it has a status row
 * and a Stop that cancels it.
 */
export function runControls(running: boolean, compacting: boolean): { steer: boolean; stop: boolean; status: boolean } {
  return { steer: running, stop: running || compacting, status: running || compacting };
}

/** What the composer's Stop is: missing, on screen but `aria-disabled`, or usable. */
export type StopButton = "hidden" | "disabled" | "usable";

/**
 * The composer's Stop: on screen while a reply or compaction runs in a box that isn't read-only,
 * `aria-disabled` while it is already stopping or the socket isn't open. Esc in the box reads the
 * same answer, so it stops exactly when pressing Stop would.
 */
export function stopButton(s: {
  running: boolean;
  compacting: boolean;
  readOnly: boolean;
  stopping: boolean;
  stopBlocked: boolean;
}): StopButton {
  if (!runControls(s.running, s.compacting).stop || s.readOnly) return "hidden";
  return s.stopping || s.stopBlocked ? "disabled" : "usable";
}

/** One line for the live region when the compaction landed. */
export function compactedAnnouncement(tokensBefore: number): string {
  return tokensBefore > 0 ? `Compacted ${tokensBefore.toLocaleString("en-US")} tokens of context.` : "Compacted.";
}

// The web /compact (§chat.slash-commands/compact): what the composer and the thread say around
// one. The command text itself is parsed by shared/compact.ts, the same reader the server uses.

/** The composer's reason while any compaction runs (§chat.composer/disabled-states). */
export const COMPACTING_REASON = "Compacting…";

/** Said without a round trip when /compact is sent mid-turn: pi's compact() would abort the turn.
    The server's own copy for the same refusal. */
export const COMPACT_STREAMING_REASON = "Stop the turn first, then compact.";

/** One line for the live region when the compaction landed. */
export function compactedAnnouncement(tokensBefore: number): string {
  return tokensBefore > 0 ? `Compacted ${tokensBefore.toLocaleString("en-US")} tokens of context.` : "Compacted.";
}

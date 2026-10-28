import type { TranscriptItem } from "../../shared/protocol";

/** A wake nudge is a real `role:"user"` message (server/transcript.ts), so it starts a turn
    exactly like an ordinary input: it counts for "N inputs", anchors a Timeline turn, and is a
    valid rewind target. Only its rendering differs (WakeCard, not a "You" bubble). A link message
    (§mesh.links/transcript) is a real user message too, so it starts a turn, but it is a partner's
    words, not the user's: never an input (`isInput`). A topic batch (§chat.topics/row) is the same:
    a turn start, never an input. */
export const isTurnStart = (row: Pick<TranscriptItem, "kind">): boolean => row.kind === "user" || row.kind === "wake" || row.kind === "link" || row.kind === "topic";

/** The user's inputs: the turn starts the inputs count, the Timeline and the rewind targets list.
    One rule with the server's count of the rows it didn't send (shared/row-counts.ts). */
export { isInput } from "../../shared/row-counts";

/** A transcript row that ends a turn on an error (the `${entryId}:stop` info row): the error's own
    words sit in its text, its producer's model on the row. The server words it "Error…" for a
    stop reason of "error" and "Aborted…" otherwise. */
export function isErroredTurnStop(it: TranscriptItem): boolean {
  return it.kind === "info" && it.id.endsWith(":stop") && (it.text ?? "").startsWith("Error");
}

import type { TranscriptItem } from "../../shared/protocol";

/** A wake nudge is a real `role:"user"` message (server/transcript.ts), so it starts a turn
    exactly like an ordinary input: it counts for "N inputs", anchors a Timeline turn, and is a
    valid rewind target. Only its rendering differs (WakeCard, not a "You" bubble). A link message
    (§mesh.links/transcript) is a real user message too, so it starts a turn, but it is a partner's
    words, not the user's: never an input (`isInput`). */
export const isTurnStart = (row: Pick<TranscriptItem, "kind">): boolean => row.kind === "user" || row.kind === "wake" || row.kind === "link";

/** The user's inputs: the turn starts the inputs count, the Timeline and the rewind targets list. */
export const isInput = (row: Pick<TranscriptItem, "kind">): boolean => row.kind === "user" || row.kind === "wake";

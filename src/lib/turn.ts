import type { TranscriptItem } from "../../shared/protocol";

/** A wake nudge is a real `role:"user"` message (server/transcript.ts), so it starts a turn
    exactly like an ordinary input: it counts for "N inputs", anchors a Timeline turn, and is a
    valid rewind target. Only its rendering differs (WakeCard, not a "You" bubble). */
export const isTurnStart = (row: Pick<TranscriptItem, "kind">): boolean => row.kind === "user" || row.kind === "wake";

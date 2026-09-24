// The fanout dialog's fork note: "Each member gets the whole
// conversation up to message {n}". The number has to mean what the words say — MESSAGES, not
// rendered rows. A rendered transcript holds one row per content block (an assistant reply with
// text, thinking and two tool calls is four rows and one message), plus info rows a conversation
// never counted (model changes, compaction, the fork marker itself), so the row count overstates
// the conversation by every tool call and every housekeeping row.
//
// Counted: the ENTRY behind a user row, a wake row (a fired nudge is a real `role:"user"`
// message under the hood, src/lib/turn.ts) or any row of an assistant entry — text, thinking and
// tool-call blocks alike, since they are one reply's blocks sharing one entry id
// (`${entryId}:${i}`, server/transcript.ts), and a multi-block reply is still one message.
// Excluded: every row that is not a message at all — info (model changes, compaction, the fork
// marker), report, tool-result, unknown.

import type { TranscriptItem } from "../../shared/protocol";
import { entryIdOf } from "./jump";

/** The kinds a rendered row can belong to that ARE messages (a user's, a nudge's, a reply's). */
const MESSAGE_KINDS: ReadonlySet<TranscriptItem["kind"]> = new Set(["user", "wake", "assistant-text", "thinking", "tool-call"]);

/**
 * User and assistant messages on this branch — the number "up to message {n}" names. Distinct
 * entry ids, so one multi-block assistant reply counts once, and a turn's tool calls never count
 * as messages of their own.
 */
export const messageCount = (items: readonly TranscriptItem[]): number =>
  new Set(items.filter((it) => MESSAGE_KINDS.has(it.kind)).map((it) => entryIdOf(it.id))).size;

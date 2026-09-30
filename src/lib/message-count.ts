// A conversation's length in MESSAGES, not rendered rows. A rendered transcript holds one row per
// content block (an assistant reply with text, thinking and two tool calls is four rows and one
// message), plus info rows a conversation never counted (model changes, compaction), so the row
// count overstates the conversation by every tool call and every housekeeping row.
//
// Counted: the ENTRY behind a user row, a wake row (a fired nudge is a real `role:"user"`
// message under the hood, src/lib/turn.ts), a link message's (the same, though it renders nothing)
// or any row of an assistant entry — text, thinking and
// tool-call blocks alike, since they are one reply's blocks sharing one entry id
// (`${entryId}:${i}`, server/transcript.ts), and a multi-block reply is still one message.
// Excluded: every row that is not a message at all — info (model changes, compaction), report,
// tool-result, unknown.

// One rule with the server's count of the rows a newest-rows-first hello didn't send
// (shared/row-counts.ts).
export { messageCount } from "../../shared/row-counts";

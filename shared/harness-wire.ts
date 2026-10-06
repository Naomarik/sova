// The harness contract, the wire (§app/harness). Types only: imports nothing but its
// siblings, emits nothing. What a browser that asked for wire 2 reads instead of pi's events and the
// rows' EntryMeta: the fields the live reducer (src/lib/live.ts applyEvent) and ChatView's per-event
// effects read, field by field, and the facts the row predicates read. shared/wire-v1.ts maps today's
// (v1) shapes onto these, on the server and in the browser alike.

/** One block of an assistant message, as the live view holds it. */
export type SovaPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; id: string; name: string; args?: unknown };

/**
 * A live event. Optional fields keep the reducer's fallbacks: a part event without an `index`
 * applies at the end of the message's parts; a `part.end` without `text` keeps the streamed text; a
 * tool call's end without an id or a name keeps the started one. The default error text and the
 * stop time are the browser's, never the wire's.
 */
export type SovaEvent =
  /** A run started (pi agent_start). */
  | { type: "run.start" }
  /** A run settled: nothing more streams until the next start (pi agent_settled). */
  | { type: "run.settled" }
  /** An assistant message began. `model` is "provider/model", when the message names both. */
  | { type: "message.start"; role: "assistant"; model?: string; parts: SovaPart[] }
  /** A user message reached the agent. `text` is its text blocks joined, without pi's image notes;
      `images` its images as data URLs. */
  | { type: "message.start"; role: "user"; text: string; images: string[] }
  | { type: "part.start"; index?: number; kind: "text" | "thinking" }
  | { type: "part.start"; index?: number; kind: "toolCall"; id?: string; name?: string }
  | { type: "part.delta"; index?: number; kind: "text" | "thinking" | "toolCall"; delta: string }
  | { type: "part.end"; index?: number; kind: "text" | "thinking"; text?: string }
  | { type: "part.end"; index?: number; kind: "toolCall"; id?: string; name?: string; args?: unknown }
  /** `entryId`: the transcript entry the message was written as, when it was. */
  | { type: "message.end"; role: "user"; entryId?: string }
  /** The message as written, authoritative over what streamed. `parts` empty keeps the streamed
      parts. `contextTokens`: the context fill the reply reports (none for an error, an abort or a
      zero usage). */
  | {
      type: "message.end";
      role: "assistant";
      entryId?: string;
      model?: string;
      parts: SovaPart[];
      stop: "ok" | "error" | "aborted";
      error?: string;
      contextTokens?: number;
    }
  /** `parentCallId` (on tool.start, .update and .end): a call another tool made (a codemode script's), by the
      calling tool's id. It has no row and no live tool of its own: its caller's result records it. */
  | { type: "tool.start"; callId: string; name: string; args?: unknown; parentCallId?: string }
  /** The tool's output so far: its text blocks joined, and its images as data URLs; `details`, the partial
      result's details when it has some (a codemode script's calls so far). */
  | { type: "tool.update"; callId: string; output: string; images: string[]; details?: unknown; parentCallId?: string }
  | { type: "tool.end"; callId: string; name?: string; args?: unknown; isError: boolean; output: string; images: string[]; details?: unknown; parentCallId?: string }
  /** A retry after a provider error, or a compaction. `wrote` (compaction end only): one was written. */
  | { type: "activity"; what: "retry" | "compaction"; phase: "start" | "end"; wrote?: boolean };

/**
 * What a row's entry says beyond the row, on the entry's first row only (where EntryMeta is today);
 * `{}` when none applies. A row without facts reads its entry's first row's, as with EntryMeta.
 */
export interface RowFacts {
  /** A settings change the thread leaves out: a model switch, a thinking level, a mode marker. */
  setting?: "model" | "thinking" | "mode";
  /** The context restarts here: a compaction, or a compaction's summary message. */
  resetsContext?: true;
  /** The compaction entry's figures (the compaction entry only, never its summary message). */
  compaction?: { tokensBefore?: number; summary?: string; details?: unknown };
  /** The context fill an assistant reply reports (none for an error, an abort or a zero usage). */
  contextTokens?: number;
  /** A tool result: its tool, its call, and whether it failed. */
  tool?: { name?: string; callId?: string; isError?: boolean };
}

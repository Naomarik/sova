// The harness contract, history (§app/harness, §app.harness/reader). Types only: imports nothing but its
// siblings, emits nothing. A session's entries as Sova reads them, whatever harness wrote them; pi's reader
// is server/harness/pi/reader.ts. Fields are optional and carry the harness's values as written, never
// coerced, so a reader that moves onto these shapes gives byte-identical output on malformed files too.
import type { EntryId } from "./harness-core";

/** A session file's first line: who it is, where it ran, which session it was forked from. */
export interface HHeader {
  id?: string;
  cwd?: string;
  version?: number;
  parentSession?: string;
  /** The header's ISO time. */
  at?: string;
}

/** Sova's block vocabulary. It coincides with pi's for these four, so pi's reader passes pi's block
    objects through without copying (a provider signature stays on the object, never declared here). */
export type HBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "image"; data: string; mimeType: string }
  /** A block type this version can't read, kept whole. */
  | { type: "unknown"; raw: unknown };

/** One model call's tokens, as the harness recorded them. */
export interface HUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The part of `cacheWrite` written with a one-hour lifetime, when the harness says. */
  cacheWrite1h?: number;
  /** What the call cost, when the harness priced it. */
  cost?: number;
}

interface HBase {
  /** null for an entry with no id (a legacy linear file, or a malformed line). */
  id: EntryId | null;
  parentId: EntryId | null;
  /** The entry's ISO time. */
  at?: string;
}

export type HEntry = HBase & (
  | { kind: "user"; blocks: HBlock[]; sentAt?: number }
  | {
      kind: "assistant"; blocks: HBlock[]; provider?: string; model?: string; usage?: HUsage;
      /** The model the provider says answered (pi's `responseModel`), when it differs from `model`. */
      responseModel?: string;
      /** Tokens in context after this reply (the fill rule, applied by the reader); absent when the reply
          says nothing about it: an error or aborted reply, no usage, or a usage of zero. */
      contextTokens?: number;
      stop?: string; error?: string; sentAt?: number;
    }
  | { kind: "tool-result"; callId?: string; tool?: string; blocks: HBlock[]; details?: unknown; isError?: boolean; sentAt?: number }
  /** A shell command the user ran (pi's `!` / bashExecution). */
  | { kind: "shell"; command?: string; output?: string; sentAt?: number }
  /** An extension's message: `inMessage` is pi's custom message role, else a custom_message entry. */
  | { kind: "note"; noteType?: string; content: unknown; display: boolean; details?: unknown; inMessage: boolean }
  /** A summary that stands in for earlier context: a branch's (pi's branch_summary entry or role) or a
      compaction's (the compactionSummary role; the compaction itself is its own kind). */
  | { kind: "summary"; of: "branch" | "compaction"; summary?: string; inMessage: boolean }
  /** The system prompt as the session recorded it (pi 0.86+), with its named sections. */
  | { kind: "system"; blocks: HBlock[]; sections?: Record<string, string | null> }
  | { kind: "setting"; what: "model"; provider?: string; modelId?: string }
  | { kind: "setting"; what: "thinking"; level?: string }
  | { kind: "setting"; what: "name"; name?: string }
  | { kind: "setting"; what: "label"; label?: string; targetId?: string }
  | { kind: "compaction"; tokensBefore?: number; summary?: string; details?: unknown }
  /** Model usage outside the conversation (pi 0.86+, e.g. a cache warm). */
  | { kind: "usage-record"; provider?: string; model?: string; usage?: HUsage }
  /** An edit to what an earlier entry sends the model (pi 0.87+). Renders nothing; history is unchanged. */
  | { kind: "context-edit" }
  /** Extension state (pi's custom entry), keyed by its type. */
  | { kind: "state"; key: string; data: unknown }
  /** An entry this version can't read (§app.harness/unknown-entries): it keeps its place in the tree, and
      carries nothing a reader could use. `type` is the harness's name for it, null when it has none. */
  | { kind: "unknown"; type: string | null }
);

export type HEntryKind = HEntry["kind"];

/** The read half of a held session (the driving session extends it later): its id, working directory and
    history, read live. */
export interface SessionRead {
  readonly id: string;
  readonly cwd: string;
  /** The active branch's leaf, null in an empty session. */
  leafId(): EntryId | null;
  /** The active branch, root first. */
  branch(): HEntry[];
  /** Every entry in the session, in the order they were written. */
  entries(): HEntry[];
  entry(id: EntryId): HEntry | undefined;
}

// The harness contract, history (§app/harness, §app.harness/reader). Types only: imports nothing but its
// siblings, emits nothing. A session's entries as Sova reads them, whatever harness wrote them; pi's reader
// is server/harness/pi/reader.ts. Fields are optional and carry the harness's values as written, never
// coerced, so a reader that moves onto these shapes gives byte-identical output on malformed files too.
import type { EntryId, SessionKey } from "./harness-core";

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

// ---- Saved sessions (§chat.saved-sessions/bundle): a session's active branch as a portable transcript, and
// back. pi's implementation is server/harness/pi/bundle.ts; the card, branch and routes are pi-free
// (shared/session-bundle.ts, server/session-bundles*.ts).

/** Where a string leaf sits, for the cleaner's report. */
export interface BundleStringSite {
  entryId: EntryId | null;
  where: "user" | "assistant" | "tool-call" | "tool-result" | "note" | "summary" | "setting";
  /** The tool's name, for a tool call or result. */
  tool?: string;
  at?: string;
}

/** An image block found in the kept history. `id` is stable across exports of the same source. */
export interface BundleImage {
  id: string;
  entryId: EntryId | null;
  mimeType: string;
  /** Decoded size. */
  bytes: number;
  where: BundleStringSite["where"];
  at?: string;
}

export interface BundleExportOptions {
  /** "whole": the active branch linearised, as fork does. "since-summary": the latest compaction and what
      follows, re-rooted (the model's context is the same either way). */
  scope: "whole" | "since-summary";
  /** False (the default) drops every thinking block. */
  includeThinking: boolean;
  /** Called on every string leaf of every kept entry (text, tool arguments, tool results, note content,
      summaries); returns the cleaned string. Redaction and path tokens live in the caller. */
  clean(text: string, site: BundleStringSite): string;
  /** Images to leave out: every image, or the ids listed. A dropped image becomes a short text note. */
  dropImages: "all" | ReadonlySet<string>;
  /** Clip each tool result longer than head + tail characters to its head and tail with a marker. */
  trimToolOutput?: { headChars: number; tailChars: number };
  /** The header's cwd in the written transcript (a token, never this computer's path). */
  placeholderCwd: string;
}

export interface BundleExport {
  /** The transcript file's bytes: a fresh header, then only conversation-shaping entries. */
  transcript: string;
  bytes: number;
  entries: number;
  messages: number;
  /** Rough context size the model would see (from the last summary on). */
  approxTokens: number;
  /** Every image in the kept history (dropped ones included), for the review. */
  images: BundleImage[];
  thinkingDropped: number;
  toolOutputsTrimmed: number;
  /** The model and thinking level in force at the leaf. */
  model?: { provider: string; id: string };
  thinking?: string;
  /** Whether the kept history holds a summary to start from. */
  hasSummary: boolean;
  /** Each subagent and team member the conversation started, from the session's own registry entries
      (uncleaned: the caller cleans them like everything else). */
  workers: BundleWorker[];
}

/** One worker of the exported session, summarised mechanically (shared/session-bundle.ts SavedWorkerSummary). */
export interface BundleWorker {
  kind: "subagent" | "team-member";
  team?: string;
  role: string;
  task: string;
  outcome: string;
  report?: string;
}

export type BundleRefusal = "not_found" | "invalid" | "tool_boundary" | "too_big" | "internal";
export type BundleOutcome<T> = { ok: true; value: T } | { ok: false; reason: BundleRefusal; message: string };

/** A saved transcript, read strictly and filtered: only conversation-shaping entries survive (messages,
    custom_message, compaction, branch_summary, context_edit, model_change, thinking_level_change,
    session_info, label); every state, grant, sandbox, baton, overseer and worktree entry is gone. */
export interface BundleRead {
  entries: HEntry[];
  /** Entries dropped by the filter, by harness type, for the log. */
  dropped: Record<string, number>;
  approxTokens: number;
  hasSummary: boolean;
  model?: { provider: string; id: string };
}

export interface BundleImportOptions {
  /** Refuse a transcript over this many bytes. */
  maxBytes: number;
  /** Called on every string leaf: tokens back to this computer's paths. */
  restore(text: string): string;
  /** Start from the latest compaction (the history won't fit the model). */
  fromSummary: boolean;
  /** The model to continue on, when it isn't the saved one (the fallback): a model change after the history. */
  model?: { provider: string; id: string };
  /** An extension message written after the imported history (display: true): the continuation note. */
  note?: { noteType: string; content: string; details?: unknown };
}

/** Export and import of saved transcripts. The source session file is only read; the blank session the
    import writes into keeps its own header and its own entries (profile, mode and sandbox picks), the
    imported history is appended after them, and nothing else in it changes. */
export interface HarnessBundles {
  exportSession(sessionKey: SessionKey, o: BundleExportOptions): BundleOutcome<BundleExport>;
  readBundle(transcript: string, o: { maxBytes: number }): BundleOutcome<BundleRead>;
  /** Writes into the blank, unprompted session's file (its runtime closed by the caller). Returns the new leaf. */
  importInto(sessionKey: SessionKey, transcript: string, o: BundleImportOptions): BundleOutcome<{ leafId: EntryId; entries: number }>;
}
